export type Crystal = 'thin' | 'regular' | 'deep' | 'subtle';
export type GlassMethod = 'auto' | 'css' | 'svg' | 'webgl';
export interface OpticalSettings {
  backgroundMotion: number;
  gradientIntensity: number;
  schema: number;
  material: MaterialName;
  ior: number;
  fresnel: number;
  edge: number;
  solidColor: string;
  customImage: string;
  sidebarCompact: boolean;
  audioReactive: boolean;
  scale: number;
  blur: number;
  refraction: number;
  opacity: number;
  saturation: number;
  specular: number;
  chromatic: number;
  thickness: number;
  tint: string;
  quality: 'auto' | 'economy' | 'balanced' | 'high';
  background: 'dynamic' | 'ambient' | 'desktop' | 'custom' | 'solid';
}
export type MaterialName = 'clear' | 'frosted' | 'floating' | 'subtle';
export const opticalDefaults: OpticalSettings = {
  backgroundMotion: 0.35,
  gradientIntensity: 0.55,
  schema: 3,
  material: 'floating',
  blur: 10,
  refraction: 4.8,
  opacity: 0.035,
  saturation: 1.08,
  specular: 0.28,
  chromatic: 0.015,
  thickness: 14,
  tint: '#e7f0f4',
  ior: 1.42,
  fresnel: 0.24,
  edge: 0.35,
  quality: 'auto',
  background: 'dynamic',
  solidColor: '#101c24',
  customImage: '',
  sidebarCompact: false,
  audioReactive: true,
  scale: 100,
};
export const materialPresets = {
  clear: {
    crystal: 'thin',
    blur: 0.32,
    refraction: 0.78,
    opacity: 0.65,
    specular: 1.05,
    thickness: 0.65,
    ior: 1,
    fresnel: 1,
    edge: 0.8,
    radius: 18,
    shadow: '0 4px 16px #00000012',
    cursor: 1,
  },
  frosted: {
    crystal: 'regular',
    blur: 1,
    refraction: 0.7,
    opacity: 1.2,
    specular: 0.65,
    thickness: 1,
    ior: 1,
    fresnel: 0.8,
    edge: 0.7,
    radius: 24,
    shadow: '0 8px 28px #00000014',
    cursor: 0.6,
  },
  floating: {
    crystal: 'deep',
    blur: 0.7,
    refraction: 1.2,
    opacity: 0.85,
    specular: 1,
    thickness: 1.4,
    ior: 1,
    fresnel: 1.1,
    edge: 1,
    radius: 26,
    shadow: '0 12px 36px #00000026',
    cursor: 1,
  },
  subtle: {
    crystal: 'subtle',
    blur: 0.15,
    refraction: 0.15,
    opacity: 0.55,
    specular: 0.3,
    thickness: 0.3,
    ior: 1,
    fresnel: 0.25,
    edge: 0.35,
    radius: 13,
    shadow: 'none',
    cursor: 0.2,
  },
} as const;
export const crystals = {
  thin: materialPresets.clear,
  regular: materialPresets.frosted,
  deep: materialPresets.floating,
  subtle: materialPresets.subtle,
};
export function normalizeOptics(raw: Record<string, unknown> = {}): OpticalSettings {
  const next = { ...opticalDefaults };
  for (const [key, lo, hi] of [
    ['backgroundMotion', 0, 1],
    ['gradientIntensity', 0.1, 1],
    ['blur', 0, 24],
    ['refraction', 0, 12],
    ['opacity', 0, 0.14],
    ['saturation', 0.5, 2],
    ['specular', 0, 1],
    ['chromatic', 0, 0.2],
    ['thickness', 3, 30],
    ['ior', 1, 2],
    ['fresnel', 0, 1],
    ['edge', 0, 1],
    ['scale', 90, 125],
  ] as const) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = Math.min(hi, Math.max(lo, value));
  }
  for (const key of ['tint', 'solidColor'] as const)
    if (typeof raw[key] === 'string' && /^#[\da-f]{6}$/i.test(raw[key])) next[key] = raw[key];
  if (['auto', 'economy', 'balanced', 'high'].includes(String(raw.quality)))
    next.quality = raw.quality as OpticalSettings['quality'];
  if (['dynamic', 'ambient', 'desktop', 'custom', 'solid'].includes(String(raw.background)))
    next.background = raw.background as OpticalSettings['background'];
  if (['floating', 'frosted', 'clear', 'subtle'].includes(String(raw.material)))
    next.material = raw.material as MaterialName;
  if (
    typeof raw.customImage === 'string' &&
    raw.customImage.length < 2800000 &&
    /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(raw.customImage)
  )
    next.customImage = raw.customImage;
  if (typeof raw.sidebarCompact === 'boolean') next.sidebarCompact = raw.sidebarCompact;
  if (typeof raw.audioReactive === 'boolean') next.audioReactive = raw.audioReactive;
  return next;
}
export function loadOptics(): OpticalSettings {
  try {
    return normalizeOptics(JSON.parse(localStorage.getItem('glass-optics-v3') || '{}'));
  } catch {
    return { ...opticalDefaults };
  }
}
export const MAX_WEBGL_SURFACES = 12;

export const glassVisualPresets = {
  liquid: {
    label: 'Vidro Líquido',
    appearance: {
      material: 'floating' as const,
      blur: 14,
      refraction: 5.2,
      specular: 0.34,
      edge: 0.42,
      fresnel: 0.28,
      quality: 'auto' as const,
    },
    glass: 22,
  },
  crystal: {
    label: 'Cristal',
    appearance: {
      material: 'clear' as const,
      blur: 8,
      refraction: 3.8,
      specular: 0.4,
      edge: 0.38,
      fresnel: 0.3,
      quality: 'balanced' as const,
    },
    glass: 14,
  },
  frosted: {
    label: 'Fosco Suave',
    appearance: {
      material: 'frosted' as const,
      blur: 18,
      refraction: 2.8,
      specular: 0.2,
      edge: 0.28,
      fresnel: 0.2,
      quality: 'balanced' as const,
    },
    glass: 30,
  },
  battery: {
    label: 'Economia',
    appearance: {
      material: 'subtle' as const,
      blur: 6,
      refraction: 0,
      specular: 0.14,
      edge: 0.18,
      fresnel: 0.12,
      quality: 'economy' as const,
    },
    glass: 26,
  },
} as const;

export function resolveGlassQualityTier(input: {
  requested: OpticalSettings['quality'];
  uiStyle: 'matte' | 'glass' | 'beat';
  performanceMode: boolean;
  prefersContrastMore?: boolean;
  prefersReducedTransparency?: boolean;
  rendererName?: string;
  maxTextureSize?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  isMobileTouch?: boolean;
}): { quality: 'economy' | 'balanced' | 'high'; engine: 'webgl' | 'css'; reason: string } {
  if (input.uiStyle === 'matte' || input.uiStyle === 'beat') {
    return { quality: 'economy', engine: 'css', reason: input.uiStyle };
  }
  if (input.performanceMode) {
    return { quality: 'economy', engine: 'css', reason: 'performance' };
  }
  if (input.prefersContrastMore) {
    return { quality: 'economy', engine: 'css', reason: 'contrast' };
  }
  if (input.prefersReducedTransparency) {
    return { quality: 'economy', engine: 'css', reason: 'reduced-transparency' };
  }
  if (input.requested === 'economy') {
    return { quality: 'economy', engine: 'css', reason: 'economy' };
  }
  if (input.requested === 'auto') {
    if (input.isMobileTouch) {
      return { quality: 'economy', engine: 'css', reason: 'mobile-touch' };
    }
    if (input.rendererName && /swiftshader|llvmpipe|software/i.test(input.rendererName)) {
      return { quality: 'economy', engine: 'css', reason: 'software-gpu' };
    }
    if (input.maxTextureSize !== undefined && input.maxTextureSize < 4096) {
      return { quality: 'economy', engine: 'css', reason: 'low-texture' };
    }
    if (input.hardwareConcurrency !== undefined && input.hardwareConcurrency <= 2) {
      return { quality: 'economy', engine: 'css', reason: 'low-cpu' };
    }
    if (input.deviceMemory !== undefined && input.deviceMemory <= 4) {
      return { quality: 'economy', engine: 'css', reason: 'low-memory' };
    }
    return { quality: 'balanced', engine: 'webgl', reason: 'auto' };
  }
  if (input.requested === 'high') {
    return { quality: 'high', engine: 'webgl', reason: 'high' };
  }
  return { quality: 'balanced', engine: 'webgl', reason: 'balanced' };
}

export function surfaceTint(settings: OpticalSettings, light: boolean) {
  if (settings.background === 'desktop') return light ? '#f4f4f4' : '#202020';
  const base = light ? '#edf4f7' : '#192b35';
  if (settings.background !== 'solid') return base;
  return (
    '#' +
    [1, 3, 5]
      .map(i =>
        Math.round(
          parseInt(base.slice(i, i + 2), 16) * 0.65 +
            parseInt(settings.solidColor.slice(i, i + 2), 16) * 0.35,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
