import { useId } from 'react';

export type LiquidLogoVariant = 'adaptive' | 'dark' | 'light' | 'mono';

export function LiquidHubLogo({
  size = 28,
  variant = 'adaptive',
  withWordmark = false,
  className = '',
}: {
  size?: number;
  variant?: LiquidLogoVariant;
  withWordmark?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const dropGradId = `lh-drop-${uid}`;
  const sheenGradId = `lh-sheen-${uid}`;
  const phoneGradId = `lh-phone-${uid}`;

  const isMono = variant === 'mono';
  const isLight = variant === 'light';

  const bodyStart = isMono ? 'currentColor' : isLight ? '#23828f' : '#9fe8e5';
  const bodyEnd = isMono ? 'currentColor' : isLight ? '#154d59' : '#3a8c9b';
  const headphoneStroke = isMono ? 'currentColor' : isLight ? '#183846' : '#e4f6f7';
  const rimHighlight = isMono ? 'currentColor' : isLight ? '#ffffff' : '#ffffff';

  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={withWordmark ? '' : className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={dropGradId} x1="20" y1="12" x2="46" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={bodyStart} stopOpacity={isMono ? 0.25 : 0.92} />
          <stop offset="55%" stopColor={bodyEnd} stopOpacity={isMono ? 0.18 : 0.78} />
          <stop offset="100%" stopColor={bodyEnd} stopOpacity={isMono ? 0.3 : 0.94} />
        </linearGradient>
        <linearGradient id={sheenGradId} x1="22" y1="18" x2="38" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={rimHighlight} stopOpacity={isMono ? 0.55 : 0.72} />
          <stop offset="100%" stopColor={rimHighlight} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={phoneGradId} x1="10" y1="10" x2="54" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={headphoneStroke} stopOpacity="0.98" />
          <stop offset="100%" stopColor={headphoneStroke} stopOpacity="0.72" />
        </linearGradient>
      </defs>

      {/* Modern Headphone Headband Arch */}
      <path
        d="M14 35V30C14 19.5066 22.0589 11 32 11C41.9411 11 50 19.5066 50 30V35"
        stroke={`url(#${phoneGradId})`}
        strokeWidth="4.2"
        strokeLinecap="round"
      />

      {/* Left & Right Headphone Earcups */}
      <rect
        x="8.5"
        y="30"
        width="8.5"
        height="16.5"
        rx="4.25"
        fill={isMono ? 'none' : `url(#${phoneGradId})`}
        stroke={headphoneStroke}
        strokeWidth="2.4"
      />
      <rect
        x="47"
        y="30"
        width="8.5"
        height="16.5"
        rx="4.25"
        fill={isMono ? 'none' : `url(#${phoneGradId})`}
        stroke={headphoneStroke}
        strokeWidth="2.4"
      />

      {/* Central Translucent Liquid Glass Droplet */}
      <path
        d="M32 17.5C32 17.5 44.5 31.2 44.5 40.2C44.5 47.4 38.9 53 32 53C25.1 53 19.5 47.4 19.5 40.2C19.5 31.2 32 17.5 32 17.5Z"
        fill={`url(#${dropGradId})`}
        stroke={rimHighlight}
        strokeOpacity={isMono ? 0.9 : 0.72}
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Specular Glass Edge Sheen */}
      <path
        d="M27.4 27.6C24.4 32.1 23 36.2 23 39.8C23 44.4 26.2 48 30.2 48.8"
        stroke={`url(#${sheenGradId})`}
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Subtle Internal Acoustic Pulse Arc */}
      <path
        d="M28.2 41.2C29.3 42.7 30.6 43.4 32 43.4C33.4 43.4 34.7 42.7 35.8 41.2"
        stroke={rimHighlight}
        strokeOpacity={isMono ? 0.9 : 0.85}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );

  if (!withWordmark) return mark;

  return (
    <span className={`liquid-brand-lockup ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      {mark}
      <span className="liquid-brand-wordmark">Liquid Hub</span>
    </span>
  );
}
