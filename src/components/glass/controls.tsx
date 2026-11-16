import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { AudioLines, Link2 } from 'lucide-react';
export function IconButton({ label, children, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean }) {
  return <Button {...props} variant="ghost" size="icon" data-glass="thin" type="button" title={label} aria-label={label} className={`icon-button ${active ? 'active' : ''} ${props.className || ''}`}>{children}</Button>;
}
export function Toggle({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; description?: string }) {
  return <label className="setting-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span><Switch aria-label={label} checked={checked} onCheckedChange={onChange} className={`toggle ${checked ? 'on' : ''}`} /></label>;
}
export function PlatformIcon({ source }: { source: string }) {
  if (source === 'youtube') return <svg className="platform-icon youtube-icon" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="5" fill="#ff1717" /><path d="m11 5 8 5-8 5z" fill="white" /></svg>;
  if (source === 'soundcloud') return <svg className="platform-icon soundcloud-icon" viewBox="0 0 36 20" aria-hidden="true"><path d="M16 17V7a7 7 0 0 1 13-2 6 6 0 1 1 1 12Z" fill="#ff761e" /><path d="M2 10v5m3-7v8m3-10v11m3-12v12m3-10v10" stroke="#ff761e" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  if (source === 'link') return <Link2 className="platform-icon" size={17}/>;
  return <AudioLines className="platform-icon local-icon" size={19} />;
}
export function SourceBadge({ source, compact = false }: { source: string; compact?: boolean }) { return <span className={`source-badge ${source} ${compact ? 'compact' : ''}`} title={source === 'local' ? 'Arquivo local' : source === 'youtube' ? 'YouTube' : source === 'link' ? 'Link' : 'SoundCloud'}><PlatformIcon source={source} />{!compact && (source === 'local' ? 'Local' : source === 'youtube' ? 'YouTube' : source === 'link' ? 'Link' : 'SoundCloud')}</span>; }
export { IconButton as GlassIconButton };
