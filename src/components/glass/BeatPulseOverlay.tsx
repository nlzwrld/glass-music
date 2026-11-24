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
 * Strict bass-only onset & sub-bass envelope detector (pure & unit-testable).
 * - Triggers exclusively on genuine sub-bass / kick transients (~26–112 Hz).
 * - Ignores midrange/vocal energy so singing, guitars, snares and hi-hats never false-pulse.
 * - Fast attack (~14ms) and clean release (~185ms) return calmly to rest between kicks.
 */
export function stepBeatDetector(
  state: BeatDetectorState,
  sample: Pick<AudioReactiveFrame, 'bass' | 'mid' | 'energy'> & { subBass?: number },
  dtMs: number,
): BeatDetectorState {
  const dt = Math.max(1, Math.min(100, Number.isFinite(dtMs) ? dtMs : 16.6));
  const rawBass = Math.max(0, Math.min(1, sample.bass || 0));
  const rawSub = Math.max(0, Math.min(1, sample.subBass ?? rawBass));
  const lowDrive = rawSub * 0.62 + rawBass * 0.38;

  // Bounded peak tracker (never over-amplifies quiet midrange leakage)
  const peakTau = lowDrive > state.peakEnvelope ? 80 : 2200;
  const nextPeak = Math.max(
    0.58,
    state.peakEnvelope + (lowDrive - state.peakEnvelope) * (1 - Math.exp(-dt / peakTau)),
  );
  const normBass = Math.min(1, rawBass / nextPeak);
  const normSub = Math.min(1, rawSub / nextPeak);

  // Rolling low-end baseline for transient kick flux detection
  const baseTau = lowDrive > state.baseline ? 210 : 420;
  const nextBaseline = Math.max(
    0.06,
    state.baseline + (lowDrive - state.baseline) * (1 - Math.exp(-dt / baseTau)),
  );

  // Sub-bass envelope (active only above strict 0.22 threshold)
  const bassTarget = rawSub > 0.22 ? normSub : 0;
  const bassTau = bassTarget > state.bass ? 24 : 165;
  let nextBass = state.bass + (bassTarget - state.bass) * (1 - Math.exp(-dt / bassTau));
  if (nextBass < 0.004) nextBass = 0;

  // Crisp decay for kick impulse
  let nextImpulse = state.impulse * Math.exp(-dt / 170);
  let cooldownOut = Math.max(0, state.cooldownMs - dt);
  let onsetTrigger = 0;

  const flux = lowDrive - state.baseline * 1.18 - 0.06;
  if (rawBass > 0.28 && flux > 0.065 && cooldownOut <= 0) {
    const hit = Math.min(1, 0.46 + flux * 1.35 + normBass * 0.28);
    if (hit > nextImpulse) {
      nextImpulse = hit;
    }
    onsetTrigger = hit;
    cooldownOut = 125;
  } else if (rawSub > 0.72 && state.bass < 0.42 && cooldownOut <= 0) {
    const hit = Math.min(1, normSub * 0.88);
    if (hit > nextImpulse) {
      nextImpulse = hit;
    }
    onsetTrigger = hit * 0.82;
    cooldownOut = 140;
  }

  if (nextImpulse < 0.004) nextImpulse = 0;

  // Punchy attack (~14ms) and clean decay (~185ms) driven strictly by bass kicks
  const sustainFloor = nextBass > 0.42 ? (nextBass - 0.42) * 0.34 : 0;
  const flashTarget = Math.max(nextImpulse, sustainFloor);
  const flashTau = flashTarget > state.flash ? 14 : 185;
  let nextFlash = state.flash + (flashTarget - state.flash) * (1 - Math.exp(-dt / flashTau));
  if (nextFlash < 0.004) nextFlash = 0;

  // Atmospheric glow tracks ONLY bass & kick flash (never midrange energy)
  const targetGlow = Math.min(1, nextBass * 0.52 + nextFlash * 0.48);
  const glowTau = targetGlow > state.glow ? 42 : 210;
  let nextGlow = state.glow + (targetGlow - state.glow) * (1 - Math.exp(-dt / glowTau));
  if (nextGlow < 0.004) nextGlow = 0;

  // Calm phase when no bass is present; accelerates smoothly on real bass hits
  const angularVelocity = 0.06 + nextBass * 1.05 + nextFlash * 1.75;
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
  const activity = Math.min(1, bass * 0.65 + flash * 0.95 + glow * 0.4);
  if (activity <= 0.006 && !ripples.some(r => r.active)) {
    return;
  }

  // Orbs stay subtle at rest and bloom crisply ONLY on genuine bass/kick energy
  const orbs: Array<{
    x: number;
    y: number;
    radius: number;
    color: RGB;
    alpha: number;
  }> = [
    {
      x: w * (0.5 + 0.34 * Math.sin(phase * 0.58 + 0.3)),
      y: h * (0.48 + 0.32 * Math.cos(phase * 0.43 + 0.1)),
      radius: dim * (0.34 + bass * 0.16 + flash * 0.14),
      color: palette.core,
      alpha: (0.02 + glow * 0.16 + bass * 0.2 + flash * 0.24) * alphaScale,
    },
    {
      x: w * (0.5 + 0.37 * Math.cos(phase * 0.49 + 2.1)),
      y: h * (0.52 + 0.3 * Math.sin(phase * 0.64 + 1.0)),
      radius: dim * (0.31 + bass * 0.13 + flash * 0.12),
      color: palette.coolShift,
      alpha: (0.015 + glow * 0.14 + bass * 0.16 + flash * 0.2) * alphaScale,
    },
    {
      x: w * (0.5 + 0.39 * Math.sin(phase * 0.84 + 3.4)),
      y: h * (0.5 + 0.28 * Math.sin(phase * 1.12 + 0.6)),
      radius: dim * (0.24 + bass * 0.12 + flash * 0.2),
      color: palette.bright,
      alpha: (bass * 0.1 + flash * 0.38) * alphaScale,
    },
  ];

  for (let i = 0; i < orbs.length; i++) {
    const o = orbs[i]!;
    if (o.alpha <= 0.004) continue;
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.radius);
    grad.addColorStop(0, rgba(o.color, o.alpha));
    grad.addColorStop(0.45, rgba(o.color, o.alpha * 0.4));
    grad.addColorStop(1, rgba(o.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fill();
  }

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
  const beatPulse = useApp(s => s.data.preferences.beatPulse);
  const performanceMode = useApp(s => s.data.preferences.performance);
  const playing = useApp(s => s.playing);
  const accentColor = useApp(s => s.data.preferences.accent ?? '');
  const theme = useApp(s => s.data.preferences.theme ?? 'dark');
  const reduced = useReducedUI();
  const active = Boolean((beatPulse ?? uiStyle === 'beat') && !performanceMode && !reduced);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(playing);
  const wakeRef = useRef<(() => void) | null>(null);
  playingRef.current = playing;

  useEffect(() => {
    if (playing) wakeRef.current?.();
  }, [playing]);

  useEffect(() => {
    const root = document.documentElement;
    if (!active) {
      wakeRef.current = null;
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    let lastAccentRaw = root.style.getPropertyValue('--user-accent').trim() || accentColor || '';
    let palette = readAccentPalette(accentColor);
    let isLight = root.dataset.theme === 'light';

    const syncSize = () => {
      if (!canvas) return { w: 320, h: 200 };
      const rect = canvas.getBoundingClientRect();
      // Compact internal buffer scaled smoothly by GPU -> zero main-thread lag
      const targetW = Math.max(160, Math.min(480, Math.round((rect.width || window.innerWidth) * 0.36)));
      const targetH = Math.max(120, Math.min(320, Math.round((rect.height || window.innerHeight) * 0.36)));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return { w: targetW, h: targetH };
    };

    syncSize();
    const onResize = () => {
      syncSize();
    };
    window.addEventListener('resize', onResize, { passive: true });

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
    wakeRef.current = scheduleTick;

    const syncVisibility = () => {
      if (document.hidden || !windowVisible) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (playingRef.current) {
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
        detector = {
          ...detector,
          bass: detector.bass * Math.exp(-dt / 180),
          impulse: detector.impulse * Math.exp(-dt / 150),
          flash: detector.flash * Math.exp(-dt / 160),
          glow: detector.glow * Math.exp(-dt / 190),
          cooldownMs: Math.max(0, detector.cooldownMs - dt),
          onsetTrigger: 0,
        };
      }

      if (detector.onsetTrigger > 0.34) {
        const slot = ripples[nextRipple % ripples.length]!;
        nextRipple++;
        slot.active = true;
        slot.x = 0.5 + 0.34 * Math.sin(detector.phase * 0.84 + 3.4);
        slot.y = 0.5 + 0.24 * Math.sin(detector.phase * 1.12 + 0.6);
        slot.ageMs = 0;
        slot.maxMs = 560 + (1 - detector.onsetTrigger) * 160;
        slot.strength = detector.onsetTrigger;
      }

      let hasActiveRipple = false;
      for (let i = 0; i < ripples.length; i++) {
        const r = ripples[i]!;
        if (!r.active) continue;
        r.ageMs += dt;
        if (r.ageMs >= r.maxMs) r.active = false;
        else hasActiveRipple = true;
      }

      if (ctx && canvas) {
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

      // Sleep rAF completely when paused and settled -> 0% idle CPU/GPU
      const settled =
        !playingRef.current &&
        !hasActiveRipple &&
        detector.bass < 0.004 &&
        detector.flash < 0.004 &&
        detector.glow < 0.004;
      if (!settled) {
        scheduleTick();
      }
    };

    palette = readAccentPalette(accentColor);
    if (playingRef.current) {
      scheduleTick();
    } else if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return () => {
      wakeRef.current = null;
      cancelAnimationFrame(rafId);
      offVisualVisibility?.();
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('resize', onResize);
    };
  }, [active, accentColor, theme]);

  if (!active) return null;

  return (
    <div className="beat-pulse-layer" aria-hidden="true">
      <canvas ref={canvasRef} className="beat-pulse-canvas" />
    </div>
  );
}
