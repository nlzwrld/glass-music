import type { ReleaseInventory } from './update-manifest.mjs';
export interface GitHubReleaseAsset { name: string; digest?: string; size?: number }
export interface GitHubRelease { draft: boolean; assets?: GitHubReleaseAsset[] }
export interface GitHubAdapter {
  getRelease(tag: string): Promise<GitHubRelease | null>;
  resolveTag(tag: string): Promise<string | null>;
  createDraft(input: { tag: string; commit: string; title: string; notesPath: string }): Promise<void>;
  uploadAsset(input: { tag: string; path: string; name: string }): Promise<void>;
  publishDraft(input: { tag: string; latest: boolean }): Promise<void>;
}
export function reconcileRelease(options: { github: GitHubAdapter; inventory: ReleaseInventory; commit: string; title?: string; notesPath?: string; makeLatest?: boolean; log?: (message: string) => void }): Promise<{ status: string; tag: string; assets: string[] }>;
export function createGitHubCliAdapter(options?: { repository?: string; env?: NodeJS.ProcessEnv; spawn?: any }): GitHubAdapter;
