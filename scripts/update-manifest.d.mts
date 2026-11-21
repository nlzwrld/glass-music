export interface ReleaseAssetInventory { path: string; name: string; sha256: string; size?: number }
export interface ReleaseInventory {
  version: string;
  tag: string;
  repository: string;
  installer: ReleaseAssetInventory;
  signature: ReleaseAssetInventory;
  manifest: ReleaseAssetInventory;
  notes: { path: string };
}
export function createReleaseArtifacts(options?: Record<string, unknown>): Promise<{ manifest: Record<string, unknown>; inventory: ReleaseInventory; inventoryPath: string }>;
