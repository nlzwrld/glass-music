import type {
  BackgroundVideoInfo,
  BackgroundVideoPreferences,
  PulsePreferences,
} from '../../shared/types';

export type { BackgroundVideoInfo, BackgroundVideoPreferences, PulsePreferences };

export type MusicEventType =
  | 'bass_sustain'
  | 'bass_one_shot'
  | 'bass_sequence'
  | 'kick'
  | 'snare'
  | 'hi_hat'
  | 'cymbal'
  | 'tom'
  | 'percussion';

export interface MusicEvent {
  type: MusicEventType;
  /** Event timestamp in performance.now() milliseconds. */
  timestamp: number;
  /** Normalized strength of the detected event (0..1). */
  intensity: number;
  /** Classifier confidence (0..1). */
  confidence: number;
  /** Duration in ms for sustained or active sequence states. */
  durationMs?: number;
  /** Estimated inter-onset interval in ms for sequential bass events. */
  intervalMs?: number;
  /** Count of consecutive impacts in the active bass sequence. */
  sequenceCount?: number;
}

export interface PulseAnalysisFrame {
  timestamp: number;
  /** Sustained or recurring normal bass/sub-bass envelope (0..1). */
  bassSustain: number;
  /** Decaying transient bass impact (kick / 808 punch / sub-drop) (0..1). */
  bassImpact: number;
  /** Normalized cadence when sequential bass is active (0..1). */
  bassSequenceRate: number;
  /** Decaying non-bass drum/percussion energy (0..1). */
  percussion: number;
  /** High-frequency hi-hat/cymbal shimmer envelope (0..1). */
  treble: number;
  /** Diagnostic estimate of lead/spoken vocal dominance (0..1). */
  vocalLikelihood: number;
  /** True while repeated/patterned low-frequency impacts are occurring. */
  activeSequence: boolean;
  /** Classified music events triggered on this analysis frame. */
  events: readonly MusicEvent[];
}

export const DEFAULT_PULSE_PREFERENCES: Readonly<PulsePreferences> = Object.freeze({
  bass: true,
  oneShot: true,
  sequentialBass: true,
  percussion: true,
  vocalSuppression: true,
  sensitivity: 1.0,
});

export const DEFAULT_BACKGROUND_VIDEO_PREFERENCES: Readonly<BackgroundVideoPreferences> =
  Object.freeze({
    enabled: false,
    beatSync: true,
    syncIntensity: 0.7,
    minSpeed: 0.75,
    maxSpeed: 2.0,
    loop: true,
  });

export const EMPTY_PULSE_FRAME: PulseAnalysisFrame = Object.freeze({
  timestamp: 0,
  bassSustain: 0,
  bassImpact: 0,
  bassSequenceRate: 0,
  percussion: 0,
  treble: 0,
  vocalLikelihood: 0,
  activeSequence: false,
  events: Object.freeze([] as readonly MusicEvent[]),
});

function clampFinite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function normalizePulsePreferences(raw?: Partial<PulsePreferences> | null): PulsePreferences {
  const src = raw ?? {};
  return {
    bass: typeof src.bass === 'boolean' ? src.bass : DEFAULT_PULSE_PREFERENCES.bass,
    oneShot: typeof src.oneShot === 'boolean' ? src.oneShot : DEFAULT_PULSE_PREFERENCES.oneShot,
    sequentialBass:
      typeof src.sequentialBass === 'boolean'
        ? src.sequentialBass
        : DEFAULT_PULSE_PREFERENCES.sequentialBass,
    percussion:
      typeof src.percussion === 'boolean' ? src.percussion : DEFAULT_PULSE_PREFERENCES.percussion,
    vocalSuppression:
      typeof src.vocalSuppression === 'boolean'
        ? src.vocalSuppression
        : DEFAULT_PULSE_PREFERENCES.vocalSuppression,
    sensitivity: clampFinite(src.sensitivity, DEFAULT_PULSE_PREFERENCES.sensitivity, 0.25, 2.0),
  };
}

export function normalizeBackgroundVideoPreferences(
  raw?: Partial<BackgroundVideoPreferences> | null,
): BackgroundVideoPreferences {
  const src = raw ?? {};
  const minSpeed = clampFinite(
    src.minSpeed,
    DEFAULT_BACKGROUND_VIDEO_PREFERENCES.minSpeed,
    0.25,
    1.5,
  );
  const rawMax = clampFinite(
    src.maxSpeed,
    DEFAULT_BACKGROUND_VIDEO_PREFERENCES.maxSpeed,
    1.0,
    3.0,
  );
  const maxSpeed = Math.max(minSpeed, rawMax);
  return {
    enabled:
      typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_BACKGROUND_VIDEO_PREFERENCES.enabled,
    beatSync:
      typeof src.beatSync === 'boolean'
        ? src.beatSync
        : DEFAULT_BACKGROUND_VIDEO_PREFERENCES.beatSync,
    syncIntensity: clampFinite(
      src.syncIntensity,
      DEFAULT_BACKGROUND_VIDEO_PREFERENCES.syncIntensity,
      0,
      1,
    ),
    minSpeed,
    maxSpeed,
    loop: typeof src.loop === 'boolean' ? src.loop : DEFAULT_BACKGROUND_VIDEO_PREFERENCES.loop,
  };
}

export type MusicAnalysisListener = (frame: PulseAnalysisFrame) => void;

export interface MusicAnalysisDriver {
  onConsumersChanged(count: number): void;
  getLatestFrame(): PulseAnalysisFrame;
  reset(): void;
}

const listeners = new Map<string, MusicAnalysisListener>();
let activeDriver: MusicAnalysisDriver | null = null;
let latestFrame: PulseAnalysisFrame = EMPTY_PULSE_FRAME;

export function registerMusicAnalysisDriver(driver: MusicAnalysisDriver | null): void {
  activeDriver = driver;
  if (driver) {
    driver.onConsumersChanged(listeners.size);
  }
}

export function subscribeMusicAnalysis(
  consumerId: string,
  listener: MusicAnalysisListener,
): () => void {
  listeners.set(consumerId, listener);
  activeDriver?.onConsumersChanged(listeners.size);
  return () => {
    const existing = listeners.get(consumerId);
    if (existing === listener) {
      listeners.delete(consumerId);
      activeDriver?.onConsumersChanged(listeners.size);
    }
  };
}

export function emitMusicAnalysisFrame(frame: PulseAnalysisFrame): void {
  latestFrame = frame;
  for (const listener of listeners.values()) {
    try {
      listener(frame);
    } catch {
      // Isolate individual consumer failures from the audio-analysis tick.
    }
  }
}

export function resetMusicAnalysis(): void {
  latestFrame = EMPTY_PULSE_FRAME;
  activeDriver?.reset();
}

export function getActiveMusicAnalysisConsumerCount(): number {
  return listeners.size;
}

export function getLatestMusicAnalysisFrame(): PulseAnalysisFrame {
  return activeDriver?.getLatestFrame() ?? latestFrame;
}
