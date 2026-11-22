export type PlusPlanId = 'free' | 'plus_monthly' | 'plus_annual';

export type SubscriptionStatus =
  | 'none'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'expired';

export type SubscriptionSource = 'system' | 'admin' | 'stripe' | 'google_play' | 'promo';

export type PlusEntitlementKey =
  | 'adFreeVisual'
  | 'exclusiveThemes'
  | 'advancedGlassPresets'
  | 'detailedListeningStats'
  | 'profileCustomizationPlus'
  | 'advancedLibraryTools';

export interface PlusEntitlements {
  nativeAudioAdFree: true;
  adFreeVisual: boolean;
  exclusiveThemes: boolean;
  advancedGlassPresets: boolean;
  detailedListeningStats: boolean;
  profileCustomizationPlus: boolean;
  advancedLibraryTools: boolean;
}

export const AUDIO_ADS_POLICY = {
  audioInterruptionsAllowed: false,
  nativeAdFreeMusic: true,
  visualAdsMutedByDefault: true,
  explicitUnmuteRequired: true,
} as const;

export interface PlusPlanDefinition {
  id: PlusPlanId;
  name: string;
  tagline: string;
  commercialStatus: 'active' | 'planned';
  checkoutEnabled: boolean;
  entitlements: PlusEntitlements;
  highlights: string[];
}

export interface LiquidPlusStatus {
  authenticated: boolean;
  planId: PlusPlanId;
  status: SubscriptionStatus;
  active: boolean;
  currentPeriodEnd: number | null;
  checkoutEnabled: boolean;
  entitlements: PlusEntitlements;
  audioAdsPolicy: typeof AUDIO_ADS_POLICY;
  source: SubscriptionSource;
}

const FREE_ENTITLEMENTS: PlusEntitlements = {
  nativeAudioAdFree: true,
  adFreeVisual: false,
  exclusiveThemes: false,
  advancedGlassPresets: false,
  detailedListeningStats: false,
  profileCustomizationPlus: false,
  advancedLibraryTools: false,
};

const PLUS_ENTITLEMENTS: PlusEntitlements = {
  nativeAudioAdFree: true,
  adFreeVisual: true,
  exclusiveThemes: true,
  advancedGlassPresets: true,
  detailedListeningStats: true,
  profileCustomizationPlus: true,
  advancedLibraryTools: true,
};

export const PLUS_PLAN_CATALOG: readonly PlusPlanDefinition[] = [
  {
    id: 'free',
    name: 'Grátis',
    tagline: 'Experiência musical completa e sem anúncios sonoros entre faixas.',
    commercialStatus: 'active',
    checkoutEnabled: false,
    entitlements: FREE_ENTITLEMENTS,
    highlights: [
      'Reprodução contínua sem anúncios em áudio (nativo para todos)',
      'Playlists, busca unificada, perfis públicos, letras e JAM ao vivo',
      'Anúncios visuais eventuais sempre silenciosos por padrão',
    ],
  },
  {
    id: 'plus_monthly',
    name: 'Liquid Plus Mensal',
    tagline: 'Visual limpo sem publicidade visual e recursos extras de personalização.',
    commercialStatus: 'planned',
    checkoutEnabled: false,
    entitlements: PLUS_ENTITLEMENTS,
    highlights: [
      'Remove anúncios visuais, cards e vídeos patrocinados da interface',
      'Temas exclusivos e presets avançados do Liquid Glass',
      'Estatísticas detalhadas de escuta e personalização estendida de perfil',
    ],
  },
  {
    id: 'plus_annual',
    name: 'Liquid Plus Anual',
    tagline: 'Todos os benefícios do Liquid Plus em ciclo anual (estrutura em preparação).',
    commercialStatus: 'planned',
    checkoutEnabled: false,
    entitlements: PLUS_ENTITLEMENTS,
    highlights: [
      'Todos os benefícios de visual limpo, temas exclusivos e organização musical',
      'Cobrança e preços comerciais ainda desativados até aprovação final',
    ],
  },
] as const;

export function resolvePlusEntitlements(
  planId: PlusPlanId,
  status: SubscriptionStatus,
  now = Date.now(),
  currentPeriodEnd: number | null = null,
): {
  active: boolean;
  effectivePlanId: PlusPlanId;
  effectiveStatus: SubscriptionStatus;
  entitlements: PlusEntitlements;
} {
  const isPaidPlan = planId === 'plus_monthly' || planId === 'plus_annual';
  const isEntitledStatus = status === 'active' || status === 'trialing';
  const periodExpired = currentPeriodEnd !== null && currentPeriodEnd <= now;

  if (isPaidPlan && isEntitledStatus && !periodExpired) {
    return {
      active: true,
      effectivePlanId: planId,
      effectiveStatus: status,
      entitlements: { ...PLUS_ENTITLEMENTS },
    };
  }

  return {
    active: false,
    effectivePlanId: 'free',
    effectiveStatus:
      isPaidPlan && isEntitledStatus && periodExpired
        ? 'expired'
        : status === 'canceled' || status === 'past_due' || status === 'expired'
          ? status
          : 'none',
    entitlements: { ...FREE_ENTITLEMENTS },
  };
}

export function defaultFreePlusStatus(authenticated = false): LiquidPlusStatus {
  return {
    authenticated,
    planId: 'free',
    status: 'none',
    active: false,
    currentPeriodEnd: null,
    checkoutEnabled: false,
    entitlements: { ...FREE_ENTITLEMENTS },
    audioAdsPolicy: AUDIO_ADS_POLICY,
    source: 'system',
  };
}
