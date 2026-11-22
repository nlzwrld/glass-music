export type {
  HubAuthProvider,
  HubIdentityPublic,
  HubOAuthProvider,
  HubProviderAvailability,
  HubProvidersAvailability,
} from './types.ts';

export const CURRENT_TERMS_VERSION = '2026-11-01';
export const CURRENT_PRIVACY_VERSION = '2026-11-01';

export const LEGAL_SUMMARY = {
  termsVersion: CURRENT_TERMS_VERSION,
  privacyVersion: CURRENT_PRIVACY_VERSION,
  termsTitle: 'Termos de Uso do Liquid Hub',
  privacyTitle: 'Política de Privacidade do Liquid Hub',
  termsHighlights: [
    'Sua conta central do Liquid Hub identifica você nas salas JAM e na sincronização segura entre dispositivos.',
    'O login com Google, Discord ou GitHub acessa apenas os escopos mínimos necessários para perfil e vínculo de identidade.',
    'O uso de recursos multiplayer exige respeito às regras da sala e não abusar de convites ou sessões.',
  ],
  privacyHighlights: [
    'Tokens e chaves de sessão no desktop são criptografados exclusivamente no cofre DPAPI do sistema operacional.',
    'Seu e-mail é opcional em provedores OAuth quando mantido privado, e contas nunca são mescladas automaticamente sem sua confirmação.',
    'Registramos apenas a versão e a data de aceitação dos documentos legais associadas à sua conta.',
  ],
} as const;

export function hasAcceptedCurrentLegal(
  value?: {
    termsVersion?: string | null;
    privacyVersion?: string | null;
    termsAcceptedAt?: number | null;
  } | null,
): boolean {
  if (!value) return false;
  return (
    value.termsVersion === CURRENT_TERMS_VERSION &&
    value.privacyVersion === CURRENT_PRIVACY_VERSION
  );
}
