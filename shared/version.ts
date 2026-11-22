export const APP_VERSION = '2.2.0';
export const MIN_SUPPORTED_VERSION = '2.2.0';
export const OFFICIAL_RELEASE_REPO = 'nlzwrld/glass-music';
export const OFFICIAL_UPDATE_URL = `https://github.com/${OFFICIAL_RELEASE_REPO}/releases/latest`;
export const OFFICIAL_MANIFEST_ENDPOINT = `https://github.com/${OFFICIAL_RELEASE_REPO}/releases/latest/download/latest.json`;
export const UPDATER_PUBKEY_FINGERPRINT = 'C24F5E0892402653';

export type SupportedPlatform = 'windows' | 'android' | 'linux' | 'macos' | 'web';

export interface PackageIntegrityPolicy {
  algorithm: 'Minisign-Ed25519+SHA-256';
  pubkeyFingerprint: string;
  manifestEndpoint: string;
  signatureRequired: true;
}

export interface VersionPolicyResponse {
  currentVersion: string;
  minSupportedVersion: string;
  clientVersion: string | null;
  platform: SupportedPlatform;
  updateAvailable: boolean;
  mandatoryUpdate: boolean;
  compatible: boolean;
  updateUrl: string;
  releaseNotes: string;
  reason: string;
  packageIntegrity: PackageIntegrityPolicy;
}

export function parseSemVer(raw?: string | null): [number, number, number] | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^v/i, '').split(/[-+]/)[0] || '';
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(clean);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return [major, minor, patch];
}

export function compareSemVer(a?: string | null, b?: string | null): -1 | 0 | 1 | null {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

export function normalizePlatform(raw?: string | null): SupportedPlatform {
  const clean = String(raw || '')
    .trim()
    .toLowerCase();
  if (clean === 'android') return 'android';
  if (clean === 'linux') return 'linux';
  if (clean === 'macos' || clean === 'darwin' || clean === 'ios') return 'macos';
  if (clean === 'web') return 'web';
  return 'windows';
}

export function evaluateVersionPolicy(input: {
  clientVersion?: string | null;
  platform?: string | null;
  currentVersion?: string;
  minSupportedVersion?: string;
  updateUrl?: string;
  releaseNotes?: string;
} = {}): VersionPolicyResponse {
  const currentVersion =
    parseSemVer(input.currentVersion) !== null ? input.currentVersion!.trim().replace(/^v/i, '') : APP_VERSION;
  const minSupportedVersion =
    parseSemVer(input.minSupportedVersion) !== null
      ? input.minSupportedVersion!.trim().replace(/^v/i, '')
      : MIN_SUPPORTED_VERSION;
  const parsedClient = parseSemVer(input.clientVersion);
  const clientVersion = parsedClient ? parsedClient.join('.') : null;
  const platform = normalizePlatform(input.platform);

  const cmpMin = clientVersion ? compareSemVer(clientVersion, minSupportedVersion) : 0;
  const cmpCur = clientVersion ? compareSemVer(clientVersion, currentVersion) : 0;

  const mandatoryUpdate = cmpMin !== null && cmpMin < 0;
  const updateAvailable = mandatoryUpdate || (cmpCur !== null && cmpCur < 0);
  const compatible = !mandatoryUpdate;

  const reason = mandatoryUpdate
    ? `Sua versão (${clientVersion}) é anterior à versão mínima obrigatória (${minSupportedVersion}), que introduziu autenticação segura PKCE S256, cofre DPAPI e aprovação de entrada na JAM.`
    : updateAvailable
      ? `Uma nova versão oficial (${currentVersion}) está disponível.`
      : 'Versão compatível e atualizada.';

  return {
    currentVersion,
    minSupportedVersion,
    clientVersion,
    platform,
    updateAvailable,
    mandatoryUpdate,
    compatible,
    updateUrl: input.updateUrl || OFFICIAL_UPDATE_URL,
    releaseNotes:
      input.releaseNotes ||
      'Inclui autenticação obrigatória com cofre criptografado, JAM em janela independente com aprovação do anfitrião, perfis e playlists colaborativas, Liquid Glass otimizado e suporte Android Beta.',
    reason,
    packageIntegrity: {
      algorithm: 'Minisign-Ed25519+SHA-256',
      pubkeyFingerprint: UPDATER_PUBKEY_FINGERPRINT,
      manifestEndpoint: OFFICIAL_MANIFEST_ENDPOINT,
      signatureRequired: true,
    },
  };
}
