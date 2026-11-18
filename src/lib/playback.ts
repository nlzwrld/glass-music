import {
  canPlay,
  isCatalogOnlyTrack,
  type NotificationMode,
  type StreamProvider,
  type Track,
} from '../../shared/types';
import { useApp } from '../stores/app';

export const NOW_PLAYING_NOTIFICATION_TAG = 'liquid-hub-now-playing';
export const TRACK_NOTIFY_DEBOUNCE_MS = 3000;
export const TRACK_NOTIFY_MIN_PLAY_SEC = 2.5;

export interface NotificationPayload {
  id: string;
  title: string;
  artist: string;
  tag: typeof NOW_PLAYING_NOTIFICATION_TAG;
  renotify: false;
  silent: true;
}

export interface PlaybackNotificationSnapshot {
  isPlaying: boolean;
  currentTime: number;
  mode: NotificationMode;
  isFocused: boolean;
}

/**
 * Anti-spam notification controller:
 * - Never fires on immediate track change or rapid skip sequences.
 * - Requires 3000ms continuous playback debounce + `currentTime > 2.5s` + `isPlaying === true`.
 * - Suppresses notifications when `mode === 'off'` (default) or when app window is focused in `background` mode.
 * - Deduplicates via `lastNotifiedTrackId` and emits single-slot silent replacement payloads (`tag: 'liquid-hub-now-playing'`, `renotify: false`).
 */
export class TrackNotificationController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeTrack: Pick<Track, 'id' | 'title' | 'artist'> | null = null;
  private lastNotifiedTrackId: string | null = null;
  private debounceElapsed = false;
  private latest: PlaybackNotificationSnapshot = {
    isPlaying: false,
    currentTime: 0,
    mode: 'off',
    isFocused: true,
  };

  constructor(
    private readonly dispatch: (payload: NotificationPayload) => void | Promise<void> = payload =>
      window.glass?.notify(payload),
    private readonly debounceMs = TRACK_NOTIFY_DEBOUNCE_MS,
    private readonly minPlaySeconds = TRACK_NOTIFY_MIN_PLAY_SEC,
  ) {}

  get lastNotifiedId(): string | null {
    return this.lastNotifiedTrackId;
  }

  onTrackChange(track: Pick<Track, 'id' | 'title' | 'artist'> | null) {
    this.cancelTimer();
    this.activeTrack = track ? { id: track.id, title: track.title, artist: track.artist } : null;
  }

  onPlaybackUpdate(snapshot: PlaybackNotificationSnapshot) {
    this.latest = snapshot;
    if (!this.activeTrack || !snapshot.isPlaying || snapshot.mode === 'off') {
      this.cancelTimer();
      return;
    }
    if (this.lastNotifiedTrackId === this.activeTrack.id) {
      this.cancelTimer();
      return;
    }
    if (this.debounceElapsed) {
      this.tryDispatch();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.debounceElapsed = true;
        this.tryDispatch();
      }, this.debounceMs);
    }
  }

  dispose() {
    this.cancelTimer();
    this.activeTrack = null;
  }

  private cancelTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.debounceElapsed = false;
  }

  private tryDispatch() {
    const track = this.activeTrack;
    const { isPlaying, currentTime, mode, isFocused } = this.latest;
    if (!track || !isPlaying || mode === 'off') {
      this.cancelTimer();
      return;
    }
    if (this.lastNotifiedTrackId === track.id) return;
    // Wait until real audio position exceeds 2.5s
    if (!Number.isFinite(currentTime) || currentTime <= this.minPlaySeconds) {
      return;
    }
    // Focus-Aware suppression: never notify if user is looking at the focused app window in background mode
    if (mode === 'background' && isFocused) {
      return;
    }
    this.lastNotifiedTrackId = track.id;
    this.debounceElapsed = false;
    void this.dispatch({
      id: track.id,
      title: track.title,
      artist: track.artist,
      tag: NOW_PLAYING_NOTIFICATION_TAG,
      renotify: false,
      silent: true,
    });
  }
}

type Prepared = {
  track: Track;
  source: { url: string; duration: number; provider?: StreamProvider; externalId?: string };
};

type Job = {
  id: string;
  users: number;
  warm: number;
  cancelled: boolean;
  done: boolean;
  created: number;
  promise: Promise<Prepared>;
};

export interface PrepareOptions {
  forceRefresh?: boolean;
  excludeIds?: string[];
  preferredProvider?: Exclude<StreamProvider, 'local'>;
}

const jobs = new Map<string, Job>();

/**
 * Unbiased Fisher-Yates (Knuth) shuffle returning a new array without mutating input.
 */
export function shuffleTracks<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

/**
 * Shuffles an entire playlist/collection using Fisher-Yates, activates shuffle preference,
 * and starts playback immediately from the randomly selected first track.
 */
export function shufflePlay(tracks: readonly Track[], rng: () => number = Math.random): Track | null {
  const playable = tracks.filter(t => canPlay(t) && t.available !== false);
  if (!playable.length) return null;
  const shuffled = shuffleTracks(playable, rng);
  const first = shuffled[0]!;
  const app = useApp.getState();
  if (!app.data.preferences.shuffle) {
    void app.setPreferences({ shuffle: true });
  }
  app.play(first, shuffled);
  return first;
}

function cancel(key: string, job: Job) {
  job.cancelled = true;
  if (!job.done) void window.glass.cancelSearch(job.id);
  if (jobs.get(key) === job) jobs.delete(key);
}

export function invalidatePlayback(id?: string) {
  for (const [key, job] of jobs) if (!id || key === id) cancel(key, job);
}

export function needsStreamSyncStatus(track: Track): boolean {
  if (track.offline || track.source === 'local') return false;
  return isCatalogOnlyTrack(track) && !track.streamProvider && !track.resolvedExternalId && !track.playbackId;
}

export function preparePlayback(track: Track, active = true, options?: PrepareOptions) {
  if (options?.forceRefresh) {
    invalidatePlayback(track.id);
  }
  if (active) {
    for (const [key, job] of jobs) {
      if (key !== track.id && !job.done && job.users === 0) cancel(key, job);
    }
  }
  let job = jobs.get(track.id);
  if (job && (job.cancelled || Date.now() - job.created > 240000)) {
    cancel(track.id, job);
    job = undefined;
  }
  if (!job) {
    const created: Job = {
      id: crypto.randomUUID(),
      users: 0,
      warm: 0,
      cancelled: false,
      done: false,
      created: Date.now(),
      promise: undefined!,
    };
    created.promise = (async () => {
      if (track.offline && !options?.forceRefresh && !options?.preferredProvider) {
        const source = await window.glass.offlineSource(track.id);
        if (created.cancelled) throw new Error('Preparação cancelada.');
        if (source) {
          created.done = true;
          return { track, source };
        }
        const p = useApp.getState().data.preferences;
        if (!p.onlineConsent || !p.onboardingDone) {
          throw new Error('O arquivo offline não está disponível neste dispositivo.');
        }
      }

      const useCrossResolver =
        typeof window.glass?.resolveStream === 'function' &&
        (isCatalogOnlyTrack(track) ||
          Boolean(options?.forceRefresh) ||
          Boolean(options?.preferredProvider) ||
          Boolean(track.streamProvider && track.streamProvider !== 'local' && track.source === 'link'));

      if (useCrossResolver) {
        const resolved = await window.glass.resolveStream(track, created.id, options);
        if (created.cancelled) throw new Error('Preparação cancelada.');
        created.done = true;
        return {
          track: resolved.track,
          source: {
            url: resolved.streamUrl,
            duration: resolved.duration,
            provider: resolved.provider,
            externalId: resolved.externalId,
          },
        };
      }

      const matched =
        track.source === 'link' && !track.playbackId && typeof window.glass?.linkPlayback === 'function'
          ? await window.glass.linkPlayback(track, created.id)
          : track;
      if (created.cancelled) throw new Error('Preparação cancelada.');
      const source = await window.glass.audioSource(
        matched.resolvedExternalId || matched.playbackId || matched.sourceId,
        created.id,
        {
          title: matched.title,
          artist: matched.artist,
          duration: matched.duration,
          isrc: matched.isrc,
          trackId: matched.id,
        },
      );
      if (created.cancelled) throw new Error('Preparação cancelada.');
      created.done = true;
      return { track: matched, source };
    })().catch(error => {
      if (jobs.get(track.id) === created) jobs.delete(track.id);
      throw error;
    });
    void created.promise.catch(() => {});
    jobs.set(track.id, created);
    job = created;
    if (jobs.size > 24) {
      for (const [key, entry] of jobs) {
        if (entry.users === 0 && entry.warm === 0 && entry.done) {
          jobs.delete(key);
          if (jobs.size <= 24) break;
        }
      }
    }
  }
  const current = job;
  if (active) current.users++;
  else current.warm++;
  let released = false;
  return {
    promise: current.promise,
    release: () => {
      if (released) return;
      released = true;
      if (active) current.users--;
      else current.warm--;
      if (current.users === 0 && current.warm === 0 && !current.done) cancel(track.id, current);
    },
  };
}

let warmTimer: ReturnType<typeof setTimeout> | undefined,
  warmStop: ReturnType<typeof setTimeout> | undefined,
  warmKey = '',
  releaseWarm: (() => void) | undefined;

export function warmTrack(track: Track) {
  const p = useApp.getState().data.preferences;
  if (
    !p.onlineConsent ||
    !p.onboardingDone ||
    !['youtube', 'link'].includes(track.source) ||
    track.kind !== 'track'
  )
    return;
  clearTimeout(warmStop);
  if (warmKey === track.id) return;
  clearTimeout(warmTimer);
  releaseWarm?.();
  releaseWarm = undefined;
  warmKey = track.id;
  warmTimer = setTimeout(() => {
    const job = preparePlayback(track, false);
    releaseWarm = job.release;
  }, 220);
}

export function cancelWarmTrack() {
  clearTimeout(warmTimer);
  warmStop = setTimeout(() => {
    releaseWarm?.();
    releaseWarm = undefined;
    warmKey = '';
  }, 500);
}
