export function resolveReleaseVersion(options?: { baseVersion?: string; explicitVersion?: string; runNumber?: string | number }): string;
export function prepareRelease(options?: { root?: string; version?: string; repository?: string }): Promise<{ version: string; repository: string }>;
