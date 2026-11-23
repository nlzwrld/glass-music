import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioGraph,
  boostedGain,
  PLAYBACK_FADE_MS,
  PLAYBACK_FADE_SECONDS,
  PlaybackFadeController,
} from '../../src/lib/audioGraph';
import { CollectionPlaybackActions } from '../../src/components/library/CollectionPlaybackActions';
import TrackList from '../../src/components/library/TrackList';
import { SidePlayer } from '../../src/components/player/GlassPlayer';
import { useApp } from '../../src/stores/app';
import { defaults, type Track } from '../../shared/types';

vi.mock('../../src/stores/app', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/stores/app')>();
  const boundUseApp = ((selector?: (s: ReturnType<typeof actual.useApp.getState>) => unknown) => {
    const state = actual.useApp.getState();
    return selector ? selector(state) : state;
  }) as typeof actual.useApp;
  Object.assign(boundUseApp, actual.useApp);
  return {
    ...actual,
    useApp: boundUseApp,
  };
});

vi.mock('react-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

function makeTrack(id: string, title = id): Track {
  return {
    id: `local:${id}`,
    source: 'local',
    sourceId: id,
    kind: 'track',
    title,
    artist: 'Artista Teste',
    duration: 180,
    addedAt: 0,
  };
}

function createMockAudioContext(options: { withCancelAndHold?: boolean } = {}) {
  const withCancelAndHold = options.withCancelAndHold ?? true;
  const gainParams: Array<{
    value: number;
    cancelAndHoldAtTime?: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    setTargetAtTime: ReturnType<typeof vi.fn>;
  }> = [];

  const makeAudioParam = (initial = 1) => {
    const param = {
      value: initial,
      ...(withCancelAndHold ? { cancelAndHoldAtTime: vi.fn() } : {}),
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      linearRampToValueAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      setTargetAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
    };
    gainParams.push(param);
    return param;
  };

  const makeNode = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });

  const ctx = {
    state: 'running',
    currentTime: 10,
    sampleRate: 48000,
    destination: {},
    createBiquadFilter: vi.fn(() => ({
      ...makeNode(),
      type: 'peaking',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: makeAudioParam(0),
    })),
    createGain: vi.fn(() => ({
      ...makeNode(),
      gain: makeAudioParam(1),
    })),
    createDynamicsCompressor: vi.fn(() => ({
      ...makeNode(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
    createAnalyser: vi.fn(() => ({
      ...makeNode(),
      fftSize: 256,
      frequencyBinCount: 128,
      smoothingTimeConstant: 0.78,
      getByteFrequencyData: vi.fn(),
    })),
    createMediaElementSource: vi.fn(() => makeNode()),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };

  return { ctx, gainParams };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Phase 1: PlaybackFadeController (500ms smooth fades & race protection)', () => {
  it('fades out over 500ms on pause before committing element.pause() and fades in over 500ms on resume', () => {
    vi.useFakeTimers();
    const fade = new PlaybackFadeController(PLAYBACK_FADE_MS);
    const rampTo = vi.fn();
    const commitPause = vi.fn();
    const startPlayback = vi.fn();

    expect(PLAYBACK_FADE_MS).toBe(500);
    expect(PLAYBACK_FADE_SECONDS).toBe(0.5);

    fade.pause({
      isPlaying: true,
      currentLevel: 1,
      silent: false,
      rampTo,
      commitPause,
    });

    expect(fade.isFadingOut()).toBe(true);
    expect(rampTo).toHaveBeenCalledWith(0, 0.5);
    expect(commitPause).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(commitPause).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(commitPause).toHaveBeenCalledTimes(1);
    expect(fade.isFadingOut()).toBe(false);

    const resumed = fade.resume({
      wasPaused: true,
      currentLevel: 0,
      silent: false,
      rampTo,
      startPlayback,
    });
    expect(resumed.resumedFromMidFade).toBe(false);
    expect(startPlayback).toHaveBeenCalledTimes(1);
    expect(rampTo).toHaveBeenLastCalledWith(0, 0);
    expect(fade.hasPendingFadeIn()).toBe(true);
    expect(fade.consumePendingFadeIn()).toBe(true);
    expect(fade.consumePendingFadeIn()).toBe(false);
  });

  it('handles rapid pause -> play clicks mid-fade without pausing audio or dropping to zero', () => {
    vi.useFakeTimers();
    const fade = new PlaybackFadeController(PLAYBACK_FADE_MS);
    const rampTo = vi.fn();
    const commitPause = vi.fn();
    const startPlayback = vi.fn();

    fade.pause({
      isPlaying: true,
      currentLevel: 1,
      silent: false,
      rampTo,
      commitPause,
    });

    vi.advanceTimersByTime(180);
    expect(commitPause).not.toHaveBeenCalled();
    expect(fade.isFadingOut()).toBe(true);

    const resumed = fade.resume({
      wasPaused: false,
      currentLevel: 0.64,
      silent: false,
      rampTo,
      startPlayback,
    });

    expect(resumed.resumedFromMidFade).toBe(true);
    expect(fade.isFadingOut()).toBe(false);
    expect(startPlayback).not.toHaveBeenCalled();
    expect(rampTo).toHaveBeenLastCalledWith(1, expect.closeTo(0.18, 3));

    vi.advanceTimersByTime(600);
    expect(commitPause).not.toHaveBeenCalled();
  });

  it('cancels pending pause timer on track change/skip so the new track is never paused', () => {
    vi.useFakeTimers();
    const fade = new PlaybackFadeController(PLAYBACK_FADE_MS);
    const rampTo = vi.fn();
    const commitPause = vi.fn();

    fade.pause({
      isPlaying: true,
      currentLevel: 1,
      silent: false,
      rampTo,
      commitPause,
    });
    vi.advanceTimersByTime(150);
    fade.cancel();
    expect(fade.isFadingOut()).toBe(false);
    expect(fade.hasPendingFadeIn()).toBe(false);

    vi.advanceTimersByTime(600);
    expect(commitPause).not.toHaveBeenCalled();
  });

  it('commits pause immediately when volume is zero (silent)', () => {
    const fade = new PlaybackFadeController(PLAYBACK_FADE_MS);
    const rampTo = vi.fn();
    const commitPause = vi.fn();

    fade.pause({
      isPlaying: true,
      currentLevel: 1,
      silent: true,
      rampTo,
      commitPause,
    });

    expect(fade.isFadingOut()).toBe(false);
    expect(rampTo).toHaveBeenCalledWith(0, 0);
    expect(commitPause).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 1: AudioGraph click-free ramping & volume preservation', () => {
  it('ramps deck gain cleanly via cancelAndHoldAtTime while leaving user boost.gain intact', async () => {
    const { ctx, gainParams } = createMockAudioContext({ withCancelAndHold: true });
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return ctx; }));

    const graph = new AudioGraph();
    const el = {} as HTMLAudioElement;
    graph.attach(el);

    await graph.configure({ ...defaults, volume: 65, volumeBoost: 0 });
    const boostGain = gainParams[5]!;
    const deckGain = gainParams[6]!;
    expect(boostGain.setTargetAtTime).toHaveBeenCalledWith(
      expect.closeTo(boostedGain(65, 0), 4),
      10,
      0.025,
    );

    graph.level(el, 0, 0.5);
    expect(deckGain.cancelAndHoldAtTime).toHaveBeenCalledWith(10);
    expect(deckGain.setValueAtTime).toHaveBeenCalledWith(1, 10);
    expect(deckGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.5);
    expect(graph.getLevel(el)).toBe(0);

    // Clamping bounds out-of-range values cleanly to [0, 1]
    graph.level(el, 3, 0);
    expect(graph.getLevel(el)).toBe(1);
    // Boost gain stays untouched by deck fade ramps
    expect(boostGain.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it('falls back to cancelScheduledValues + setValueAtTime when cancelAndHoldAtTime is unavailable', () => {
    const { ctx, gainParams } = createMockAudioContext({ withCancelAndHold: false });
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return ctx; }));

    const graph = new AudioGraph();
    const el = {} as HTMLAudioElement;
    graph.attach(el);
    const deckGain = gainParams[6]!;
    deckGain.value = 0.72;

    graph.level(el, 0, 0.5);
    expect(deckGain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(deckGain.setValueAtTime).toHaveBeenCalledWith(0.72, 10);
    expect(deckGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.5);
  });
});

describe('Phase 1: Unified Play & Shuffle buttons and duplicate-control removal', () => {
  it('renders CollectionPlaybackActions with shared circle identity and keeps playlist shuffle isolated from player shuffle', () => {
    const t1 = makeTrack('a', 'Faixa A');
    const t2 = makeTrack('b', 'Faixa B');
    useApp.setState({
      queueShuffled: false,
      queueShuffleMode: null,
      data: {
        tracks: [t1, t2],
        playlists: [],
        likes: [],
        history: [],
        // Even with PLAYER shuffle ON, playlist Shuffle Play must NOT falsely light up
        preferences: { ...defaults, shuffle: true },
      },
    });

    const inactiveHtml = renderToStaticMarkup(
      createElement(CollectionPlaybackActions, {
        tracks: [t1, t2],
        activeHere: false,
        playing: false,
        isPlaylist: true,
        contextId: 'playlist:p1',
      }),
    );
    expect(inactiveHtml).toContain('aria-label="Reproduzir playlist"');
    expect(inactiveHtml).toContain('aria-label="Reproduzir playlist no aleatório"');
    expect(inactiveHtml).toContain('collection-action-btn playlist-play');
    expect(inactiveHtml).toContain('collection-action-btn playlist-shuffle-play');
    expect(inactiveHtml).toContain('aria-pressed="false"');
    expect(inactiveHtml).not.toContain('action-active-dot');

    // Only when THIS collection is actively running in playlist-shuffled mode does the button activate
    useApp.setState({
      queueShuffled: true,
      queueShuffleMode: 'smart',
      data: {
        tracks: [t1, t2],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, shuffle: false },
      },
    });

    const activeHtml = renderToStaticMarkup(
      createElement(CollectionPlaybackActions, {
        tracks: [t1, t2],
        activeHere: true,
        playing: true,
        isPlaylist: false,
        contextId: 'collection:demo',
      }),
    );
    expect(activeHtml).toContain('aria-label="Pausar coleção"');
    expect(activeHtml).toContain('aria-label="Reproduzir coleção no aleatório"');
    expect(activeHtml).toContain('is-active');
    expect(activeHtml).toContain('aria-pressed="true"');
    expect(activeHtml).toContain('action-active-dot');
  });

  it('hides duplicate header shuffle button in TrackList when showHeaderShuffle is false', () => {
    const t1 = makeTrack('a', 'Faixa A');
    const t2 = makeTrack('b', 'Faixa B');
    useApp.setState({
      queue: [],
      index: -1,
      data: {
        tracks: [t1, t2],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults },
      },
    });

    const hiddenHtml = renderToStaticMarkup(
      createElement(TrackList, {
        tracks: [t1, t2],
        playlistId: 'p1',
        showHeaderShuffle: false,
      }),
    );
    expect(hiddenHtml).not.toContain('tracklist-shuffle-btn');

    const shownHtml = renderToStaticMarkup(
      createElement(TrackList, {
        tracks: [t1, t2],
      }),
    );
    expect(shownHtml).toContain('tracklist-shuffle-btn');
  });

  it('renders SidePlayer without duplicated transport, seekbar or volume controls', () => {
    const t1 = makeTrack('a', 'Faixa Atual');
    const t2 = makeTrack('b', 'Próxima Faixa');
    vi.stubGlobal('document', { querySelector: () => null, body: {} });
    useApp.setState({
      queue: [t1, t2],
      index: 0,
      shufflePlayed: [],
      shuffleNext: null,
      downloadingIds: [],
      data: {
        tracks: [t1, t2],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, shuffle: false, repeat: 'off' },
      },
    });

    const html = renderToStaticMarkup(createElement(SidePlayer));
    expect(html).toContain('aria-label="Tocando agora"');
    expect(html).toContain('Faixa Atual');
    expect(html).toContain('A seguir');
    expect(html).toContain('Próxima Faixa');
    expect(html).not.toContain('play-main');
    expect(html).not.toContain('volume-control');
    expect(html).not.toContain('compact-seek');
    expect(html).not.toContain('Posição da música');
  });
});
