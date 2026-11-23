import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import {
  normalizeJamCode,
  type JamInviteLookupResult,
  type JamInvitePreview,
  type JamJoinRequestStatus,
  type JamRoom,
  type JamRoomPermissions,
  type JamSession,
  type LanJamAnnouncement,
} from '../../../shared/jam';
import { JamClient, parseJamInvite, sendJam } from '../../lib/jam';
import { discoverLanJamRooms } from '../../lib/discovery';
import { useAccounts } from '../../stores/accounts';
import { useApp, cleanError } from '../../stores/app';

export const jamClient = new JamClient();

export interface PendingJoinRequestState {
  code: string;
  endpoint?: string;
  requestId: string;
  requestToken: string;
  roomName: string;
  hostName: string;
  hostAvatar?: string;
  status: JamJoinRequestStatus;
  expiresAt?: number;
  reason?: string;
  errorCode?: string;
}

let joinRequestPollTimer: ReturnType<typeof setInterval> | null = null;
let joinRequestPollInFlight = false;

function stopJoinRequestPolling() {
  if (joinRequestPollTimer !== null) {
    clearInterval(joinRequestPollTimer);
    joinRequestPollTimer = null;
  }
  joinRequestPollInFlight = false;
}

function isHubAuthenticated(): boolean {
  const hub = useAccounts.getState().hub;
  return Boolean(hub.authenticated && !hub.needsTermsAcceptance);
}

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
  jamWindowOpen: boolean;
  pendingInvite: PendingInviteState | null;
  pendingJoinRequest: PendingJoinRequestState | null;
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
    opts?: {
      roomName?: string;
      avatar?: string;
      requireAuth?: boolean;
      requireApproval?: boolean;
      permissions?: Partial<JamRoomPermissions>;
    },
  ): Promise<boolean>;
  requestJoin(
    code: string,
    name: string,
    endpoint?: string,
    opts?: { avatar?: string; preview?: JamInvitePreview | null },
  ): Promise<boolean>;
  cancelJoinRequest(): Promise<void>;
  clearJoinRequest(): void;
  rotateInvite(): Promise<void>;
  updateRoom(patch: {
    roomName?: string;
    locked?: boolean;
    requireAuth?: boolean;
    requireApproval?: boolean;
    permissions?: Partial<JamRoomPermissions>;
  }): Promise<void>;
  approveJoin(requestId: string): Promise<void>;
  rejectJoin(requestId: string, block?: boolean): Promise<void>;
  blockMember(memberId: string): Promise<void>;
  unblockMember(blockKey: string): Promise<void>;
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
  jamWindowOpen: false,
  pendingInvite: null,
  pendingJoinRequest: null,
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
      void invoke('call', { action: 'openJam', payload: null }).catch(() => {});
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
    if (!isHubAuthenticated()) {
      set({ error: 'Faça login com uma conta Liquid Hub para criar ou participar de uma JAM.' });
      return false;
    }
    const isCreate = action === 'create' || action === 'createLocal';
    set({ busy: true, error: '' });
    try {
      const session = await jamClient.enter(action, name, code, endpoint, {
        ...opts,
        ...(isCreate ? { requireApproval: opts?.requireApproval ?? true } : {}),
        clientId: get().clientId || undefined,
      });
      stopJoinRequestPolling();
      set({
        session,
        room: session,
        connected: true,
        reconnecting: false,
        pendingInvite: null,
        pendingJoinRequest: null,
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

  requestJoin: async (code, name, endpoint, opts) => {
    if (get().busy || get().session) return false;
    if (!isHubAuthenticated()) {
      set({ error: 'Faça login com uma conta Liquid Hub para criar ou participar de uma JAM.' });
      return false;
    }
    const normCode = normalizeJamCode(code) || code.trim().toUpperCase();
    set({ busy: true, error: '' });
    try {
      const res = await jamClient.requestJoin(normCode, name, endpoint, {
        avatar: opts?.avatar,
        clientId: get().clientId || undefined,
      });
      const directSession = (res as { session?: JamSession }).session;
      if (res.status === 'approved' && directSession) {
        stopJoinRequestPolling();
        set({
          session: directSession,
          room: directSession,
          connected: true,
          reconnecting: false,
          pendingJoinRequest: null,
          pendingInvite: null,
          lookupState: { input: '', loading: false, result: null },
          error: '',
          rttMs: Math.round(jamClient.clock.rttMs),
        });
        useApp
          .getState()
          .message(`Você entrou na JAM ${directSession.roomName || directSession.code}.`);
        return true;
      }
      const reqId = res.requestId;
      const pendingReq: PendingJoinRequestState = {
        code: res.preview?.code || normCode,
        endpoint: res.endpoint || res.preview?.endpoint || endpoint,
        requestId: reqId,
        requestToken: res.requestToken || '',
        roomName: opts?.preview?.roomName || res.preview?.roomName || `JAM ${normCode}`,
        hostName: opts?.preview?.hostName || res.preview?.hostName || 'Anfitrião',
        hostAvatar: opts?.preview?.hostAvatar || res.preview?.hostAvatar,
        status: res.status,
        expiresAt: res.expiresAt,
      };
      stopJoinRequestPolling();
      set({
        pendingJoinRequest: pendingReq,
        pendingInvite: null,
        lookupState: { input: '', loading: false, result: null },
      });
      joinRequestPollTimer = setInterval(() => {
        const current = get().pendingJoinRequest;
        if (
          joinRequestPollInFlight ||
          !current ||
          current.requestId !== reqId ||
          get().session
        ) {
          if (!current || get().session) stopJoinRequestPolling();
          return;
        }
        joinRequestPollInFlight = true;
        void jamClient
          .checkJoinRequest(
            current.code,
            current.requestId,
            current.requestToken,
            current.endpoint,
          )
          .then(checked => {
            if (get().pendingJoinRequest?.requestId !== reqId) return;
            if (checked.status === 'approved' && checked.session) {
              stopJoinRequestPolling();
              set({
                session: checked.session,
                room: checked.session,
                connected: true,
                reconnecting: false,
                pendingJoinRequest: null,
                pendingInvite: null,
                error: '',
                rttMs: Math.round(jamClient.clock.rttMs),
              });
              useApp
                .getState()
                .message(`Entrada aprovada! Você entrou na JAM ${checked.session.roomName}.`);
              void invoke('call', { action: 'openJam', payload: null }).catch(() => {});
              return;
            }
            if (['rejected', 'blocked', 'expired', 'cancelled'].includes(checked.status)) {
              stopJoinRequestPolling();
              const terminalReason =
                checked.reason ||
                (checked.status === 'blocked'
                  ? 'Você foi bloqueado pelo anfitrião desta JAM.'
                  : checked.status === 'rejected'
                    ? 'O anfitrião recusou sua solicitação de entrada.'
                    : 'Solicitação de entrada expirada.');
              set(s =>
                s.pendingJoinRequest?.requestId === reqId
                  ? {
                      pendingJoinRequest: {
                        ...s.pendingJoinRequest,
                        status: checked.status,
                        reason: terminalReason,
                        errorCode: checked.errorCode,
                      },
                      error: terminalReason,
                    }
                  : s,
              );
            }
          })
          .catch(() => {})
          .finally(() => {
            joinRequestPollInFlight = false;
          });
      }, 1500);
      return true;
    } catch (e) {
      set({ error: cleanError(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  cancelJoinRequest: async () => {
    const current = get().pendingJoinRequest;
    stopJoinRequestPolling();
    set({ pendingJoinRequest: null, error: '' });
    if (current && current.requestToken) {
      try {
        await jamClient.cancelJoinRequest(
          current.code,
          current.requestId,
          current.requestToken,
          current.endpoint,
        );
      } catch {}
    }
  },

  clearJoinRequest: () => {
    stopJoinRequestPolling();
    set({ pendingJoinRequest: null, error: '' });
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

  approveJoin: async requestId => {
    try {
      const room = await jamClient.approveJoin(requestId);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message('Solicitação aprovada!');
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  rejectJoin: async (requestId, block = false) => {
    try {
      const room = await jamClient.rejectJoin(requestId, block);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp
        .getState()
        .message(block ? 'Solicitante bloqueado nesta JAM.' : 'Solicitação recusada.');
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  blockMember: async memberId => {
    try {
      const room = await jamClient.blockMember(memberId);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message('Participante bloqueado nesta JAM.');
    } catch (e) {
      set({ error: cleanError(e) });
    }
  },

  unblockMember: async blockKey => {
    try {
      const room = await jamClient.unblockMember(blockKey);
      set({
        session: jamClient.session ? { ...jamClient.session } : null,
        room,
        error: '',
      });
      useApp.getState().message('Participante desbloqueado.');
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
    stopJoinRequestPolling();
    const wasGuest = !!get().session && !get().session?.host;
    set({
      session: null,
      room: null,
      pendingJoinRequest: null,
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
    stopJoinRequestPolling();
    jamClient.clearLocal();
    set({
      session: null,
      room: null,
      pendingJoinRequest: null,
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
