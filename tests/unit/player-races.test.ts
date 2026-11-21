import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { upcomingIndex, useApp } from '../../src/stores/app';
import {
  handlePlaybackStartError,
  shouldStartPreparedPlayback,
  transport,
} from '../../src/components/player/engine';
import {
  defaults,
  type CollectionPreview,
  type Preferences,
  type Track,
} from '../../shared/types';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function track(id: string, available = true): Track {
  return {
    id: `youtube:${id}`,
    source: 'youtube',
    sourceId: id,
    kind: 'track',
    title: id,
    artist: 'Artist',
    duration: 120,
    addedAt: 0,
    available,
  };
}

function preferences(patch: Partial<Preferences> = {}): Preferences {
  return {
    ...defaults,
    onlineConsent: true,
    onboardingDone: true,
    autoplay: true,
    ...patch,
  };
}

function setPlayback(queue: Track[], index: number, prefs = preferences()) {
  useApp.setState({
    queue,
    index,
    revision: 0,
    playing: false,
    playbackIntent: false,
    autoAdvance: false,
    status: '',
    position: 0,
    shufflePlayed: [],
    shuffleNext: null,
    data: { tracks: queue, playlists: [], likes: [], history: [], preferences: prefs },
  });
}

function preview(name: string): CollectionPreview {
  return { name, artwork: '', url: `https://example.com/${name}`, tracks: [], warning: '', skipped: 0 };
}

beforeEach(() => {
  useApp.setState({
    data: { tracks: [], playlists: [], likes: [], history: [], preferences: preferences() },
    queue: [],
    index: -1,
    revision: 0,
    playing: false,
    playbackIntent: false,
    autoAdvance: false,
    status: '',
    position: 0,
    shufflePlayed: [],
    shuffleNext: null,
    preview: null,
    previewBusy: false,
    page: 'home',
    probeLyrics: vi.fn(async () => false),
    message: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shares prewarm and ended work in one context and advances only once', async () => {
  const request = deferred<Track[]>();
  const recommendations = vi.fn(() => request.promise);
  vi.stubGlobal('window', { glass: { recommendations } });
  const a = track('a');
  const recommended = track('recommended');
  setPlayback([a], 0);

  const prewarm = useApp.getState().extendWithRecommendations();
  expect(useApp.getState().extendWithRecommendations()).toBe(prewarm);
  useApp.getState().next(false);
  useApp.getState().next(false);
  expect(recommendations).toHaveBeenCalledTimes(1);

  request.resolve([recommended]);
  await expect(prewarm).resolves.toBe(true);
  await vi.waitFor(() => expect(useApp.getState().index).toBe(1));
  expect(useApp.getState().queue.map(t => t.id)).toEqual([a.id, recommended.id]);
  expect(useApp.getState().playbackIntent).toBe(true);
  expect(recommendations).toHaveBeenCalledTimes(1);
});

it.each(['play', 'jumpQueue', 'next'] as const)(
  'discards a delayed recommendation after manual %s',
  async action => {
    const request = deferred<Track[]>();
    const recommendations = vi.fn(() => request.promise);
    vi.stubGlobal('window', { glass: { recommendations } });
    const a = track('a');
    const b = track('b');
    const replacement = track('replacement');
    const initial = action === 'play' ? [a] : [a, b];
    setPlayback(initial, action === 'next' ? 0 : initial.length - 1);

    const flight = useApp.getState().extendWithRecommendations();
    if (action !== 'next') useApp.getState().next(false);
    const expectedQueue =
      action === 'play' ? [replacement.id] : action === 'jumpQueue' ? [a.id, b.id] : [a.id, b.id];
    if (action === 'play') useApp.getState().play(replacement, [replacement]);
    if (action === 'jumpQueue') useApp.getState().jumpQueue(0);
    if (action === 'next') useApp.getState().next(true);

    request.resolve([track(`late-${action}`)]);
    await expect(flight).resolves.toBe(false);
    await Promise.resolve();
    expect(useApp.getState().queue.map(t => t.id)).toEqual(expectedQueue);
    expect(useApp.getState().queue.some(t => t.id.includes('late-'))).toBe(false);
    expect(useApp.getState().status).not.toBe('Fim da fila');
    if (action === 'play') expect(useApp.getState().index).toBe(0);
    if (action === 'jumpQueue') expect(useApp.getState().index).toBe(0);
    if (action === 'next') expect(useApp.getState().index).toBe(1);
  },
);

it('starts a new flight when a new context ends before the old flight resolves', async () => {
  const oldRequest = deferred<Track[]>();
  const newRequest = deferred<Track[]>();
  const recommendations = vi
    .fn()
    .mockImplementationOnce(() => oldRequest.promise)
    .mockImplementationOnce(() => newRequest.promise);
  vi.stubGlobal('window', { glass: { recommendations } });
  const a = track('a');
  const b = track('b');
  const oldRecommendation = track('old-recommendation');
  const newRecommendation = track('new-recommendation');
  setPlayback([a], 0);

  const oldFlight = useApp.getState().extendWithRecommendations();
  useApp.getState().next(false);
  useApp.getState().play(b, [b]);
  const newFlight = useApp.getState().extendWithRecommendations();
  useApp.getState().next(false);
  expect(newFlight).not.toBe(oldFlight);
  expect(recommendations).toHaveBeenCalledTimes(2);

  newRequest.resolve([newRecommendation]);
  await expect(newFlight).resolves.toBe(true);
  await vi.waitFor(() => expect(useApp.getState().index).toBe(1));
  expect(useApp.getState().queue.map(t => t.id)).toEqual([b.id, newRecommendation.id]);

  oldRequest.resolve([oldRecommendation]);
  await expect(oldFlight).resolves.toBe(false);
  await Promise.resolve();
  expect(useApp.getState().queue.map(t => t.id)).toEqual([b.id, newRecommendation.id]);
  expect(useApp.getState().index).toBe(1);
});

it('advances to a track enqueued while recommendations are in flight', async () => {
  const request = deferred<Track[]>();
  const recommendations = vi.fn(() => request.promise);
  vi.stubGlobal('window', { glass: { recommendations } });
  const a = track('a');
  const enqueued = track('enqueued');
  setPlayback([a], 0);

  const flight = useApp.getState().extendWithRecommendations();
  useApp.getState().next(false);
  useApp.getState().enqueue(enqueued);
  expect(useApp.getState().extendWithRecommendations()).toBe(flight);

  request.resolve([]);
  await expect(flight).resolves.toBe(false);
  await vi.waitFor(() => expect(useApp.getState().index).toBe(1));
  expect(useApp.getState().queue.map(t => t.id)).toEqual([a.id, enqueued.id]);
  expect(useApp.getState().status).not.toBe('Fim da fila');
});

it('keeps resolved-track queue replacements in the same autoplay context', async () => {
  const request = deferred<Track[]>();
  const recommendations = vi.fn(() => request.promise);
  vi.stubGlobal('window', { glass: { recommendations } });
  const a = track('a');
  const recommended = track('recommended');
  setPlayback([a], 0);

  const flight = useApp.getState().extendWithRecommendations();
  useApp.getState().next(false);
  useApp.getState().applyResolvedTrack({ ...a, playbackId: 'resolved-a' }, false);
  expect(useApp.getState().extendWithRecommendations()).toBe(flight);

  request.resolve([recommended]);
  await expect(flight).resolves.toBe(true);
  await vi.waitFor(() => expect(useApp.getState().index).toBe(1));
  expect(useApp.getState().queue[0]?.playbackId).toBe('resolved-a');
  expect(useApp.getState().queue.map(t => t.id)).toEqual([a.id, recommended.id]);
});

it('skips unavailable tracks sequentially, including wrapped repeat and manual navigation', () => {
  const a = track('a');
  const unavailable = track('unavailable', false);
  const c = track('c');
  setPlayback([a, unavailable, c], 0, preferences({ repeat: 'off' }));
  expect(upcomingIndex(useApp.getState(), false)).toBe(2);

  useApp.setState({ index: 2 });
  expect(upcomingIndex(useApp.getState(), false)).toBe(-1);
  useApp.setState({
    data: { ...useApp.getState().data, preferences: preferences({ repeat: 'all' }) },
  });
  expect(upcomingIndex(useApp.getState(), false)).toBe(0);
  expect(upcomingIndex(useApp.getState(), true)).toBe(0);

  setPlayback([a, unavailable], 0, preferences({ repeat: 'off' }));
  expect(upcomingIndex(useApp.getState(), false)).toBe(-1);
  expect(upcomingIndex(useApp.getState(), true)).toBe(0);
  setPlayback([track('also-unavailable', false), unavailable], 0, preferences({ repeat: 'all' }));
  expect(upcomingIndex(useApp.getState(), false)).toBe(-1);
  expect(upcomingIndex(useApp.getState(), true)).toBe(-1);
});

it('keeps only the newest collection result when responses resolve out of order', async () => {
  const first = deferred<CollectionPreview>();
  const second = deferred<CollectionPreview>();
  const previewCollection = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  vi.stubGlobal('window', { glass: { previewCollection } });
  setPlayback([], -1);

  const oldOpen = useApp.getState().openCollection('https://example.com/old', 'Old');
  await vi.waitFor(() => expect(previewCollection).toHaveBeenCalledTimes(1));
  const newOpen = useApp.getState().openCollection('https://example.com/new', 'New');
  await vi.waitFor(() => expect(previewCollection).toHaveBeenCalledTimes(2));

  second.resolve(preview('new-result'));
  await newOpen;
  first.resolve(preview('old-result'));
  await oldOpen;
  expect(useApp.getState().preview?.name).toBe('new-result');
  expect(useApp.getState().previewBusy).toBe(false);
});

it('ignores an obsolete collection error and does not finish the newest busy state', async () => {
  const first = deferred<CollectionPreview>();
  const second = deferred<CollectionPreview>();
  const previewCollection = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  vi.stubGlobal('window', { glass: { previewCollection } });
  setPlayback([], -1);

  const oldOpen = useApp.getState().openCollection('https://example.com/old', 'Old');
  await vi.waitFor(() => expect(previewCollection).toHaveBeenCalledTimes(1));
  const newOpen = useApp.getState().openCollection('https://example.com/new', 'New');
  await vi.waitFor(() => expect(previewCollection).toHaveBeenCalledTimes(2));

  first.reject(new Error('obsolete failure'));
  await oldOpen;
  expect(useApp.getState().message).not.toHaveBeenCalled();
  expect(useApp.getState().preview?.name).toBe('New');
  expect(useApp.getState().previewBusy).toBe(true);

  second.resolve(preview('new-result'));
  await newOpen;
  expect(useApp.getState().preview?.name).toBe('new-result');
  expect(useApp.getState().previewBusy).toBe(false);
});

it('gates delayed preparation by playback intent and supports pausing and resuming', async () => {
  const a = track('a');
  setPlayback([a], 0);
  const playPrepared = vi.fn();
  const first = deferred<void>();
  const firstAttempt = first.promise.then(() => {
    if (shouldStartPreparedPlayback(false, useApp.getState().playbackIntent)) playPrepared();
  });

  useApp.getState().play(a, [a]);
  expect(useApp.getState().status).toBe('Carregando');
  expect(useApp.getState().playbackIntent).toBe(true);
  transport.toggle();
  expect(useApp.getState().playbackIntent).toBe(false);
  expect(useApp.getState().status).toBe('Pausado');

  first.resolve();
  await firstAttempt;
  expect(playPrepared).not.toHaveBeenCalled();

  transport.toggle();
  expect(useApp.getState().playbackIntent).toBe(true);
  const second = deferred<void>();
  const secondAttempt = second.promise.then(() => {
    if (shouldStartPreparedPlayback(false, useApp.getState().playbackIntent)) playPrepared();
  });
  second.resolve();
  await secondAttempt;
  expect(playPrepared).toHaveBeenCalledTimes(1);

  transport.pause();
  expect(useApp.getState().playbackIntent).toBe(false);
  transport.play();
  expect(useApp.getState().playbackIntent).toBe(true);
});

it('clears blocked playback explicitly so one subsequent click retries', () => {
  const a = track('a');
  setPlayback([a], 0);
  useApp.setState({ playing: true, playbackIntent: true, status: 'Carregando' });

  expect(handlePlaybackStartError({ name: 'NotAllowedError' })).toBe(true);
  expect(useApp.getState()).toMatchObject({
    playing: false,
    playbackIntent: false,
    status: 'Pausado',
  });
  transport.toggle();
  expect(useApp.getState().playbackIntent).toBe(true);
  expect(handlePlaybackStartError({ name: 'AbortError' })).toBe(false);
});

it('clears playback intent at a real end and sets it on queue navigation', () => {
  const a = track('a');
  const b = track('b');
  setPlayback([a, b], 0, preferences({ autoplay: false, repeat: 'off' }));
  useApp.getState().play(a, [a, b]);
  useApp.getState().next(true);
  expect(useApp.getState().index).toBe(1);
  expect(useApp.getState().playbackIntent).toBe(true);

  useApp.setState({ playing: true });
  useApp.getState().next(false);
  expect(useApp.getState().status).toBe('Fim da fila');
  expect(useApp.getState().playing).toBe(false);
  expect(useApp.getState().playbackIntent).toBe(false);

  useApp.getState().previous();
  expect(useApp.getState().playbackIntent).toBe(true);
  useApp.getState().jumpQueue(0);
  expect(useApp.getState().playbackIntent).toBe(true);
});

it('keeps playback intent when previous rewinds the current track', () => {
  const a = track('a');
  setPlayback([a], 0);
  useApp.setState({ position: 12, playing: false, playbackIntent: false });

  useApp.getState().previous();
  expect(useApp.getState().position).toBe(0);
  expect(useApp.getState().playbackIntent).toBe(true);
});
