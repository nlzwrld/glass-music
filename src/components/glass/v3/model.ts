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
