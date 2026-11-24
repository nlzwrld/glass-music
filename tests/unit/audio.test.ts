import { afterEach, expect, it, vi } from 'vitest';
import { boostedGain, computeBassModulation, transitionSeconds } from '../../src/lib/audioGraph';
import {
  invalidatePlayback,
  NOW_PLAYING_NOTIFICATION_TAG,
  preparePlayback,
  TrackNotificationController,
} from '../../src/lib/playback';
import { detectPlatform } from '../../src/components/glass/controls';
import { upcomingIndex, useApp } from '../../src/stores/app';
import { useUpdateNotice } from '../../src/lib/updates';
import { defaults, resolveNotificationMode, type Track } from '../../shared/types';

afterEach(() => {
  invalidatePlayback();
  vi.unstubAllGlobals();
});

it('keeps zero volume silent with booster and bounds invalid transition values', () => {
  expect(boostedGain(0, 12)).toBe(0);
  expect(boostedGain(100, 6)).toBeCloseTo(1.995, 2);
  expect(boostedGain(200, 99)).toBeCloseTo(3.981, 2);
  expect(transitionSeconds(NaN)).toBe(3);
  expect(transitionSeconds(100)).toBe(10);
  expect(transitionSeconds(-1)).toBe(0.5);
});

it('modulates audio-reactive WebGL bass uniform from sub-bass/bass FFT bins while gating noise floor', () => {
  const silent = new Uint8Array(128).fill(10);
  expect(computeBassModulation(silent, 48000, 256).bass).toBe(0);

  // High-hat / treble-only energy does not falsely trigger bass refraction
  const trebleOnly = new Uint8Array(128).fill(0);
  for (let i = 40; i < 128; i++) trebleOnly[i] = 240;
  expect(computeBassModulation(trebleOnly, 48000, 256).bass).toBe(0);

  // Strong kick/sub-bass bins (~20-185 Hz -> bins 1..2 at 48kHz/256) produce smooth bounded (0, 1] modulation
  const bassHit = new Uint8Array(128).fill(0);
  bassHit[1] = 235;
  bassHit[2] = 210;
  const frame = computeBassModulation(bassHit, 48000, 256);
  expect(frame.bass).toBeGreaterThan(0.7);
  expect(frame.bass).toBeLessThanOrEqual(1);
  expect(frame.energy).toBeGreaterThan(0.5);

  // High-resolution 2048 FFT (~23.4 Hz/bin at 48 kHz) resolves tight 47-70 Hz 808 kicks cleanly
  const sub808 = new Uint8Array(1024).fill(0);
  sub808[2] = 240; // ~47 Hz
  sub808[3] = 225; // ~70 Hz
  const hiRes = computeBassModulation(sub808, 48000, 2048);
  expect(hiRes.subBass).toBeGreaterThan(0.5);
  expect(hiRes.bass).toBeGreaterThan(0.45);

  // Loud vocals / guitars / snares (160–2500 Hz) with spectral leakage below 110 Hz do NOT falsely pulse
  const vocalsAndGuitars = new Uint8Array(2048).fill(0);
  for (let i = 2; i <= 9; i++) vocalsAndGuitars[i] = 95; // low-level spectral bleed
  for (let i = 14; i <= 180; i++) vocalsAndGuitars[i] = 235; // loud vocals & guitars
  const vocalFrame = computeBassModulation(vocalsAndGuitars, 48000, 4096);
  expect(vocalFrame.bass).toBe(0);
  expect(vocalFrame.subBass).toBe(0);
});

it('detects Spotify, Deezer, Apple Music, YT Music, Bandcamp and Tidal badges from track URLs', () => {
  expect(detectPlatform('link', 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(
    'spotify',
  );
  expect(detectPlatform('link', 'https://www.deezer.com/track/916424')).toBe('deezer');
  expect(detectPlatform('link', 'https://music.apple.com/br/album/617154241?i=617154366')).toBe(
    'apple',
  );
  expect(detectPlatform('youtube', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
    'ytmusic',
  );
  expect(detectPlatform('link', 'https://c418.bandcamp.com/track/sweden')).toBe('bandcamp');
  expect(detectPlatform('link', 'https://tidal.com/track/123456')).toBe('tidal');
  expect(detectPlatform('local')).toBe('local');
});

it('keeps deterministic upcoming track in shuffle mode and supports playNext + moveQueue', () => {
  const a: Track = {
    id: 'local:a',
    source: 'local',
    sourceId: 'a',
    kind: 'track',
    title: 'A',
    artist: 'X',
    duration: 100,
    addedAt: 0,
  };
  const b: Track = {
    id: 'local:b',
    source: 'local',
    sourceId: 'b',
    kind: 'track',
    title: 'B',
    artist: 'X',
    duration: 100,
    addedAt: 0,
  };
  const c: Track = {
    id: 'local:c',
    source: 'local',
    sourceId: 'c',
    kind: 'track',
    title: 'C',
    artist: 'X',
    duration: 100,
    addedAt: 0,
  };
  useApp.setState({
    queue: [a, b],
    index: 0,
    shufflePlayed: [0],
    shuffleNext: 1,
    data: {
      tracks: [a, b, c],
      playlists: [],
      likes: [],
      history: [],
      preferences: { ...defaults, shuffle: true },
    },
  });
  expect(upcomingIndex(useApp.getState())).toBe(1);
  useApp.getState().playNext(c);
  expect(useApp.getState().queue.map(t => t.id)).toEqual(['local:a', 'local:c', 'local:b']);
  expect(upcomingIndex(useApp.getState())).toBe(1);
  useApp.getState().moveQueue(2, 0);
  expect(useApp.getState().queue.map(t => t.id)).toEqual(['local:b', 'local:a', 'local:c']);
  expect(useApp.getState().index).toBe(1);
});

it('never repeats any song in shuffle mode until every playable song has been played, while allowing manual replay', () => {
  const list: Track[] = Array.from({ length: 10 }, (_, i) => ({
    id: `local:s${i}`,
    source: 'local',
    sourceId: `s${i}`,
    kind: 'track',
    title: `Song ${i}`,
    artist: 'Artist',
    duration: 120,
    addedAt: 0,
  }));
  for (let trial = 0; trial < 20; trial++) {
    useApp.setState({
      queue: [],
      index: -1,
      shufflePlayed: [],
      shuffleNext: null,
      status: '',
      data: {
        tracks: list,
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, shuffle: true, repeat: 'off' },
      },
    });
    useApp.getState().play(list[3], list);
    const visited = [useApp.getState().queue[useApp.getState().index].id];
    for (let step = 0; step < 9; step++) {
      const predicted = upcomingIndex(useApp.getState(), false);
      useApp.getState().next(false);
      expect(useApp.getState().index).toBe(predicted);
      visited.push(useApp.getState().queue[useApp.getState().index].id);
    }
    expect(new Set(visited).size).toBe(10);
    expect(upcomingIndex(useApp.getState(), false)).toBe(-1);
    useApp.getState().next(false);
    expect(useApp.getState().status).toBe('Fim da fila');
  }
  useApp.setState({
    queue: [],
    index: -1,
    shufflePlayed: [],
    shuffleNext: null,
    status: '',
    data: {
      tracks: list,
      playlists: [],
      likes: [],
      history: [],
      preferences: { ...defaults, shuffle: true, repeat: 'all' },
    },
  });
  useApp.getState().play(list[0], list);
  const cycle1 = [useApp.getState().queue[useApp.getState().index].id];
  for (let i = 0; i < 9; i++) {
    useApp.getState().next(false);
    cycle1.push(useApp.getState().queue[useApp.getState().index].id);
  }
  expect(new Set(cycle1).size).toBe(10);
  const lastOfCycle1 = cycle1[9];
  const cycle2: string[] = [];
  for (let i = 0; i < 10; i++) {
    useApp.getState().next(false);
    cycle2.push(useApp.getState().queue[useApp.getState().index].id);
  }
  expect(cycle2[0]).not.toBe(lastOfCycle1);
  expect(new Set(cycle2).size).toBe(10);

  useApp.setState({
    queue: [],
    index: -1,
    shufflePlayed: [],
    shuffleNext: null,
    status: '',
    data: {
      tracks: list,
      playlists: [],
      likes: [],
      history: [],
      preferences: { ...defaults, shuffle: true, repeat: 'off' },
    },
  });
  useApp.getState().play(list[2], list);
  useApp.getState().next(false);
  useApp.getState().next(false);
  const heardSoFar = new Set(useApp.getState().shufflePlayed.map(i => list[i].id));
  expect(heardSoFar.size).toBe(3);
  useApp.getState().play(list[2], list);
  expect(useApp.getState().queue[useApp.getState().index].id).toBe('local:s2');
  const remaining: string[] = [];
  for (let i = 0; i < 7; i++) {
    useApp.getState().next(false);
    remaining.push(useApp.getState().queue[useApp.getState().index].id);
  }
  expect(remaining.every(id => !heardSoFar.has(id))).toBe(true);
  expect(new Set([...heardSoFar, ...remaining]).size).toBe(10);
});

it('uses saved audio before trying remote matching or extraction', async () => {
  const offlineSource = vi.fn(async () => ({ url: 'http://127.0.0.1/offline/file', duration: 213 }));
  const audioSource = vi.fn();
  const linkPlayback = vi.fn();
  vi.stubGlobal('window', {
    glass: { offlineSource, audioSource, linkPlayback, cancelSearch: vi.fn(async () => {}) },
  });
  const track: Track = {
    id: 'link:offline',
    source: 'link',
    sourceId: 'offline',
    kind: 'track',
    title: 'Saved song',
    artist: 'Artist',
    duration: 213,
    addedAt: 0,
    offline: true,
  };
  const prepared = preparePlayback(track);
  await expect(prepared.promise).resolves.toMatchObject({
    source: { url: 'http://127.0.0.1/offline/file' },
  });
  prepared.release();
  expect(offlineSource).toHaveBeenCalledOnce();
  expect(audioSource).not.toHaveBeenCalled();
  expect(linkPlayback).not.toHaveBeenCalled();
});

it('extends finished playlist with outside-playlist style recommendations when autoplay is enabled', async () => {
  expect(defaults.autoplay).toBe(true);
  expect(defaults.uiStyle).toBe('matte');
  const p1: Track = {
    id: 'youtube:v1',
    source: 'youtube',
    sourceId: 'v1',
    kind: 'track',
    title: 'Montagem 1',
    artist: 'DJ Test',
    duration: 150,
    addedAt: 0,
  };
  const p2: Track = {
    id: 'youtube:v2',
    source: 'youtube',
    sourceId: 'v2',
    kind: 'track',
    title: 'Montagem 2',
    artist: 'DJ Test',
    duration: 155,
    addedAt: 0,
  };
  const rec1: Track = {
    id: 'youtube:r1',
    source: 'youtube',
    sourceId: 'r1',
    kind: 'track',
    title: 'Montagem Nova',
    artist: 'DJ Outro',
    duration: 160,
    addedAt: 0,
  };
  const recommendations = vi.fn(async () => [p1, rec1]);
  vi.stubGlobal('window', { glass: { recommendations, cancelSearch: vi.fn(async () => {}) } });
  useApp.setState({
    queue: [p1, p2],
    index: 1,
    shufflePlayed: [0, 1],
    shuffleNext: null,
    data: {
      tracks: [p1, p2],
      playlists: [],
      likes: [],
      history: [],
      preferences: {
        ...defaults,
        onlineConsent: true,
        onboardingDone: true,
        autoplay: true,
        shuffle: true,
        repeat: 'off',
      },
    },
  });
  expect(upcomingIndex(useApp.getState(), false)).toBe(-1);
  const added = await useApp.getState().extendWithRecommendations();
  expect(added).toBe(true);
  expect(recommendations).toHaveBeenCalledOnce();
  expect(useApp.getState().queue.map(t => t.id)).toEqual(['youtube:v1', 'youtube:v2', 'youtube:r1']);
  expect(useApp.getState().queue[2].recommended).toBe(true);
  expect(upcomingIndex(useApp.getState(), false)).toBe(2);
  useApp.getState().clearQueue();
  expect(useApp.getState().queue.map(t => t.id)).toEqual(['youtube:v2']);
  expect(useApp.getState().index).toBe(0);
});

it('tracks available updates, supports dismissal and triggers immediate install on Atualizar agora', async () => {
  const updateStatus = vi.fn(async () => ({
    configured: true,
    available: true,
    version: '2.3.0',
    message: 'Versão 2.3.0 disponível.',
  }));
  vi.stubGlobal('window', { glass: { updateStatus, cancelSearch: vi.fn(async () => {}) } });
  useUpdateNotice.setState({ availableVersion: '', dismissedVersion: '', installing: false });
  useUpdateNotice.getState().setAvailable('2.3.0');
  expect(useUpdateNotice.getState().availableVersion).toBe('2.3.0');
  await useUpdateNotice.getState().installNow();
  expect(updateStatus).toHaveBeenCalledWith(true);
  useUpdateNotice.setState({ installing: false });
  useUpdateNotice.getState().dismiss();
  expect(useUpdateNotice.getState().dismissedVersion).toBe('2.3.0');
});

it('suppresses notification spam across 5 rapid skips (<2s), blocks focused/off states, and deduplicates single-slot playback', () => {
  vi.useFakeTimers();
  try {
    expect(defaults.notificationMode).toBe('off');
    expect(defaults.notifications).toBe(false);
    expect(resolveNotificationMode(defaults)).toBe('off');

    const notifySpy = vi.fn();
    const controller = new TrackNotificationController(notifySpy);

    const tracks = Array.from({ length: 5 }, (_, i) => ({
      id: `youtube:skip_track_${i + 1}`,
      title: `Faixa ${i + 1}`,
      artist: `Artista ${i + 1}`,
    }));

    // 1. Simulate 5 rapid skips within 1.6 seconds (400ms apart) while in background
    for (let i = 0; i < 5; i++) {
      controller.onTrackChange(tracks[i]!);
      controller.onPlaybackUpdate({
        isPlaying: true,
        currentTime: 0.4,
        mode: 'background',
        isFocused: false,
      });
      if (i < 4) vi.advanceTimersByTime(400); // 4 * 400ms = 1600ms (< 2s total!)
    }

    // Zero notifications fired during the rapid skip sequence!
    expect(notifySpy).not.toHaveBeenCalled();

    // 2. With mode 'off' (Desativado), zero notifications even after 5s and currentTime > 2.5s
    controller.onPlaybackUpdate({
      isPlaying: true,
      currentTime: 6.0,
      mode: 'off',
      isFocused: false,
    });
    vi.advanceTimersByTime(5000);
    expect(notifySpy).not.toHaveBeenCalled();

    // 3. With mode 'background' while window is focused (isFocused: true), zero notifications!
    controller.onPlaybackUpdate({
      isPlaying: true,
      currentTime: 8.0,
      mode: 'background',
      isFocused: true,
    });
    vi.advanceTimersByTime(5000);
    expect(notifySpy).not.toHaveBeenCalled();

    // 4. Unfocused background playback: still blocked if currentTime <= 2.5s when 3000ms elapses
    controller.onTrackChange(tracks[4]!);
    controller.onPlaybackUpdate({
      isPlaying: true,
      currentTime: 1.8,
      mode: 'background',
      isFocused: false,
    });
    vi.advanceTimersByTime(3000);
    expect(notifySpy).not.toHaveBeenCalled();

    // Once real playback crosses currentTime > 2.5s after 3s stabilization -> dispatches ONCE for Track 5!
    controller.onPlaybackUpdate({
      isPlaying: true,
      currentTime: 2.9,
      mode: 'background',
      isFocused: false,
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith({
      id: 'youtube:skip_track_5',
      title: 'Faixa 5',
      artist: 'Artista 5',
      tag: NOW_PLAYING_NOTIFICATION_TAG,
      renotify: false,
      silent: true,
    });

    // 5. Pause -> Play -> Seek on the same Track 5 NEVER fires a duplicate notification!
    controller.onPlaybackUpdate({
      isPlaying: false,
      currentTime: 15,
      mode: 'background',
      isFocused: false,
    });
    controller.onPlaybackUpdate({
      isPlaying: true,
      currentTime: 45,
      mode: 'always',
      isFocused: false,
    });
    vi.advanceTimersByTime(4000);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});
