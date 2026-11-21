import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureCatalogBinaries, readCatalogProvenance, verifyCatalogBinaries } from '../../scripts/configure-catalog.mjs';

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquid-catalog-'));
  roots.push(root);
  const assetsDir = join(root, 'catalog');
  const files: Record<string, string> = {
    'yt-dlp/yt-dlp.exe': 'valid executable',
    'plugins/liquid_hub/extractor/fixture.py': 'valid plugin',
  };
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(assetsDir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const zip = Buffer.from('small zip fixture');
  const provenance = {
    version: '1.0.0',
    asset: 'fixture.zip',
    sha256: hash(zip),
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)])),
  };
  await writeFile(join(assetsDir, 'PROVENANCE.json'), JSON.stringify(provenance));
  return { root, assetsDir, files, zip, provenance };
}

describe('catalog provenance', () => {
  it('checks every declared file and reports missing and corrupted resources together', async () => {
    const { assetsDir } = await fixture();
    expect((await verifyCatalogBinaries({ assetsDir })).verified).toBe(2);
    await writeFile(join(assetsDir, 'yt-dlp', 'yt-dlp.exe'), 'corrupted');
    await rm(join(assetsDir, 'plugins', 'liquid_hub', 'extractor', 'fixture.py'));
    const result = await verifyCatalogBinaries({ assetsDir });
    expect(result.ok).toBe(false);
    expect(result.mismatched?.[0].path).toBe('yt-dlp/yt-dlp.exe');
    expect(result.missing).toEqual(['plugins/liquid_hub/extractor/fixture.py']);
  });

  it.each(['../outside.exe', '/absolute.exe', 'yt-dlp\\escape.exe', 'yt-dlp//empty.exe'])(
    'rejects unsafe path %s before download or skip early returns',
    async path => {
      const { assetsDir, provenance } = await fixture();
      provenance.files = { [path]: hash('x') };
      await writeFile(join(assetsDir, 'PROVENANCE.json'), JSON.stringify(provenance));
      vi.stubEnv('LIQUID_SKIP_YTDLP_DOWNLOAD', '1');
      await expect(readCatalogProvenance(assetsDir)).rejects.toThrow(/inseguro|inválido/);
      await expect(ensureCatalogBinaries({ assetsDir })).rejects.toThrow(/inseguro|inválido/);
    },
  );

  it('requires hashes and performs no network request on repeated valid ensures', async () => {
    const { assetsDir, provenance } = await fixture();
    const fetchImpl = vi.fn();
    expect((await ensureCatalogBinaries({ assetsDir, fetchImpl })).downloaded).toBe(false);
    expect((await ensureCatalogBinaries({ assetsDir, fetchImpl })).downloaded).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    provenance.files['yt-dlp/yt-dlp.exe'] = '';
    await writeFile(join(assetsDir, 'PROVENANCE.json'), JSON.stringify(provenance));
    await expect(verifyCatalogBinaries({ assetsDir })).rejects.toThrow(/SHA-256/);
  });

  it('accepts LF/CRLF variants only for recognized text without rewriting or hiding content changes', async () => {
    const { assetsDir, provenance } = await fixture();
    const plugin = 'plugins/liquid_hub/extractor/fixture.py';
    const license = 'yt-dlp-LICENSE';
    const pluginLf = 'alpha\nbeta\n';
    const pluginCrlf = pluginLf.replace(/\n/g, '\r\n');
    const licenseCrlf = 'one\r\ntwo\r\n';
    const licenseLf = licenseCrlf.replace(/\r\n/g, '\n');
    provenance.files[plugin] = hash(pluginLf);
    provenance.files[license] = hash(licenseCrlf);
    await writeFile(join(assetsDir, 'PROVENANCE.json'), JSON.stringify(provenance));
    await writeFile(join(assetsDir, ...plugin.split('/')), pluginCrlf);
    await writeFile(join(assetsDir, license), licenseLf);

    const accepted = await verifyCatalogBinaries({ assetsDir });
    expect(accepted.ok).toBe(true);
    expect(accepted.eolNormalized).toEqual(expect.arrayContaining([
      { path: plugin, variant: 'LF' },
      { path: license, variant: 'CRLF' },
    ]));
    expect(await readFile(join(assetsDir, ...plugin.split('/')), 'utf8')).toBe(pluginCrlf);
    expect(await readFile(join(assetsDir, license), 'utf8')).toBe(licenseLf);

    await writeFile(join(assetsDir, ...plugin.split('/')), 'alpha\r\nchanged\r\n');
    const changed = await verifyCatalogBinaries({ assetsDir });
    expect(changed.ok).toBe(false);
    expect(changed.mismatched?.map(item => item.path)).toEqual([plugin]);
  });

  it('never applies EOL normalization to binary resources', async () => {
    const { assetsDir, provenance } = await fixture();
    const executable = 'yt-dlp/yt-dlp.exe';
    provenance.files[executable] = hash('binary\npayload\n');
    await writeFile(join(assetsDir, 'PROVENANCE.json'), JSON.stringify(provenance));
    await writeFile(join(assetsDir, 'yt-dlp', 'yt-dlp.exe'), 'binary\r\npayload\r\n');
    const result = await verifyCatalogBinaries({ assetsDir });
    expect(result.ok).toBe(false);
    expect(result.mismatched?.map(item => item.path)).toEqual([executable]);
  });

  it('preserves a valid active tree when forced replacement extraction fails', async () => {
    const { assetsDir, files, zip } = await fixture();
    const fetchImpl = vi.fn(async () => new Response(zip));
    const spawnSyncImpl = vi.fn(() => ({ status: 1 }));
    await expect(ensureCatalogBinaries({ assetsDir, force: true, fetchImpl, spawnSyncImpl })).rejects.toThrow(/extrair/);
    for (const [path, bytes] of Object.entries(files)) {
      expect(await readFile(join(assetsDir, ...path.split('/')), 'utf8')).toBe(bytes);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
