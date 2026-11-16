import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../../stores/app';
import { displacementMap } from './refraction';

export type GlassVariant = 'thin' | 'regular' | 'thick';
const strength = { thin: 7, regular: 12, thick: 18 };
const bevels = { thin: 7, regular: 16, thick: 22 };
const svgBackdropSupported = () => typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url("#glass")') && /Chrome|Chromium|Edg\//.test(navigator.userAgent);

/** Only the backdrop is filtered. Foreground children are never an SVG input. */
export default function GlassOptics({ variant, refraction, blur }: { variant: GlassVariant; refraction?: number; blur?: number }) {
  const ref = useRef<HTMLSpanElement>(null), id = `glass-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const performanceMode = useApp(s => s.data.preferences.performance);
  const blurPreference = useApp(s => s.data.preferences.blur);
  const [map, setMap] = useState<{ url: string; width: number; height: number }>();
  const advanced = !performanceMode && svgBackdropSupported() && (refraction ?? strength[variant]) > 0;
  useEffect(() => {
    if (!advanced || !ref.current) { setMap(undefined); return; }
    const host = ref.current.parentElement!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const width = Math.round(host.clientWidth), height = Math.round(host.clientHeight);
      if (!width || !height) return;
      const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 24;
      setMap({ url: displacementMap(width, height, radius, bevels[variant]), width, height });
    };
    update();
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(update, 90); });
    observer.observe(host);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [advanced, variant]);
  return <span ref={ref} className="glass-optics" data-optics={advanced && map ? 'svg' : 'css'} aria-hidden="true" style={advanced && map ? { backdropFilter: `url("#${id}") saturate(var(--glass-saturation))` } : undefined}>
    {advanced && map && <svg className="glass-filter-defs" width={map.width} height={map.height} aria-hidden="true"><defs>
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map.url} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="normal-map" />
        <feDisplacementMap in="SourceGraphic" in2="normal-map" scale={refraction ?? strength[variant]} xChannelSelector="R" yChannelSelector="G" result="bent" />
        <feGaussianBlur in="SourceGraphic" stdDeviation={Math.max(0, blur ?? blurPreference * { thin: .12, regular: .34, thick: .48 }[variant])} result="frosted" />
        <feColorMatrix in="normal-map" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0" result="rim" />
        <feComposite in="bent" in2="rim" operator="in" result="edge" />
        <feComposite in="frosted" in2="rim" operator="out" result="center" />
        <feMerge><feMergeNode in="center" /><feMergeNode in="edge" /></feMerge>
      </filter>
    </defs></svg>}
  </span>;
}
