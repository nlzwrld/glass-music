import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  canJam,
  type JamInviteLookupResult,
  type JamInvitePreview,
  type JamRoom,
  type JamRoomPermissions,
  type JamSession,
  type LanJamAnnouncement,
} from '../../shared/jam';
import type { Preferences, Track } from '../../shared/types';
import { useJam, type PendingJoinRequestState } from '../components/jam/state';
import { useAccounts } from '../stores/accounts';
import { useApp } from '../stores/app';
import { parseJamInvite } from './jam';

export async function openJamWindow(): Promise<void> {
  try {
    await invoke('call', { action: 'openJam', payload: null });
  } catch {}
}

export async function closeJamWindow(): Promise<void> {
  try {
    await invoke('call', { action: 'closeJam', payload: null });
  } catch {}
}

export async function pinJamWindow(pinned: boolean): Promise<void> {
  try {
    await invoke('call', { action: 'pinJam', payload: { pinned } });
  } catch {}
}

export async function dispatchJamControl(
  payload: Record<string, unknown> & { action: string },
): Promise<void> {
  await invoke('call', { action: 'jamControl', payload });
}

export type SanitizedJamSession = Omit<JamSession, 'token'>;
export type SanitizedJoinRequest = Omit<PendingJoinRequestState, 'requestToken'>;

export interface ShareablePlaylistSummary {
  id: string;
  name: string;
  tracks: Track[];
}

export interface JamWindowSnapshot {
  session: SanitizedJamSession | null;
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
  pendingJoinRequest: SanitizedJoinRequest | null;
  lookupState: {
    input: string;
    loading: boolean;
    result: JamInviteLookupResult | null;
  };
  auth: {
    authenticated: boolean;
    needsTermsAcceptance: boolean;
    displayName: string;
    avatarUrl: string | null;
    providerLabel: string | null;
  };
  onlineConsent: boolean;
  currentTrack: Track | null;
  playing: boolean;
  libraryTracks: Track[];
  shareablePlaylists: ShareablePlaylistSummary[];
  preferences: Preferences;
}

export function resolveHubIdentity(hub: ReturnType<typeof useAccounts.getState>['hub']) {
  const identities = hub.identities || [];
  const preferred =
    identities.find(i => i.provider === 'google') ||
    identities.find(i => i.provider === 'discord') ||
    identities.find(i => i.provider === 'github') ||
    null;
  const displayName = (
    hub.displayName ||
    preferred?.displayName ||
    preferred?.username ||
    hub.username ||
    hub.subject ||
    'Ouvinte'
  )
    .trim()
    .slice(0, 40);
  const providerLabel =
    preferred?.provider === 'google'
      ? 'Google'
      : preferred?.provider === 'discord'
        ? 'Discord'
        : preferred?.provider === 'github'
          ? 'GitHub'
          : null;
  const avatarUrl = hub.avatarUrl || preferred?.avatarUrl || null;
  return {
    displayName: displayName || 'Ouvinte',
    avatarUrl,
    providerLabel,
  };
}

function stripSessionSecret(session: JamSession | null): SanitizedJamSession | null {
  if (!session) return null;
  const { token: _secretToken, ...safe } = session;
  return safe;
}

function stripRoomSecret(room: JamRoom | null): JamRoom | null {
  if (!room) return null;
  const { token: _secretToken, ...safe } = room as JamRoom & { token?: string };
  return safe;
}

function stripJoinRequestSecret(
  req: PendingJoinRequestState | null,
): SanitizedJoinRequest | null {
  if (!req) return null;
  const { requestToken: _secretToken, ...safe } = req;
  return safe;
}

export function sanitizeJamSnapshotForWindow(
  jamState: ReturnType<typeof useJam.getState>,
  appState: ReturnType<typeof useApp.getState>,
  accountState: ReturnType<typeof useAccounts.getState>,
): JamWindowSnapshot {
  const identity = resolveHubIdentity(accountState.hub);
  const tracks = appState.data.tracks || [];
  const playlists = appState.data.playlists || [];
  const trackById = new Map(tracks.map(t => [t.id, t]));
  const libraryTracks = tracks.filter(t => canJam(t)).slice(0, 12);
  const shareablePlaylists: ShareablePlaylistSummary[] = [];
  for (const pl of playlists) {
    const validTracks = pl.trackIds
      .map(id => trackById.get(id))
      .filter((t): t is Track => canJam(t))
      .slice(0, 20);
    if (validTracks.length > 0) {
      shareablePlaylists.push({ id: pl.id, name: pl.name, tracks: validTracks });
    }
  }
  const prefs = appState.data.preferences;
  return {
    session: stripSessionSecret(jamState.session),
    room: stripRoomSecret(jamState.room),
    lanRooms: jamState.lanRooms,
    rttMs: jamState.rttMs,
    busy: jamState.busy,
    error: jamState.error,
    connected: jamState.connected,
    realtimeConnected: jamState.realtimeConnected,
    reconnecting: jamState.reconnecting,
    endpoint: jamState.endpoint,
    configured: jamState.configured,
    pendingJoinRequest: stripJoinRequestSecret(jamState.pendingJoinRequest),
    lookupState: jamState.lookupState,
    auth: {
      authenticated: Boolean(accountState.hub.authenticated),
      needsTermsAcceptance: Boolean(accountState.hub.needsTermsAcceptance),
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      providerLabel: identity.providerLabel,
    },
    onlineConsent: Boolean(prefs.onlineConsent && prefs.onboardingDone),
    currentTrack: appState.queue[appState.index] || null,
    playing: appState.playing,
    libraryTracks,
    shareablePlaylists,
    preferences: {
      ...prefs,
      appearance: { ...prefs.appearance, customImage: '' },
    },
  };
}

interface JamControlPayload {
  action: string;
  value?: string;
  code?: string;
  endpoint?: string;
  roomName?: string;
  local?: boolean;
  direct?: boolean;
  requireApproval?: boolean;
  requireAuth?: boolean;
  locked?: boolean;
  permissions?: Partial<JamRoomPermissions>;
  preview?: JamInvitePreview | null;
  requestId?: string;
  block?: boolean;
  memberId?: string;
  blockKey?: string;
  track?: Track;
  queueItemId?: string;
  playlistId?: string;
  playlistName?: string;
  playlistTracks?: Track[];
  message?: string;
  notice?: string;
}

export function JamWindowBridge() {
  useEffect(() => {
    let offControl: (() => void) | undefined;
    let offOpen: (() => void) | undefined;
    let unsubJam: (() => void) | undefined;
    let unsubAccounts: (() => void) | undefined;
    let unsubApp: (() => void) | undefined;
    let intervalTimer: ReturnType<typeof setInterval> | undefined;
    let pushDebounce: ReturnType<typeof setTimeout> | undefined;
    let isOpen = false;
    let disposed = false;

    const sendNow = () => {
      if (disposed || !isOpen) return;
      const appState = useApp.getState();
      if (!appState.ready) return;
      const payload = sanitizeJamSnapshotForWindow(
        useJam.getState(),
        appState,
        useAccounts.getState(),
      );
      void invoke('call', { action: 'jamState', payload }).catch(() => {});
    };

    const scheduleSend = () => {
      if (disposed || !isOpen || pushDebounce) return;
      pushDebounce = setTimeout(() => {
        pushDebounce = undefined;
        sendNow();
      }, 30);
    };

    const setWindowOpen = (open: boolean) => {
      if (disposed) return;
      isOpen = open;
      useJam.setState({ jamWindowOpen: open });
      if (open) {
        void useJam.getState().refresh();
        sendNow();
        if (!intervalTimer) {
          intervalTimer = setInterval(sendNow, 1000);
        }
        if (!unsubJam) unsubJam = useJam.subscribe(scheduleSend);
        if (!unsubAccounts) unsubAccounts = useAccounts.subscribe(scheduleSend);
        if (!unsubApp) {
          unsubApp = useApp.subscribe((next, prev) => {
            if (
              next.playing !== prev.playing ||
              next.index !== prev.index ||
              next.queue !== prev.queue ||
              next.data.tracks !== prev.data.tracks ||
              next.data.playlists !== prev.data.playlists ||
              next.data.preferences !== prev.data.preferences
            ) {
              scheduleSend();
            }
          });
        }
      } else {
        if (intervalTimer) {
          clearInterval(intervalTimer);
          intervalTimer = undefined;
        }
        if (pushDebounce) {
          clearTimeout(pushDebounce);
          pushDebounce = undefined;
        }
        unsubJam?.();
        unsubJam = undefined;
        unsubAccounts?.();
        unsubAccounts = undefined;
        unsubApp?.();
        unsubApp = undefined;
      }
    };

    const handleControl = async (p: JamControlPayload) => {
      const jam = useJam.getState();
      const identity = resolveHubIdentity(useAccounts.getState().hub);
      switch (p.action) {
        case 'create': {
          const ok = await jam.enter(
            p.local ? 'createLocal' : 'create',
            identity.displayName,
            undefined,
            undefined,
            {
              roomName: p.roomName,
              avatar: identity.avatarUrl || undefined,
              requireAuth: p.requireAuth,
              requireApproval: p.requireApproval ?? true,
              permissions: p.permissions,
            },
          );
          if (ok) {
            useApp.getState().message('JAM criada! Compartilhe o link para convidar amigos.');
          }
          break;
        }
        case 'lookup':
          await jam.lookupInvite(String(p.value || ''));
          break;
        case 'requestJoin': {
          const parsed = p.code
            ? { code: p.code, endpoint: p.endpoint || '' }
            : parseJamInvite(String(p.value || ''), jam.endpoint);
          if (!parsed.code) return;
          if (p.direct) {
            await jam.enter('join', identity.displayName, parsed.code, parsed.endpoint || undefined, {
              avatar: identity.avatarUrl || undefined,
            });
          } else {
            await jam.requestJoin(parsed.code, identity.displayName, parsed.endpoint || undefined, {
              avatar: identity.avatarUrl || undefined,
              preview: p.preview,
            });
          }
          break;
        }
        case 'cancelJoinRequest':
          await jam.cancelJoinRequest();
          break;
        case 'approveJoin':
          if (p.requestId) await jam.approveJoin(p.requestId);
          break;
        case 'rejectJoin':
          if (p.requestId) await jam.rejectJoin(p.requestId, Boolean(p.block));
          break;
        case 'blockMember':
          if (p.memberId) await jam.blockMember(p.memberId);
          break;
        case 'unblockMember':
          if (p.blockKey) await jam.unblockMember(p.blockKey);
          break;
        case 'kick':
          if (p.memberId) await jam.kick(p.memberId);
          break;
        case 'updateRoom':
          await jam.updateRoom({
            ...(p.roomName !== undefined ? { roomName: p.roomName } : {}),
            ...(p.locked !== undefined ? { locked: p.locked } : {}),
            ...(p.requireAuth !== undefined ? { requireAuth: p.requireAuth } : {}),
            ...(p.requireApproval !== undefined ? { requireApproval: p.requireApproval } : {}),
            ...(p.permissions !== undefined ? { permissions: p.permissions } : {}),
          });
          break;
        case 'rotateInvite':
          await jam.rotateInvite();
          break;
        case 'voteSkip':
          await jam.voteSkip();
          break;
        case 'queueAdd':
          if (p.track) await jam.queueAdd(p.track);
          break;
        case 'queueRemove':
          if (p.queueItemId) await jam.queueRemove(p.queueItemId);
          break;
        case 'recommendPlaylist': {
          if (p.playlistId) {
            const snap = useApp.getState().data;
            const pl = snap.playlists.find(item => item.id === p.playlistId);
            if (!pl) return;
            const tracks = pl.trackIds
              .map(id => snap.tracks.find(t => t.id === id))
              .filter((t): t is Track => canJam(t));
            if (tracks.length) await jam.recommendPlaylist(pl.name, tracks);
          } else if (p.playlistName && Array.isArray(p.playlistTracks)) {
            await jam.recommendPlaylist(p.playlistName, p.playlistTracks);
          }
          break;
        }
        case 'savePlaylist': {
          const plName = String(p.playlistName || '').trim();
          const tracks = Array.isArray(p.playlistTracks)
            ? p.playlistTracks.filter(t => canJam(t))
            : [];
          if (!plName || !tracks.length) return;
          try {
            let snap = await window.glass.library({ action: 'create', name: plName });
            const created = [...snap.playlists].reverse().find(item => item.name === plName);
            if (created) {
              for (const tr of tracks) {
                snap = await window.glass.library({ action: 'add', id: created.id, track: tr });
              }
            }
            useApp.setState(s => ({ data: { ...snap, preferences: s.data.preferences } }));
            void useAccounts.getState().syncLibraryToCloud();
            useApp.getState().message(`Playlist "${plName}" salva na sua biblioteca!`);
          } catch {
            useApp.getState().message('Não foi possível salvar a playlist recomendada.');
          }
          break;
        }
        case 'chat':
          if (p.message) await jam.sendChat(p.message);
          break;
        case 'leave':
          await jam.leave(p.notice);
          break;
        case 'scanLan':
          await jam.scanLan();
          break;
        case 'resync': {
          const s = jam.session;
          if (!s) return;
          const { jamClient } = await import('../components/jam/state');
          if (s.host) {
            const app = useApp.getState();
            await jamClient.update({
              track: app.queue[app.index] || null,
              playing: app.playing,
              position: app.position,
            });
          } else {
            const room = await jamClient.update();
            useJam.setState({
              session: jamClient.session ? { ...jamClient.session } : null,
              room,
              rttMs: Math.round(jamClient.clock.rttMs),
            });
          }
          break;
        }
        case 'playTrack':
          if (jam.session?.host && p.track && canJam(p.track)) {
            useApp.getState().play(p.track, [p.track]);
          }
          break;
      }
      sendNow();
    };

    void listen<JamControlPayload>('jam-control', e => {
      void handleControl(e.payload);
    }).then(fn => {
      if (disposed) fn();
      else offControl = fn;
    });

    void listen<boolean>('jam-window-open', e => {
      setWindowOpen(Boolean(e.payload));
    }).then(fn => {
      if (disposed) fn();
      else offOpen = fn;
    });

    void invoke<boolean>('call', { action: 'jamWindowOpen', payload: null })
      .then(open => {
        if (!disposed) setWindowOpen(Boolean(open));
      })
      .catch(() => {});

    return () => {
      disposed = true;
      setWindowOpen(false);
      offControl?.();
      offOpen?.();
    };
  }, []);

  return null;
}
