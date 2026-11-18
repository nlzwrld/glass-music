import { afterEach, expect, it, vi } from 'vitest';
import {
  invalidatePlayback,
  preparePlayback,
  shufflePlay,
  shuffleTracks,
} from '../../src/lib/playback';
import { useApp } from '../../src/stores/app';
import { defaults, type Track } from '../../shared/types';

const track = (id: string): Track => ({
  id: 'youtube:' + id,
  source: 'youtube',
  sourceId: id,
  title: 'Example ' + id,
  artist: 'Artist',
  duration: 20,
  kind: 'track',
  addedAt: 0,
});

afterEach(() => {
  invalidatePlayback();
  vi.unstubAllGlobals();
});

it('reuses a pending hover preparation when the same song is played', async () => {
  let finish: (value: { url: string; duration: number }) => void = () => {};
  const audioSource = vi.fn(() => new Promise<{ url: string; duration: number }>(r => (finish = r)));
  const cancelSearch = vi.fn(async () => {});
  vi.stubGlobal('window', { glass: { audioSource, cancelSearch } });
  const t = track('dedup123456');
  const warm = preparePlayback(t, false),
    playing = preparePlayback(t, true);
  warm.release();
  expect(audioSource).toHaveBeenCalledTimes(1);
  expect(cancelSearch).not.toHaveBeenCalled();
  finish({ url: 'http://127.0.0.1/test', duration: 20 });
  await expect(playing.promise).resolves.toMatchObject({ track: t, source: { duration: 20 } });
  playing.release();
});

it('cancels speculative work before preparing a different selected song', async () => {
  const cancelSearch = vi.fn(async () => {});
  const audioSource = vi.fn(async () => ({ url: 'http://127.0.0.1/test', duration: 20 }));
  vi.stubGlobal('window', { glass: { audioSource, cancelSearch } });
  const warm = preparePlayback(track('warm1234567'), false);
  const selected = preparePlayback(track('live1234567'));
  expect(cancelSearch).toHaveBeenCalledTimes(1);
  await expect(warm.promise).rejects.toThrow('cancelada');
  await selected.promise;
  warm.release();
  selected.release();
});

it('drops prepared tickets when online permission is revoked', async () => {
  const audioSource = vi.fn(async () => ({ url: 'http://127.0.0.1/test', duration: 20 }));
  vi.stubGlobal('window', { glass: { audioSource, cancelSearch: vi.fn(async () => {}) } });
  const t = track('reset123456');
  const first = preparePlayback(t);
  await first.promise;
  first.release();
  invalidatePlayback();
  const second = preparePlayback(t);
  await second.promise;
  second.release();
  expect(audioSource).toHaveBeenCalledTimes(2);
});

it('shuffles tracks with Fisher-Yates without mutating original order', () => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f'];
  const copy = [...original];
  // Deterministic RNG sequence
  const seq = [0.1, 0.8, 0.3, 0.9, 0.2];
  let idx = 0;
  const out = shuffleTracks(original, () => seq[idx++ % seq.length]!);
  expect(original).toEqual(copy);
  expect([...out].sort()).toEqual([...original].sort());
  expect(out).not.toEqual(original);
});

it('activates shuffle mode and starts playback on a random track via shufflePlay', async () => {
  const preferences = vi.fn(async (p: any) => p);
  vi.stubGlobal('window', {
    glass: {
      preferences,
      cancelSearch: vi.fn(async () => {}),
    },
  });

  const collection: Track[] = [
    track('song_000001'),
    track('song_000002'),
    track('song_000003'),
    track('song_000004'),
    { ...track('unavailable_05'), available: false },
  ];

  useApp.setState({
    queue: [],
    index: -1,
    playing: false,
    data: {
      tracks: collection,
      playlists: [],
      likes: [],
      history: [],
      preferences: { ...defaults, onlineConsent: true, onboardingDone: true, shuffle: false },
    },
  });

  const started = shufflePlay(collection, () => 0.25);
  expect(started).not.toBeNull();
  const state = useApp.getState();
  expect(state.status).toBe('Carregando');
  expect(state.index).toBe(0);
  expect(state.shufflePlayed).toEqual([0]);
  expect(state.queue).toHaveLength(4);
  expect(state.queue[0]?.id).toBe(started!.id);
  expect(state.data.preferences.shuffle).toBe(true);
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledOnce());
});

it('displays "Sincronizando fonte de áudio..." for unresolved Spotify tracks and resolves via window.glass.resolveStream', async () => {
  const spotifyTrack: Track = {
    id: 'link:sp_blinding_lights_hash',
    source: 'link',
    sourceId: 'sp_blinding_lights_hash',
    kind: 'track',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    duration: 200.04,
    durationMs: 200040,
    catalogSource: 'spotify',
    url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    addedAt: 0,
  };

  const resolveStream = vi.fn(async (t: Track) => ({
    track: {
      ...t,
      streamProvider: 'ytmusic' as const,
      resolvedExternalId: '4NRXx6U8ABQ',
      playbackId: '4NRXx6U8ABQ',
    },
    provider: 'ytmusic' as const,
    externalId: '4NRXx6U8ABQ',
    streamUrl: 'http://127.0.0.1:42000/audio/ticket-ytm',
    duration: 200,
    durationDeltaMs: 40,
    score: 99,
    fromCache: false,
  }));

  vi.stubGlobal('window', {
    glass: {
      resolveStream,
      cancelSearch: vi.fn(async () => {}),
    },
  });

  useApp.setState({
    queue: [],
    index: -1,
    data: {
      tracks: [spotifyTrack],
      playlists: [],
      likes: [],
      history: [],
      preferences: { ...defaults, onlineConsent: true, onboardingDone: true },
    },
  });

  useApp.getState().play(spotifyTrack, [spotifyTrack]);
  expect(useApp.getState().status).toBe('Sincronizando fonte de áudio...');

  const prepared = preparePlayback(spotifyTrack);
  const result = await prepared.promise;
  prepared.release();

  expect(resolveStream).toHaveBeenCalledOnce();
  expect(result.track.catalogSource).toBe('spotify');
  expect(result.track.streamProvider).toBe('ytmusic');
  expect(result.source.url).toBe('http://127.0.0.1:42000/audio/ticket-ytm');
});
