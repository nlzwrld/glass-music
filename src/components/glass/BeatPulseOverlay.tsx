import { useEffect, useRef } from 'react';
import { getAudioReactiveFrame, type AudioReactiveFrame } from '../../lib/audioGraph';
import { useReducedUI } from '../../lib/motion';
import { useApp } from '../../stores/app';

export interface BeatDetectorState {
  baseline: number;
  peakEnvelope: number;
  bass: number;
  impulse: number;
  flash: number;
  glow: number;
  phase: number;
  cooldownMs: number;
  onsetTrigger: number;
}

export function createBeatDetectorState(): BeatDetectorState {
  return {
    baseline: 0.08,
    peakEnvelope: 0.45,
    bass: 0,
    impulse: 0,
    flash: 0,
    glow: 0,
    phase: 0,
    cooldownMs: 0,
    onsetTrigger: 0,
  };
}

/**
 * Musical dual-band bass-onset & sub-bass envelope detector (pure & unit-testable).
 * - Smooth fast attack (~16ms) and velvety exponential release (~240ms) eliminate robotic stiffness.
 * - Adaptive auto-gain (`peakEnvelope`) ensures kicks hit clearly across both dynamic and loud tracks.
 * - Sustained sub-bass energy buoys continuous motion and atmospheric glow between kick hits.
 */
export function stepBeatDetector(
  state: BeatDetectorState,
  sample: Pick<AudioReactiveFrame, 'bass' | 'mid' | 'energy'> & { subBass?: number },
  dtMs: number,
): BeatDetectorState {
  const dt = Math.max(1, Math.min(100, Number.isFinite(dtMs) ? dtMs : 16.6));
  const rawBass = Math.max(0, Math.min(1, sample.bass || 0));
  const rawSub = Math.max(0, Math.min(1, sample.subBass ?? rawBass));
  const energy = Math.max(0, Math.min(1, sample.energy || 0));

  // Auto-gain peak tracker so quiet intros & heavy drops both feel alive
  const peakTau = rawBass > state.peakEnvelope ? 90 : 2400;
  const nextPeak = Math.max(
    0.38,
    state.peakEnvelope + (rawBass - state.peakEnvelope) * (1 - Math.exp(-dt / peakTau)),
  );
  const normBass = Math.min(1, rawBass / Math.max(0.38, nextPeak));
  const normSub = Math.min(1, rawSub / Math.max(0.38, nextPeak));

  // Smooth rolling bass baseline for transient onset (flux) detection
  const baseTau = rawBass > state.baseline ? 240 : 480;
  const nextBaseline = Math.max(
    0.04,
    state.baseline + (rawBass - state.baseline) * (1 - Math.exp(-dt / baseTau)),
  );

  // Continuous sub-bass rumble envelope (fast smooth rise, warm decay)
  const bassTarget = rawSub > 0.08 ? normSub : 0;
  const bassTau = bassTarget > state.bass ? 28 : 190;
  let nextBass = state.bass + (bassTarget - state.bass) * (1 - Math.exp(-dt / bassTau));
  if (nextBass < 0.004) nextBass = 0;

  // Exponential decay for previous kick impulse
  let nextImpulse = state.impulse * Math.exp(-dt / 220);
  let cooldownOut = Math.max(0, state.cooldownMs - dt);
  let onsetTrigger = 0;

  const flux = rawBass - state.baseline * 1.15 - 0.03;
  if (rawBass > 0.12 && flux > 0.032 && cooldownOut <= 0) {
    const hit = Math.min(1, 0.42 + flux * 1.65 + normBass * 0.32);
    if (hit > nextImpulse) {
      nextImpulse = hit;
    }
    onsetTrigger = hit;
    cooldownOut = 85;
  } else if (rawBass > 0.58 && normBass > 0.8 && cooldownOut <= 0) {
    const hit = Math.min(1, normBass * 0.9);
    if (hit > nextImpulse) {
      nextImpulse = hit;
    }
    onsetTrigger = hit * 0.85;
    cooldownOut = 105;
  }

  if (nextImpulse < 0.004) nextImpulse = 0;

  // Smooth visual flash: fast liquid attack toward impulse, velvet release, buoyed by deep sub-bass
  const sustainFloor = nextBass > 0.18 ? (nextBass - 0.18) * 0.48 : 0;
  const flashTarget = Math.max(nextImpulse, sustainFloor);
  const flashTau = flashTarget > state.flash ? 16 : 240;
  let nextFlash = state.flash + (flashTarget - state.flash) * (1 - Math.exp(-dt / flashTau));
  if (nextFlash < 0.004) nextFlash = 0;

  // Deep atmospheric glow tracking sustained bass + energy
  const targetGlow = Math.min(1, nextBass * 0.56 + energy * 0.24 + nextFlash * 0.34);
  const glowTau = targetGlow > state.glow ? 55 : 280;
  let nextGlow = state.glow + (targetGlow - state.glow) * (1 - Math.exp(-dt / glowTau));
  if (nextGlow < 0.004) nextGlow = 0;

  // Continuous fluid motion phase that glides steadily and accelerates on kicks & basslines
  const angularVelocity = 0.36 + nextBass * 1.25 + nextFlash * 1.85;
  const nextPhase = (state.phase + (dt / 1000) * angularVelocity) % (Math.PI * 200);

  return {
    baseline: nextBaseline,
    peakEnvelope: nextPeak,
    bass: nextBass,
    impulse: nextImpulse,
    flash: nextFlash,
    glow: nextGlow,
    phase: nextPhase,
    cooldownMs: cooldownOut,
    onsetTrigger,
  };
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface PulsePalette {
  core: RGB;
  bright: RGB;
  warmShift: RGB;
  coolShift: RGB;
}

interface RippleSlot {
  active: boolean;
  x: number;
  y: number;
  ageMs: number;
  maxMs: number;
  strength: number;
}

function parseColor(raw: string): RGB {
  const s = raw.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0]! + hex[0]!, 16) || 82,
        g: parseInt(hex[1]! + hex[1]!, 16) || 183,
        b: parseInt(hex[2]! + hex[2]!, 16) || 154,
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) || 82,
        g: parseInt(hex.slice(2, 4), 16) || 183,
        b: parseInt(hex.slice(4, 6), 16) || 154,
      };
    }
  }
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
    };
  }
  return { r: 82, g: 183, b: 154 };
}

function rgbToHsl({ r, g, b }: RGB): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(hDeg: number, s: number, l: number): RGB {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return { r: v, g: v, b: v };
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const hue2rgb = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

function buildPulsePalette(accent: RGB): PulsePalette {
  const [h, s, l] = rgbToHsl(accent);
  const richSat = Math.max(0.45, Math.min(0.95, s * 1.12));
  return {
    core: hslToRgb(h, richSat, Math.max(0.44, Math.min(0.62, l))),
    bright: hslToRgb(h + 6, Math.min(1, richSat * 1.08), Math.min(0.76, l + 0.16)),
    warmShift: hslToRgb(h + 20, Math.max(0.4, richSat * 0.94), Math.max(0.38, Math.min(0.56, l))),
    coolShift: hslToRgb(h - 20, Math.max(0.4, richSat * 0.92), Math.max(0.36, Math.min(0.54, l - 0.04))),
  };
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function readAccentPalette(preferredAccent?: string): PulsePalette {
  const inlineAccent = document.documentElement.style.getPropertyValue('--user-accent').trim();
  const raw =
    inlineAccent ||
    (preferredAccent && preferredAccent.trim()) ||
    getComputedStyle(document.documentElement).getPropertyValue('--user-accent').trim() ||
    '#52b79a';
  return buildPulsePalette(parseColor(raw));
}

function drawFluidBeatFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  palette: PulsePalette,
  phase: number,
  bass: number,
  flash: number,
  glow: number,
  ripples: RippleSlot[],
  isLight: boolean,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';

  const dim = Math.max(w, h);
  const alphaScale = isLight ? 0.42 : 1.0;

  // 4 organic orbiting orbs moving across the entire viewport (never static in corners)
  const orbs: Array<{
    x: number;
    y: number;
    radius: number;
    color: RGB;
    alpha: number;
  }> = [
    {
      // Primary deep sub-bass orb sweeping wide across the screen
      x: w * (0.5 + 0.34 * Math.sin(phase * 0.58 + 0.3)),
      y: h * (0.48 + 0.32 * Math.cos(phase * 0.43 + 0.1)),
      radius: dim * (0.38 + bass * 0.14 + flash * 0.11),
      color: palette.core,
      alpha: (0.16 + glow * 0.22 + bass * 0.16 + flash * 0.18) * alphaScale,
    },
    {
      // Counter-orbiting harmonic companion
      x: w * (0.5 + 0.37 * Math.cos(phase * 0.49 + 2.1)),
      y: h * (0.52 + 0.3 * Math.sin(phase * 0.64 + 1.0)),
      radius: dim * (0.34 + bass * 0.12 + flash * 0.1),
      color: palette.coolShift,
      alpha: (0.14 + glow * 0.2 + bass * 0.14 + flash * 0.16) * alphaScale,
    },
    {
      // Expressive kick-punch orb weaving in a dynamic figure-8 across the canvas
      x: w * (0.5 + 0.39 * Math.sin(phase * 0.84 + 3.4)),
      y: h * (0.5 + 0.28 * Math.sin(phase * 1.12 + 0.6)),
      radius: dim * (0.26 + bass * 0.1 + flash * 0.16),
      color: palette.bright,
      alpha: (0.1 + glow * 0.14 + flash * 0.34) * alphaScale,
    },
    {
      // Warm atmospheric undertow gliding across opposite quadrants
      x: w * (0.5 + 0.31 * Math.cos(phase * 0.36 + 4.5)),
      y: h * (0.54 + 0.31 * Math.cos(phase * 0.55 + 2.4)),
      radius: dim * (0.36 + bass * 0.13 + glow * 0.08),
      color: palette.warmShift,
      alpha: (0.12 + glow * 0.18 + bass * 0.16 + flash * 0.12) * alphaScale,
    },
  ];

  for (let i = 0; i < orbs.length; i++) {
    const o = orbs[i]!;
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.radius);
    grad.addColorStop(0, rgba(o.color, o.alpha));
    grad.addColorStop(0.45, rgba(o.color, o.alpha * 0.42));
    grad.addColorStop(1, rgba(o.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sweeping diagonal aurora bass ribbon that drifts and breathes with sub-bass
  ctx.save();
  const ribbonX = w * (0.5 + 0.22 * Math.sin(phase * 0.31));
  const ribbonY = h * (0.5 + 0.18 * Math.cos(phase * 0.27));
  ctx.translate(ribbonX, ribbonY);
  ctx.rotate(phase * 0.16 + bass * 0.18);
  ctx.scale(1.65, 0.42 + bass * 0.14 + flash * 0.12);
  const ribRadius = dim * (0.34 + glow * 0.12);
  const ribGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, ribRadius);
  const ribAlpha = (0.09 + bass * 0.16 + flash * 0.16) * alphaScale;
  ribGrad.addColorStop(0, rgba(palette.bright, ribAlpha));
  ribGrad.addColorStop(0.55, rgba(palette.core, ribAlpha * 0.36));
  ribGrad.addColorStop(1, rgba(palette.core, 0));
  ctx.fillStyle = ribGrad;
  ctx.beginPath();
  ctx.arc(0, 0, ribRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Soft expanding radial bass ripples spawned on genuine kick onsets
  for (let i = 0; i < ripples.length; i++) {
    const r = ripples[i]!;
    if (!r.active) continue;
    const t = Math.min(1, r.ageMs / r.maxMs);
    const eased = 1 - Math.pow(1 - t, 2.6);
    const outerR = dim * (0.08 + eased * 0.56);
    const bandWidth = Math.max(18, dim * (0.14 * (1 - t * 0.4)));
    const innerR = Math.max(0, outerR - bandWidth);
    const fade = Math.sin(Math.min(1, t * 4) * (Math.PI / 2)) * Math.pow(1 - t, 1.85);
    const alpha = r.strength * fade * 0.28 * alphaScale;
    if (alpha <= 0.003) continue;

    const ringGrad = ctx.createRadialGradient(r.x * w, r.y * h, innerR, r.x * w, r.y * h, outerR);
    ringGrad.addColorStop(0, rgba(palette.bright, 0));
    ringGrad.addColorStop(0.55, rgba(palette.bright, alpha));
    ringGrad.addColorStop(1, rgba(palette.core, 0));
    ctx.fillStyle = ringGrad;
    ctx.beginPath();
    ctx.arc(r.x * w, r.y * h, outerR, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function BeatPulseOverlay() {
  const uiStyle = useApp(s => s.data.preferences.uiStyle ?? 'matte');
  const playing = useApp(s => s.playing);
  const accentColor = useApp(s => s.data.preferences.accent ?? '');
  const theme = useApp(s => s.data.preferences.theme ?? 'dark');
  const reduced = useReducedUI();
  const active = uiStyle === 'beat';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    const root = document.documentElement;
    if (!active) {
      root.style.removeProperty('--beat-flash');
      root.style.removeProperty('--beat-glow');
      root.style.removeProperty('--beat-bass');
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    let lastAccentRaw =
      document.documentElement.style.getPropertyValue('--user-accent').trim() || accentColor || '';
    let palette = readAccentPalette(accentColor);
    let isLight = root.dataset.theme === 'light';

    const syncSize = () => {
      if (!canvas) return { w: 320, h: 200 };
      const rect = canvas.getBoundingClientRect();
      // Compact internal buffer scaled smoothly by GPU -> silky soft gradients at <1% CPU
      const targetW = Math.max(160, Math.min(640, Math.round((rect.width || window.innerWidth) * 0.45)));
      const targetH = Math.max(120, Math.min(420, Math.round((rect.height || window.innerHeight) * 0.45)));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return { w: targetW, h: targetH };
    };

    syncSize();
    const onResize = () => {
      const { w, h } = syncSize();
      if (reduced && ctx) {
        drawFluidBeatFrame(
          ctx,
          w,
          h,
          palette,
          1.2,
          playingRef.current ? 0.24 : 0.1,
          0,
          playingRef.current ? 0.28 : 0.12,
          [],
          isLight,
        );
      }
    };
    window.addEventListener('resize', onResize, { passive: true });

    if (reduced) {
      root.style.setProperty('--beat-flash', '0');
      root.style.setProperty('--beat-bass', playing ? '0.22' : '0.08');
      root.style.setProperty('--beat-glow', playing ? '0.28' : '0.12');
      onResize();
      return () => {
        window.removeEventListener('resize', onResize);
      };
    }

    let rafId = 0;
    let windowVisible = true;
    let lastTs = performance.now();
    let detector = createBeatDetectorState();
    let nextRipple = 0;
    const ripples: RippleSlot[] = Array.from({ length: 4 }, () => ({
      active: false,
      x: 0.5,
      y: 0.5,
      ageMs: 0,
      maxMs: 680,
      strength: 0,
    }));

    const scheduleTick = () => {
      if (!rafId && !document.hidden && windowVisible) {
        lastTs = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    };

    const syncVisibility = () => {
      if (document.hidden || !windowVisible) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        scheduleTick();
      }
    };

    const offVisualVisibility = window.glass?.onVisualVisibility?.(visible => {
      windowVisible = visible;
      syncVisibility();
    });
    document.addEventListener('visibilitychange', syncVisibility);

    const tick = (now: number) => {
      rafId = 0;
      if (document.hidden || !windowVisible) return;
      const dt = Math.max(1, Math.min(64, now - lastTs));
      lastTs = now;

      if (playingRef.current) {
        const frame = getAudioReactiveFrame();
        detector = stepBeatDetector(detector, frame, dt);
      } else {
        // Gentle calm ambient drift when paused so the backdrop stays alive and smooth
        detector = {
          ...detector,
          bass: detector.bass * Math.exp(-dt / 320),
          impulse: detector.impulse * Math.exp(-dt / 260),
          flash: detector.flash * Math.exp(-dt / 280),
          glow: detector.glow + (0.14 - detector.glow) * (1 - Math.exp(-dt / 420)),
          phase: (detector.phase + (dt / 1000) * 0.18) % (Math.PI * 200),
          cooldownMs: Math.max(0, detector.cooldownMs - dt),
          onsetTrigger: 0,
        };
      }

      // Spawn expanding radial bass ripple at the active moving kick-orb position
      if (detector.onsetTrigger > 0.24) {
        const slot = ripples[nextRipple % ripples.length]!;
        nextRipple++;
        slot.active = true;
        slot.x = 0.5 + 0.36 * Math.sin(detector.phase * 0.84 + 3.4);
        slot.y = 0.5 + 0.26 * Math.sin(detector.phase * 1.12 + 0.6);
        slot.ageMs = 0;
        slot.maxMs = 620 + (1 - detector.onsetTrigger) * 180;
        slot.strength = detector.onsetTrigger;
      }

      for (let i = 0; i < ripples.length; i++) {
        const r = ripples[i]!;
        if (!r.active) continue;
        r.ageMs += dt;
        if (r.ageMs >= r.maxMs) r.active = false;
      }

      root.style.setProperty('--beat-flash', detector.flash.toFixed(3));
      root.style.setProperty('--beat-glow', detector.glow.toFixed(3));
      root.style.setProperty('--beat-bass', detector.bass.toFixed(3));

      if (ctx && canvas) {
        // Zero-reflow live accent sync (picks up both user color choice and autoAccent changes immediately)
        const liveAccent = root.style.getPropertyValue('--user-accent').trim() || accentColor || '';
        if (liveAccent && liveAccent !== lastAccentRaw) {
          lastAccentRaw = liveAccent;
          palette = readAccentPalette(liveAccent);
        }
        isLight = root.dataset.theme === 'light';
        drawFluidBeatFrame(
          ctx,
          canvas.width,
          canvas.height,
          palette,
          detector.phase,
          detector.bass,
          detector.flash,
          detector.glow,
          ripples,
          isLight,
        );
      }

      scheduleTick();
    };

    palette = readAccentPalette(accentColor);
    scheduleTick();
    return () => {
      cancelAnimationFrame(rafId);
      offVisualVisibility?.();
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('resize', onResize);
      root.style.setProperty('--beat-flash', '0');
      root.style.setProperty('--beat-glow', '0.10');
      root.style.setProperty('--beat-bass', '0');
    };
  }, [active, accentColor, theme, reduced]);

  if (!active) return null;

  return (
    <div className="beat-pulse-layer" aria-hidden="true">
      <canvas ref={canvasRef} className="beat-pulse-canvas" />
    </div>
  );
}
