import { create } from 'zustand';
import type {
  JamInviteLookupResult,
  JamRoom,
  JamSession,
  LanJamAnnouncement,
} from '../../../shared/jam';
import { JamClient, parseJamInvite, sendJam } from '../../lib/jam';
import { discoverLanJamRooms } from '../../lib/discovery';
import { useAccounts } from '../../stores/accounts';
import { useApp, cleanError } from '../../stores/app';

export const jamClient = new JamClient();

interface PendingInviteState {
  raw: string;
  loading: boolean;
  result: JamInviteLookupResult | null;
}

interface LookupState {
  input: string;
  loading: boolean;
  result: JamInviteLookupResult | null;
}

interface State {
  session: JamSession | null;
  room: JamRoom | null;
  lanRooms: LanJamAnnouncement[];
  rttMs: number;
  busy: boolean;
  error: string;
  connected: boolean;
  realtimeConnected: boolean;
  reconnecting: boolean;
  endpoint: string;
  configured: boolean;
  clientId: string;
  hubAuthenticated: boolean;
  hubSubject: string;
  hubDisplayName: string;
  hubAvatar: string | null;
  protocolRegistered: boolean;
  pendingInvite: PendingInviteState | null;
  lookupState: LookupState;
  refresh(): Promise<void>;
  scanLan(): Promise<void>;
  lookupInvite(rawInput: string): Promise<JamInviteLookupResult | null>;
  clearLookup(): void;
  openInviteModal(rawInput: string): Promise<void>;
  closeInviteModal(): void;
  enter(
    action: 'create' | 'createLocal' | 'join',
    name: string,
    code?: string,
    endpoint?: string,
    opts?: { roomName?: string; avatar?: string; requireAuth?: boolean },
  ): Promise<boolean>;
  rotateInvite(): Promise<void>;
  updateRoom(patch: { roomName?: string; locked?: boolean; requireAuth?: boolean }): Promise<void>;
  kick(memberId: string): Promise<void>;
  voteSkip(): Promise<void>;
  queueAdd(track: import('../../../shared/types').Track): Promise<void>;
  queueRemove(queueItemId: string): Promise<void>;
  recommendPlaylist(
    playlistName: string,
    tracks: import('../../../shared/types').Track[],
  ): Promise<void>;
  sendChat(message: string): Promise<void>;
  leave(notice?: string): Promise<void>;
  leaveLocal(notice?: string): void;
}

export const useJam = create<State>((set, get) => ({
  session: null,
  room: null,
  lanRooms: [],
  rttMs: 0,
  busy: false,
  error: '',
  connected: false,
  realtimeConnected: false,
  reconnecting: false,
  endpoint: '',
  configured: false,
  clientId: '',
  hubAuthenticated: false,
  hubSubject: '',
  hubDisplayName: '',
  hubAvatar: null,
  protocolRegistered: false,
  pendingInvite: null,
  lookupState: { input: '', loading: false, result: null },

  refresh: async () => {
    try {
      const config = await sendJam<{
        endpoint: string;
        configured: boolean;
        clientId?: string;
        hubAuthenticated?: boolean;
        hubSubject?: string;
        hubDisplayName?: string;
        hubAvatar?: string | null;
        protocolRegistered?: boolean;
      }>({ action: 'status' });
      if (config.clientId) {
        jamClient.setClientId(config.clientId);
      }
      set({
        endpoint: config.endpoint || '',
        configured: Boolean(config.configured),
        clientId: config.clientId || '',
        hubAuthenticated: Boolean(config.hubAuthenticated),
        hubSubject: config.hubSubject || '',
        hubDisplayName: config.hubDisplayName || config.hubSubject || '',
        hubAvatar: config.hubAvatar || null,
        protocolRegistered: Boolean(config.protocolRegistered),
      });
    } catch (e) {
      set({ configured: false, error: cleanError(e) });
    }
  },

  scanLan: async () => {
    const lanRooms = await discoverLanJamRooms();
    set({ lanRooms });
  },

  lookupInvite: async rawInput => {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      set({ lookupState: { input: rawInput, loading: false, result: null } });
      return null;
    }
    set({ lookupState: { input: rawInput, loading: true, result: null }, error: '' });
    let result: JamInviteLookupResult;
    try {
      result = await jamClient.lookup(rawInput, get().endpoint);
    } catch (e) {
      result = {
        found: false,
        errorCode: 'UNAVAILABLE',
        error: cleanError(e),
      };
    }
    if (get().lookupState.input === rawInput) {
      set({ lookupState: { input: rawInput, loading: false, result } });
    }
    return result;
  },

  clearLookup: () => set({ lookupState: { input: '', loading: false, result: null }, error: '' }),

  openInviteModal: async rawInput => {
    const auth = useAccounts.getState();
    if (!auth.hub.authenticated || auth.hub.needsTermsAcceptance) {
      auth.setPostAuthJamInvite(rawInput);
      return;
    }
    const current = get().session;
    const parsed = parseJamInvite(rawInput, get().endpoint);
    if (current && parsed.code && parsed.code === current.code) {
      useApp.getState().setPage('settings');
      useApp.getState().message(`Você já está na JAM ${current.roomName || current.code}.`);
      return;
    }
    set({
      pendingInvite: { raw: rawInput, loading: true, result: null },
      error: '',
    });
    if (!get().clientId) {
      await get().refresh();
    }
    let result: JamInviteLookupResult;
    try {
      result = await jamClient.lookup(rawInput, get().endpoint);
    } catch (e) {
      result = {
        found: false,
        errorCode: 'UNAVAILABLE',
        error: cleanError(e),
      };
    }
    if (get().pendingInvite?.raw === rawInput) {
      set({
        pendingInvite: { raw: rawInput, loading: false, result },
      });
    }
  },

  closeInviteModal: () => set({ pendingInvite: null, error: '' }),

  enter: async (action, name, code, endpoint, opts) => {
    if (get().busy || get().session) return false;
    set({ busy: true, error: '' });
    try {
      const session = await jamClient.enter(action, name, code, endpoint, {
        ...opts,
        clientId: get().clientId || undefined,
      });
      set({
        session,
        room: session,
        connected: true,
        reconnecting: false,
        pendingInvite: null,
        lookupState: { input: '', loading: false, result: null },
        rttMs: Math.round(jamClient.clock.rttMs),
      });
      return true;
    } catch (e) {
      set({ error: cleanError(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  rotateInvite: async () => {
    try {
      const room = await jamClient.rotateInvite();
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message('Novo código de convite gerado.');
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  updateRoom: async patch => {
    try {
      const room = await jamClient.updateRoom(patch);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  kick: async memberId => {
    try {
      const room = await jamClient.kick(memberId);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  voteSkip: async () => {
    try {
      const room = await jamClient.voteSkip();
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  queueAdd: async track => {
    try {
      const room = await jamClient.queueAdd(track);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message(`"${track.title}" adicionada à fila da JAM.`);
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  queueRemove: async queueItemId => {
    try {
      const room = await jamClient.queueRemove(queueItemId);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  recommendPlaylist: async (playlistName, tracks) => {
    try {
      const room = await jamClient.recommendPlaylist(playlistName, tracks);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message(`Playlist "${playlistName}" recomendada na JAM.`);
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  sendChat: async message => {
    const trimmed = message.trim();
    if (!trimmed) return;
    try {
      const room = await jamClient.sendChat(trimmed);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  leave: async notice => {
    const wasGuest = !!get().session && !get().session?.host;
    set({
      session: null,
      room: null,
      connected: false,
      realtimeConnected: false,
      reconnecting: false,
      error: '',
      rttMs: 0,
    });
    try {
      await sendJam({ action: 'unsubscribe' });
    } catch {}
    try {
      await jamClient.leave();
    } catch {}
    if (notice) {
      useApp.getState().message(notice);
    } else if (wasGuest) {
      useApp.getState().message('Você saiu da JAM. A reprodução voltou ao seu controle.');
    }
  },

  leaveLocal: notice => {
    jamClient.clearLocal();
    set({
      session: null,
      room: null,
      connected: false,
      realtimeConnected: false,
      reconnecting: false,
      error: '',
      rttMs: 0,
    });
    try {
      void sendJam({ action: 'unsubscribe' });
    } catch {}
    if (notice) {
      useApp.getState().message(notice);
    }
  },
}));
