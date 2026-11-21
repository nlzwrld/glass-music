import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileRelease } from '../../scripts/publish-release.mjs';
import type { GitHubAdapter, GitHubRelease, GitHubReleaseAsset } from '../../scripts/publish-release.mjs';
import type { ReleaseInventory } from '../../scripts/update-manifest.mjs';

const roots: string[] = [];
const commit = 'a'.repeat(40);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquid-publish-'));
  roots.push(root);
  const assets: Record<string, [string, string]> = {
    installer: ['Liquid.Hub_1.2.3_x64-setup.exe', 'installer'],
    signature: ['Liquid.Hub_1.2.3_x64-setup.exe.sig', 'signature'],
    manifest: ['latest.json', '{"version":"1.2.3"}'],
  };
  const inventory: Record<string, unknown> = { version: '1.2.3', tag: 'v1.2.3', repository: 'owner/repo' };
  for (const [key, [name, bytes]] of Object.entries(assets)) {
    const path = join(root, name);
    await writeFile(path, bytes);
    inventory[key] = { path, name, sha256: hash(Buffer.from(bytes)) };
  }
  const notes = join(root, 'release-notes.md');
  await writeFile(notes, 'notes');
  inventory.notes = { path: notes };
  return { root, inventory: inventory as unknown as ReleaseInventory };
}

async function remoteAsset(local: { path: string; name: string }): Promise<GitHubReleaseAsset> {
  const bytes = await readFile(local.path);
  return { name: local.name, digest: `sha256:${hash(bytes)}`, size: bytes.length };
}

class FakeGitHub implements GitHubAdapter {
  release: (GitHubRelease & { tag?: string }) | null = null;
  tagCommit: string | null = commit;
  mutations: string[] = [];
  getRelease = vi.fn(async (_tag: string) => this.release ? structuredClone(this.release) : null);
  resolveTag = vi.fn(async (_tag: string) => this.tagCommit);
  createDraft = vi.fn(async ({ tag, commit: target }: { tag: string; commit: string; title: string; notesPath: string }) => {
    this.mutations.push('create');
    this.tagCommit = target;
    this.release = { draft: true, assets: [], tag };
  });
  uploadAsset = vi.fn(async ({ path, name }: { tag: string; path: string; name: string }) => {
    this.mutations.push(`upload:${name}`);
    const bytes = await readFile(path);
    this.release!.assets!.push({ name, digest: `sha256:${hash(bytes)}`, size: bytes.length });
  });
  publishDraft = vi.fn(async ({ latest }: { tag: string; latest: boolean }) => {
    this.mutations.push(`publish:latest=${latest}`);
    this.release!.draft = false;
  });
}

describe('publish reconciliation', () => {
  it('creates a draft, uploads latest.json last, publishes, then becomes a no-op', async () => {
    const { inventory } = await fixture();
    const github = new FakeGitHub();
    github.tagCommit = null;
    expect((await reconcileRelease({ github, inventory, commit })).status).toBe('published');
    expect(github.mutations).toEqual([
      'create',
      `upload:${inventory.installer.name}`,
      `upload:${inventory.signature.name}`,
      'upload:latest.json',
      'publish:latest=true',
    ]);
    github.mutations = [];
    expect((await reconcileRelease({ github, inventory, commit })).status).toBe('no-op');
    expect(github.mutations).toEqual([]);
  });

  it('recovers only missing assets in a partial draft and publishes after verification', async () => {
    const { inventory } = await fixture();
    const github = new FakeGitHub();
    github.release = { draft: true, assets: [await remoteAsset(inventory.installer)] };
    await reconcileRelease({ github, inventory, commit });
    expect(github.mutations).toEqual([
      `upload:${inventory.signature.name}`,
      'upload:latest.json',
      'publish:latest=true',
    ]);
  });

  it('rejects conflicts and wrong tags without uploading, publishing or moving tags', async () => {
    const { inventory } = await fixture();
    const conflict = new FakeGitHub();
    // A late manifest conflict must be found before either earlier missing asset is uploaded.
    conflict.release = { draft: true, assets: [{ name: 'latest.json', digest: `sha256:${'0'.repeat(64)}`, size: 9 }] };
    await expect(reconcileRelease({ github: conflict, inventory, commit })).rejects.toThrow(/Conflito/);
    expect(conflict.mutations).toEqual([]);

    const wrongTag = new FakeGitHub();
    wrongTag.tagCommit = 'b'.repeat(40);
    wrongTag.release = { draft: true, assets: [] };
    await expect(reconcileRelease({ github: wrongTag, inventory, commit })).rejects.toThrow(/não será movida/);
    expect(wrongTag.mutations).toEqual([]);
  });

  it('does not reinterpret API/authentication failures as a missing release', async () => {
    const { inventory } = await fixture();
    const github = new FakeGitHub();
    github.getRelease.mockRejectedValue(new Error('HTTP 401: bad credentials'));
    await expect(reconcileRelease({ github, inventory, commit })).rejects.toThrow('HTTP 401');
    expect(github.mutations).toEqual([]);
  });
});
