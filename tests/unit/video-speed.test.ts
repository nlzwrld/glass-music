import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_VIDEO_PREFERENCES,
  EMPTY_PULSE_FRAME,
  normalizeBackgroundVideoPreferences,
  type BackgroundVideoPreferences,
  type MusicEvent,
  type PulseAnalysisFrame,
} from '../../src/lib/musicEvents';
import {
  RATE_COMMIT_EPSILON,
  RATE_MIN_INTERVAL_MS,
  VideoSpeedController,
  applyPlaybackRateToVideo,
  computeBaseVideoSpeed,
  createVideoRateCoalescer,
  createVideoSpeedState,
  shouldCommitPlaybackRate,
  stepVideoSpeed,
  type VideoPlaybackTarget,
} from '../../src/lib/videoSpeedController';

function makeFrame(
  overrides: Partial<PulseAnalysisFrame> & { events?: MusicEvent[] } = {},
): PulseAnalysisFrame {
  return {
    ...EMPTY_PULSE_FRAME,
    timestamp: 1000,
    ...overrides,
    events: overrides.events ?? [],
  };
}

function makePrefs(
  overrides: Partial<BackgroundVideoPreferences> = {},
): BackgroundVideoPreferences {
  return {
    ...DEFAULT_BACKGROUND_VIDEO_PREFERENCES,
    enabled: true,
    ...overrides,
  };
}

describe('videoSpeedController', () => {
  it('stays at base speed when beatSync is disabled and smoothly returns from elevated speed', () => {
    const prefs = makePrefs({ beatSync: false, minSpeed: 0.75, maxSpeed: 2.0 });
    const state = createVideoSpeedState(1.0);
    const kickFrame = makeFrame({
      bassImpact: 1.0,
      events: [{ type: 'kick', timestamp: 100, intensity: 1.0, confidence: 1.0 }],
    });

    for (let i = 0; i < 30; i++) {
      stepVideoSpeed(state, kickFrame, prefs, 16.67, true);
      expect(state.speed).toBe(1.0);
    }

    // Elevated speed smoothly decelerates back to 1.0x without abrupt jump
    state.speed = 1.75;
    stepVideoSpeed(state, kickFrame, prefs, 16.67, true);
    expect(state.speed).toBeGreaterThan(1.55);
    expect(state.speed).toBeLessThan(1.75);

    for (let i = 0; i < 160; i++) {
      stepVideoSpeed(state, kickFrame, prefs, 16.67, true);
    }
    expect(state.speed).toBe(1.0);

    // Clamped base speed when minSpeed > 1.0
    const highMinPrefs = makePrefs({ beatSync: false, minSpeed: 1.25, maxSpeed: 2.0 });
    expect(computeBaseVideoSpeed(highMinPrefs)).toBe(1.25);
    const highState = createVideoSpeedState(1.25);
    stepVideoSpeed(highState, kickFrame, highMinPrefs, 16.67, true);
    expect(highState.speed).toBe(1.25);
  });

  it('smoothly accelerates on isolated strong kick and bass_one_shot without abrupt jumping', () => {
    const prefs = makePrefs({ beatSync: true, syncIntensity: 0.85, minSpeed: 0.75, maxSpeed: 2.0 });

    for (const type of ['kick', 'bass_one_shot'] as const) {
      const state = createVideoSpeedState(1.0);
      const hitFrame = makeFrame({
        bassImpact: 0.95,
        events: [{ type, timestamp: 100, intensity: 0.95, confidence: 0.95 }],
      });
      const decayFrame = makeFrame({ timestamp: 116 });

      const first = stepVideoSpeed(state, hitFrame, prefs, 16.67, true).speed;
      // Smooth continuous acceleration: rises above 1.0x but does NOT snap to maxSpeed in one frame
      expect(first).toBeGreaterThan(1.08);
      expect(first).toBeLessThan(1.65);

      let peak = first;
      let prev = first;
      for (let i = 0; i < 8; i++) {
        const next = stepVideoSpeed(state, decayFrame, prefs, 16.67, true).speed;
        expect(Math.abs(next - prev)).toBeLessThan(0.35);
        expect(next).toBeLessThanOrEqual(prefs.maxSpeed);
        expect(next).toBeGreaterThanOrEqual(prefs.minSpeed);
        if (next > peak) peak = next;
        prev = next;
      }
      expect(peak).toBeGreaterThan(1.3);
      expect(peak).toBeLessThanOrEqual(prefs.maxSpeed);

      // Returns smoothly back to 1.0x during silence
      for (let i = 0; i < 160; i++) {
        stepVideoSpeed(state, decayFrame, prefs, 16.67, true);
      }
      expect(state.speed).toBeCloseTo(1.0, 2);
    }
  });

  it('modulates speed rhythmically across bass_sequence hits without collapsing flat at maxSpeed', () => {
    const prefs = makePrefs({ beatSync: true, syncIntensity: 0.85, minSpeed: 0.75, maxSpeed: 2.0 });
    const state = createVideoSpeedState(1.0);

    const peaks: number[] = [];
    const troughs: number[] = [];
    let ts = 0;

    // Simulate 5 sequential bass hits spaced 260 ms apart (~230 BPM / double kick cadence)
    for (let hit = 0; hit < 5; hit++) {
      let cyclePeak = 0;
      let cycleTrough = 99;
      for (let step = 0; step < 16; step++) {
        ts += 16.25;
        const isHitFrame = step === 0;
        const frame = makeFrame({
          timestamp: ts,
          activeSequence: true,
          bassSequenceRate: 0.75,
          events: isHitFrame
            ? [
                {
                  type: 'bass_sequence',
                  timestamp: ts,
                  intensity: 0.88,
                  confidence: 0.92,
                  intervalMs: 260,
                  sequenceCount: hit + 1,
                },
              ]
            : [],
        });
        const speed = stepVideoSpeed(state, frame, prefs, 16.25, true).speed;
        expect(speed).toBeLessThanOrEqual(prefs.maxSpeed);
        if (speed > cyclePeak) cyclePeak = speed;
        if (step >= 10 && speed < cycleTrough) cycleTrough = speed;
      }
      peaks.push(cyclePeak);
      troughs.push(cycleTrough);
    }

    // Every sequential hit produces a distinct rhythmic peak and recovery dip below maxSpeed
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]!).toBeGreaterThan(1.22);
      expect(peaks[i]!).toBeLessThan(prefs.maxSpeed - 0.05);
      expect(peaks[i]! - troughs[i]!).toBeGreaterThan(0.1);
    }
  });

  it('scales bass_sustain and percussion contributions smoothly with syncIntensity', () => {
    const runScenario = (frame: PulseAnalysisFrame, syncIntensity: number, steps = 20) => {
      const state = createVideoSpeedState(1.0);
      const prefs = makePrefs({ syncIntensity, minSpeed: 0.75, maxSpeed: 2.0 });
      let peak = 1.0;
      for (let i = 0; i < steps; i++) {
        const s = stepVideoSpeed(state, i === 0 ? frame : makeFrame({ bassSustain: frame.bassSustain }), prefs, 16.67, true).speed;
        if (s > peak) peak = s;
      }
      return peak;
    };

    const sustainFrame = makeFrame({
      bassSustain: 0.85,
      events: [{ type: 'bass_sustain', timestamp: 100, intensity: 0.85, confidence: 0.9 }],
    });
    const snareFrame = makeFrame({
      events: [{ type: 'snare', timestamp: 100, intensity: 0.9, confidence: 0.9 }],
    });
    const tomFrame = makeFrame({
      events: [{ type: 'tom', timestamp: 100, intensity: 0.9, confidence: 0.9 }],
    });
    const hiHatFrame = makeFrame({
      events: [{ type: 'hi_hat', timestamp: 100, intensity: 0.9, confidence: 0.9 }],
    });
    const kickFrame = makeFrame({
      events: [{ type: 'kick', timestamp: 100, intensity: 0.9, confidence: 0.9 }],
    });

    // Zero intensity yields strict 1.0x
    expect(runScenario(sustainFrame, 0)).toBe(1.0);
    expect(runScenario(snareFrame, 0)).toBe(1.0);

    // Monotonic scaling with syncIntensity
    const sustainHalf = runScenario(sustainFrame, 0.5, 35);
    const sustainFull = runScenario(sustainFrame, 1.0, 35);
    expect(sustainHalf).toBeGreaterThan(1.05);
    expect(sustainFull).toBeGreaterThan(sustainHalf);

    const snareHalf = runScenario(snareFrame, 0.5, 8);
    const snareFull = runScenario(snareFrame, 1.0, 8);
    expect(snareHalf).toBeGreaterThan(1.04);
    expect(snareFull).toBeGreaterThan(snareHalf);

    // Relative musical weighting: kick > snare/tom > hi_hat
    const kickPeak = runScenario(kickFrame, 0.8, 8);
    const snarePeak = runScenario(snareFrame, 0.8, 8);
    const tomPeak = runScenario(tomFrame, 0.8, 8);
    const hiHatPeak = runScenario(hiHatFrame, 0.8, 8);
    expect(kickPeak).toBeGreaterThan(snarePeak);
    expect(snarePeak).toBeGreaterThan(hiHatPeak);
    expect(tomPeak).toBeGreaterThan(hiHatPeak);
    expect(hiHatPeak).toBeGreaterThan(1.01);
  });

  it('suppresses vocal-only passages and smoothly decelerates back to 1.0x', () => {
    const prefs = makePrefs({ beatSync: true, syncIntensity: 0.8, minSpeed: 0.75, maxSpeed: 2.0 });
    const state = createVideoSpeedState(1.0);

    // Vocal-only from idle stays at 1.0x
    const vocalOnlyFrame = makeFrame({
      bassSustain: 0.6,
      bassImpact: 0.5,
      percussion: 0.4,
      vocalLikelihood: 0.86,
      events: [],
    });
    for (let i = 0; i < 30; i++) {
      stepVideoSpeed(state, vocalOnlyFrame, prefs, 16.67, true);
      expect(state.speed).toBe(1.0);
    }

    // Decelerates smoothly from elevated speed during vocal-only passage
    state.speed = 1.65;
    state.impactEnvelope = 0.7;
    const afterOne = stepVideoSpeed(state, vocalOnlyFrame, prefs, 16.67, true).speed;
    expect(afterOne).toBeGreaterThan(1.45);
    expect(afterOne).toBeLessThan(1.65);

    let prev = afterOne;
    for (let i = 0; i < 160; i++) {
      const next = stepVideoSpeed(state, vocalOnlyFrame, prefs, 16.67, true).speed;
      expect(next).toBeLessThanOrEqual(prev);
      expect(prev - next).toBeLessThan(0.1);
      prev = next;
    }
    expect(state.speed).toBe(1.0);
  });

  it('handles pause, track change, and strict minSpeed/maxSpeed bounds safely', () => {
    const prefs = makePrefs({ minSpeed: 0.8, maxSpeed: 1.45, syncIntensity: 1.0 });
    const controller = new VideoSpeedController(1.0);
    const kickFrame = makeFrame({
      bassSustain: 1.0,
      bassImpact: 1.0,
      events: [
        { type: 'kick', timestamp: 10, intensity: 1.0, confidence: 1.0 },
        { type: 'bass_one_shot', timestamp: 10, intensity: 1.0, confidence: 1.0 },
      ],
    });

    for (let i = 0; i < 30; i++) {
      const speed = controller.step(kickFrame, prefs, 16.67, true);
      expect(speed).toBeGreaterThanOrEqual(0.8);
      expect(speed).toBeLessThanOrEqual(1.45);
    }
    expect(controller.state.speed).toBeGreaterThan(1.25);

    // Track change clears transient envelopes and lets speed smoothly glide back
    controller.onTrackChange(prefs);
    expect(controller.state.impactEnvelope).toBe(0);
    expect(controller.state.sequenceEnvelope).toBe(0);
    expect(controller.state.sustainEnvelope).toBe(0);
    expect(controller.state.percussionEnvelope).toBe(0);

    // Pause smoothly decelerates back to 1.0x
    const pausedFirst = controller.step(kickFrame, prefs, 16.67, false);
    expect(pausedFirst).toBeGreaterThan(1.1);
    for (let i = 0; i < 160; i++) {
      controller.step(kickFrame, prefs, 16.67, false);
    }
    expect(controller.state.speed).toBe(1.0);
  });

  it('normalizes edge-case preferences including minSpeed > maxSpeed and NaN values', () => {
    const inverted = normalizeBackgroundVideoPreferences({
      enabled: true,
      minSpeed: 1.5,
      maxSpeed: 1.1,
      syncIntensity: 5,
    });
    expect(inverted.minSpeed).toBe(1.5);
    expect(inverted.maxSpeed).toBe(1.5);
    expect(inverted.syncIntensity).toBe(1);

    const nanPrefs = normalizeBackgroundVideoPreferences({
      minSpeed: Number.NaN,
      maxSpeed: Number.POSITIVE_INFINITY,
      syncIntensity: Number.NEGATIVE_INFINITY,
    });
    expect(nanPrefs).toEqual(DEFAULT_BACKGROUND_VIDEO_PREFERENCES);

    // stepVideoSpeed itself remains finite and bounded even with raw malformed input
    const state = createVideoSpeedState(1.0);
    state.speed = Number.NaN;
    const out = stepVideoSpeed(
      state,
      makeFrame({ events: [{ type: 'kick', timestamp: 1, intensity: Number.NaN, confidence: 1 }] }),
      { minSpeed: 1.4, maxSpeed: 1.1, syncIntensity: Number.NaN, beatSync: true },
      Number.NaN,
      true,
    );
    expect(Number.isFinite(out.speed)).toBe(true);
    expect(out.speed).toBe(1.4);
  });

  it('coalesces DOM playbackRate writes to prevent WebView2 jitter and snaps cleanly on idle', () => {
    const coalescer = createVideoRateCoalescer(1.0);
    const writes: number[] = [];
    let currentRate = 1.0;
    let defaultRate = 1.0;
    const video: VideoPlaybackTarget = {
      get playbackRate() {
        return currentRate;
      },
      set playbackRate(v: number) {
        currentRate = v;
        writes.push(v);
      },
      get defaultPlaybackRate() {
        return defaultRate;
      },
      set defaultPlaybackRate(v: number) {
        defaultRate = v;
      },
    };

    // Micro-delta below 0.015 is suppressed
    expect(
      shouldCommitPlaybackRate(coalescer, 1.0 + RATE_COMMIT_EPSILON * 0.5, 1.0, 100),
    ).toBeNull();
    expect(applyPlaybackRateToVideo(video, coalescer, 1.01, 1.0, 100)).toBe(false);
    expect(writes).toHaveLength(0);

    // Significant change commits cleanly
    expect(applyPlaybackRateToVideo(video, coalescer, 1.24, 1.0, 100)).toBe(true);
    expect(writes).toEqual([1.24]);

    // Rapid update inside 33 ms throttle window is skipped
    expect(
      applyPlaybackRateToVideo(video, coalescer, 1.38, 1.0, 100 + RATE_MIN_INTERVAL_MS - 5),
    ).toBe(false);
    expect(writes).toHaveLength(1);

    // After throttle interval passes, commits smoothly
    expect(
      applyPlaybackRateToVideo(video, coalescer, 1.38, 1.0, 100 + RATE_MIN_INTERVAL_MS + 2),
    ).toBe(true);
    expect(writes).toEqual([1.24, 1.38]);

    // Idle snap back to exact baseSpeed commits cleanly even if close
    expect(applyPlaybackRateToVideo(video, coalescer, 1.001, 1.0, 200)).toBe(true);
    expect(currentRate).toBe(1.0);
    expect(defaultRate).toBe(1.0);
    expect(writes[writes.length - 1]).toBe(1.0);
  });
});
