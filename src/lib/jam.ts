import { invoke } from '@tauri-apps/api/core';
import {
  normalizeJamCode,
  type JamInviteLookupResult,
  type JamJoinRequestResult,
  type JamJoinRequestStatus,
  type JamPingResponse,
  type JamRequest,
  type JamRoom,
  type JamRoomPermissions,
  type JamSession,
  type LanJamAnnouncement,
} from '../../shared/jam';
import { discoverLanJamRooms } from './discovery';

export type JamSend = <T>(request: JamRequest | { action: 'status' }) => Promise<T>;
export const sendJam: JamSend = request => invoke('call', { action: 'jam', payload: request });

export function generateJamNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function computeBackoffMs(
  attempt: number,
  baseMs = 600,
  maxMs = 12000,
  jitterRatio = 0.15,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(8, attempt)));
  const jitter = exp * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.min(maxMs, Math.round(exp + jitter)));
}

function isLocalHostname(host: string): boolean {
  const low = host.toLowerCase();
  if (low === 'localhost' || low === '[::1]') return true;
  if (/^127\./.test(low) || /^10\./.test(low) || /^192\.168\./.test(low)) return true;
  const m172 = /^172\.(\d{1,3})\./.exec(low);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return low.startsWith('[fc') || low.startsWith('[fd');
}

export function validateSafeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') {
      return '';
    }
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && isLocalHostname(u.hostname)) return u.origin;
  } catch {}
  return '';
}

export function parseJamInvite(value: string, defaultEndpoint = ''): { code: string; endpoint: string } {
  const trimmed = value.trim();
  const safeDefault = validateSafeEndpoint(defaultEndpoint);
  if (!trimmed) return { code: '', endpoint: '' };

  // Direct raw invite code (e.g. "K9M4P2XR", "k9m4-p2xr", "ABCDEF0123")
  const directCode = normalizeJamCode(trimmed);
  if (directCode) {
    return { code: directCode, endpoint: safeDefault };
  }

  // Extract URL even if user pasted a shared chat message from WhatsApp/Discord
  const urlMatch = /(liquidhub:\/\/[^\s<>"']+|https?:\/\/[^\s<>"']+)/i.exec(trimmed);
  const candidate = urlMatch ? urlMatch[1]!.replace(/[),.;!?]+$/, '') : trimmed;

  try {
    const url = new URL(candidate);
    if (url.username || url.password) return { code: '', endpoint: '' };

    if (url.protocol === 'liquidhub:') {
      const segs = url.pathname
        .split('/')
        .map(s => decodeURIComponent(s.trim()))
        .filter(Boolean);
      const host = url.hostname.toLowerCase();
      let rawCode = '';
      if (host === 'jam') {
        if (segs.length === 2 && segs[0]!.toLowerCase() === 'join') rawCode = segs[1]!;
        else if (segs.length === 1) rawCode = segs[0]!;
        else if (segs.length === 0) rawCode = url.searchParams.get('code') || url.searchParams.get('jam') || '';
        else return { code: '', endpoint: '' };
      } else if (host === 'join') {
        if (segs.length === 1) rawCode = segs[0]!;
        else if (segs.length === 0) rawCode = url.searchParams.get('code') || url.searchParams.get('jam') || '';
        else return { code: '', endpoint: '' };
      } else {
        return { code: '', endpoint: '' };
      }

      const code = normalizeJamCode(rawCode);
      if (!code) return { code: '', endpoint: '' };

      const epParam = url.searchParams.get('endpoint') || '';
      const resolvedEp = epParam ? validateSafeEndpoint(epParam) : safeDefault;
      if (epParam && !resolvedEp) return { code: '', endpoint: '' };
      return { code, endpoint: resolvedEp };
    }

    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const origin = validateSafeEndpoint(url.origin);
      if (!origin) return { code: '', endpoint: '' };

      const segs = url.pathname
        .split('/')
        .map(s => decodeURIComponent(s.trim()))
        .filter(Boolean);
      let rawCode = '';
      let epParam = url.searchParams.get('endpoint') || '';
      if (segs.length === 3 && segs[0]!.toLowerCase() === 'jam' && segs[1]!.toLowerCase() === 'join') {
        rawCode = segs[2]!;
      } else if (segs.length === 2 && segs[0]!.toLowerCase() === 'join') {
        rawCode = segs[1]!;
      } else {
        rawCode = url.searchParams.get('jam') || url.searchParams.get('code') || '';
      }
      if (!rawCode && url.hash) {
        const frag = url.hash.replace(/^#[?/]?/, '');
        const hashParams = new URLSearchParams(frag);
        rawCode = hashParams.get('jam') || hashParams.get('code') || '';
        if (!epParam) epParam = hashParams.get('endpoint') || '';
      }
      const code = normalizeJamCode(rawCode);
      if (!code) return { code: '', endpoint: '' };
      const targetEndpoint = epParam ? validateSafeEndpoint(epParam) : origin;
      if (epParam && !targetEndpoint) return { code: '', endpoint: '' };
      return { code, endpoint: targetEndpoint };
    }
  } catch {}

  return { code: '', endpoint: '' };
}

export function buildJamInvite(endpoint: string, code: string): string {
  const cleanCode = normalizeJamCode(code) || code.trim().toUpperCase();
  const cleanEp = validateSafeEndpoint(endpoint) || endpoint.trim().replace(/\/+$/, '');
  if (cleanEp && !cleanEp.includes('liquid-hub-jam.nlzezwrld.workers.dev') && isLocalJamEndpoint(cleanEp)) {
    const params = new URLSearchParams({ jam: cleanCode, endpoint: cleanEp });
    return `https://liquid-hub-jam.nlzezwrld.workers.dev/#${params}`;
  }
  return buildJamInviteUrl(cleanCode, cleanEp);
}

export function buildJamInviteUrl(code: string, endpoint?: string): string {
  const cleanCode = normalizeJamCode(code) || code.trim().toUpperCase();
  const cleanEp = (endpoint || '').trim().replace(/\/+$/, '');
  if (cleanEp) {
    return `${cleanEp}/jam/join/${cleanCode}`;
  }
  return `liquidhub://jam/join/${cleanCode}`;
}

export function buildJamDeepLink(code: string, endpoint?: string): string {
  const cleanCode = normalizeJamCode(code) || code.trim().toUpperCase();
  const cleanEp = (endpoint || '').trim().replace(/\/+$/, '');
  return cleanEp
    ? `liquidhub://jam/join/${cleanCode}?endpoint=${encodeURIComponent(cleanEp)}`
    : `liquidhub://jam/join/${cleanCode}`;
}

export function buildWhatsAppShareUrl(roomName: string, inviteUrl: string, code: string): string {
  const text = `Entre na minha JAM "${roomName}" no Liquid Hub!\nLink: ${inviteUrl}\nCódigo: ${code}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function buildDiscordShareText(roomName: string, inviteUrl: string, code: string): string {
  return `🎧 **${roomName}** — Entra na minha JAM no Liquid Hub!\n🔗 ${inviteUrl}\n🔑 Código: \`${code}\``;
}

export async function shareNativeInvite(opts: {
  roomName: string;
  inviteUrl: string;
  code: string;
}): Promise<'shared' | 'copied'> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: `${opts.roomName} · Liquid Hub JAM`,
        text: `Entre na minha JAM "${opts.roomName}" no Liquid Hub (código ${opts.code})`,
        url: opts.inviteUrl,
      });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw e;
      }
    }
  }
  await navigator.clipboard.writeText(opts.inviteUrl);
  return 'copied';
}

/**
 * Clock sample uses the request midpoint; prefers low-RTT samples to reject queueing bias
 * and maintains millisecond RTT & jitter telemetry for Clock Drift Compensation.
 */
export class JamClock {
  offset = 0;
  rttMs = 0;
  jitterMs = 0;
  private best = Number.POSITIVE_INFINITY;

  sample(start: number, end: number, serverTime: number) {
    const roundTrip = Math.max(0, end - start),
      offset = serverTime - (start + end) / 2;
    if (!Number.isFinite(offset)) return;
    if (this.rttMs > 0) {
      this.jitterMs = this.jitterMs * 0.75 + Math.abs(roundTrip - this.rttMs) * 0.25;
    }
    this.rttMs = roundTrip;
    if (roundTrip <= this.best * 1.5) {
      this.offset = Number.isFinite(this.best) ? this.offset * 0.3 + offset * 0.7 : offset;
      this.best = Math.min(this.best, roundTrip);
    } else {
      this.best = Math.min(this.best * 1.1, roundTrip);
    }
  }

  now() {
    return Date.now() + this.offset;
  }

  reset() {
    this.offset = 0;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.best = Number.POSITIVE_INFINITY;
  }
}

export function isLocalJamEndpoint(endpoint?: string): boolean {
  if (!endpoint) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function jamWebSocketUrl(endpoint: string | undefined, code: string, token: string): string | null {
  const cleanCode = normalizeJamCode(code);
  if (!endpoint || !cleanCode || cleanCode.length < 8 || !token) return null;
  try {
    const u = new URL(endpoint);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${u.host}/v1/jam/ws?code=${encodeURIComponent(cleanCode)}&token=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

export interface HostSyncSnapshot {
  trackId: string | null;
  playing: boolean;
  position: number;
  sentAt: number;
}

/**
 * Change-driven host sync detector: avoids redundant network & SQLite writes while a track plays
 * smoothly, triggering a sync only on initial state, track change, play/pause, or seek (> threshold).
 */
export function shouldHostSync(
  last: HostSyncSnapshot | null,
  next: { trackId: string | null; playing: boolean; position: number },
  nowMs: number,
  driftThresholdSec = 0.75,
): boolean {
  if (!last) return true;
  if (last.trackId !== next.trackId) return true;
  if (last.playing !== next.playing) return true;
  const elapsedSec = last.playing ? Math.max(0, (nowMs - last.sentAt) / 1000) : 0;
  const expectedPos = last.position + elapsedSec;
  return Math.abs(next.position - expectedPos) > driftThresholdSec;
}

export class JamClient {
  session: JamSession | null = null;
  readonly clock = new JamClock();
  private lastKnownName = 'Ouvinte';
  private lastRoomName = '';
  private lastAvatar = '';
  private clientId = '';
  private lastSequence = -1;
  private cachedRoom: JamRoom | null = null;
  private enterLock: Promise<JamSession> | null = null;
  private send: JamSend;
  private lanDiscovery: (code?: string) => Promise<LanJamAnnouncement[]>;

  constructor(
    send: JamSend = sendJam,
    lanDiscovery: (code?: string) => Promise<LanJamAnnouncement[]> = discoverLanJamRooms,
  ) {
    this.send = send;
    this.lanDiscovery = lanDiscovery;
  }

  setClientId(id: string) {
    if (id && /^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      this.clientId = id;
    }
  }

  private stamp(request: JamRequest): JamRequest {
    const now = Date.now();
    return {
      ...request,
      nonce: request.nonce || generateJamNonce(),
      timestamp: request.timestamp ?? Math.round(this.clock.now()),
      clientTime: now,
    };
  }

  private async request<T extends { serverTime: number }>(request: JamRequest) {
    const stamped = this.stamp(request);
    const start = Date.now(),
      value = await this.send<T>(stamped);
    this.clock.sample(start, Date.now(), value.serverTime);
    return value;
  }

  private decorateSession(session: JamSession, fallbackEndpoint?: string): JamSession {
    const ep = session.endpoint || fallbackEndpoint || '';
    return {
      ...session,
      ...(ep ? { endpoint: ep } : {}),
      inviteUrl: buildJamInviteUrl(session.code, ep),
      deepLinkUrl: buildJamDeepLink(session.code, ep),
    };
  }

  async ping(endpoint?: string): Promise<number> {
    const targetEndpoint = endpoint ?? this.session?.endpoint;
    const start = Date.now();
    const res = await this.send<JamPingResponse>(
      this.stamp({ action: 'ping', endpoint: targetEndpoint }),
    );
    const end = Date.now();
    this.clock.sample(start, end, res.serverTime);
    return Math.max(0, end - start);
  }

  async lookup(codeOrUrl: string, defaultEndpoint = ''): Promise<JamInviteLookupResult> {
    const parsed = parseJamInvite(codeOrUrl, defaultEndpoint);
    if (!parsed.code) {
      return {
        found: false,
        errorCode: 'INVITE_INVALID',
        error: 'Digite um código válido (6 a 16 letras/números) ou cole um link de convite.',
      };
    }
    return this.send<JamInviteLookupResult>({
      action: 'lookup',
      code: parsed.code,
      ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}),
    });
  }

  async enter(
    action: 'create' | 'createLocal' | 'join',
    name: string,
    code?: string,
    endpoint?: string,
    opts?: {
      roomName?: string;
      avatar?: string;
      clientId?: string;
      requireAuth?: boolean;
      requireApproval?: boolean;
      permissions?: Partial<JamRoomPermissions>;
      inviteTtlMs?: number;
    },
  ): Promise<JamSession> {
    if (this.enterLock) return this.enterLock;
    const task = (async () => {
      this.clock.reset();
      this.lastSequence = -1;
      this.cachedRoom = null;
      this.lastKnownName = name.trim() || 'Ouvinte';
      if (opts?.roomName !== undefined) this.lastRoomName = opts.roomName.trim();
      if (opts?.avatar !== undefined) this.lastAvatar = opts.avatar.trim();
      const cid = opts?.clientId || this.clientId || undefined;
      const normCode = code ? normalizeJamCode(code) || code.trim().toUpperCase() : undefined;

      const rawSession = await this.request<JamSession>({
        action,
        name: this.lastKnownName,
        ...(normCode ? { code: normCode } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(this.lastRoomName ? { roomName: this.lastRoomName } : {}),
        ...(this.lastAvatar ? { avatar: this.lastAvatar } : {}),
        ...(cid ? { clientId: cid } : {}),
        ...(opts?.requireAuth !== undefined ? { requireAuth: opts.requireAuth } : {}),
        ...(opts?.requireApproval !== undefined ? { requireApproval: opts.requireApproval } : {}),
        ...(opts?.permissions ? { permissions: opts.permissions } : {}),
        ...(opts?.inviteTtlMs !== undefined ? { inviteTtlMs: opts.inviteTtlMs } : {}),
      });
      rawSession.mode =
        action === 'createLocal' || isLocalJamEndpoint(rawSession.endpoint || endpoint)
          ? 'lan'
          : 'cloud';
      const session = this.decorateSession(rawSession, endpoint);
      this.session = session;
      this.cachedRoom = session;
      this.lastSequence = session.playback.sequence;
      return session;
    })();
    this.enterLock = task;
    try {
      return await task;
    } finally {
      if (this.enterLock === task) this.enterLock = null;
    }
  }

  async requestJoin(
    code: string,
    name: string,
    endpoint?: string,
    opts?: { avatar?: string; clientId?: string },
  ): Promise<JamJoinRequestResult> {
    this.lastKnownName = name.trim() || 'Ouvinte';
    if (opts?.avatar !== undefined) this.lastAvatar = opts.avatar.trim();
    const cid = opts?.clientId || this.clientId || undefined;
    const normCode = normalizeJamCode(code) || code.trim().toUpperCase();
    const res = await this.request<JamJoinRequestResult>({
      action: 'requestJoin',
      code: normCode,
      name: this.lastKnownName,
      ...(endpoint ? { endpoint } : {}),
      ...(this.lastAvatar ? { avatar: this.lastAvatar } : {}),
      ...(cid ? { clientId: cid } : {}),
    });
    if (res.status === 'approved' && res.session) {
      res.session.mode = isLocalJamEndpoint(res.session.endpoint || endpoint) ? 'lan' : 'cloud';
      const session = this.decorateSession(res.session, endpoint);
      this.session = session;
      this.cachedRoom = session;
      this.lastSequence = session.playback.sequence;
      res.session = session;
    }
    return res;
  }

  async checkJoinRequest(
    code: string,
    requestId: string,
    requestToken: string,
    endpoint?: string,
  ): Promise<JamJoinRequestResult> {
    const normCode = normalizeJamCode(code) || code.trim().toUpperCase();
    const res = await this.request<JamJoinRequestResult>({
      action: 'checkJoinRequest',
      code: normCode,
      requestId,
      requestToken,
      ...(endpoint ? { endpoint } : {}),
    });
    if (res.status === 'approved' && res.session) {
      res.session.mode = isLocalJamEndpoint(res.session.endpoint || endpoint) ? 'lan' : 'cloud';
      const session = this.decorateSession(res.session, endpoint);
      this.session = session;
      this.cachedRoom = session;
      this.lastSequence = session.playback.sequence;
      res.session = session;
    }
    return res;
  }

  async cancelJoinRequest(
    code: string,
    requestId: string,
    requestToken: string,
    endpoint?: string,
  ): Promise<{ status: JamJoinRequestStatus; requestId: string; serverTime: number }> {
    const normCode = normalizeJamCode(code) || code.trim().toUpperCase();
    return this.request<{ status: JamJoinRequestStatus; requestId: string; serverTime: number }>({
      action: 'cancelJoinRequest',
      code: normCode,
      requestId,
      requestToken,
      ...(endpoint ? { endpoint } : {}),
    });
  }

  async resume(): Promise<JamSession> {
    const s = this.session;
    if (!s) throw new Error('Nenhuma sessão JAM para restaurar.');
    const rawSession = await this.request<JamSession>({
      action: 'resume',
      code: s.code,
      resumeToken: s.token,
      name: this.lastKnownName,
      ...(s.clientId || this.clientId ? { clientId: s.clientId || this.clientId } : {}),
      ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    });
    rawSession.mode = s.mode || (isLocalJamEndpoint(rawSession.endpoint || s.endpoint) ? 'lan' : 'cloud');
    const restored = this.decorateSession(rawSession, s.endpoint);
    this.session = restored;
    this.cachedRoom = restored;
    this.lastSequence = restored.playback.sequence;
    return restored;
  }

  async rotateInvite(): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'rotateInvite',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
    });
    return this.applyPush(room);
  }

  async updateRoom(patch: {
    roomName?: string;
    locked?: boolean;
    requireAuth?: boolean;
    requireApproval?: boolean;
    permissions?: Partial<JamRoomPermissions>;
  }): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'updateRoom',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      ...patch,
    });
    return this.applyPush(room);
  }

  async approveJoin(requestId: string): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'approveJoin',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      requestId,
    });
    return this.applyPush(room);
  }

  async rejectJoin(requestId: string, block = false): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'rejectJoin',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      requestId,
      block,
    });
    return this.applyPush(room);
  }

  async blockMember(memberId: string): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'blockMember',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      memberId,
    });
    return this.applyPush(room);
  }

  async unblockMember(blockKey: string): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'unblockMember',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      blockKey,
    });
    return this.applyPush(room);
  }

  async kick(memberId: string): Promise<JamRoom> {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'kick',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      memberId,
    });
    return this.applyPush(room);
  }

  private cleanPlayback(playback?: JamRequest['playback']) {
    if (!playback) return undefined;
    const t = playback.track;
    const clean = t
      ? {
          id: t.id,
          source: t.source,
          sourceId: t.sourceId,
          kind: t.kind,
          title: t.title,
          artist: t.artist,
          duration: t.duration,
          url: t.url,
          artwork: t.artwork,
          playbackId: t.playbackId,
          addedAt: 0,
        }
      : null;
    return { ...playback, track: clean };
  }

  buildSyncCommand(playback?: JamRequest['playback']): JamRequest {
    return this.stamp({
      action: 'sync',
      playback: this.cleanPlayback(playback),
    });
  }

  buildPollCommand(): JamRequest {
    return this.stamp({
      action: 'poll',
      ...(this.lastSequence >= 0 ? { sinceSequence: this.lastSequence } : {}),
    });
  }

  applyRoom(room: JamRoom): JamRoom {
    return this.applyPush(room);
  }

  applyPush(room: JamRoom): JamRoom {
    const merged: JamRoom =
      room.unchanged && this.cachedRoom
        ? {
            ...room,
            playback: {
              ...room.playback,
              track: room.playback.track ?? this.cachedRoom.playback.track,
            },
          }
        : room;
    this.cachedRoom = merged;
    this.lastSequence = merged.playback.sequence;
    if (this.session) {
      this.session = this.decorateSession(
        {
          ...this.session,
          ...merged,
        },
        this.session.endpoint,
      );
    }
    return merged;
  }

  async update(playback?: JamRequest['playback']) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const isSync = s.host && playback !== undefined;
    const room = await this.request<JamRoom>({
      action: isSync ? 'sync' : 'poll',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      ...(!isSync && this.lastSequence >= 0 ? { sinceSequence: this.lastSequence } : {}),
      ...(isSync ? { playback: this.cleanPlayback(playback) } : {}),
    });
    return this.applyPush(room);
  }

  async voteSkip() {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'voteSkip',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
    });
    return this.applyPush(room);
  }

  async queueAdd(track: NonNullable<JamRequest['track']>) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const clean = this.cleanPlayback({ track, playing: false, position: 0 })?.track;
    if (!clean) throw new Error('Apenas faixas online podem ser adicionadas à fila da JAM.');
    const room = await this.request<JamRoom>({
      action: 'queueAdd',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      track: clean,
    });
    return this.applyPush(room);
  }

  async queueRemove(queueItemId: string) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'queueRemove',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      queueItemId,
    });
    return this.applyPush(room);
  }

  async recommendPlaylist(playlistName: string, tracks: NonNullable<JamRequest['playlistTracks']>) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const cleaned = tracks
      .map(t => this.cleanPlayback({ track: t, playing: false, position: 0 })?.track)
      .filter((t): t is NonNullable<typeof t> => !!t)
      .slice(0, 10);
    if (!cleaned.length) {
      throw new Error('A playlist precisa ter ao menos uma faixa online.');
    }
    const room = await this.request<JamRoom>({
      action: 'recommendPlaylist',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      playlistName,
      playlistTracks: cleaned,
    });
    return this.applyPush(room);
  }

  async sendChat(message: string) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const room = await this.request<JamRoom>({
      action: 'chat',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      message,
    });
    return this.applyPush(room);
  }

  /**
   * Hybrid Cloud -> LAN Fallback:
   * - Host: automatically spins up the native LAN coordinator (`createLocal`) preserving room code & playback.
   * - Guest: scans LAN via UDP discovery for the matching room code and seamlessly rejoins on LAN.
   */
  async fallbackToLan(playback?: JamRequest['playback']): Promise<JamSession | null> {
    const current = this.session;
    if (!current || current.mode === 'lan' || current.mode === 'lan-fallback') return null;

    if (current.host) {
      const migratedRaw = await this.request<JamSession>({
        action: 'createLocal',
        name: this.lastKnownName,
        roomName: current.roomName || this.lastRoomName || undefined,
        preferredCode: current.code,
        ...(this.clientId || current.clientId ? { clientId: this.clientId || current.clientId } : {}),
      });
      migratedRaw.mode = 'lan-fallback';
      let migrated = this.decorateSession(migratedRaw);
      this.session = migrated;
      this.cachedRoom = migrated;
      this.lastSequence = migrated.playback.sequence;
      if (playback) {
        const synced = await this.update(playback);
        migrated = this.decorateSession({
          ...migrated,
          ...synced,
          playback: synced.playback,
          members: synced.members,
        });
        this.session = migrated;
      }
      return this.session;
    }

    const matches = await this.lanDiscovery(current.code);
    const target = matches[0];
    if (!target?.endpoint) return null;
    const rejoinedRaw = await this.request<JamSession>({
      action: 'join',
      name: this.lastKnownName,
      code: target.code,
      endpoint: target.endpoint,
      ...(this.clientId || current.clientId ? { clientId: this.clientId || current.clientId } : {}),
    });
    rejoinedRaw.mode = 'lan-fallback';
    const rejoined = this.decorateSession(rejoinedRaw, target.endpoint);
    this.session = rejoined;
    this.cachedRoom = rejoined;
    this.lastSequence = rejoined.playback.sequence;
    return rejoined;
  }

  clearLocal() {
    this.session = null;
    this.cachedRoom = null;
    this.lastSequence = -1;
  }

  async leave() {
    const s = this.session;
    this.clearLocal();
    if (s) {
      await this.request<{ serverTime: number }>({
        action: 'leave',
        code: s.code,
        token: s.token,
        endpoint: s.endpoint,
      });
    }
  }
}
