import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { CheckCircle2, HardDrive, Link2, LoaderCircle } from 'lucide-react';

export type PlatformKind =
  | 'local'
  | 'youtube'
  | 'ytmusic'
  | 'soundcloud'
  | 'spotify'
  | 'deezer'
  | 'apple'
  | 'bandcamp'
  | 'tidal'
  | 'link';

export function detectPlatform(source: string, url?: string): PlatformKind {
  if (source === 'local') return 'local';
  if (url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (h === 'open.spotify.com') return 'spotify';
      if (h === 'deezer.com' || h === 'www.deezer.com') return 'deezer';
      if (h === 'music.apple.com' || h === 'itunes.apple.com') return 'apple';
      if (h === 'music.youtube.com') return 'ytmusic';
      if (h.endsWith('.bandcamp.com')) return 'bandcamp';
      if (h === 'tidal.com' || h === 'www.tidal.com' || h === 'listen.tidal.com') return 'tidal';
    } catch {}
  }
  if (source === 'youtube') return 'youtube';
  if (source === 'ytmusic') return 'ytmusic';
  if (source === 'soundcloud') return 'soundcloud';
  if (source === 'spotify') return 'spotify';
  if (source === 'deezer') return 'deezer';
  if (source === 'apple') return 'apple';
  if (source === 'bandcamp') return 'bandcamp';
  if (source === 'tidal') return 'tidal';
  return 'link';
}

const platformLabels: Record<PlatformKind, string> = {
  local: 'Arquivo local',
  youtube: 'YouTube',
  ytmusic: 'YT Music',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  deezer: 'Deezer',
  apple: 'Apple Music',
  bandcamp: 'Bandcamp',
  tidal: 'Tidal',
  link: 'Link',
};

export function SmartShuffleIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="lucide lucide-smart-shuffle"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M5.2 1.2 L6.35 4.15 L9.3 5.3 L6.35 6.45 L5.2 9.4 L4.05 6.45 L1.1 5.3 L4.05 4.15 Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="m18 14 4 4-4 4" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="M12.2 13.7 12.73 14.5a4 4 0 0 0 3.3 1.7H22" />
    </svg>
  );
}

export function IconButton({
  label,
  children,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <Button
      {...props}
      variant="ghost"
      size="icon"
      data-glass="thin"
      type="button"
      title={label}
      aria-label={label}
      className={`icon-button ${active ? 'active' : ''} ${props.className || ''}`}
    >
      {children}
    </Button>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onChange}
        className={`toggle ${checked ? 'on' : ''}`}
      />
    </label>
  );
}

export function PlatformIcon({ source, url }: { source: string; url?: string }) {
  const kind = detectPlatform(source, url);
  if (kind === 'youtube')
    return (
      <svg className="platform-icon youtube-icon" viewBox="0 0 28 20" aria-hidden="true">
        <rect width="28" height="20" rx="6" fill="#ff0033" />
        <path d="m11 5.5 8 4.5-8 4.5V5.5Z" fill="#ffffff" />
      </svg>
    );
  if (kind === 'ytmusic')
    return (
      <svg className="platform-icon ytmusic-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="#ff0033" />
        <circle cx="12" cy="12" r="5.6" fill="none" stroke="#ffffff" strokeWidth="1.35" opacity="0.9" />
        <path d="m10.4 9.3 4.5 2.7-4.5 2.7V9.3Z" fill="#ffffff" />
      </svg>
    );
  if (kind === 'soundcloud')
    return (
      <svg className="platform-icon soundcloud-icon" viewBox="0 0 36 20" aria-hidden="true">
        <path d="M16 17V7a7 7 0 0 1 13-2 6 6 0 1 1 1 12Z" fill="#ff761e" />
        <path
          d="M2 10v5m3-7v8m3-10v11m3-12v12m3-10v10"
          stroke="#ff761e"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === 'spotify')
    return (
      <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="#1ed760" opacity="0.9" />
        <path
          d="M7.5 10.2c3.2-1 6.8-.8 9.5.8M8.2 13.2c2.6-.7 5.4-.5 7.6.7M8.9 16c2-.5 4.2-.4 5.9.5"
          fill="none"
          stroke="#0d1512"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === 'deezer')
    return (
      <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 20.2s-7-4.4-8.5-9.2C2.4 7.5 4.8 4.5 7.8 5c1.8.3 3.2 1.8 4.2 3.4 1-1.6 2.4-3.1 4.2-3.4 3-.5 5.4 2.5 4.3 6-1.5 4.8-8.5 9.2-8.5 9.2Z"
          fill="#a238ff"
        />
      </svg>
    );
  if (kind === 'apple')
    return (
      <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#fa2d48" />
        <path
          d="M15.5 6.8v7.7a2.1 2.1 0 1 1-1.4-2V9.3l-4.2.9v5.3a2.1 2.1 0 1 1-1.4-2V8.2l7-1.4Z"
          fill="white"
        />
      </svg>
    );
  if (kind === 'bandcamp')
    return (
      <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
        <polygon points="3,18 8.5,6 21,6 15.5,18" fill="#1da0c3" />
      </svg>
    );
  if (kind === 'tidal')
    return (
      <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m12 6 3 3-3 3-3-3 3-3Zm-6 0 3 3-3 3-3-3 3-3Zm12 0 3 3-3 3-3-3 3-3Zm-6 6 3 3-3 3-3-3 3-3Z"
          fill="currentColor"
        />
      </svg>
    );
  if (kind === 'link') return <Link2 className="platform-icon" size={14} />;
  return <HardDrive className="platform-icon local-icon" size={14} />;
}

export function SourceBadge({
  source,
  url,
  catalogSource,
  streamProvider,
  compact = false,
}: {
  source: string;
  url?: string;
  catalogSource?: string;
  streamProvider?: string;
  compact?: boolean;
}) {
  const catalogKind = catalogSource
    ? detectPlatform(catalogSource, url)
    : detectPlatform(source, url);
  const catalogLabel = platformLabels[catalogKind];

  const streamKind =
    streamProvider && streamProvider !== 'local'
      ? detectPlatform(streamProvider)
      : undefined;
  const isSameYoutubeFamily =
    (catalogKind === 'youtube' || catalogKind === 'ytmusic') &&
    (streamKind === 'youtube' || streamKind === 'ytmusic');
  const crossStream = Boolean(
    streamKind && streamKind !== catalogKind && !isSameYoutubeFamily,
  );
  const streamLabel = crossStream ? platformLabels[streamKind!] : undefined;

  const tooltip = streamLabel
    ? `Importado do ${catalogLabel} • Tocando via ${streamLabel}`
    : catalogLabel;

  return (
    <span
      className={`source-badge ${catalogKind} ${compact ? 'compact' : ''} ${crossStream ? 'dual-source' : ''}`}
      data-provider-badge={catalogKind}
      data-stream-badge={crossStream ? streamKind : undefined}
      title={tooltip}
      aria-label={tooltip}
    >
      <PlatformIcon source={catalogSource || source} url={url} />
      {!compact && (
        <span>
          {catalogKind === 'local' ? 'Local' : catalogLabel}
          {streamLabel ? ` • ${streamLabel}` : ''}
        </span>
      )}
    </span>
  );
}

export function OfflineIndicator({
  offline,
  downloading = false,
}: {
  offline?: boolean;
  downloading?: boolean;
}) {
  if (downloading) {
    return (
      <span
        className="offline-indicator downloading"
        data-offline-state="downloading"
        title="Baixando para ouvir offline…"
        aria-label="Baixando para ouvir offline"
      >
        <LoaderCircle size={13} className="spinner" />
      </span>
    );
  }
  if (!offline) return null;
  return (
    <span
      className="offline-indicator cached"
      data-offline-state="cached"
      title="Disponível offline"
      aria-label="Disponível offline"
    >
      <CheckCircle2 size={13} />
    </span>
  );
}

export { IconButton as GlassIconButton };
