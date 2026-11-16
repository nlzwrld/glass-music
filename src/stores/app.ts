import { create } from 'zustand';
import { canPlay, defaults, type Snapshot, type Preferences, type Track, type LibraryCommand, type IntegrationStatus } from '../../shared/types';
export type Page = 'home' | 'explore' | 'search' | 'library' | 'likes' | 'history' | 'local' | 'settings' | `playlist:${string}`;
type Dialog = { type: 'playlist'; id?: string; name?: string } | { type: 'add'; track: Track; fromPlaylist?:string } | { type: 'link'; playlist?:boolean } | { type: 'confirm'; title: string; text: string; action: () => Promise<void> } | null;
interface State {
  searchBusy:boolean; ready: boolean; data: Snapshot; integrations?: IntegrationStatus; page: Page; collapsed: boolean; filter: string;
  navigation: Page[]; navigationIndex: number; navigate(direction: -1 | 1): void; sideOpen: boolean;
  dialog: Dialog; toast: string; queue: Track[]; index: number; playing: boolean; position: number; duration: number; status: string; error: string;
  lyricsOpen:boolean; expanded: boolean; queueOpen: boolean; mini: boolean; revision: number;
  boot(): Promise<void>; setPage(p: Page): void; setDialog(d: Dialog): void; message(t: string): void;
  mutate(c: LibraryCommand): Promise<void>; setPreferences(p: Partial<Preferences>): Promise<void>;
  importAudio(): Promise<void>; importLibrary(): Promise<void>; play(t: Track, list?: Track[]): void;
  next(manual?: boolean): void; previous(): void; removeQueue(index: number): void; enqueue(t: Track): void;
}
let toastTimer: ReturnType<typeof setTimeout>; let preferenceWrites = Promise.resolve();
export const useApp = create<State>((set, get) => ({
  searchBusy:false, ready: false, data: { tracks: [], playlists: [], likes: [], history: [], preferences: defaults }, page: 'home', collapsed: false, filter: '', dialog: null, toast: '',
  navigation: ['home'], navigationIndex: 0, sideOpen: false,
  queue: [], index: -1, playing: false, position: 0, duration: 0, status: '', error: '', lyricsOpen:false, expanded: false, queueOpen: false, mini: false, revision: 0,
  boot: async () => { try { const [data, integrations] = await Promise.all([window.glass.bootstrap(), window.glass.integrations()]); set({ data, integrations, ready: true }); } catch (e) { set({ ready: true, error: String(e) }); } },
  setPage: page => { const s = get(); if (page === s.page) { set({ expanded: false }); return; } const navigation = [...s.navigation.slice(0, s.navigationIndex + 1), page].slice(-80); set({ page, filter: '', expanded: false, navigation, navigationIndex: navigation.length - 1 }); },
  navigate: direction => { const s = get(), index = s.navigationIndex + direction; if (index >= 0 && index < s.navigation.length) set({ page: s.navigation[index], navigationIndex: index, filter: '', expanded: false }); },
  setDialog: dialog => set({ dialog }),
  message: toast => { clearTimeout(toastTimer); set({ toast }); toastTimer = setTimeout(() => set({ toast: '' }), Math.min(18000,Math.max(5500,toast.length*65))); },
  mutate: async command => { try { const data = await window.glass.library(command); set({ data: { ...data, preferences: get().data.preferences } }); } catch (e) { get().message(cleanError(e)); throw e; } },
  setPreferences: async patch => {
    const next = { ...get().data.preferences, ...patch }; const permissionChange = ["onlineConsent","catalogConsent","onboardingDone"].some(key=>key in patch); if (!permissionChange) set({ data: { ...get().data, preferences: next } });
    preferenceWrites = preferenceWrites.catch(() => {}).then(async () => { try { await window.glass.preferences(next); if (permissionChange) set({data:{...get().data,preferences:next}}); } catch (e) { get().message(cleanError(e)); const data = await window.glass.bootstrap(); set({ data }); } }); await preferenceWrites;
  },
  importAudio: async () => { get().setDialog({type:'link'}); },
  importLibrary: async () => { try { const data = await window.glass.importLibrary(); if (data) { set({ data }); get().message('Biblioteca importada. Suas playlists anteriores foram preservadas.'); } } catch (e) { get().message(cleanError(e)); } },
  play: (incoming, list = [incoming]) => {
    const enrich=(t:Track)=>{const saved=get().data.tracks.find(v=>v.id===t.id);return {...t,...(saved?.offline?{offline:true}:{}),...(saved?.playbackId&&!t.playbackId?{playbackId:saved.playbackId}:{})};};const track=enrich(incoming);
    if (!canPlay(track)) { get().message('Use o link de uma faixa para reproduzir no Glass.'); return; }
    if (track.available === false) { get().message(track.reason || 'Esta faixa está indisponível.'); return; }
    if (track.source !== 'local' && !track.offline && !get().data.preferences.onlineConsent) { get().setPage('settings'); get().message('Ative as integrações após ler os termos de privacidade.'); return; }
    const queue = list.filter(canPlay).map(enrich); const index = queue.findIndex(t => t.id === track.id);
    set({ queue: index >= 0 ? queue : [track], index: index >= 0 ? index : 0, playing: false, position: 0, duration: track.duration, error: '', status: 'Carregando', revision: get().revision + 1 });
  },
  next: (manual = true) => {
    const s = get(); if (!s.queue.length) return; const p = s.data.preferences;
    if (!manual && p.repeat === 'one') { set({ revision: s.revision + 1, position: 0, playing: false }); return; }
    let index = s.index + 1;
    if (p.shuffle && s.queue.length > 1) { const choices = s.queue.map((_,i) => i).filter(i => i !== s.index && s.queue[i].available !== false); index = choices[Math.floor(Math.random() * choices.length)] ?? s.queue.length; }
    if (index >= s.queue.length && (p.repeat === 'all' || manual)) index = 0;
    if (index >= s.queue.length) { set({ playing: false, status: 'Fim da fila' }); return; }
    set({ index, playing: false, position: 0, duration: s.queue[index].duration, error: '', status: 'Carregando', revision: s.revision + 1 });
  },
  previous: () => { const s = get(); if (!s.queue.length) return; const index = Math.max(0, s.index - 1); set({ index, position: 0, duration: s.queue[index].duration, playing: false, error: '', revision: s.revision + 1 }); },
  enqueue: t => { if (!canPlay(t)) { get().message('Adicione faixas individuais à fila.'); return; } set({ queue: [...get().queue, t] }); get().message('Adicionada à fila.'); },
  removeQueue: i => { const s = get(); if (i === s.index) return; set({ queue: s.queue.filter((_,j) => j !== i), index: i < s.index ? s.index - 1 : s.index }); }
}));
export function cleanError(e: unknown): string { return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Error: /, ''); }
export function currentTrack() { const s = useApp.getState(); return s.queue[s.index]; }
export function formatTime(seconds: number) { if (!Number.isFinite(seconds) || seconds < 0) return '0:00'; return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2,'0')}`; }
