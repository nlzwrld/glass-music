import { create } from 'zustand';
import {
  canPlay,
  defaults,
  type Snapshot,
  type Preferences,
  type Track,
  type LibraryCommand,
  type IntegrationStatus,
  type CollectionPreview,
} from '../../shared/types';

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
  | { type: 'add'; track: Track; fromPlaylist?: string }
  | { type: 'link'; playlist?: boolean }
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
  position: number;
  duration: number;
  status: string;
  error: string;
  lyricsOpen: boolean;
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
  const next = s.index + 1;
  if (next < s.queue.length) return next;
  if (p.repeat === 'all' || manual) return 0;
  return -1;
}

let toastTimer: ReturnType<typeof setTimeout>;
let preferenceWrites = Promise.resolve();
let autoplayBusy = false;

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
  position: 0,
  duration: 0,
  status: '',
  error: '',
  lyricsOpen: false,
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
    if (!permissionChange)
      set({ data: { ...prev.data, preferences: next }, ...shufflePatch });
    preferenceWrites = preferenceWrites.catch(() => {}).then(async () => {
      try {
        await window.glass.preferences(next);
        if (permissionChange)
          set({ data: { ...get().data, preferences: next }, ...shufflePatch });
      } catch (e) {
        get().message(cleanError(e));
        const data = await window.glass.bootstrap();
        set({ data });
      }
    });
    await preferenceWrites;
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
    if (!get().data.preferences.onlineConsent) {
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
      set({ preview, previewBusy: false });
    } catch (e) {
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
      get().message('Use o link de uma faixa para reproduzir no Glass.');
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
      position: 0,
      duration: track.duration,
      error: '',
      status: 'Carregando',
      revision: prev.revision + 1,
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
      position: 0,
      duration: target.duration,
      error: '',
      status: 'Carregando',
      revision: s.revision + 1,
    });
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
      });
      return;
    }
    const index = upcomingIndex(s, manual);
    if (index < 0 || index >= s.queue.length) {
      if (!manual && p.autoplay && p.onlineConsent && p.onboardingDone) {
        set({ status: 'Buscando recomendações no seu estilo…' });
        void get()
          .extendWithRecommendations()
          .then(added => {
            if (added) {
              get().next(false);
            } else {
              set({ playing: false, autoAdvance: false, status: 'Fim da fila' });
            }
          });
        return;
      }
      set({ playing: false, autoAdvance: false, status: 'Fim da fila' });
      return;
    }
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
      position: 0,
      duration: s.queue[index].duration,
      error: '',
      status: !manual && s.playing ? 'Reproduzindo' : 'Carregando',
      revision: s.revision + 1,
    });
  },
  previous: () => {
    const s = get();
    if (!s.queue.length) return;
    if (s.position > 4) {
      set({ revision: s.revision + 1, position: 0, autoAdvance: false, error: '' });
      return;
    }
    if (s.data.preferences.shuffle && s.shufflePlayed.length > 1) {
      const prevPlayed = s.shufflePlayed.slice(0, -1);
      const prevIndex = prevPlayed[prevPlayed.length - 1]!;
      if (prevIndex >= 0 && prevIndex < s.queue.length) {
        set({
          index: prevIndex,
          shufflePlayed: prevPlayed,
          shuffleNext: s.index,
          autoAdvance: false,
          position: 0,
          duration: s.queue[prevIndex].duration,
          playing: false,
          error: '',
          revision: s.revision + 1,
        });
        return;
      }
    }
    const index = Math.max(0, s.index - 1);
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
      duration: s.queue[index].duration,
      playing: false,
      error: '',
      revision: s.revision + 1,
    });
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
    nextQueue.splice(to, 0, moved);
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
      set({ queue: [], index: -1, shufflePlayed: [], shuffleNext: null });
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
  extendWithRecommendations: async () => {
    if (autoplayBusy || !window.glass?.recommendations) return false;
    const s = get();
    const p = s.data.preferences;
    if (!p.onlineConsent || !p.onboardingDone || !s.queue.length || s.index < 0) return false;
    autoplayBusy = true;
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
      const valid = (recs || []).filter(canPlay);
      if (!valid.length) return false;
      const latest = get();
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
      return true;
    } catch {
      return false;
    } finally {
      autoplayBusy = false;
    }
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
