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
  | { type: 'playlist'; id?: string; name?: string }
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
  next(manual?: boolean): void;
  previous(): void;
  removeQueue(index: number): void;
  moveQueue(from: number, to: number): void;
  enqueue(t: Track): void;
}

function pickShuffleIndex(queue: Track[], current: number): number | null {
  if (queue.length <= 1) return null;
  const choices = queue
    .map((_, i) => i)
    .filter(i => i !== current && queue[i]?.available !== false);
  if (!choices.length) return null;
  return choices[Math.floor(Math.random() * choices.length)] ?? null;
}

export function upcomingIndex(
  s: Pick<State, 'queue' | 'index' | 'shuffleNext' | 'data'>,
  manual = false,
): number {
  if (!s.queue.length || s.index < 0) return -1;
  const p = s.data.preferences;
  if (!manual && p.repeat === 'one') return s.index;
  if (p.shuffle && s.queue.length > 1) {
    if (
      s.shuffleNext !== null &&
      s.shuffleNext >= 0 &&
      s.shuffleNext < s.queue.length &&
      s.shuffleNext !== s.index &&
      s.queue[s.shuffleNext]?.available !== false
    ) {
      return s.shuffleNext;
    }
    return pickShuffleIndex(s.queue, s.index) ?? -1;
  }
  const next = s.index + 1;
  if (next < s.queue.length) return next;
  if (p.repeat === 'all' || manual) return 0;
  return -1;
}

let toastTimer: ReturnType<typeof setTimeout>;
let preferenceWrites = Promise.resolve();

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
    const shufflePatch =
      'shuffle' in patch
        ? {
            shuffleNext: next.shuffle ? pickShuffleIndex(prev.queue, prev.index) : null,
          }
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
    set({
      queue: finalQueue,
      index: finalIndex,
      shuffleNext: get().data.preferences.shuffle
        ? pickShuffleIndex(finalQueue, finalIndex)
        : null,
      autoAdvance: false,
      playing: false,
      position: 0,
      duration: track.duration,
      error: '',
      status: 'Carregando',
      revision: get().revision + 1,
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
    set({
      queue: nextQueue,
      shuffleNext: s.data.preferences.shuffle ? insertAt : null,
    });
    s.message(`“${incoming.title}” tocará a seguir.`);
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
      set({ playing: false, autoAdvance: false, status: 'Fim da fila' });
      return;
    }
    set({
      index,
      shuffleNext: p.shuffle ? pickShuffleIndex(s.queue, index) : null,
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
    const index = Math.max(0, s.index - 1);
    set({
      index,
      shuffleNext: s.data.preferences.shuffle ? pickShuffleIndex(s.queue, index) : null,
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
    set({
      queue: nextQueue,
      shuffleNext:
        s.data.preferences.shuffle && s.shuffleNext === null
          ? pickShuffleIndex(nextQueue, s.index)
          : s.shuffleNext,
    });
    s.message('Adicionada à fila.');
  },
  removeQueue: i => {
    const s = get();
    if (i === s.index) return;
    const nextQueue = s.queue.filter((_, j) => j !== i);
    const nextIdx = i < s.index ? s.index - 1 : s.index;
    set({
      queue: nextQueue,
      index: nextIdx,
      shuffleNext: s.data.preferences.shuffle ? pickShuffleIndex(nextQueue, nextIdx) : null,
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
    let nextIndex = s.index;
    if (from === s.index) nextIndex = to;
    else if (from < s.index && to >= s.index) nextIndex = s.index - 1;
    else if (from > s.index && to <= s.index) nextIndex = s.index + 1;
    set({
      queue: nextQueue,
      index: nextIndex,
      shuffleNext: s.data.preferences.shuffle ? pickShuffleIndex(nextQueue, nextIndex) : null,
    });
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
