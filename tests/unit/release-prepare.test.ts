import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRelease, resolveReleaseVersion } from '../../scripts/prepare-release.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquid-prepare-'));
  roots.push(root);
  await mkdir(join(root, 'src-tauri'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.2.0' }, null, 2) + '\n');
  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '2.2.0' }, null, 2) + '\n');
  await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nversion = "2.2.0"\n');
  return root;
}

describe('prepare-release', () => {
  it('resolves the run version once and accepts an explicit immutable version', () => {
    expect(resolveReleaseVersion({ baseVersion: '2.2.0', runNumber: '42' })).toBe('2.2.42');
    expect(resolveReleaseVersion({ baseVersion: '2.2.42', explicitVersion: '2.2.42', runNumber: '42' })).toBe('2.2.42');
    expect(() => resolveReleaseVersion({ baseVersion: '2.2.0', runNumber: '0' })).toThrow(/RUN_NUMBER/);
  });

  it('is byte-idempotent when applied twice with the same version', async () => {
    const root = await fixture();
    const options = { root, version: '2.2.42', repository: 'owner/repo' };
    await prepareRelease(options);
    const paths = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/release.json'];
    const first = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')));
    await prepareRelease(options);
    const second = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')));
    expect(second).toEqual(first);
    expect(JSON.parse(second[0]).version).toBe('2.2.42');
    expect(second[2]).toContain('version = "2.2.42"');
    expect(JSON.parse(second[3]).endpoint).toBe('https://github.com/owner/repo/releases/latest/download/latest.json');
  });
});
