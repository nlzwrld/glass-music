import {
  DEFAULT_BACKGROUND_VIDEO_PREFERENCES,
  type BackgroundVideoPreferences,
  type PulseAnalysisFrame,
} from './musicEvents';

export const RATE_COMMIT_EPSILON = 0.015;
export const RATE_MIN_INTERVAL_MS = 33;
export const RATE_DOM_GUARD_EPSILON = 0.01;

const MIN_SPEED_FLOOR = 0.25;
const MIN_SPEED_CEIL = 1.5;
const MAX_SPEED_FLOOR = 1.0;
const MAX_SPEED_CEIL = 3.0;
const IDLE_SNAP_EPSILON = 0.0015;
const ENVELOPE_FLOOR_EPSILON = 0.001;

export interface VideoSpeedState {
  /** Current smoothed video playback rate, strictly within [minSpeed, maxSpeed]. */
  speed: number;
  /** Decaying transient impulse envelope for isolated kicks / bass_one_shot (0..1). */
  impactEnvelope: number;
  /** Crisp attack / shorter recovery pulse envelope for bass_sequence hits (0..1). */
  sequenceEnvelope: number;
  /** Gently smoothed sustained bass lift envelope (0..1). */
  sustainEnvelope: number;
  /** Weighted percussion envelope for snare / tom / hi_hat / cymbal / percussion (0..1). */
  percussionEnvelope: number;
  /** Timestamp of the last processed analysis frame (ms). */
  lastTimestamp: number;
}

export interface VideoRateCoalescerState {
  lastCommittedRate: number;
  lastCommitTs: number;
}

export interface VideoPlaybackTarget {
  playbackRate: number;
  defaultPlaybackRate: number;
}

function clampFinite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < min ? min : value > max ? max : value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function readMinSpeed(prefs?: Partial<BackgroundVideoPreferences> | null): number {
  return clampFinite(
    prefs?.minSpeed,
    DEFAULT_BACKGROUND_VIDEO_PREFERENCES.minSpeed,
    MIN_SPEED_FLOOR,
    MIN_SPEED_CEIL,
  );
}

function readMaxSpeed(
  prefs: Partial<BackgroundVideoPreferences> | null | undefined,
  minSpeed: number,
): number {
  const rawMax = clampFinite(
    prefs?.maxSpeed,
    DEFAULT_BACKGROUND_VIDEO_PREFERENCES.maxSpeed,
    MAX_SPEED_FLOOR,
    MAX_SPEED_CEIL,
  );
  return rawMax < minSpeed ? minSpeed : rawMax;
}

export function computeBaseVideoSpeed(
  prefs?: Partial<Pick<BackgroundVideoPreferences, 'minSpeed' | 'maxSpeed'>> | null,
): number {
  const minSpeed = readMinSpeed(prefs);
  const maxSpeed = readMaxSpeed(prefs, minSpeed);
  return clamp(1.0, minSpeed, maxSpeed);
}

export function createVideoSpeedState(baseSpeed = 1.0): VideoSpeedState {
  const safeBase = clampFinite(baseSpeed, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);
  return {
    speed: safeBase,
    impactEnvelope: 0,
    sequenceEnvelope: 0,
    sustainEnvelope: 0,
    percussionEnvelope: 0,
    lastTimestamp: 0,
  };
}

export function resetVideoSpeedState(
  state: VideoSpeedState,
  baseSpeed = 1.0,
): VideoSpeedState {
  state.speed = clampFinite(baseSpeed, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);
  state.impactEnvelope = 0;
  state.sequenceEnvelope = 0;
  state.sustainEnvelope = 0;
  state.percussionEnvelope = 0;
  state.lastTimestamp = 0;
  return state;
}

export function createVideoRateCoalescer(initialRate = 1.0): VideoRateCoalescerState {
  return {
    lastCommittedRate: clampFinite(initialRate, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL),
    lastCommitTs: 0,
  };
}

export function resetVideoRateCoalescer(
  coalescer: VideoRateCoalescerState,
  initialRate = 1.0,
): VideoRateCoalescerState {
  coalescer.lastCommittedRate = clampFinite(initialRate, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);
  coalescer.lastCommitTs = 0;
  return coalescer;
}

/**
 * Pure, deterministic, zero-allocation beat-synchronized video speed envelope step.
 * Mutates `state` in place and returns it so callers never allocate on the 60 Hz analysis path.
 */
export function stepVideoSpeed(
  state: VideoSpeedState,
  frame: PulseAnalysisFrame | null | undefined,
  prefs: Partial<BackgroundVideoPreferences> | null | undefined,
  dtMs: number,
  isPlaying: boolean,
): VideoSpeedState {
  const dt = clampFinite(dtMs, 16.67, 1, 100);
  const minSpeed = readMinSpeed(prefs);
  const maxSpeed = readMaxSpeed(prefs, minSpeed);
  const baseSpeed = clamp(1.0, minSpeed, maxSpeed);
  const beatSync =
    typeof prefs?.beatSync === 'boolean'
      ? prefs.beatSync
      : DEFAULT_BACKGROUND_VIDEO_PREFERENCES.beatSync;
  const syncIntensity = clampFinite(
    prefs?.syncIntensity,
    DEFAULT_BACKGROUND_VIDEO_PREFERENCES.syncIntensity,
    0,
    1,
  );

  if (!Number.isFinite(state.speed)) {
    state.speed = baseSpeed;
  }

  const events = frame?.events;
  const eventCount = events ? events.length : 0;
  const vocalLikelihood = frame ? clamp01(frame.vocalLikelihood) : 0;
  const vocalOnly = Boolean(frame && vocalLikelihood > 0.72 && eventCount === 0);
  const syncActive = Boolean(isPlaying && beatSync && syncIntensity > 0 && frame && !vocalOnly);

  if (frame && Number.isFinite(frame.timestamp)) {
    state.lastTimestamp = frame.timestamp;
  }

  if (!syncActive) {
    state.impactEnvelope *= Math.exp(-dt / 190);
    state.sequenceEnvelope *= Math.exp(-dt / 145);
    state.sustainEnvelope *= Math.exp(-dt / 240);
    state.percussionEnvelope *= Math.exp(-dt / 150);

    if (state.impactEnvelope < ENVELOPE_FLOOR_EPSILON) state.impactEnvelope = 0;
    if (state.sequenceEnvelope < ENVELOPE_FLOOR_EPSILON) state.sequenceEnvelope = 0;
    if (state.sustainEnvelope < ENVELOPE_FLOOR_EPSILON) state.sustainEnvelope = 0;
    if (state.percussionEnvelope < ENVELOPE_FLOOR_EPSILON) state.percussionEnvelope = 0;

    // Smooth deceleration (tau = 290 ms) back to normal playback speed without jarring drops.
    const releaseAlpha = 1 - Math.exp(-dt / 290);
    let nextSpeed = state.speed + (baseSpeed - state.speed) * releaseAlpha;
    if (Math.abs(nextSpeed - baseSpeed) < IDLE_SNAP_EPSILON) {
      nextSpeed = baseSpeed;
    }
    state.speed = clamp(nextSpeed, minSpeed, maxSpeed);
    return state;
  }

  let impactHit = 0;
  let sequenceHit = 0;
  let sustainEventBoost = 0;
  let percHit = 0;

  if (events) {
    for (let i = 0; i < eventCount; i++) {
      const ev = events[i];
      if (!ev) continue;
      const weight = clamp01(ev.intensity) * clamp01(ev.confidence);
      if (weight <= 0) continue;

      switch (ev.type) {
        case 'kick':
          if (weight > impactHit) impactHit = weight;
          break;
        case 'bass_one_shot': {
          const boosted = weight * 1.05;
          const clamped = boosted > 1 ? 1 : boosted;
          if (clamped > impactHit) impactHit = clamped;
          break;
        }
        case 'bass_sequence':
          if (weight > sequenceHit) sequenceHit = weight;
          break;
        case 'bass_sustain':
          if (weight > sustainEventBoost) sustainEventBoost = weight;
          break;
        case 'snare': {
          const scaled = weight * 0.52;
          if (scaled > percHit) percHit = scaled;
          break;
        }
        case 'tom': {
          const scaled = weight * 0.48;
          if (scaled > percHit) percHit = scaled;
          break;
        }
        case 'hi_hat': {
          const scaled = weight * 0.24;
          if (scaled > percHit) percHit = scaled;
          break;
        }
        case 'cymbal': {
          const scaled = weight * 0.26;
          if (scaled > percHit) percHit = scaled;
          break;
        }
        case 'percussion': {
          const scaled = weight * 0.30;
          if (scaled > percHit) percHit = scaled;
          break;
        }
      }
    }
  }

  // Gently attenuate continuous envelopes if vocals are prominent and no beat event fired.
  const vocalGate =
    eventCount === 0 && vocalLikelihood > 0.55
      ? Math.max(0, 1 - (vocalLikelihood - 0.55) / 0.17)
      : 1;

  // 1. Isolated kick / bass_one_shot transient envelope
  state.impactEnvelope *= Math.exp(-dt / 215);
  if (impactHit > state.impactEnvelope) {
    state.impactEnvelope = impactHit;
  } else if (frame && !frame.activeSequence && vocalGate > 0) {
    const continuousImpact = clamp01(frame.bassImpact) * 0.45 * vocalGate;
    if (continuousImpact > 0.08 && continuousImpact > state.impactEnvelope) {
      state.impactEnvelope = continuousImpact;
    }
  }

  // 2. Sequential bass hits: crisp response & shorter recovery (~160 ms) so each hit visibly pulses
  state.sequenceEnvelope *= Math.exp(-dt / 160);
  if (sequenceHit > 0) {
    const seqPeak = Math.min(1, sequenceHit * 0.92);
    if (seqPeak > state.sequenceEnvelope) {
      state.sequenceEnvelope = seqPeak;
    }
  }

  // 3. Sustained bass lift: gentle bounded elevation
  const frameSustain = frame ? clamp01(frame.bassSustain) * vocalGate : 0;
  const sustainTarget = Math.min(1, Math.max(frameSustain, sustainEventBoost * 0.85));
  const sustainTau = sustainTarget > state.sustainEnvelope ? 120 : 280;
  state.sustainEnvelope +=
    (sustainTarget - state.sustainEnvelope) * (1 - Math.exp(-dt / sustainTau));

  // 4. Percussive layers (snare/tom moderate, hi-hat/cymbal/percussion subtle)
  state.percussionEnvelope *= Math.exp(-dt / 135);
  const continuousPerc = frame ? clamp01(frame.percussion) * 0.25 * vocalGate : 0;
  const percTarget = percHit > continuousPerc ? percHit : continuousPerc;
  if (percTarget > state.percussionEnvelope) {
    state.percussionEnvelope = percTarget;
  }

  if (state.impactEnvelope < ENVELOPE_FLOOR_EPSILON) state.impactEnvelope = 0;
  if (state.sequenceEnvelope < ENVELOPE_FLOOR_EPSILON) state.sequenceEnvelope = 0;
  if (state.sustainEnvelope < ENVELOPE_FLOOR_EPSILON) state.sustainEnvelope = 0;
  if (state.percussionEnvelope < ENVELOPE_FLOOR_EPSILON) state.percussionEnvelope = 0;

  const impactDrive = state.impactEnvelope * 0.88;
  const sequenceDrive = state.sequenceEnvelope * 0.72;
  const sustainDrive = state.sustainEnvelope * 0.34;
  const percDrive = state.percussionEnvelope * 0.55;

  const primaryDrive = impactDrive > sequenceDrive ? impactDrive : sequenceDrive;
  const rawDrive =
    primaryDrive +
    sustainDrive * (1 - primaryDrive * 0.55) +
    percDrive * (1 - primaryDrive * 0.45);

  // Smooth soft-knee curve keeps speed expressive without slamming abruptly against maxSpeed.
  const curvedDrive = rawDrive > 0 ? Math.min(1, 1 - Math.exp(-1.45 * rawDrive)) : 0;
  const headroom = Math.max(0, maxSpeed - baseSpeed);
  const targetSpeed = clamp(baseSpeed + headroom * curvedDrive * syncIntensity, minSpeed, maxSpeed);

  const sequenceMode = Boolean(
    sequenceHit > 0 ||
      (frame?.activeSequence && state.sequenceEnvelope >= state.impactEnvelope * 0.85),
  );
  let tau: number;
  if (targetSpeed > state.speed) {
    // Crisp attack (~26 ms) for sequential bass pulses; smooth organic attack (~42 ms) otherwise.
    tau = sequenceMode ? 26 : 42;
  } else if (sequenceMode || state.sequenceEnvelope > 0.05) {
    // Shorter recovery (~165 ms) so sequential hits visibly breathe in rhythm.
    tau = 165;
  } else if (rawDrive < 0.01) {
    // Calm idle deceleration (~290 ms) back to normal playback rate.
    tau = 290;
  } else {
    tau = 220;
  }

  const alpha = 1 - Math.exp(-dt / tau);
  let nextSpeed = state.speed + (targetSpeed - state.speed) * alpha;
  if (targetSpeed === baseSpeed && Math.abs(nextSpeed - baseSpeed) < IDLE_SNAP_EPSILON) {
    nextSpeed = baseSpeed;
  }
  state.speed = clamp(Number.isFinite(nextSpeed) ? nextSpeed : baseSpeed, minSpeed, maxSpeed);
  return state;
}

/**
 * Decides whether a new playback rate should be committed to the DOM `<video>` element.
 * Suppresses micro-jitter (< 0.015 delta) and caps commit frequency at ~30 updates/sec
 * for Chromium/WebView2 hardware-decoder stability, while allowing clean exact snaps to baseSpeed.
 */
export function shouldCommitPlaybackRate(
  coalescer: VideoRateCoalescerState,
  nextRate: number,
  baseSpeed: number,
  nowMs: number,
): number | null {
  const safeBase = clampFinite(baseSpeed, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);
  const safeNext = clampFinite(nextRate, safeBase, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;

  const isIdleSnap =
    Math.abs(safeNext - safeBase) < 0.003 &&
    Math.abs(coalescer.lastCommittedRate - safeBase) >= 0.003;
  const deltaEnough = Math.abs(safeNext - coalescer.lastCommittedRate) >= RATE_COMMIT_EPSILON;

  if (!isIdleSnap && !deltaEnough) {
    return null;
  }

  if (
    coalescer.lastCommitTs > 0 &&
    safeNow - coalescer.lastCommitTs < RATE_MIN_INTERVAL_MS &&
    !isIdleSnap
  ) {
    return null;
  }

  const committed = isIdleSnap ? safeBase : Math.round(safeNext * 1000) / 1000;
  coalescer.lastCommittedRate = committed;
  coalescer.lastCommitTs = safeNow;
  return committed;
}

/**
 * Safely applies a coalesced playback rate update to an HTMLVideoElement (or compatible test stub).
 */
export function applyPlaybackRateToVideo(
  video: VideoPlaybackTarget | null | undefined,
  coalescer: VideoRateCoalescerState,
  nextRate: number,
  baseSpeed: number,
  nowMs: number,
): boolean {
  if (!video) return false;
  const safeBase = clampFinite(baseSpeed, 1.0, MIN_SPEED_FLOOR, MAX_SPEED_CEIL);

  if (Math.abs(video.defaultPlaybackRate - safeBase) > RATE_DOM_GUARD_EPSILON) {
    try {
      video.defaultPlaybackRate = safeBase;
    } catch {
      // Ignore host WebView range errors.
    }
  }

  const committed = shouldCommitPlaybackRate(coalescer, nextRate, safeBase, nowMs);
  if (committed === null) {
    return false;
  }

  const needsWrite =
    Math.abs(video.playbackRate - committed) > RATE_DOM_GUARD_EPSILON ||
    (committed === safeBase && video.playbackRate !== safeBase);

  if (needsWrite) {
    try {
      video.playbackRate = committed;
    } catch {
      return false;
    }
  }
  return true;
}

export class VideoSpeedController {
  readonly state: VideoSpeedState;
  readonly coalescer: VideoRateCoalescerState;

  constructor(baseSpeed = 1.0) {
    this.state = createVideoSpeedState(baseSpeed);
    this.coalescer = createVideoRateCoalescer(baseSpeed);
  }

  step(
    frame: PulseAnalysisFrame | null | undefined,
    prefs: Partial<BackgroundVideoPreferences> | null | undefined,
    dtMs: number,
    isPlaying: boolean,
  ): number {
    stepVideoSpeed(this.state, frame, prefs, dtMs, isPlaying);
    return this.state.speed;
  }

  applyToVideo(
    video: VideoPlaybackTarget | null | undefined,
    prefs: Partial<BackgroundVideoPreferences> | null | undefined,
    nowMs: number,
  ): boolean {
    const baseSpeed = computeBaseVideoSpeed(prefs);
    return applyPlaybackRateToVideo(video, this.coalescer, this.state.speed, baseSpeed, nowMs);
  }

  /**
   * Clears transient beat envelopes on track changes so speed smoothly glides back
   * toward normal playback without carrying over impulses from the previous song.
   */
  onTrackChange(
    prefs?: Partial<Pick<BackgroundVideoPreferences, 'minSpeed' | 'maxSpeed'>> | null,
  ): void {
    const baseSpeed = computeBaseVideoSpeed(prefs);
    this.state.impactEnvelope = 0;
    this.state.sequenceEnvelope = 0;
    this.state.sustainEnvelope = 0;
    this.state.percussionEnvelope = 0;
    this.state.lastTimestamp = 0;
    if (!Number.isFinite(this.state.speed)) {
      this.state.speed = baseSpeed;
    }
  }

  reset(baseSpeed = 1.0): void {
    resetVideoSpeedState(this.state, baseSpeed);
    resetVideoRateCoalescer(this.coalescer, baseSpeed);
  }
}
