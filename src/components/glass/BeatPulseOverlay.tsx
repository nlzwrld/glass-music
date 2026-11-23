import { useEffect } from 'react';
import { getAudioReactiveFrame } from '../../lib/audioGraph';
import { useApp } from '../../stores/app';

export interface BeatDetectorState {
  baseline: number;
  flash: number;
  glow: number;
  cooldownMs: number;
}

export function createBeatDetectorState(): BeatDetectorState {
  return { baseline: 0.08, flash: 0, glow: 0, cooldownMs: 0 };
}

/**
 * Pure spectral bass-onset beat detector (unit-testable, zero allocations).
 * Produces a snappy, musical flash impulse (0..1) on kick/bass hits and decays cleanly.
 */
export function stepBeatDetector(
  state: BeatDetectorState,
  sample: { bass: number; mid: number; energy: number },
  dtMs: number,
): BeatDetectorState {
  const dt = Math.max(1, Math.min(100, Number.isFinite(dtMs) ? dtMs : 16.6));
  const bass = Math.max(0, Math.min(1, sample.bass || 0));
  const energy = Math.max(0, Math.min(1, sample.energy || 0));

  const nextCooldown = Math.max(0, state.cooldownMs - dt);
  const adaptRate = bass > state.baseline ? 0.085 : 0.04;
  const nextBaseline = Math.max(
    0.04,
    state.baseline + (bass - state.baseline) * Math.min(1, adaptRate * (dt / 16.6)),
  );

  // Exponential decay for previous flash
  let nextFlash = state.flash * Math.exp(-dt / 175);
  let cooldownOut = nextCooldown;

  const flux = bass - state.baseline * 1.16 - 0.035;
  if (flux > 0.035 && nextCooldown <= 0) {
    const impulse = Math.min(1, 0.36 + flux * 2.15 + bass * 0.32);
    if (impulse > nextFlash) {
      nextFlash = impulse;
    }
    cooldownOut = 135;
  } else if (bass > 0.72 && nextCooldown <= 0) {
    nextFlash = Math.max(nextFlash, Math.min(1, bass * 0.88));
    cooldownOut = 150;
  }

  if (nextFlash < 0.004) nextFlash = 0;

  const targetGlow = Math.min(1, energy * 0.58 + nextFlash * 0.42);
  const nextGlow = state.glow + (targetGlow - state.glow) * Math.min(1, 0.22 * (dt / 16.6));

  return {
    baseline: nextBaseline,
    flash: nextFlash,
    glow: nextGlow < 0.004 ? 0 : nextGlow,
    cooldownMs: cooldownOut,
  };
}

export function BeatPulseOverlay() {
  const uiStyle = useApp(s => s.data.preferences.uiStyle ?? 'matte');
  const playing = useApp(s => s.playing);
  const reduced = useApp(
    s => Boolean(s.data.preferences.reducedMotion || s.data.preferences.performance),
  );
  const active = uiStyle === 'beat';

  useEffect(() => {
    const root = document.documentElement;
    if (!active) {
      root.style.removeProperty('--beat-flash');
      root.style.removeProperty('--beat-glow');
      return;
    }
    if (reduced) {
      root.style.setProperty('--beat-flash', '0');
      root.style.setProperty('--beat-glow', playing ? '0.28' : '0.12');
      return;
    }
    if (!playing) {
      root.style.setProperty('--beat-flash', '0');
      root.style.setProperty('--beat-glow', '0.10');
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();
    let detector = createBeatDetectorState();

    const tick = (now: number) => {
      const dt = now - lastTs;
      lastTs = now;
      const frame = getAudioReactiveFrame();
      detector = stepBeatDetector(detector, frame, dt);
      root.style.setProperty('--beat-flash', detector.flash.toFixed(3));
      root.style.setProperty('--beat-glow', detector.glow.toFixed(3));
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      root.style.setProperty('--beat-flash', '0');
      root.style.setProperty('--beat-glow', '0.10');
    };
  }, [active, playing, reduced]);

  if (!active) return null;

  return (
    <div className="beat-pulse-layer" aria-hidden="true">
      <div className="beat-pulse-bloom beat-pulse-top" />
      <div className="beat-pulse-bloom beat-pulse-bottom" />
      <div className="beat-pulse-edge" />
    </div>
  );
}
