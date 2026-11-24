import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { MoreHorizontal } from 'lucide-react';
import { useApp } from '../../stores/app';
import { Button } from '../ui/button';
import { menuMotion, useReducedUI } from '../../lib/motion';
import type { GlassVariant } from './GlassOptics';
import SVGPlane from './v3/SVGPlane';
import { useOptics } from './v3/OpticalEngine';
import { crystals, materialPresets, type MaterialName, type GlassMethod } from './v3/model';


export interface GlassMaterialProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'aside' | 'section' | 'footer' | 'label' | 'article';
  variant?: GlassVariant;
  material?:MaterialName; ior?:number; fresnel?:number; thickness?:number; radius?:number; shadow?:string; cursorResponse?:number;
  opacity?: number;
  blur?: number;
  refraction?: number;
  specularIntensity?: number;
  borderIllumination?: number;
  saturation?: number;
  depth?: number;
  tint?: string;
  /** Advanced refraction is reserved for persistent surfaces, not every list item. */
  refractive?: boolean;
  method?: GlassMethod;
  style?: CSSProperties & Partial<Record<`--glass-${'opacity' | 'blur' | 'specular' | 'edge' | 'saturation' | 'depth' | 'tint' | 'light'}`, string | number>>;
}
export function GlassMaterial({ as: Tag = 'div', variant = 'regular', className = '', children, style, material, ior, fresnel, thickness, radius, shadow, cursorResponse, opacity, blur, refraction, specularIntensity, borderIllumination, saturation, depth, tint, refractive = true, method='auto', ...props }: GlassMaterialProps) {
  const {settings,lab}=useOptics();
  const materialStyle: GlassMaterialProps['style'] = { ...style };
  if (opacity !== undefined) materialStyle['--glass-opacity'] = Math.max(0, Math.min(1, opacity));
  if (blur !== undefined) materialStyle['--glass-blur'] = `${Math.max(0, blur)}px`;
  if (specularIntensity !== undefined) materialStyle['--glass-specular'] = Math.max(0, specularIntensity);
  if (borderIllumination !== undefined) materialStyle['--glass-edge'] = Math.max(0, borderIllumination);
  if (saturation !== undefined) materialStyle['--glass-saturation'] = `${Math.max(0, saturation)}%`;
  if (depth !== undefined) materialStyle['--glass-depth'] = Math.max(0, Math.min(1, depth));
  if (tint) materialStyle['--glass-tint'] = tint;
  const name=lab?(material||(variant==='thick'?'floating':variant==='thin'?'clear':'frosted')):settings.material;
  const preset=materialPresets[name],crystal=preset.crystal;
  materialStyle.borderRadius=radius??undefined;materialStyle.boxShadow=shadow;
  Object.assign(materialStyle,{'--material-radius':`${preset.radius}px`,'--material-shadow':preset.shadow});
  materialStyle['--glass-blur']=`${blur??settings.blur*crystals[crystal].blur}px`;
  materialStyle['--glass-opacity']=opacity??(lab?settings.opacity*crystals[crystal].opacity:'var(--appearance-opacity)');
  materialStyle['--glass-tint']=tint??(lab?settings.tint:'var(--appearance-tint)');
  materialStyle['--glass-specular']=specularIntensity??settings.specular;
  materialStyle['--glass-saturation']=`${saturation??settings.saturation*100}%`;
  const selectedMethod=refractive?method:'css';
  return <Tag {...props} style={materialStyle} data-material={name} data-optical-ior={ior} data-optical-fresnel={fresnel} data-optical-thickness={thickness} data-optical-edge={borderIllumination} data-optical-cursor={cursorResponse} data-glass={variant} data-crystal={crystal} data-optic={selectedMethod} data-optical-blur={blur} data-optical-refraction={refraction} data-optical-specular={specularIntensity} data-optical-saturation={saturation} data-optical-opacity={opacity} data-optical-tint={tint} className={`glass-material ${className}`}>{selectedMethod==='svg'&&<SVGPlane variant={crystal}/ >}{children}</Tag>;
}

export function GlassWindow({ children, className = '' }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`app glass-window ${className}`}>{children}</div>;
}
export function GlassSidebar({ className = '', ...props }: HTMLAttributes<HTMLElement>) { return <GlassMaterial as="aside" variant="regular" {...props} className={`sidebar ${className}`} />; }
export function GlassPanel({ className = '', ...props }: HTMLAttributes<HTMLElement>) { return <GlassMaterial as="section" variant="thick" {...props} className={`glass-panel ${className}`} />; }
export function GlassCard({ className = '', ...props }: HTMLAttributes<HTMLElement>) { return <article {...props} className={`music-card ${className}`} />; }
export function GlassButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <Button {...props} data-glass="thin" className={`glass-button ${className}`} />; }
export function GlassSlider({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} type="range" className={`glass-slider ${className}`} />; }

// Small optical surfaces avoid applying SVG displacement to whole scrolling panels.
export function LiquidLens({ radius = 99 }: { radius?: number }) { return <span className="lens-fallback" style={{borderRadius:radius}} aria-hidden="true" />; }

const contextScopeHandlers = new WeakMap<
  HTMLElement,
  {
    isDisabled: () => boolean;
    openAt: (point: { x: number; y: number } | null) => void;
  }
>();
let contextDelegationBound = false;

function ensureContextDelegation() {
  if (contextDelegationBound || typeof document === 'undefined') return;
  contextDelegationBound = true;
  document.addEventListener('contextmenu', e => {
    const target = e.target as Element | null;
    const scope = target?.closest<HTMLElement>('[data-track-item],.playlist-row');
    if (!scope) return;
    const entry = contextScopeHandlers.get(scope);
    if (!entry || entry.isDisabled()) return;
    e.preventDefault();
    e.stopPropagation();
    entry.openAt({ x: e.clientX, y: e.clientY });
  });
  document.addEventListener('keydown', e => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    const target = e.target as Element | null;
    const scope = target?.closest<HTMLElement>('[data-track-item],.playlist-row');
    if (!scope) return;
    const entry = contextScopeHandlers.get(scope);
    if (!entry || entry.isDisabled()) return;
    e.preventDefault();
    e.stopPropagation();
    entry.openAt(null);
  });
}

export interface GlassMenuItem {
  label: string;
  icon?: ReactNode;
  action(): void;
  disabled?: boolean;
  danger?: boolean;
}
export function GlassContextMenu({
  label,
  items,
  getItems,
  disabled = false,
  icon,
  className = '',
  align = 'end',
}: {
  label: string;
  items?: GlassMenuItem[];
  getItems?: () => GlassMenuItem[];
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}) {
  const { reduced: opticsReduced } = useOptics();
  const uiReduced = useReducedUI();
  const reduced = opticsReduced || uiReduced;
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [portalMounted, setPortalMounted] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const id = useId();

  const openMenu = (nextPoint: { x: number; y: number } | null) => {
    setPoint(nextPoint);
    setPortalMounted(true);
    setOpen(true);
  };

  useEffect(() => {
    ensureContextDelegation();
    const scope = trigger.current?.closest<HTMLElement>('[data-track-item],.playlist-row');
    if (!scope) return;
    contextScopeHandlers.set(scope, {
      isDisabled: () => disabledRef.current,
      openAt: openMenu,
    });
    return () => {
      contextScopeHandlers.delete(scope);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect(),
      box = menu.current.getBoundingClientRect();
    const anchorX = align === 'start' ? r.left : r.right - box.width;
    setPosition(
      point
        ? {
            left: Math.max(12, Math.min(innerWidth - box.width - 12, point.x)),
            top: Math.max(12, Math.min(innerHeight - box.height - 12, point.y)),
          }
        : {
            left: Math.max(12, Math.min(innerWidth - box.width - 12, anchorX)),
            top:
              r.bottom + box.height + 10 < innerHeight
                ? r.bottom + 6
                : Math.max(12, r.top - box.height - 6),
          },
    );
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, point, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    const scroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', resize);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', resize);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const resolvedItems = open ? (getItems ? getItems() : items || []) : [];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`icon-button menu-trigger ${className}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu(null);
          }
        }}
      >
        {icon ?? <MoreHorizontal size={16} />}
      </button>
      {(open || portalMounted) &&
        createPortal(
          <AnimatePresence onExitComplete={() => setPortalMounted(false)}>
            {open && (
              <motion.div
                ref={menu}
                id={id}
                role="menu"
                aria-label={label}
                className="glass-context-menu"
                style={position}
                {...menuMotion(reduced)}
                onKeyDown={e => {
                  const nodes = Array.from(
                    menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
                  );
                  const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
                  if (e.key === 'Escape' || e.key === 'Tab') {
                    e.stopPropagation();
                    setOpen(false);
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      trigger.current?.focus();
                    }
                  }
                  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && nodes.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    nodes[
                      e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? nodes.length - 1
                          : (index + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length
                    ]?.focus();
                  }
                }}
              >
                {resolvedItems.map(item => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={item.danger ? 'danger' : ''}
                    onClick={() => {
                      setOpen(false);
                      trigger.current?.focus();
                      item.action();
                    }}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          document.querySelector('.optical-root') || document.body,
        )}
    </>
  );
}
