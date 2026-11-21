import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseArtifacts } from '../../scripts/update-manifest.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquid-manifest-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] — Fixture\n\n- Mudança determinística.\n');
  const installer = join(root, 'Liquid Hub_1.2.3_x64-setup.exe');
  await writeFile(installer, 'small installer fixture');
  await writeFile(installer + '.sig', 'small signature fixture\n');
  return { root, installer };
}

function options(root: string, installer: string) {
  return {
    root,
    installer,
    version: '1.2.3',
    timestamp: '2026-11-21T12:34:56-03:00',
    repository: 'owner/repo',
    output: join(root, 'out', 'latest.json'),
    notesOutput: join(root, 'out', 'release-notes.md'),
    inventoryOutput: join(root, 'out', 'release-artifacts.json'),
    fetchNotes: async () => '',
  };
}

describe('update-manifest', () => {
  it('uses explicit inputs and produces identical bytes on repeated runs', async () => {
    const { root, installer } = await fixture();
    const first = await createReleaseArtifacts(options(root, installer));
    const manifestBytes = await readFile(join(root, 'out', 'latest.json'), 'utf8');
    const inventoryBytes = await readFile(join(root, 'out', 'release-artifacts.json'), 'utf8');
    await createReleaseArtifacts(options(root, installer));
    expect(await readFile(join(root, 'out', 'latest.json'), 'utf8')).toBe(manifestBytes);
    expect(await readFile(join(root, 'out', 'release-artifacts.json'), 'utf8')).toBe(inventoryBytes);
    expect(first.manifest.pub_date).toBe('2026-11-21T15:34:56.000Z');
    expect(JSON.stringify(first.manifest)).toContain('Liquid%20Hub_1.2.3_x64-setup.exe');
    expect(first.inventory.tag).toBe('v1.2.3');
  });

  it('fails on a missing signature, inconsistent version or non-explicit timestamp', async () => {
    const { root, installer } = await fixture();
    await rm(installer + '.sig');
    await expect(createReleaseArtifacts(options(root, installer))).rejects.toThrow(/ENOENT/);
    await writeFile(installer + '.sig', 'sig');
    await expect(createReleaseArtifacts({ ...options(root, installer), version: '9.9.9' })).rejects.toThrow(/divergente|inválida/);
    await expect(createReleaseArtifacts({ ...options(root, installer), timestamp: '' })).rejects.toThrow(/timestamp/i);
  });
});
