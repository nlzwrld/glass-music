import { useEffect, useRef } from 'react';
import type { AudioReactiveFrame } from '../../lib/audioGraph';
import {
  EMPTY_PULSE_FRAME,
  normalizePulsePreferences,
  subscribeMusicAnalysis,
  type MusicEvent,
  type PulseAnalysisFrame,
} from '../../lib/musicEvents';
import { ensurePulseEngineRegistered } from '../../lib/pulseEngine';
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
  trebleBaseline: number;
  treblePeak: number;
  treble: number;
  trebleImpulse: number;
  trebleFlash: number;
  trebleCooldownMs: number;
  trebleOnsetTrigger: number;
}

export function createBeatDetectorState(): BeatDetectorState {
  return {
    baseline: 0.08,
    peakEnvelope: 0.44,
    bass: 0,
    impulse: 0,
    flash: 0,
    glow: 0,
    phase: 0,
    cooldownMs: 0,
    onsetTrigger: 0,
    trebleBaseline: 0.08,
    treblePeak: 0.4,
    treble: 0,
    trebleImpulse: 0,
    trebleFlash: 0,
    trebleCooldownMs: 0,
    trebleOnsetTrigger: 0,
  };
}

/**
 * Dual-band bass (24–135 Hz) + treble/highs (3.5–16 kHz) onset & fluid motion detector.
 * - Triggers deep pulses on bass kicks / 808 sub-bass without being suppressed by dense mixes.
 * - Triggers crisp luminous pulses on sharp highs (hi-hats, cymbals, bright notes, claps).
 * - Ignores flat midrange/vocal energy while keeping smooth ambient motion flowing in the backdrop.
 */
export function stepBeatDetector(
  state: BeatDetectorState,
  sample: Pick<AudioReactiveFrame, 'bass' | 'mid' | 'energy'> & {
    subBass?: number;
    treble?: number;
  },
  dtMs: number,
): BeatDetectorState {
  const dt = Math.max(1, Math.min(100, Number.isFinite(dtMs) ? dtMs : 16.6));
  const rawBass = Math.max(0, Math.min(1, sample.bass || 0));
  const rawSub = Math.max(0, Math.min(1, sample.subBass ?? rawBass));
  const rawTreble = Math.max(0, Math.min(1, sample.treble ?? 0));
  const lowDrive = rawSub * 0.56 + rawBass * 0.44;

  // --- BAND 1: BASS / SUB-BASS (24–135 Hz) ---
  const peakTau = lowDrive > state.peakEnvelope ? 85 : 2200;
  const nextPeak = Math.max(
    0.42,
    state.peakEnvelope + (lowDrive - state.peakEnvelope) * (1 - Math.exp(-dt / peakTau)),
  );
  const normBass = Math.min(1, rawBass / nextPeak);
  const normSub = Math.min(1, rawSub / nextPeak);

  const baseTau = lowDrive > state.baseline ? 220 : 440;
  const nextBaseline = Math.max(
    0.04,
    state.baseline + (lowDrive - state.baseline) * (1 - Math.exp(-dt / baseTau)),
  );

  const bassTarget = rawSub > 0.14 ? normSub : 0;
  const bassTau = bassTarget > state.bass ? 24 : 185;
  let nextBass = state.bass + (bassTarget - state.bass) * (1 - Math.exp(-dt / bassTau));
  if (nextBass < 0.004) nextBass = 0;

  let nextImpulse = state.impulse * Math.exp(-dt / 210);
  let cooldownOut = Math.max(0, state.cooldownMs - dt);
  let onsetTrigger = 0;

  const bassFlux = lowDrive - state.baseline * 1.12 - 0.028;
  if (rawBass > 0.18 && bassFlux > 0.032 && cooldownOut <= 0) {
    const hit = Math.min(1, 0.48 + bassFlux * 1.65 + normBass * 0.34);
    if (hit > nextImpulse) nextImpulse = hit;
    onsetTrigger = hit;
    cooldownOut = 92;
  } else if (rawBass > 0.56 && normBass > 0.78 && cooldownOut <= 0) {
    const hit = Math.min(1, normBass * 0.92);
    if (hit > nextImpulse) nextImpulse = hit;
    onsetTrigger = hit * 0.85;
    cooldownOut = 108;
  }
  if (nextImpulse < 0.004) nextImpulse = 0;

  const sustainFloor = nextBass > 0.22 ? (nextBass - 0.22) * 0.45 : 0;
  const flashTarget = Math.max(nextImpulse, sustainFloor);
  const flashTau = flashTarget > state.flash ? 14 : 215;
  let nextFlash = state.flash + (flashTarget - state.flash) * (1 - Math.exp(-dt / flashTau));
  if (nextFlash < 0.004) nextFlash = 0;

  // --- BAND 2: TREBLE / HIGHS (3.5–16 kHz) ---
  const tPeakTau = rawTreble > state.treblePeak ? 75 : 2000;
  const nextTreblePeak = Math.max(
    0.38,
    state.treblePeak + (rawTreble - state.treblePeak) * (1 - Math.exp(-dt / tPeakTau)),
  );
  const normTreble = Math.min(1, rawTreble / nextTreblePeak);

  const tBaseTau = rawTreble > state.trebleBaseline ? 180 : 380;
  const nextTrebleBaseline = Math.max(
    0.04,
    state.trebleBaseline + (rawTreble - state.trebleBaseline) * (1 - Math.exp(-dt / tBaseTau)),
  );

  const trebleTarget = rawTreble > 0.14 ? normTreble : 0;
  const trebleTau = trebleTarget > state.treble ? 16 : 120;
  let nextTreble = state.treble + (trebleTarget - state.treble) * (1 - Math.exp(-dt / trebleTau));
  if (nextTreble < 0.004) nextTreble = 0;

  let nextTrebleImpulse = state.trebleImpulse * Math.exp(-dt / 135);
  let trebleCooldownOut = Math.max(0, state.trebleCooldownMs - dt);
  let trebleOnsetTrigger = 0;

  const trebleFlux = rawTreble - state.trebleBaseline * 1.14 - 0.03;
  if (rawTreble > 0.16 && trebleFlux > 0.036 && trebleCooldownOut <= 0) {
    const hit = Math.min(1, 0.44 + trebleFlux * 1.7 + normTreble * 0.3);
    if (hit > nextTrebleImpulse) nextTrebleImpulse = hit;
    trebleOnsetTrigger = hit;
    trebleCooldownOut = 80;
  } else if (rawTreble > 0.54 && normTreble > 0.78 && trebleCooldownOut <= 0) {
    const hit = Math.min(1, normTreble * 0.85);
    if (hit > nextTrebleImpulse) nextTrebleImpulse = hit;
    trebleOnsetTrigger = hit * 0.8;
    trebleCooldownOut = 96;
  }
  if (nextTrebleImpulse < 0.004) nextTrebleImpulse = 0;

  const trebleSustain = nextTreble > 0.24 ? (nextTreble - 0.24) * 0.4 : 0;
  const trebleFlashTarget = Math.max(nextTrebleImpulse, trebleSustain);
  const trebleFlashTau = trebleFlashTarget > state.trebleFlash ? 10 : 135;
  let nextTrebleFlash =
    state.trebleFlash + (trebleFlashTarget - state.trebleFlash) * (1 - Math.exp(-dt / trebleFlashTau));
  if (nextTrebleFlash < 0.004) nextTrebleFlash = 0;

  // Atmospheric glow tracks bass + treble combined (never muddy midrange vocals)
  const targetGlow = Math.min(
    1,
    nextBass * 0.5 + nextFlash * 0.38 + nextTreble * 0.24 + nextTrebleFlash * 0.28,
  );
  const glowTau = targetGlow > state.glow ? 48 : 260;
  let nextGlow = state.glow + (targetGlow - state.glow) * (1 - Math.exp(-dt / glowTau));
  if (nextGlow < 0.004) nextGlow = 0;

  // Continuous fluid motion even between bass/treble hits, accelerating dynamically on drops & highs
  const angularVelocity = 0.36 + nextBass * 1.3 + nextFlash * 1.9 + nextTrebleFlash * 0.95;
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
    trebleBaseline: nextTrebleBaseline,
    treblePeak: nextTreblePeak,
    treble: nextTreble,
    trebleImpulse: nextTrebleImpulse,
    trebleFlash: nextTrebleFlash,
    trebleCooldownMs: trebleCooldownOut,
    trebleOnsetTrigger,
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

type RippleKind = 'bass_impact' | 'bass_seq' | 'snare' | 'hi_hat' | 'cymbal';

interface RippleSlot {
  active: boolean;
  kind: RippleKind;
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
  const richSat = Math.max(0.48, Math.min(0.96, s * 1.15));
  return {
    core: hslToRgb(h, richSat, Math.max(0.45, Math.min(0.62, l))),
    bright: hslToRgb(h + 8, Math.min(1, richSat * 1.08), Math.min(0.82, l + 0.22)),
    warmShift: hslToRgb(h + 24, Math.max(0.44, richSat * 0.96), Math.max(0.4, Math.min(0.58, l))),
    coolShift: hslToRgb(h - 24, Math.max(0.44, richSat * 0.95), Math.max(0.44, Math.min(0.66, l + 0.06))),
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
  bassSustain: number,
  bassImpact: number,
  seqRate: number,
  percussion: number,
  treble: number,
  glow: number,
  ripples: RippleSlot[],
  isLight: boolean,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';

  const dim = Math.max(w, h);
  const alphaScale = isLight ? 0.48 : 1.0;

  // Living orbiting orbs: calm & serene during silence/vocals, surging deeply on bass sustain/impacts and shimmering on percussion/treble
  const orbs: Array<{
    x: number;
    y: number;
    radius: number;
    color: RGB;
    alpha: number;
  }> = [
    {
      // Primary deep sub-bass sustain & impact orb gliding wide across the backdrop
      x: w * (0.5 + 0.34 * Math.sin(phase * 0.56 + 0.3)),
      y: h * (0.5 + 0.31 * Math.cos(phase * 0.42 + 0.1)),
      radius: dim * (0.34 + bassSustain * 0.19 + bassImpact * 0.16),
      color: palette.core,
      alpha: (0.08 + glow * 0.14 + bassSustain * 0.28 + bassImpact * 0.3) * alphaScale,
    },
    {
      // Warm kick / sequential bass undertow orb
      x: w * (0.5 + 0.32 * Math.cos(phase * 0.37 + 4.4)),
      y: h * (0.56 + 0.29 * Math.cos(phase * 0.54 + 2.3)),
      radius: dim * (0.31 + bassSustain * 0.15 + bassImpact * 0.14 + seqRate * 0.08),
      color: palette.warmShift,
      alpha:
        (0.07 + glow * 0.12 + bassSustain * 0.22 + bassImpact * 0.24 + seqRate * 0.12) * alphaScale,
    },
    {
      // Crisp hi-hat / cymbal shimmer orb orbiting upper-diagonal field
      x: w * (0.5 + 0.38 * Math.cos(phase * 0.62 + 2.0)),
      y: h * (0.44 + 0.3 * Math.sin(phase * 0.74 + 1.1)),
      radius: dim * (0.26 + treble * 0.16 + percussion * 0.12),
      color: palette.coolShift,
      alpha: (0.06 + glow * 0.1 + treble * 0.34 + percussion * 0.18) * alphaScale,
    },
    {
      // Expressive snare/percussion + bass highlight orb weaving in a dynamic figure-8
      x: w * (0.5 + 0.4 * Math.sin(phase * 0.86 + 3.4)),
      y: h * (0.48 + 0.28 * Math.sin(phase * 1.14 + 0.6)),
      radius: dim * (0.21 + bassImpact * 0.16 + percussion * 0.16 + treble * 0.1),
      color: palette.bright,
      alpha: (0.05 + bassImpact * 0.32 + percussion * 0.34 + treble * 0.24) * alphaScale,
    },
  ];

  for (let i = 0; i < orbs.length; i++) {
    const o = orbs[i]!;
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.radius);
    grad.addColorStop(0, rgba(o.color, o.alpha));
    grad.addColorStop(0.45, rgba(o.color, o.alpha * 0.44));
    grad.addColorStop(1, rgba(o.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sweeping diagonal aurora ribbon reacting smoothly to sustained bass, sequential groove & percussion
  ctx.save();
  const ribbonX = w * (0.5 + 0.22 * Math.sin(phase * 0.31));
  const ribbonY = h * (0.5 + 0.18 * Math.cos(phase * 0.27));
  ctx.translate(ribbonX, ribbonY);
  ctx.rotate(phase * 0.18 + bassSustain * 0.22 + seqRate * 0.16 + treble * 0.1);
  ctx.scale(1.65, 0.36 + bassSustain * 0.18 + bassImpact * 0.14 + percussion * 0.12);
  const ribRadius = dim * (0.32 + glow * 0.14);
  const ribGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, ribRadius);
  const ribAlpha =
    (0.06 + bassSustain * 0.2 + bassImpact * 0.18 + percussion * 0.18 + treble * 0.16) * alphaScale;
  ribGrad.addColorStop(0, rgba(palette.bright, ribAlpha));
  ribGrad.addColorStop(0.55, rgba(palette.core, ribAlpha * 0.38));
  ribGrad.addColorStop(1, rgba(palette.core, 0));
  ctx.fillStyle = ribGrad;
  ctx.beginPath();
  ctx.arc(0, 0, ribRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Classified event shockwave ripples (one-shot bass, sequential bass, snare/tom, hi-hat, cymbal wash)
  for (let i = 0; i < ripples.length; i++) {
    const r = ripples[i]!;
    if (!r.active) continue;
    const t = Math.min(1, r.ageMs / r.maxMs);
    const isHigh = r.kind === 'hi_hat' || r.kind === 'cymbal';
    const isSeq = r.kind === 'bass_seq';
    const isSnare = r.kind === 'snare';

    const eased = 1 - Math.pow(1 - t, isHigh ? 2.15 : isSeq ? 2.35 : 2.65);
    const maxSpan =
      r.kind === 'bass_impact'
        ? 0.64
        : isSeq
          ? 0.48
          : r.kind === 'cymbal'
            ? 0.52
            : isSnare
              ? 0.44
              : 0.34;
    const outerR = dim * ((isHigh ? 0.05 : 0.08) + eased * maxSpan);
    const bandWidth = Math.max(
      isHigh ? 12 : 18,
      dim * ((r.kind === 'cymbal' ? 0.14 : isHigh ? 0.08 : 0.155) * (1 - t * 0.4)),
    );
    const innerR = Math.max(0, outerR - bandWidth);
    const fade = Math.sin(Math.min(1, t * 4.2) * (Math.PI / 2)) * Math.pow(1 - t, 1.72);
    const alpha = r.strength * fade * (isHigh ? 0.35 : 0.39) * alphaScale;
    if (alpha <= 0.003) continue;

    const ringColor =
      r.kind === 'hi_hat'
        ? palette.bright
        : r.kind === 'cymbal'
          ? palette.coolShift
          : isSnare
            ? palette.warmShift
            : palette.core;
    const edgeColor =
      isHigh ? palette.coolShift : isSnare || isSeq ? palette.bright : palette.warmShift;
    const ringGrad = ctx.createRadialGradient(r.x * w, r.y * h, innerR, r.x * w, r.y * h, outerR);
    ringGrad.addColorStop(0, rgba(ringColor, 0));
    ringGrad.addColorStop(0.55, rgba(ringColor, alpha));
    ringGrad.addColorStop(1, rgba(edgeColor, 0));
    ctx.fillStyle = ringGrad;
    ctx.beginPath();
    ctx.arc(r.x * w, r.y * h, outerR, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function BeatPulseOverlay() {
  const uiStyle = useApp(s => s.data.preferences.uiStyle ?? 'matte');
  const beatPulse = useApp(s => s.data.preferences.beatPulse);
  const pulseConfig = useApp(s => s.data.preferences.pulseConfig);
  const performanceMode = useApp(s => s.data.preferences.performance);
  const playing = useApp(s => s.playing);
  const accentColor = useApp(s => s.data.preferences.accent ?? '');
  const theme = useApp(s => s.data.preferences.theme ?? 'dark');
  const reduced = useReducedUI();
  const active = Boolean((beatPulse ?? uiStyle === 'beat') && !performanceMode && !reduced);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pulseConfigRef = useRef(pulseConfig);
  pulseConfigRef.current = pulseConfig;

  useEffect(() => {
    const root = document.documentElement;
    if (!active) return;

    ensurePulseEngineRegistered();

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    let lastAccentRaw = root.style.getPropertyValue('--user-accent').trim() || accentColor || '';
    let palette = readAccentPalette(accentColor);
    let isLight = root.dataset.theme === 'light';

    const syncSize = () => {
      if (!canvas) return { w: 320, h: 200 };
      const rect = canvas.getBoundingClientRect();
      // Compact internal buffer upscaled smoothly by GPU -> crisp aurora with zero lag
      const targetW = Math.max(160, Math.min(520, Math.round((rect.width || window.innerWidth) * 0.38)));
      const targetH = Math.max(120, Math.min(340, Math.round((rect.height || window.innerHeight) * 0.38)));
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
    let lastDrawTs = 0;

    // Smoothed visual state driven by Pulse 2.0 analysis frames
    let latestAnalysis: PulseAnalysisFrame = EMPTY_PULSE_FRAME;
    const queuedEvents: MusicEvent[] = [];
    let phase = 0;
    let smoothSustain = 0;
    let smoothImpact = 0;
    let smoothSeqRate = 0;
    let smoothPerc = 0;
    let smoothTreble = 0;
    let smoothGlow = 0.06;
    let seqStepAngle = 0;

    let nextRipple = 0;
    const ripples: RippleSlot[] = Array.from({ length: 8 }, () => ({
      active: false,
      kind: 'bass_impact',
      x: 0.5,
      y: 0.5,
      ageMs: 0,
      maxMs: 650,
      strength: 0,
    }));

    const spawnRipple = (
      kind: RippleKind,
      x: number,
      y: number,
      maxMs: number,
      strength: number,
    ) => {
      const slot = ripples[nextRipple % ripples.length]!;
      nextRipple++;
      slot.active = true;
      slot.kind = kind;
      slot.x = x;
      slot.y = y;
      slot.ageMs = 0;
      slot.maxMs = maxMs;
      slot.strength = Math.max(0.18, Math.min(1, strength));
    };

    const unsubscribeAnalysis = subscribeMusicAnalysis('beat-pulse-overlay', frame => {
      latestAnalysis = frame;
      if (frame.events.length > 0 && queuedEvents.length < 16) {
        for (let i = 0; i < frame.events.length && queuedEvents.length < 16; i++) {
          queuedEvents.push(frame.events[i]!);
        }
      }
    });

    const scheduleTick = () => {
      if (!rafId && !document.hidden && windowVisible) {
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
        lastTs = performance.now();
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
      const isPlaying = playingRef.current;

      // Throttle calm/paused background drift to ~30fps to save CPU/GPU while keeping motion silky smooth
      if (!isPlaying && now - lastDrawTs < 32) {
        scheduleTick();
        return;
      }

      const dt = Math.max(1, Math.min(64, now - lastTs));
      lastTs = now;
      lastDrawTs = now;

      const prefs = normalizePulsePreferences(pulseConfigRef.current);

      if (isPlaying) {
        const f = latestAnalysis;
        // Suppress residual shimmer during dominant vocal-only passages with no drum/bass events
        const vocalCalmFactor =
          prefs.vocalSuppression && f.vocalLikelihood > 0.62 && f.events.length === 0
            ? Math.max(0.25, 1 - (f.vocalLikelihood - 0.62) * 1.4)
            : 1.0;

        const targetSustain = prefs.bass ? f.bassSustain : 0;
        const targetImpact =
          prefs.bass && (f.activeSequence ? prefs.sequentialBass : prefs.oneShot)
            ? f.bassImpact
            : 0;
        const targetSeq = prefs.bass && prefs.sequentialBass ? f.bassSequenceRate : 0;
        const targetPerc = prefs.percussion ? f.percussion * vocalCalmFactor : 0;
        const targetTreble = prefs.percussion ? f.treble * vocalCalmFactor : 0;

        smoothSustain +=
          (targetSustain - smoothSustain) * (1 - Math.exp(-dt / (targetSustain > smoothSustain ? 36 : 190)));
        smoothImpact +=
          (targetImpact - smoothImpact) * (1 - Math.exp(-dt / (targetImpact > smoothImpact ? 14 : 180)));
        smoothSeqRate +=
          (targetSeq - smoothSeqRate) * (1 - Math.exp(-dt / (targetSeq > smoothSeqRate ? 28 : 220)));
        smoothPerc +=
          (targetPerc - smoothPerc) * (1 - Math.exp(-dt / (targetPerc > smoothPerc ? 12 : 145)));
        smoothTreble +=
          (targetTreble - smoothTreble) * (1 - Math.exp(-dt / (targetTreble > smoothTreble ? 12 : 130)));

        const targetGlow = Math.min(
          1,
          0.05 +
            smoothSustain * 0.48 +
            smoothImpact * 0.36 +
            smoothPerc * 0.24 +
            smoothTreble * 0.22,
        );
        smoothGlow +=
          (targetGlow - smoothGlow) * (1 - Math.exp(-dt / (targetGlow > smoothGlow ? 44 : 260)));

        const angularVel =
          0.2 +
          smoothSustain * 0.95 +
          smoothImpact * 1.65 +
          smoothSeqRate * 1.35 +
          smoothPerc * 0.85 +
          smoothTreble * 0.55;
        phase = (phase + (dt / 1000) * angularVel) % (Math.PI * 200);

        // Drain classified events to spawn distinct visual ripples
        if (queuedEvents.length > 0) {
          let spawnedBassThisTick = false;
          for (let i = 0; i < queuedEvents.length; i++) {
            const ev = queuedEvents[i]!;
            if (ev.intensity < 0.16) continue;
            switch (ev.type) {
              case 'bass_one_shot':
                if (prefs.bass && prefs.oneShot) {
                  spawnedBassThisTick = true;
                  spawnRipple(
                    'bass_impact',
                    0.5 + 0.3 * Math.sin(phase * 0.72 + 1.1),
                    0.52 + 0.24 * Math.cos(phase * 0.58 + 0.4),
                    620 + (1 - ev.intensity) * 160,
                    ev.intensity,
                  );
                }
                break;
              case 'bass_sequence':
                if (prefs.bass && prefs.sequentialBass) {
                  spawnedBassThisTick = true;
                  seqStepAngle += 1.35;
                  spawnRipple(
                    'bass_seq',
                    0.5 + 0.28 * Math.cos(seqStepAngle),
                    0.52 + 0.22 * Math.sin(seqStepAngle),
                    390 + (1 - ev.intensity) * 110,
                    ev.intensity,
                  );
                }
                break;
              case 'kick':
                if (!spawnedBassThisTick && prefs.bass && prefs.oneShot) {
                  spawnedBassThisTick = true;
                  spawnRipple(
                    'bass_impact',
                    0.5 + 0.3 * Math.sin(phase * 0.72 + 1.1),
                    0.52 + 0.24 * Math.cos(phase * 0.58 + 0.4),
                    600 + (1 - ev.intensity) * 150,
                    ev.intensity,
                  );
                }
                break;
              case 'snare':
              case 'tom':
              case 'percussion':
                if (prefs.percussion) {
                  spawnRipple(
                    'snare',
                    0.5 + 0.34 * Math.sin(phase * 0.88 + 2.7),
                    0.48 + 0.26 * Math.cos(phase * 0.76 + 1.5),
                    440 + (1 - ev.intensity) * 110,
                    ev.intensity,
                  );
                }
                break;
              case 'hi_hat':
                if (prefs.percussion) {
                  spawnRipple(
                    'hi_hat',
                    0.5 + 0.38 * Math.cos(phase * 0.96 + 2.4),
                    0.42 + 0.28 * Math.sin(phase * 1.18 + 0.8),
                    300 + (1 - ev.intensity) * 90,
                    ev.intensity,
                  );
                }
                break;
              case 'cymbal':
                if (prefs.percussion) {
                  spawnRipple(
                    'cymbal',
                    0.5 + 0.32 * Math.cos(phase * 0.64 + 0.9),
                    0.4 + 0.24 * Math.sin(phase * 0.82 + 2.1),
                    680 + (1 - ev.intensity) * 150,
                    ev.intensity,
                  );
                }
                break;
              case 'bass_sustain':
                // Driven continuously via smoothSustain aurora envelope without sharp ring flashes
                break;
            }
          }
          queuedEvents.length = 0;
        }
      } else {
        queuedEvents.length = 0;
        smoothSustain *= Math.exp(-dt / 240);
        smoothImpact *= Math.exp(-dt / 200);
        smoothSeqRate *= Math.exp(-dt / 220);
        smoothPerc *= Math.exp(-dt / 160);
        smoothTreble *= Math.exp(-dt / 150);
        smoothGlow += (0.06 - smoothGlow) * (1 - Math.exp(-dt / 420));
        phase = (phase + (dt / 1000) * 0.18) % (Math.PI * 200);
      }

      if (smoothSustain < 0.004) smoothSustain = 0;
      if (smoothImpact < 0.004) smoothImpact = 0;
      if (smoothSeqRate < 0.004) smoothSeqRate = 0;
      if (smoothPerc < 0.004) smoothPerc = 0;
      if (smoothTreble < 0.004) smoothTreble = 0;

      for (let i = 0; i < ripples.length; i++) {
        const r = ripples[i]!;
        if (!r.active) continue;
        r.ageMs += dt;
        if (r.ageMs >= r.maxMs) r.active = false;
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
          phase,
          smoothSustain,
          smoothImpact,
          smoothSeqRate,
          smoothPerc,
          smoothTreble,
          smoothGlow,
          ripples,
          isLight,
        );
      }

      scheduleTick();
    };

    palette = readAccentPalette(accentColor);
    lastTs = performance.now();
    scheduleTick();
    return () => {
      unsubscribeAnalysis();
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
