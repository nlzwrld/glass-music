export interface CatalogVerification {
  ok: boolean;
  reason?: string;
  provenance: Record<string, unknown>;
  verified?: number;
  missing?: string[];
  mismatched?: Array<{ path: string; actual: string; expected: string }>;
  eolNormalized?: Array<{ path: string; variant: 'LF' | 'CRLF' }>;
}
export function readCatalogProvenance(assetsDir?: string): Promise<Record<string, any>>;
export function verifyCatalogBinaries(options?: { assetsDir?: string; provenance?: Record<string, any> }): Promise<CatalogVerification>;
export function ensureCatalogBinaries(options?: { force?: boolean; allowOfflinePlaceholder?: boolean; assetsDir?: string; fetchImpl?: typeof fetch; spawnSyncImpl?: any }): Promise<Record<string, unknown>>;
