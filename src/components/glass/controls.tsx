import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { AudioLines, Link2 } from 'lucide-react';

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
  if (source === 'soundcloud') return 'soundcloud';
  if (source === 'deezer') return 'deezer';
  if (source === 'apple') return 'apple';
  return 'link';
}

const platformLabels: Record<PlatformKind, string> = {
  local: 'Local',
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
  if (kind === 'youtube' || kind === 'ytmusic')
    return (
      <svg className="platform-icon youtube-icon" viewBox="0 0 28 20" aria-hidden="true">
        <rect width="28" height="20" rx="5" fill="#ff1717" />
        <path d="m11 5 8 5-8 5z" fill="white" />
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
  if (kind === 'link') return <Link2 className="platform-icon" size={17} />;
  return <AudioLines className="platform-icon local-icon" size={19} />;
}

export function SourceBadge({
  source,
  url,
  compact = false,
}: {
  source: string;
  url?: string;
  compact?: boolean;
}) {
  const kind = detectPlatform(source, url);
  const label = platformLabels[kind];
  return (
    <span
      className={`source-badge ${kind} ${compact ? 'compact' : ''}`}
      title={kind === 'local' ? 'Arquivo local' : label}
    >
      <PlatformIcon source={source} url={url} />
      {!compact && label}
    </span>
  );
}

export { IconButton as GlassIconButton };
