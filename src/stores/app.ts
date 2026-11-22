import { create } from 'zustand';
import {
  canPlay,
  defaults,
  isCatalogOnlyTrack,
  type Snapshot,
  type Preferences,
  type Track,
  type LibraryCommand,
  type IntegrationStatus,
  type CollectionPreview,
  type LyricsResult,
} from '../../shared/types';
import { hasValidLyrics, resolveTrackLyrics } from '../lib/lyrics';

function initialPlaybackStatus(track: Track): string {
  if (!track.offline && isCatalogOnlyTrack(track) && !track.streamProvider && !track.playbackId) {
    return 'Sincronizando fonte de áudio...';
  }
  return 'Carregando';
}

export type Page =
  | 'home'
  | 'explore'
  | 'search'
  | 'library'
  | 'likes'
  | 'history'
  | 'local'
  | 'settings'
  | 'collection'
  | `playlist:${string}`;

type Dialog =
  | { type: 'playlist'; id?: string; name?: string; description?: string; artwork?: string }
  | { type: 'jam' }
  | { type: 'add'; track: Track; fromPlaylist?: string }
  | { type: 'link'; playlist?: boolean }
  | { type: 'streamSource'; track: Track }
  | { type: 'confirm'; title: string; text: string; action: () => Promise<void> }
  | null;

interface State {
  searchBusy: boolean;
  ready: boolean;
  data: Snapshot;
  integrations?: IntegrationStatus;
  page: Page;
  collapsed: boolean;
  filter: string;
  navigation: Page[];
  navigationIndex: number;
  navigate(direction: -1 | 1): void;
  sideOpen: boolean;
  dialog: Dialog;
  toast: string;
  queue: Track[];
  index: number;
  shufflePlayed: number[];
  shuffleNext: number | null;
  autoAdvance: boolean;
  playing: boolean;
  playbackIntent: boolean;
  position: number;
  duration: number;
  status: string;
  error: string;
  lyricsOpen: boolean;
  lyricsAvailable: boolean;
  lyricsChecking: boolean;
  currentLyrics: LyricsResult | null;
  expanded: boolean;
  queueOpen: boolean;
  mini: boolean;
  revision: number;
  preview: CollectionPreview | null;
  previewBusy: boolean;
  downloadingIds: string[];
  boot(): Promise<void>;
  setPage(p: Page): void;
  setDialog(d: Dialog): void;
  message(t: string): void;
  mutate(c: LibraryCommand): Promise<void>;
  setPreferences(p: Partial<Preferences>): Promise<void>;
  importAudio(): Promise<void>;
  importLocalFiles(): Promise<void>;
  importLibrary(): Promise<void>;
  openCollection(url: string, fallbackTitle?: string): Promise<void>;
  downloadTrack(track: Track): Promise<void>;
  downloadPlaylist(tracks: Track[]): Promise<void>;
  probeLyrics(track?: Track | null): Promise<boolean>;
  applyResolvedTrack(updated: Track, reloadIfActive?: boolean): void;
  play(t: Track, list?: Track[]): void;
  playNext(t: Track): void;
  jumpQueue(index: number): void;
  next(manual?: boolean): void;
  previous(): void;
  removeQueue(index: number): void;
  moveQueue(from: number, to: number): void;
  clearQueue(): void;
  enqueue(t: Track): void;
  extendWithRecommendations(): Promise<boolean>;
  startStyleRadio(seed?: Track): Promise<void>;
}

function remapIndex(idx: number, from: number, to: number): number {
  if (idx === from) return to;
  if (from < to && idx > from && idx <= to) return idx - 1;
  if (from > to && idx >= to && idx < from) return idx + 1;
  return idx;
}

function computeShuffleStep(
  queue: Track[],
  current: number,
  played: number[],
  allowWrap: boolean,
): { played: number[]; next: number | null } {
  const playable = queue
    .map((_, i) => i)
    .filter(i => queue[i]?.available !== false);
  if (current < 0 || current >= queue.length || playable.length <= 1) {
    return { played: current >= 0 ? [current] : [], next: null };
  }
  const uniquePlayed = played.filter(
    (idx, pos, arr) =>
      idx >= 0 &&
      idx < queue.length &&
      idx !== current &&
      queue[idx]?.available !== false &&
      arr.indexOf(idx) === pos,
  );
  uniquePlayed.push(current);

  const unplayed = playable.filter(i => !uniquePlayed.includes(i));
  if (unplayed.length > 0) {
    const next = unplayed[Math.floor(Math.random() * unplayed.length)] ?? null;
    return { played: uniquePlayed, next };
  }
  if (allowWrap) {
    const freshPool = playable.filter(i => i !== current);
    const next = freshPool[Math.floor(Math.random() * freshPool.length)] ?? null;
    return { played: uniquePlayed, next };
  }
  return { played: uniquePlayed, next: null };
}

export function upcomingIndex(
  s: Pick<State, 'queue' | 'index' | 'shufflePlayed' | 'shuffleNext' | 'data'>,
  manual = false,
): number {
  if (!s.queue.length || s.index < 0) return -1;
  const p = s.data.preferences;
  if (!manual && p.repeat === 'one') return s.index;
  if (p.shuffle) {
    const playable = s.queue
      .map((_, i) => i)
      .filter(i => s.queue[i]?.available !== false);
    if (playable.length <= 1) {
      return (p.repeat === 'all' || manual) && playable.length === 1 ? playable[0] : -1;
    }
    const unplayed = playable.filter(i => !s.shufflePlayed.includes(i) && i !== s.index);
    const cycleComplete = unplayed.length === 0;
    if (
      s.shuffleNext !== null &&
      s.shuffleNext >= 0 &&
      s.shuffleNext < s.queue.length &&
      s.shuffleNext !== s.index &&
      s.queue[s.shuffleNext]?.available !== false &&
      (!s.shufflePlayed.includes(s.shuffleNext) || (cycleComplete && (p.repeat === 'all' || manual)))
    ) {
      return s.shuffleNext;
    }
    if (!cycleComplete) {
      return unplayed[Math.floor(Math.random() * unplayed.length)] ?? -1;
    }
    if (p.repeat === 'all' || manual) {
      const fresh = playable.filter(i => i !== s.index);
      return fresh[Math.floor(Math.random() * fresh.length)] ?? -1;
    }
    return -1;
  }
  for (let index = s.index + 1; index < s.queue.length; index++) {
    if (s.queue[index]?.available !== false) return index;
  }
  if (p.repeat === 'all' || manual) {
    for (let index = 0; index <= s.index && index < s.queue.length; index++) {
      if (s.queue[index]?.available !== false) return index;
    }
  }
  return -1;
}

let toastTimer: ReturnType<typeof setTimeout>;
let preferenceWrites = Promise.resolve();
let preferenceWriteId = 0;
let canonicalPreferences: Preferences | null = null;
const pendingPreferenceWrites = new Map<
  number,
  { patch: Partial<Preferences>; permissionChange: boolean; failed: boolean }
>();
type AutoplayContext = {
  revision: number;
  index: number;
  trackId: string | undefined;
};

function sameAutoplaySelection(s: State, context: AutoplayContext): boolean {
  return (
    s.revision === context.revision &&
    s.index === context.index &&
    s.queue[s.index]?.id === context.trackId
  );
}

let autoplayFlight: { context: AutoplayContext; promise: Promise<boolean> } | null = null;
let autoplayContinuation: Promise<boolean> | null = null;
let collectionPreviewGeneration = 0;
let lyricsProbeSeq = 0;

export const useApp = create<State>((set, get) => ({
  searchBusy: false,
  ready: false,
  data: { tracks: [], playlists: [], likes: [], history: [], preferences: defaults },
  page: 'home',
  collapsed: false,
  filter: '',
  dialog: null,
  toast: '',
  navigation: ['home'],
  navigationIndex: 0,
  sideOpen: false,
  queue: [],
  index: -1,
  shufflePlayed: [],
  shuffleNext: null,
  autoAdvance: false,
  playing: false,
  playbackIntent: false,
  position: 0,
  duration: 0,
  status: '',
  error: '',
  lyricsOpen: false,
  lyricsAvailable: false,
  lyricsChecking: false,
  currentLyrics: null,
  expanded: false,
  queueOpen: false,
  mini: false,
  revision: 0,
  preview: null,
  previewBusy: false,
  downloadingIds: [],
  boot: async () => {
    try {
      const [data, integrations] = await Promise.all([
        window.glass.bootstrap(),
        window.glass.integrations(),
      ]);
      set({ data, integrations, ready: true });
    } catch (e) {
      set({ ready: true, error: String(e) });
    }
  },
  setPage: page => {
    const s = get();
    if (page === s.page) {
      set({ expanded: false });
      return;
    }
    const navigation = [...s.navigation.slice(0, s.navigationIndex + 1), page].slice(-80);
    set({
      page,
      filter: page === 'search' ? s.filter : '',
      expanded: false,
      navigation,
      navigationIndex: navigation.length - 1,
    });
  },
  navigate: direction => {
    const s = get(),
      index = s.navigationIndex + direction;
    if (index >= 0 && index < s.navigation.length)
      set({
        page: s.navigation[index],
        navigationIndex: index,
        filter: '',
        expanded: false,
      });
  },
  setDialog: dialog => set({ dialog }),
  message: toast => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(
      () => set({ toast: '' }),
      Math.min(18000, Math.max(5500, toast.length * 65)),
    );
  },
  mutate: async command => {
    try {
      const data = await window.glass.library(command);
      set({ data: { ...data, preferences: get().data.preferences } });
      if (
        ['create', 'rename', 'delete', 'add', 'remove', 'move', 'reorder', 'like'].includes(
          command.action,
        )
      ) {
        void import('./accounts').then(m => m.useAccounts.getState().syncLibraryToCloud());
      }
    } catch (e) {
      get().message(cleanError(e));
      throw e;
    }
  },
  setPreferences: async patch => {
    const prev = get();
    const next = { ...prev.data.preferences, ...patch };
    const permissionChange = ['onlineConsent', 'catalogConsent', 'onboardingDone'].some(
      key => key in patch,
    );
    if (pendingPreferenceWrites.size === 0) canonicalPreferences = prev.data.preferences;
    const operation = {
      id: ++preferenceWriteId,
      patch: { ...patch },
      permissionChange,
      failed: false,
    };
    pendingPreferenceWrites.set(operation.id, operation);
    const projectPreferences = () => {
      let preferences = canonicalPreferences ?? get().data.preferences;
      for (const pending of pendingPreferenceWrites.values()) {
        if (!pending.permissionChange && !pending.failed) {
          preferences = { ...preferences, ...pending.patch };
        }
      }
      return preferences;
    };
    const syncPreferences = (extra: Partial<State> = {}) => {
      const preferences = projectPreferences();
      set(curr => ({ ...extra, data: { ...curr.data, preferences } }));
    };
    const needShuffleRecompute = 'shuffle' in patch || 'repeat' in patch;
    const shufflePatch = needShuffleRecompute
      ? (() => {
          if (!next.shuffle) return { shufflePlayed: [] as number[], shuffleNext: null };
          const step = computeShuffleStep(
            prev.queue,
            prev.index,
            'shuffle' in patch ? [] : prev.shufflePlayed,
            next.repeat === 'all',
          );
          return { shufflePlayed: step.played, shuffleNext: step.next };
        })()
      : {};
    if (!permissionChange) syncPreferences(shufflePatch);
    const write = preferenceWrites.catch(() => {}).then(async () => {
      // A full snapshot is required by GlassAPI, but it must be based on the last
      // completed write, never on state captured before this operation was queued.
      const snapshot = {
        ...(canonicalPreferences ?? get().data.preferences),
        ...operation.patch,
      };
      try {
        await window.glass.preferences(snapshot);
        canonicalPreferences = snapshot;
        pendingPreferenceWrites.delete(operation.id);
        syncPreferences(permissionChange ? shufflePatch : {});
        if (permissionChange) {
          void get().probeLyrics(get().queue[get().index] || null);
        }
      } catch (e) {
        operation.failed = true;
        syncPreferences();
        get().message(cleanError(e));
        let recovered: Snapshot | undefined;
        let recoveryError: unknown;
        try {
          recovered = await window.glass.bootstrap();
          canonicalPreferences = recovered.preferences;
        } catch (bootstrapError) {
          recoveryError = bootstrapError;
        }
        pendingPreferenceWrites.delete(operation.id);
        if (recovered) {
          const preferences = projectPreferences();
          set({ data: { ...recovered, preferences } });
        } else {
          syncPreferences();
        }
        if (recoveryError) {
          throw new AggregateError(
            [e, recoveryError],
            `${cleanError(e)} (também falhou ao recuperar as preferências: ${cleanError(recoveryError)})`,
          );
        }
        throw e;
      }
    });
    preferenceWrites = write;
    await write;
  },
  importAudio: async () => {
    get().setDialog({ type: 'link' });
  },
  importLocalFiles: async () => {
    try {
      const before = get().data.tracks.filter(t => t.source === 'local').length;
      const snapshot = await window.glass.importAudio();
      const after = snapshot.tracks.filter(t => t.source === 'local').length;
      set({ data: { ...snapshot, preferences: get().data.preferences } });
      if (after > before) {
        get().message(`${after - before} arquivo(s) de áudio importado(s).`);
        get().setPage('library');
      }
    } catch (e) {
      get().message(cleanError(e));
    }
  },
  importLibrary: async () => {
    try {
      const data = await window.glass.importLibrary();
      if (data) {
        set({ data });
        get().message('Biblioteca importada. Suas playlists anteriores foram preservadas.');
      }
    } catch (e) {
      get().message(cleanError(e));
    }
  },
  openCollection: async (url, fallbackTitle) => {
    const generation = ++collectionPreviewGeneration;
    if (!get().data.preferences.onlineConsent) {
      set({ previewBusy: false });
      get().setPage('settings');
      get().message('Ative o acesso online nas configurações para abrir esta coleção.');
      return;
    }
    set({
      previewBusy: true,
      preview: fallbackTitle
        ? { name: fallbackTitle, artwork: '', url, tracks: [], warning: '', skipped: 0 }
        : null,
    });
    get().setPage('collection');
    try {
      const preview = await window.glass.previewCollection(url);
      if (generation === collectionPreviewGeneration) set({ preview, previewBusy: false });
    } catch (e) {
      if (generation !== collectionPreviewGeneration) return;
      set({ previewBusy: false });
      get().message(cleanError(e));
    }
  },
  downloadTrack: async track => {
    const s = get();
    if (track.offline) {
      s.message('Removendo download…');
      try {
        const data = await window.glass.removeOffline(track.id);
        set({
          data: { ...data, preferences: get().data.preferences },
          queue: get().queue.map(t => (t.id === track.id ? { ...t, offline: false } : t)),
        });
        get().message('Download removido.');
      } catch (e) {
        get().message(cleanError(e));
      }
      return;
    }
    if (s.downloadingIds.includes(track.id)) return;
    set({ downloadingIds: [...s.downloadingIds, track.id] });
    s.message(`Baixando “${track.title}” para ouvir offline…`);
    try {
      const data = await window.glass.downloadOffline(track);
      set(curr => ({
        data: { ...data, preferences: curr.data.preferences },
        queue: curr.queue.map(t => (t.id === track.id ? { ...t, offline: true } : t)),
        downloadingIds: curr.downloadingIds.filter(id => id !== track.id),
      }));
      get().message(`“${track.title}” disponível offline.`);
    } catch (e) {
      set(curr => ({ downloadingIds: curr.downloadingIds.filter(id => id !== track.id) }));
      get().message(cleanError(e));
    }
  },
  downloadPlaylist: async tracks => {
    const eligible = tracks.filter(
      t => ['youtube', 'link'].includes(t.source) && t.kind === 'track' && !t.offline,
    );
    if (!eligible.length) {
      get().message('Todas as faixas compatíveis desta lista já estão disponíveis offline.');
      return;
    }
    get().message(`Baixando ${eligible.length} faixa(s) em segundo plano…`);
    let done = 0;
    for (const t of eligible) {
      if (get().downloadingIds.includes(t.id)) continue;
      set(curr => ({ downloadingIds: [...curr.downloadingIds, t.id] }));
      try {
        const data = await window.glass.downloadOffline(t);
        done++;
        set(curr => ({
          data: { ...data, preferences: curr.data.preferences },
          queue: curr.queue.map(q => (q.id === t.id ? { ...q, offline: true } : q)),
          downloadingIds: curr.downloadingIds.filter(id => id !== t.id),
        }));
      } catch {
        set(curr => ({ downloadingIds: curr.downloadingIds.filter(id => id !== t.id) }));
      }
    }
    get().message(
      done > 0
        ? `${done} faixa(s) salvas para ouvir offline.`
        : 'Não foi possível concluir o download offline.',
    );
  },
  probeLyrics: async (incomingTrack = get().queue[get().index] || null) => {
    const seq = ++lyricsProbeSeq;
    const p = get().data.preferences;
    const allowed = p.onlineConsent && p.onboardingDone;
    if (!incomingTrack || !allowed || typeof window === 'undefined' || !window.glass?.lyrics) {
      set({
        lyricsAvailable: false,
        lyricsChecking: false,
        currentLyrics: null,
        lyricsOpen: false,
      });
      if (typeof window !== 'undefined') void window.glass?.closeLyrics?.().catch(() => {});
      return false;
    }
    set({ lyricsChecking: true });
    try {
      const result = await resolveTrackLyrics(incomingTrack, true);
      if (seq !== lyricsProbeSeq) return get().lyricsAvailable;
      const valid = hasValidLyrics(result);
      if (valid) {
        set({
          lyricsAvailable: true,
          lyricsChecking: false,
          currentLyrics: result,
        });
        return true;
      }
      set({
        lyricsAvailable: false,
        lyricsChecking: false,
        currentLyrics: null,
        lyricsOpen: false,
      });
      void window.glass?.closeLyrics?.().catch(() => {});
      return false;
    } catch {
      if (seq !== lyricsProbeSeq) return get().lyricsAvailable;
      set({
        lyricsAvailable: false,
        lyricsChecking: false,
        currentLyrics: null,
        lyricsOpen: false,
      });
      void window.glass?.closeLyrics?.().catch(() => {});
      return false;
    }
  },
  play: (incoming, list = [incoming]) => {
    const enrich = (t: Track) => {
      const saved = get().data.tracks.find(v => v.id === t.id);
      return {
        ...t,
        ...(saved?.offline ? { offline: true } : {}),
        ...(saved?.playbackId && !t.playbackId ? { playbackId: saved.playbackId } : {}),
      };
    };
    const track = enrich(incoming);
    if (!canPlay(track)) {
      if (track.url && ['album', 'playlist', 'artist'].includes(track.kind)) {
        void get().openCollection(track.url, track.title);
        return;
      }
      get().message('Use o link de uma faixa para reproduzir no Liquid Hub.');
      return;
    }
    if (track.available === false) {
      get().message(track.reason || 'Esta faixa está indisponível.');
      return;
    }
    if (track.source !== 'local' && !track.offline && !get().data.preferences.onlineConsent) {
      get().setPage('settings');
      get().message('Ative as integrações após ler os termos de privacidade.');
      return;
    }
    const queue = list.filter(canPlay).map(enrich);
    const found = queue.findIndex(t => t.id === track.id);
    const finalQueue = found >= 0 ? queue : [track];
    const finalIndex = found >= 0 ? found : 0;
    const prev = get();
    const sameTrack = prev.queue[prev.index]?.id === track.id;
    const sameQueue =
      prev.status !== 'Fim da fila' &&
      prev.queue.length === finalQueue.length &&
      prev.queue.every((t, i) => t.id === finalQueue[i]?.id);
    const step = prev.data.preferences.shuffle
      ? computeShuffleStep(
          finalQueue,
          finalIndex,
          sameQueue ? prev.shufflePlayed : [],
          prev.data.preferences.repeat === 'all',
        )
      : { played: [] as number[], next: null };
    set({
      queue: finalQueue,
      index: finalIndex,
      shufflePlayed: step.played,
      shuffleNext: step.next,
      autoAdvance: false,
      playing: false,
      playbackIntent: true,
      position: 0,
      duration: track.duration,
      error: '',
      status: initialPlaybackStatus(track),
      revision: prev.revision + 1,
      ...(sameTrack ? {} : { lyricsAvailable: false, currentLyrics: null }),
    });
    void get().probeLyrics(track);
  },
  applyResolvedTrack: (updated, reloadIfActive = false) => {
    set(s => {
      const isActive = s.queue[s.index]?.id === updated.id;
      return {
        queue: s.queue.map(t => (t.id === updated.id ? { ...t, ...updated } : t)),
        data: {
          ...s.data,
          tracks: s.data.tracks.map(t => (t.id === updated.id ? { ...t, ...updated } : t)),
        },
        ...(reloadIfActive && isActive
          ? {
              revision: s.revision + 1,
              position: 0,
              status: initialPlaybackStatus(updated),
              error: '',
            }
          : {}),
      };
    });
  },
  playNext: incoming => {
    if (!canPlay(incoming)) {
      get().message('Adicione faixas individuais à fila.');
      return;
    }
    const s = get();
    if (!s.queue.length || s.index < 0) {
      s.play(incoming, [incoming]);
      return;
    }
    const saved = s.data.tracks.find(v => v.id === incoming.id);
    const enriched: Track = {
      ...incoming,
      ...(saved?.offline ? { offline: true } : {}),
      ...(saved?.playbackId && !incoming.playbackId ? { playbackId: saved.playbackId } : {}),
    };
    const nextQueue = [...s.queue];
    const insertAt = Math.min(nextQueue.length, s.index + 1);
    nextQueue.splice(insertAt, 0, enriched);
    const shiftedPlayed = s.shufflePlayed.map(idx => (idx >= insertAt ? idx + 1 : idx));
    set({
      queue: nextQueue,
      shufflePlayed: shiftedPlayed,
      shuffleNext: s.data.preferences.shuffle ? insertAt : null,
    });
    s.message(`“${incoming.title}” tocará a seguir.`);
  },
  jumpQueue: targetIndex => {
    const s = get();
    if (targetIndex < 0 || targetIndex >= s.queue.length) return;
    const target = s.queue[targetIndex];
    if (!target || target.available === false) return;
    const sameTrack = s.queue[s.index]?.id === target.id;
    const step = s.data.preferences.shuffle
      ? computeShuffleStep(
          s.queue,
          targetIndex,
          s.shufflePlayed,
          s.data.preferences.repeat === 'all',
        )
      : { played: [] as number[], next: null };
    set({
      index: targetIndex,
      shufflePlayed: step.played,
      shuffleNext: step.next,
      autoAdvance: false,
      playing: false,
      playbackIntent: true,
      position: 0,
      duration: target.duration,
      error: '',
      status: initialPlaybackStatus(target),
      revision: s.revision + 1,
      ...(sameTrack ? {} : { lyricsAvailable: false, currentLyrics: null }),
    });
    void get().probeLyrics(target);
  },
  next: (manual = true) => {
    const s = get();
    if (!s.queue.length) return;
    const p = s.data.preferences;
    if (!manual && p.repeat === 'one') {
      set({
        revision: s.revision + 1,
        position: 0,
        autoAdvance: true,
        playbackIntent: true,
      });
      return;
    }
    const index = upcomingIndex(s, manual);
    if (index < 0 || index >= s.queue.length) {
      if (!manual && p.autoplay && p.onlineConsent && p.onboardingDone) {
        set({ status: 'Buscando recomendações no seu estilo…', playbackIntent: true });
        const context: AutoplayContext = {
          revision: s.revision,
          index: s.index,
          trackId: s.queue[s.index]?.id,
        };
        const flight = get().extendWithRecommendations();
        if (autoplayContinuation !== flight) {
          autoplayContinuation = flight;
          void flight.then(added => {
            if (autoplayContinuation === flight) autoplayContinuation = null;
            const latest = get();
            if (!sameAutoplaySelection(latest, context)) return;
            const canAdvance = added || upcomingIndex(latest, false) >= 0;
            if (canAdvance) {
              if (latest.playbackIntent) latest.next(false);
            } else {
              set({
                playing: false,
                playbackIntent: false,
                autoAdvance: false,
                status: 'Fim da fila',
              });
            }
          });
        }
        return;
      }
      set({
        playing: false,
        playbackIntent: false,
        autoAdvance: false,
        status: 'Fim da fila',
      });
      return;
    }
    const nextTrack = s.queue[index]!;
    const sameTrack = s.queue[s.index]?.id === nextTrack.id;
    const step = p.shuffle
      ? computeShuffleStep(
          s.queue,
          index,
          s.shufflePlayed.includes(index) ? [] : s.shufflePlayed,
          p.repeat === 'all',
        )
      : { played: [] as number[], next: null };
    set({
      index,
      shufflePlayed: step.played,
      shuffleNext: step.next,
      autoAdvance: !manual,
      playing: !manual && s.playing,
      playbackIntent: true,
      position: 0,
      duration: nextTrack.duration,
      error: '',
      status: !manual && s.playing ? 'Reproduzindo' : initialPlaybackStatus(nextTrack),
      revision: s.revision + 1,
      ...(sameTrack ? {} : { lyricsAvailable: false, currentLyrics: null }),
    });
    void get().probeLyrics(nextTrack);
  },
  previous: () => {
    const s = get();
    if (!s.queue.length) return;
    if (s.position > 4) {
      set({
        revision: s.revision + 1,
        position: 0,
        autoAdvance: false,
        playbackIntent: true,
        error: '',
      });
      return;
    }
    if (s.data.preferences.shuffle && s.shufflePlayed.length > 1) {
      const prevPlayed = s.shufflePlayed.slice(0, -1);
      const prevIndex = prevPlayed[prevPlayed.length - 1]!;
      if (prevIndex >= 0 && prevIndex < s.queue.length) {
        const prevTrack = s.queue[prevIndex]!;
        set({
          index: prevIndex,
          shufflePlayed: prevPlayed,
          shuffleNext: s.index,
          autoAdvance: false,
          position: 0,
          duration: prevTrack.duration,
          playing: false,
          playbackIntent: true,
          error: '',
          revision: s.revision + 1,
          lyricsAvailable: false,
          currentLyrics: null,
        });
        void get().probeLyrics(prevTrack);
        return;
      }
    }
    const index = Math.max(0, s.index - 1);
    const targetTrack = s.queue[index]!;
    const sameTrack = s.queue[s.index]?.id === targetTrack.id;
    const step = s.data.preferences.shuffle
      ? computeShuffleStep(
          s.queue,
          index,
          s.shufflePlayed,
          s.data.preferences.repeat === 'all',
        )
      : { played: [] as number[], next: null };
    set({
      index,
      shufflePlayed: step.played,
      shuffleNext: step.next,
      autoAdvance: false,
      position: 0,
      duration: targetTrack.duration,
      playing: false,
      playbackIntent: true,
      error: '',
      revision: s.revision + 1,
      ...(sameTrack ? {} : { lyricsAvailable: false, currentLyrics: null }),
    });
    void get().probeLyrics(targetTrack);
  },
  enqueue: t => {
    if (!canPlay(t)) {
      get().message('Adicione faixas individuais à fila.');
      return;
    }
    const s = get();
    if (!s.queue.length || s.index < 0) {
      s.play(t, [t]);
      return;
    }
    const nextQueue = [...s.queue, t];
    const step =
      s.data.preferences.shuffle && s.shuffleNext === null
        ? computeShuffleStep(
            nextQueue,
            s.index,
            s.shufflePlayed,
            s.data.preferences.repeat === 'all',
          )
        : { played: s.shufflePlayed, next: s.shuffleNext };
    set({
      queue: nextQueue,
      shufflePlayed: step.played,
      shuffleNext: step.next,
    });
    s.message('Adicionada à fila.');
  },
  removeQueue: i => {
    const s = get();
    if (i === s.index) return;
    const nextQueue = s.queue.filter((_, j) => j !== i);
    const nextIdx = i < s.index ? s.index - 1 : s.index;
    const adjustedPlayed = s.shufflePlayed
      .filter(idx => idx !== i)
      .map(idx => (idx > i ? idx - 1 : idx));
    let nextShuffle =
      s.shuffleNext === null
        ? null
        : s.shuffleNext === i
          ? null
          : s.shuffleNext > i
            ? s.shuffleNext - 1
            : s.shuffleNext;
    let finalPlayed = adjustedPlayed;
    if (s.data.preferences.shuffle && nextShuffle === null) {
      const step = computeShuffleStep(
        nextQueue,
        nextIdx,
        adjustedPlayed,
        s.data.preferences.repeat === 'all',
      );
      finalPlayed = step.played;
      nextShuffle = step.next;
    }
    set({
      queue: nextQueue,
      index: nextIdx,
      shufflePlayed: finalPlayed,
      shuffleNext: nextShuffle,
    });
  },
  moveQueue: (from, to) => {
    const s = get();
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= s.queue.length ||
      to >= s.queue.length
    )
      return;
    const nextQueue = [...s.queue];
    const [moved] = nextQueue.splice(from, 1);
    nextQueue.splice(to, 0, moved!);
    const nextIndex = remapIndex(s.index, from, to);
    const remappedPlayed = s.shufflePlayed.map(idx => remapIndex(idx, from, to));
    const remappedNext =
      s.shuffleNext !== null ? remapIndex(s.shuffleNext, from, to) : null;
    set({
      queue: nextQueue,
      index: nextIndex,
      shufflePlayed: remappedPlayed,
      shuffleNext: remappedNext,
    });
  },
  clearQueue: () => {
    const s = get();
    if (!s.queue.length) return;
    const active = s.queue[s.index];
    if (!active) {
      set({
        queue: [],
        index: -1,
        playing: false,
        playbackIntent: false,
        shufflePlayed: [],
        shuffleNext: null,
        lyricsAvailable: false,
        currentLyrics: null,
        lyricsOpen: false,
      });
      return;
    }
    set({
      queue: [active],
      index: 0,
      shufflePlayed: s.data.preferences.shuffle ? [0] : [],
      shuffleNext: null,
    });
    s.message('Próximas músicas removidas da fila.');
  },
  extendWithRecommendations: () => {
    const s = get();
    const p = s.data.preferences;
    if (!window.glass?.recommendations || !p.onlineConsent || !p.onboardingDone || !s.queue.length || s.index < 0) {
      return Promise.resolve(false);
    }
    const context: AutoplayContext = {
      revision: s.revision,
      index: s.index,
      trackId: s.queue[s.index]?.id,
    };
    if (autoplayFlight && sameAutoplaySelection(s, autoplayFlight.context)) {
      return autoplayFlight.promise;
    }
    const flight = (async () => {
      try {
        const current = s.queue[s.index];
        const recentInQueue = s.queue
          .slice(Math.max(0, s.index - 2), s.index + 1)
          .reverse()
          .filter(Boolean);
        const seeds = recentInQueue.length ? recentInQueue : current ? [current] : [];
        const excludeIds = Array.from(
          new Set([
            ...s.queue.map(t => t.id),
            ...s.data.history.slice(0, 30).map(h => h.id),
          ]),
        );
        const recs = await window.glass.recommendations(seeds, excludeIds);
        const latest = get();
        const latestPreferences = latest.data.preferences;
        if (
          !sameAutoplaySelection(latest, context) ||
          !latestPreferences.autoplay ||
          !latestPreferences.onlineConsent ||
          !latestPreferences.onboardingDone
        ) {
          return false;
        }
        const valid = (recs || []).filter(t => canPlay(t) && t.available !== false);
        if (!valid.length) return false;
        const existing = new Set(latest.queue.map(t => t.id));
        const fresh = valid
          .filter(t => !existing.has(t.id))
          .slice(0, 6)
          .map(t => ({ ...t, recommended: true }));
        if (!fresh.length) return false;
        const firstNewIdx = latest.queue.length;
        const nextQueue = [...latest.queue, ...fresh];
        set({
          queue: nextQueue,
          shuffleNext:
            latest.data.preferences.shuffle && latest.shuffleNext === null
              ? firstNewIdx
              : latest.shuffleNext,
        });
        return sameAutoplaySelection(get(), context);
      } catch {
        return false;
      }
    })();
    autoplayFlight = { context, promise: flight };
    void flight.finally(() => {
      if (autoplayFlight?.promise === flight) autoplayFlight = null;
    });
    return flight;
  },
  startStyleRadio: async seed => {
    const s = get();
    const p = s.data.preferences;
    const target =
      seed ||
      s.queue[s.index] ||
      s.data.history.map(h => s.data.tracks.find(t => t.id === h.id)).find(Boolean) ||
      s.data.tracks[0];
    if (!target) {
      s.setPage('explore');
      return;
    }
    if (!p.onlineConsent || !p.onboardingDone) {
      s.play(target, s.data.tracks);
      return;
    }
    s.message(`Criando mix baseado em “${target.title}”…`);
    try {
      const recs = await window.glass.recommendations([target], [target.id]);
      const list = [target, ...(recs || []).filter(canPlay).map(t => ({ ...t, recommended: true }))];
      s.play(target, list);
    } catch {
      s.play(target, [target]);
    }
  },
}));

/** Fire-and-forget UI path; awaited callers still receive the original rejection. */
export function setPreferencesFromUI(patch: Partial<Preferences>): void {
  void useApp.getState().setPreferences(patch).catch(() => {
    // Persistence failures are already reported and recovered by setPreferences.
  });
}

export function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Error: /, '');
}

export function looksLikeMusicLink(raw: string): boolean {
  const v = raw.trim();
  if (!v.startsWith('https://') || /\s/.test(v)) return false;
  try {
    return new URL(v).hostname.includes('.');
  } catch {
    return false;
  }
}

export async function handleDirectLink(raw: string) {
  const url = raw.trim();
  const s = useApp.getState();
  if (!s.data.preferences.onlineConsent) {
    s.setPage('settings');
    s.message('Ative o acesso online para reproduzir ou importar links.');
    return;
  }
  useApp.setState({ searchBusy: true });
  try {
    const res = await window.glass.importLink(url);
    useApp.setState({
      data: { ...res.snapshot, preferences: useApp.getState().data.preferences },
      filter: '',
    });
    if (res.playlistId) {
      s.setPage(`playlist:${res.playlistId}`);
      s.message(`${res.count} faixas importadas.${res.warning ? ` ${res.warning}` : ''}`);
    } else if (res.track) {
      s.play(res.track);
    }
  } catch (e) {
    try {
      await s.openCollection(url);
      useApp.setState({ filter: '' });
    } catch {
      s.message(cleanError(e));
    }
  } finally {
    useApp.setState({ searchBusy: false });
  }
}

export function currentTrack() {
  const s = useApp.getState();
  return s.queue[s.index];
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}
