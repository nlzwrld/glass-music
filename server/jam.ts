/**
 * Liquid Hub — High-Capacity Ephemeral + Persistent JAM Coordinator (v3)
 * Dual Runtime:
 *   1. Node.js 24+ HTTP + SSE + RFC 6455 WebSocket + optional SQLite persistence (`createJam`)
 *   2. Cloudflare Workers + Durable Objects with WebSocket Hibernation (`JamRoomDO` & default Worker export)
 * Security & Protocol:
 *   - CSPRNG 8-char unambiguous invite codes separate from immutable roomId
 *   - Optional Ed25519 (EdDSA) Zero-Trust JWT enforcement (`JAM_REQUIRE_AUTH` / `JAM_AUTH_PUBLIC_KEY`)
 *   - Millisecond Clock Drift Compensation (`ping` / `pong` + `serverTime` + `echoClientTime`)
 *   - Replay Attack Protection (`nonce` + `timestamp` validation & bounded deduplication cache)
 *   - Real-time Server-Sent Events (`GET /v1/jam/events`) & WebSocket (`WS /v1/jam/ws`) with quotas & backpressure
 *   - Shareable Web Invite Bridge (`GET /jam/join/:code`) & JSON Preview (`GET /v1/jam/invites/:code`)
 *   - Delta Heartbeat & Gzip Compression (`sinceSequence` + `Content-Encoding: gzip`)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import type { Track } from '../shared/types.ts';
import {
  DEFAULT_JAM_PERMISSIONS,
  normalizeJamCode,
  type JamBlockedParticipant,
  type JamChatMessage,
  type JamErrorCode,
  type JamInvitePreview,
  type JamJoinRequest,
  type JamJoinRequestStatus,
  type JamMember,
  type JamPlayback,
  type JamPlaylistRecommendation,
  type JamQueueItem,
  type JamRoom,
  type JamRoomPermissions,
  type JamRoomStatus,
} from '../shared/jam.ts';
import {
  type CloudflareDoSqlStorage,
  createDoSqliteAdapter,
  resolveOAuthProviders,
} from './auth.ts';
import { ZeroTrustAuthEngine, handleFetchAuthRequest } from './broker.ts';

interface Member extends JamMember {
  token: string;
  clientId?: string;
  userId?: string;
  seen: number;
}

interface RecentMember {
  id: string;
  token: string;
  clientId?: string;
  userId?: string;
  name: string;
  avatar?: string;
  host: boolean;
  joinedAt: number;
  expiredAt: number;
}

interface InternalJoinRequest {
  id: string;
  requestToken: string;
  name: string;
  avatar?: string;
  userId?: string;
  clientId?: string;
  requestedAt: number;
  expiresAt: number;
  status: JamJoinRequestStatus;
  reason?: string;
  errorCode?: JamErrorCode;
  approvedSession?: Record<string, unknown>;
}

interface Room {
  roomId: string;
  code: string;
  roomName: string;
  hostAvatar?: string;
  locked: boolean;
  requireAuth: boolean;
  requireApproval: boolean;
  permissions: JamRoomPermissions;
  maxParticipants: number;
  inviteExpiresAt: number;
  inviteTtlMs: number;
  createdAt: number;
  members: Map<string, Member>;
  recentMembers: Map<string, RecentMember>;
  kickedKeys: Set<string>;
  blockedKeys: Set<string>;
  blockedList: Map<string, JamBlockedParticipant>;
  joinRequests: Map<string, InternalJoinRequest>;
  playback: JamPlayback;
  skipVotes?: Set<string>;
  skipTriggeredAt?: number;
  jamQueue?: JamQueueItem[];
  recommendations?: JamPlaylistRecommendation[];
  messages?: JamChatMessage[];
  touched: number;
}

interface InviteTombstone {
  code: string;
  roomId: string;
  roomName: string;
  hostName: string;
  hostAvatar?: string;
  reason: 'ended' | 'expired';
  createdAt: number;
  endedAt: number;
  expiresAt: number;
}

interface NodeJamSocket {
  socket: Duplex;
  roomId: string;
  code: string;
  token: string;
  memberId: string;
  ip: string;
  lastSeen: number;
  draining?: boolean;
}

interface NodeSseSubscriber {
  res: ServerResponse;
  roomId: string;
  token: string;
  lastHeartbeat: number;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?: () => void;
}

export class JamError extends Error {
  status: number;
  errorCode?: JamErrorCode;
  preview?: JamInvitePreview | null;

  constructor(
    message: string,
    status = 400,
    errorCode?: JamErrorCode,
    preview?: JamInvitePreview | null,
  ) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.preview = preview;
  }
}

const MAX_PARTICIPANTS = 8;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_INVITE_TTL_MS = 2 * 60 * 60 * 1000;
const JOIN_REQUEST_TTL_MS = 5 * 60 * 1000;
const APPROVED_CLAIM_TTL_MS = 90 * 1000;
const RESOLVED_STATUS_TTL_MS = 120 * 1000;
const MAX_PENDING_JOIN_REQUESTS = 32;
const REQUEST_JOIN_IP_LIMIT_PER_MIN = 6;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DOWNLOAD_URL = 'https://github.com/nlzwrld/glass-music/releases/latest';
const JAM_BODY_LIMIT = 16384;

const id = () => randomBytes(24).toString('base64url');
const makeRoomId = () => `jam_${randomBytes(16).toString('base64url')}`;

function generateInviteCode(taken: { has(code: string): boolean }): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const raw = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += INVITE_ALPHABET[raw[i]! & 31];
    }
    if (!taken.has(code)) return code;
  }
  return randomBytes(5).toString('hex').toUpperCase();
}

const safeName = (value: unknown) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Ouvinte'
    : 'Ouvinte';

const safeRoomName = (value: unknown, hostName: string) => {
  const clean =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)
      : '';
  return clean || `JAM de ${hostName}`.slice(0, 60);
};

const safeClientId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : undefined;

const safeMemberId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : undefined;

function sanitizeAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password) {
      return u.href;
    }
  } catch {}
  return undefined;
}

const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(value);

const ALLOWED_REQUEST_KEYS = new Set([
  'action',
  'code',
  'preferredCode',
  'token',
  'resumeToken',
  'name',
  'roomName',
  'avatar',
  'clientId',
  'memberId',
  'locked',
  'requireAuth',
  'requireApproval',
  'permissions',
  'requestId',
  'requestToken',
  'block',
  'blockKey',
  'inviteTtlMs',
  'endpoint',
  'playback',
  'track',
  'queueItemId',
  'message',
  'playlistName',
  'playlistTracks',
  'nonce',
  'timestamp',
  'clientTime',
  'sinceSequence',
]);

const ALLOWED_PERMISSION_KEYS = new Set([
  'allowQueueAdd',
  'allowVoteSkip',
  'allowChat',
  'allowRecommendations',
]);

function sanitizePermissions(
  raw: unknown,
  base: JamRoomPermissions = DEFAULT_JAM_PERMISSIONS,
): JamRoomPermissions {
  const next: JamRoomPermissions = { ...base };
  if (raw === undefined) return next;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JamError('Permissões da JAM inválidas.', 400);
  }
  const obj = raw as Record<string, unknown>;
  assertNoUnknownKeys(obj, ALLOWED_PERMISSION_KEYS, 'Permissões JAM');
  if (typeof obj.allowQueueAdd === 'boolean') next.allowQueueAdd = obj.allowQueueAdd;
  if (typeof obj.allowVoteSkip === 'boolean') next.allowVoteSkip = obj.allowVoteSkip;
  if (typeof obj.allowChat === 'boolean') next.allowChat = obj.allowChat;
  if (typeof obj.allowRecommendations === 'boolean') {
    next.allowRecommendations = obj.allowRecommendations;
  }
  return next;
}

const safeRequestId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : undefined;

const safeBlockKey = (value: unknown): string | undefined =>
  typeof value === 'string' && /^(uid|cid|id|tok):[A-Za-z0-9_.:-]{2,120}$/.test(value)
    ? value
    : undefined;

function pruneJoinRequests(room: Room, now: number): boolean {
  let changed = false;
  for (const [reqId, req] of room.joinRequests) {
    if (req.status === 'pending' && req.expiresAt <= now) {
      req.status = 'expired';
      req.reason = 'Solicitação expirada. Peça entrada novamente ao anfitrião.';
      req.errorCode = 'INVITE_EXPIRED';
      req.expiresAt = now + RESOLVED_STATUS_TTL_MS;
      changed = true;
    } else if (req.status !== 'pending' && req.expiresAt <= now) {
      room.joinRequests.delete(reqId);
    }
  }
  return changed;
}

function pendingRequestsList(room: Room, now: number): JamJoinRequest[] {
  const list: JamJoinRequest[] = [];
  for (const req of room.joinRequests.values()) {
    if (req.status === 'pending' && req.expiresAt > now) {
      list.push({
        id: req.id,
        name: req.name,
        ...(req.avatar ? { avatar: req.avatar } : {}),
        ...(req.userId ? { userId: req.userId } : {}),
        ...(req.clientId ? { clientId: req.clientId } : {}),
        requestedAt: req.requestedAt,
        expiresAt: req.expiresAt,
        status: req.status,
      });
    }
  }
  return list;
}

function isBlockedRequester(
  room: Room,
  userId?: string,
  clientId?: string,
): boolean {
  if (userId && room.blockedKeys.has(`uid:${userId}`)) {
    return true;
  }
  if (clientId && room.blockedKeys.has(`cid:${clientId}`)) {
    return true;
  }
  return false;
}

function addBlockKeysForMember(
  room: Room,
  target: Pick<Member, 'id' | 'name' | 'token' | 'clientId' | 'userId'>,
  now: number,
  alwaysRevokeToken = true,
) {
  if (alwaysRevokeToken) room.kickedKeys.add(`tok:${target.token}`);
  if (target.clientId) {
    room.kickedKeys.add(`cid:${target.clientId}`);
    room.blockedKeys.add(`cid:${target.clientId}`);
  }
  if (target.userId) {
    room.kickedKeys.add(`uid:${target.userId}`);
    room.blockedKeys.add(`uid:${target.userId}`);
  }
  room.blockedKeys.add(`id:${target.id}`);
  const primaryKey = target.userId
    ? `uid:${target.userId}`
    : target.clientId
      ? `cid:${target.clientId}`
      : `id:${target.id}`;
  room.blockedList.set(primaryKey, {
    key: primaryKey,
    name: target.name,
    blockedAt: now,
  });
}

function enforceInteractivePermission(room: Room, member: Member, action: string) {
  if (member.host) return;
  if (action === 'queueAdd' && !room.permissions.allowQueueAdd) {
    throw new JamError(
      'O anfitrião desativou a adição de músicas à fila pelos participantes.',
      403,
      'FORBIDDEN',
    );
  }
  if (action === 'voteSkip' && !room.permissions.allowVoteSkip) {
    throw new JamError(
      'O anfitrião desativou a votação para pular músicas.',
      403,
      'FORBIDDEN',
    );
  }
  if (action === 'chat' && !room.permissions.allowChat) {
    throw new JamError('O anfitrião desativou o bate-papo desta JAM.', 403, 'FORBIDDEN');
  }
  if (action === 'recommendPlaylist' && !room.permissions.allowRecommendations) {
    throw new JamError(
      'O anfitrião desativou o envio de playlists pelos participantes.',
      403,
      'FORBIDDEN',
    );
  }
}

function roomInteractiveView(room: Room) {
  const onlineCount = Math.max(
    1,
    [...room.members.values()].filter(m => m.online !== false).length,
  );
  const skipVotes = [...(room.skipVotes || [])];
  const skipThreshold = Math.max(1, Math.ceil(onlineCount / 2));
  return {
    skipVotes,
    skipThreshold,
    ...(room.skipTriggeredAt ? { skipTriggeredAt: room.skipTriggeredAt } : {}),
    ...(room.jamQueue?.length ? { jamQueue: room.jamQueue } : {}),
    ...(room.recommendations?.length ? { recommendations: room.recommendations } : {}),
    ...(room.messages?.length ? { messages: room.messages } : {}),
  };
}

function applyJamInteractiveAction(
  room: Room,
  member: Member,
  action: string,
  p: Record<string, unknown>,
  now: number,
): boolean {
  enforceInteractivePermission(room, member, action);
  if (action === 'voteSkip') {
    if (!room.skipVotes) room.skipVotes = new Set();
    if (room.skipVotes.has(member.id)) {
      room.skipVotes.delete(member.id);
    } else {
      room.skipVotes.add(member.id);
    }
    const onlineCount = Math.max(
      1,
      [...room.members.values()].filter(m => m.online !== false).length,
    );
    const threshold = Math.max(1, Math.ceil(onlineCount / 2));
    if (room.skipVotes.size >= threshold) {
      room.skipTriggeredAt = now;
      room.skipVotes.clear();
    }
    return true;
  }
  if (action === 'queueAdd') {
    const track = sanitizeTrack(p.track);
    if (!track) throw new JamError('Selecione uma música online válida para a fila.', 400);
    if (!room.jamQueue) room.jamQueue = [];
    if (room.jamQueue.length >= 30) {
      throw new JamError('A fila da JAM atingiu o limite de 30 músicas.', 400);
    }
    room.jamQueue.push({
      id: `jq_${id().slice(0, 12)}`,
      track,
      addedById: member.id,
      addedByName: member.name,
      addedAt: now,
    });
    return true;
  }
  if (action === 'queueRemove') {
    const itemId = typeof p.queueItemId === 'string' ? p.queueItemId.trim() : '';
    if (!itemId) throw new JamError('Item da fila inválido.', 400);
    if (!room.jamQueue) room.jamQueue = [];
    const idx = room.jamQueue.findIndex(item => item.id === itemId);
    if (idx >= 0) {
      const target = room.jamQueue[idx]!;
      if (!member.host && target.addedById !== member.id) {
        throw new JamError('Somente o anfitrião ou quem adicionou pode remover da fila.', 403, 'FORBIDDEN');
      }
      room.jamQueue.splice(idx, 1);
    }
    return true;
  }
  if (action === 'recommendPlaylist') {
    const rawName = typeof p.playlistName === 'string'
      ? p.playlistName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)
      : '';
    if (!rawName) throw new JamError('Informe o nome da playlist recomendada.', 400);
    const rawTracks = Array.isArray(p.playlistTracks) ? p.playlistTracks.slice(0, 20) : [];
    const tracks: Track[] = [];
    for (const candidate of rawTracks) {
      try {
        const clean = sanitizeTrack(candidate);
        if (clean) tracks.push(clean);
      } catch {
        // Ignore local or unsupported entries inside a shared playlist
      }
    }
    if (!tracks.length) {
      throw new JamError('A playlist recomendada precisa ter ao menos uma música online.', 400);
    }
    if (!room.recommendations) room.recommendations = [];
    room.recommendations.unshift({
      id: `jr_${id().slice(0, 12)}`,
      name: rawName,
      trackCount: tracks.length,
      tracks,
      recommendedById: member.id,
      recommendedByName: member.name,
      recommendedAt: now,
    });
    if (room.recommendations.length > 15) room.recommendations.length = 15;
    return true;
  }
  if (action === 'chat') {
    const rawMsg = typeof p.message === 'string'
      ? p.message.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300)
      : '';
    if (!rawMsg) throw new JamError('Digite uma mensagem para enviar no chat.', 400);
    if (!room.messages) room.messages = [];
    room.messages.push({
      id: `jm_${id().slice(0, 12)}`,
      memberId: member.id,
      name: member.name,
      ...(member.avatar ? { avatar: member.avatar } : {}),
      text: rawMsg,
      sentAt: now,
    });
    if (room.messages.length > 80) {
      room.messages.splice(0, room.messages.length - 80);
    }
    return true;
  }
  return false;
}

const ALLOWED_PLAYBACK_KEYS = new Set(['track', 'playing', 'position']);

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new JamError(`${label} contém campo não autorizado (${key}).`, 400);
    }
  }
}

function sanitizeTrack(value: unknown): Track | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JamError('Música inválida.');
  const v = value as Record<string, unknown>;
  if (v.kind !== 'track' || !['youtube', 'link', 'soundcloud'].includes(String(v.source))) {
    throw new JamError('A JAM aceita músicas online. Arquivos locais ficam no seu dispositivo.');
  }
  for (const key of ['id', 'sourceId', 'title', 'artist']) {
    if (
      typeof v[key] !== 'string' ||
      !(v[key] as string).length ||
      (v[key] as string).length > (key === 'title' || key === 'artist' ? 500 : 200)
    ) {
      throw new JamError('Dados da música inválidos.');
    }
  }
  if (
    !/^[A-Za-z0-9_:.-]+$/.test(String(v.id)) ||
    v.id !== `${v.source}:${v.sourceId}` ||
    !Number.isFinite(v.duration) ||
    Number(v.duration) < 0 ||
    Number(v.duration) > 86400
  ) {
    throw new JamError('Referência da música inválida.');
  }
  if (v.source === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(String(v.sourceId))) {
    throw new JamError('Vídeo inválido.');
  }
  let url: URL;
  try {
    url = new URL(String(v.url));
  } catch {
    throw new JamError('Link público da música ausente.');
  }
  const hosts = [
    'www.youtube.com',
    'youtube.com',
    'music.youtube.com',
    'youtu.be',
    'open.spotify.com',
    'www.deezer.com',
    'deezer.com',
    'soundcloud.com',
    'www.soundcloud.com',
    'music.apple.com',
    'itunes.apple.com',
    'tidal.com',
    'www.tidal.com',
    'listen.tidal.com',
  ];
  const bandcamp = /^[a-z0-9-]+\.bandcamp\.com$/i.test(url.hostname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (!hosts.includes(url.hostname) && !bandcamp) ||
    url.href.length > 2048
  ) {
    throw new JamError('Link da música não permitido.');
  }
  const clean: Track = {
    id: String(v.id),
    source: v.source as Track['source'],
    sourceId: String(v.sourceId),
    kind: 'track',
    title: String(v.title),
    artist: String(v.artist),
    duration: Number(v.duration),
    url: url.href,
    addedAt: 0,
  };
  if (typeof v.playbackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.playbackId)) {
    clean.playbackId = v.playbackId;
  }
  if (typeof v.artwork === 'string' && v.artwork.length <= 2048) {
    try {
      const art = new URL(v.artwork);
      if (
        art.protocol === 'https:' &&
        !art.username &&
        !art.password &&
        !art.port &&
        [
          'i.ytimg.com',
          'i9.ytimg.com',
          'lh3.googleusercontent.com',
          'i.scdn.co',
          'i1.sndcdn.com',
          'i2.sndcdn.com',
          'cdn-images.dzcdn.net',
          'e-cdns-images.dzcdn.net',
          'cdns-images.dzcdn.net',
          'mosaic.scdn.co',
          'image-cdn-fa.spotifycdn.com',
          'image-cdn-ak.spotifycdn.com',
          'is1-ssl.mzstatic.com',
          'is2-ssl.mzstatic.com',
          'is3-ssl.mzstatic.com',
          'is4-ssl.mzstatic.com',
          'is5-ssl.mzstatic.com',
          'f4.bcbits.com',
          'resources.tidal.com',
          'akamai.sscdn.co',
        ].includes(art.hostname)
      ) {
        clean.artwork = art.href;
      }
    } catch {}
  }
  return clean;
}

function importEd25519PublicKeyFromX(jwkX?: string): KeyObject | null {
  if (!jwkX) return null;
  try {
    const raw = Buffer.from(jwkX.trim(), 'base64url');
    if (raw.length !== 32) return null;
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    return createPublicKey({
      key: Buffer.concat([spkiPrefix, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

function verifyBearerJwt(
  authHeader: string | undefined,
  publicKey: KeyObject | null,
  nowMs: number,
  required: boolean,
): { userId: string } | null {
  if (!authHeader) {
    if (required) {
      throw new JamError(
        'Autenticação no Liquid Hub necessária para participar desta JAM.',
        401,
        'AUTH_REQUIRED',
      );
    }
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authHeader.trim());
  if (!match) {
    if (required) {
      throw new JamError('Cabeçalho de autenticação inválido.', 401, 'AUTH_REQUIRED');
    }
    return null;
  }
  if (!publicKey) {
    if (required) {
      throw new JamError(
        'Este servidor exige autenticação, mas a chave pública JWT não foi configurada.',
        503,
        'AUTH_REQUIRED',
      );
    }
    return null;
  }
  const jwt = match[1]!;
  const parts = jwt.split('.');
  if (parts.length !== 3 || jwt.length > 4096) {
    throw new JamError('Sessão de autenticação inválida.', 401, 'AUTH_REQUIRED');
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      alg?: string;
      typ?: string;
    };
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') {
      throw new Error('alg');
    }
    const sig = Buffer.from(parts[2]!, 'base64url');
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    if (!verify(null, signingInput, publicKey, sig)) {
      throw new Error('sig');
    }
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      iss?: string;
      aud?: string;
      sub?: string;
      iat?: number;
      exp?: number;
    };
    const nowSec = Math.floor(nowMs / 1000);
    if (
      claims.iss !== 'liquid-hub-auth' ||
      claims.aud !== 'liquid-hub-desktop' ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= nowSec ||
      claims.iat > nowSec + 30 ||
      claims.exp - claims.iat > 900
    ) {
      throw new Error('claims');
    }
    return { userId: claims.sub };
  } catch {
    throw new JamError(
      'Sessão de autenticação expirada ou inválida. Entre novamente no Liquid Hub.',
      401,
      'AUTH_REQUIRED',
    );
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveRequestOrigin(req: IncomingMessage): string {
  const protoRaw = String(req.headers['x-forwarded-proto'] || '').split(',')[0]!.trim().toLowerCase();
  const hostRaw = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]!
    .trim();
  const safeHost = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(hostRaw) ? hostRaw : '127.0.0.1:8789';
  const proto =
    protoRaw === 'https' || protoRaw === 'http'
      ? protoRaw
      : safeHost.startsWith('127.0.0.1') || safeHost.startsWith('localhost')
        ? 'http'
        : 'https';
  return `${proto}://${safeHost}`;
}

export function renderInviteLandingHtml(opts: {
  code: string;
  origin: string;
  preview: JamInvitePreview | null;
  errorMessage?: string;
  errorCode?: JamErrorCode;
  downloadUrl?: string;
  nonce: string;
}): string {
  const { code, origin, preview, errorMessage, errorCode, nonce } = opts;
  const downloadUrl = opts.downloadUrl || DEFAULT_DOWNLOAD_URL;
  const deepLink = `liquidhub://jam/join/${code}${origin ? `?endpoint=${encodeURIComponent(origin)}` : ''}`;
  const isAvailable = Boolean(preview && preview.canJoin);
  const titleText = preview ? `${preview.roomName} · JAM no Liquid Hub` : `Convite ${code} · Liquid Hub`;
  const descText = preview
    ? isAvailable
      ? `Entre na JAM de ${preview.hostName} (${preview.participantCount}/${preview.maxParticipants} ouvintes) no Liquid Hub.`
      : preview.reason || errorMessage || 'Esta sessão JAM não está mais disponível.'
    : errorMessage || 'Convite de sessão JAM no Liquid Hub.';

  const hostInitial = (preview?.hostName || 'L').trim().charAt(0).toUpperCase() || 'L';
  const statusLabel = !preview
    ? errorCode === 'ROOM_ENDED'
      ? 'Encerrada'
      : errorCode === 'INVITE_EXPIRED'
        ? 'Expirada'
        : 'Não encontrada'
    : preview.status === 'active'
      ? 'Ao vivo'
      : preview.status === 'full'
        ? 'Lotada'
        : preview.status === 'locked'
          ? 'Trancada'
          : preview.status === 'ended'
            ? 'Encerrada'
            : 'Expirada';

  const statusTone = !preview
    ? 'ended'
    : preview.status === 'active'
      ? 'live'
      : preview.status === 'locked' || preview.status === 'full'
        ? 'warn'
        : 'ended';

  const trackLine =
    preview?.currentTrack && preview.status !== 'ended' && preview.status !== 'expired'
      ? `<div class="track"><span>${preview.playing ? 'Tocando agora' : 'Na fila'}</span><strong>${escapeHtml(preview.currentTrack.title)}</strong><small>${escapeHtml(preview.currentTrack.artist)}</small></div>`
      : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="theme-color" content="#0b0d10" />
  <title>${escapeHtml(titleText)}</title>
  <meta property="og:title" content="${escapeHtml(titleText)}" />
  <meta property="og:description" content="${escapeHtml(descText)}" />
  <meta property="og:type" content="music.playlist" />
  <style nonce="${escapeHtml(nonce)}">
    :root{color-scheme:dark;--bg:#0b0d10;--surface:#14171c;--border:rgba(255,255,255,.1);--text:#f3f5f7;--muted:#9aa4b2;--accent:#52b79a;--warn:#e0a54c;--err:#e57373}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,rgba(82,183,154,.12),transparent 52%),var(--bg);color:var(--text);font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;display:grid;gap:18px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
    .brand{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;font-weight:600}
    .pill{padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600;text-transform:none;letter-spacing:0;background:rgba(255,255,255,.07);border:1px solid var(--border);color:var(--text)}
    .pill.live{background:rgba(82,183,154,.16);border-color:rgba(82,183,154,.35);color:#8ce0c7}
    .pill.warn{background:rgba(224,165,76,.14);border-color:rgba(224,165,76,.35);color:#f3cb83}
    .pill.ended{background:rgba(229,115,115,.14);border-color:rgba(229,115,115,.32);color:#f5a3a3}
    .host{display:flex;align-items:center;gap:14px}
    .avatar{width:46px;height:46px;border-radius:50%;background:rgba(82,183,154,.18);border:1px solid rgba(82,183,154,.35);display:grid;place-items:center;font-weight:700;font-size:18px;color:#8ce0c7;overflow:hidden;flex:none}
    .avatar img{width:100%;height:100%;object-fit:cover}
    h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em;line-height:1.25}
    .meta{color:var(--muted);font-size:13px;margin-top:2px}
    .track{padding:11px 13px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid var(--border);display:grid;gap:2px}
    .track span{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8ce0c7;font-weight:600}
    .track strong{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .track small{color:var(--muted);font-size:12.5px}
    .code-box{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:9px;background:rgba(0,0,0,.28);border:1px solid var(--border)}
    .code-box span{font-size:12px;color:var(--muted)}
    .code-box strong{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.12em}
    .actions{display:grid;gap:9px}
    .btn{appearance:none;border:0;border-radius:9px;min-height:40px;padding:0 16px;font:600 13.5px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;transition:opacity .15s ease,transform .12s ease}
    .btn:active{transform:scale(.99)}
    .btn.primary{background:var(--accent);color:#08120f}
    .btn.secondary{background:rgba(255,255,255,.08);color:var(--text);border:1px solid var(--border)}
    .btn.ghost{background:transparent;color:var(--muted);font-weight:500;min-height:34px;font-size:12.5px}
    .btn.ghost:hover{color:var(--text)}
    .hint{margin:0;font-size:12px;color:var(--muted);text-align:center}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <span>Liquid Hub · JAM</span>
      <span class="pill ${statusTone}">${escapeHtml(statusLabel)}</span>
    </div>
    <div class="host">
      <div class="avatar">${preview?.hostAvatar ? `<img src="${escapeHtml(preview.hostAvatar)}" alt="" />` : escapeHtml(hostInitial)}</div>
      <div>
        <h1>${escapeHtml(preview?.roomName || 'Convite de JAM')}</h1>
        <div class="meta">${preview ? `Anfitrião: ${escapeHtml(preview.hostName)} · ${preview.participantCount}/${preview.maxParticipants} ouvintes` : escapeHtml(descText)}</div>
      </div>
    </div>
    ${trackLine}
    <div class="code-box">
      <span>Código da JAM</span>
      <strong id="jam-code">${escapeHtml(code)}</strong>
    </div>
    ${!isAvailable && (preview?.reason || errorMessage) ? `<p class="meta">${escapeHtml(preview?.reason || errorMessage || '')}</p>` : ''}
    <div class="actions">
      ${isAvailable ? `<a id="open-app" class="btn primary" href="${escapeHtml(deepLink)}">Abrir no Liquid Hub</a>` : ''}
      <button id="copy-code" class="btn secondary" type="button">Copiar código (${escapeHtml(code)})</button>
      <a class="btn ghost" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer">Baixar ou instalar Liquid Hub</a>
    </div>
    <p id="launch-hint" class="hint">${isAvailable ? 'Tentando abrir o Liquid Hub instalado… Se não abrir, clique acima ou cole o código no aplicativo.' : 'Cole outro código no Liquid Hub para entrar em uma sala ativa.'}</p>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    (function () {
      var code = ${JSON.stringify(code)};
      var deepLink = ${JSON.stringify(deepLink)};
      var active = ${isAvailable ? 'true' : 'false'};
      var copyBtn = document.getElementById('copy-code');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(function () {
              copyBtn.textContent = 'Código copiado!';
              setTimeout(function () { copyBtn.textContent = 'Copiar código (' + code + ')'; }, 1800);
            }).catch(function () {});
          }
        });
      }
      if (active) {
        setTimeout(function () {
          try { window.location.href = deepLink; } catch (e) {}
        }, 80);
      }
    })();
  </script>
</body>
</html>`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > JAM_BODY_LIMIT) throw new JamError('Solicitação muito grande.', 413);
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch {
    throw new JamError('Solicitação inválida.');
  }
}

/** RFC 6455 minimal frame helpers for lightweight real-time room push without external deps */
function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let len = buffer[1]! & 0x7f;
  let offset = 2;
  if (!masked) throw new JamError('Frame WebSocket sem máscara.', 400);
  if (opcode >= 0x08 && ((buffer[0]! & 0x80) === 0 || len > 125)) {
    throw new JamError('Frame de controle WebSocket inválido.', 400);
  }
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > 16384n) throw new JamError('Frame WebSocket muito grande.', 413);
    len = Number(big);
    offset = 10;
  }
  if (len > 16384) throw new JamError('Frame WebSocket muito grande.', 413);
  if (buffer.length < offset + 4 + len) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const data = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    data[i] = buffer[offset + 4 + i]! ^ mask[i & 3]!;
  }
  return { opcode, payload: data, consumed: offset + 4 + len };
}

function openSqlite(dbPath: string): SqliteDatabase | null {
  if (!dbPath || dbPath === 'memory' || dbPath === 'disabled') return null;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
    const db = new mod.DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS jam_rooms (
        room_id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        room_name TEXT NOT NULL,
        host_avatar TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        require_auth INTEGER NOT NULL DEFAULT 0,
        max_participants INTEGER NOT NULL DEFAULT 8,
        playback_json TEXT NOT NULL,
        invite_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        touched INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jam_members (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES jam_rooms(room_id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        client_id TEXT,
        user_id TEXT,
        name TEXT NOT NULL,
        avatar TEXT,
        host INTEGER NOT NULL DEFAULT 0,
        online INTEGER NOT NULL DEFAULT 1,
        joined_at INTEGER NOT NULL,
        seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jam_invite_tombstones (
        code TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        room_name TEXT NOT NULL,
        host_name TEXT NOT NULL,
        host_avatar TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    try {
      db.exec('ALTER TABLE jam_rooms ADD COLUMN meta_json TEXT');
    } catch {}
    return db;
  } catch {
    return null;
  }
}

function roomStatusFrom(room: Room, now: number): JamRoomStatus {
  if (room.inviteExpiresAt <= now) return 'expired';
  if (room.locked) return 'locked';
  if (room.members.size >= room.maxParticipants) return 'full';
  return 'active';
}

function previewFromRoom(room: Room, now: number): JamInvitePreview {
  const host = [...room.members.values()].find(m => m.host);
  const status = roomStatusFrom(room, now);
  const canJoin = status === 'active';
  const reason =
    status === 'expired'
      ? 'Este convite expirou. Peça um novo link ao anfitrião.'
      : status === 'locked'
        ? 'Esta JAM está trancada pelo anfitrião.'
        : status === 'full'
          ? `Esta JAM atingiu o limite de ${room.maxParticipants} participantes.`
          : undefined;
  return {
    roomId: room.roomId,
    code: room.code,
    roomName: room.roomName,
    hostName: host?.name || 'Anfitrião',
    hostAvatar: room.hostAvatar || host?.avatar,
    participantCount: room.members.size,
    maxParticipants: room.maxParticipants,
    status,
    canJoin,
    ...(reason ? { reason } : {}),
    requireAuth: room.requireAuth,
    requireApproval: room.requireApproval,
    currentTrack: room.playback.track
      ? {
          id: room.playback.track.id,
          title: room.playback.track.title,
          artist: room.playback.track.artist,
          artwork: room.playback.track.artwork,
          source: room.playback.track.source,
        }
      : null,
    playing: room.playback.playing,
    inviteExpiresAt: room.inviteExpiresAt,
    createdAt: room.createdAt,
    serverTime: now,
  };
}

function previewFromTombstone(tomb: InviteTombstone, now: number): JamInvitePreview {
  const status: JamRoomStatus = tomb.reason === 'ended' ? 'ended' : 'expired';
  return {
    roomId: tomb.roomId,
    code: tomb.code,
    roomName: tomb.roomName,
    hostName: tomb.hostName,
    hostAvatar: tomb.hostAvatar,
    participantCount: 0,
    maxParticipants: MAX_PARTICIPANTS,
    status,
    canJoin: false,
    reason:
      tomb.reason === 'ended'
        ? 'Esta JAM foi encerrada pelo anfitrião.'
        : 'Este convite expirou. Peça um novo link ao anfitrião.',
    inviteExpiresAt: tomb.expiresAt,
    createdAt: tomb.createdAt,
    serverTime: now,
  };
}

function buildRoomView(
  room: Room,
  now: number,
  p?: Record<string, unknown>,
  forHost = false,
): JamRoom {
  const unchanged =
    p?.action === 'poll' &&
    typeof p.sinceSequence === 'number' &&
    p.sinceSequence === room.playback.sequence;
  const pending = pendingRequestsList(room, now);
  return {
    roomId: room.roomId,
    code: room.code,
    roomName: room.roomName,
    ...(room.hostAvatar ? { hostAvatar: room.hostAvatar } : {}),
    status: roomStatusFrom(room, now),
    locked: room.locked,
    requireAuth: room.requireAuth,
    requireApproval: room.requireApproval,
    permissions: room.permissions,
    maxParticipants: room.maxParticipants,
    inviteExpiresAt: room.inviteExpiresAt,
    createdAt: room.createdAt,
    members: [...room.members.values()].map(
      ({ id: mid, name, host, avatar, online, joinedAt }) => ({
        id: mid,
        name,
        host,
        ...(avatar ? { avatar } : {}),
        online: online !== false,
        ...(joinedAt ? { joinedAt } : {}),
      }),
    ),
    pendingRequestCount: pending.length,
    ...(forHost
      ? {
          joinRequests: pending,
          blockedList: [...room.blockedList.values()],
        }
      : {}),
    playback: unchanged ? { ...room.playback, track: null } : room.playback,
    ...roomInteractiveView(room),
    unchanged: unchanged || undefined,
    serverTime: now,
    ...(typeof p?.clientTime === 'number' && Number.isFinite(p.clientTime)
      ? { echoClientTime: p.clientTime }
      : {}),
  };
}

function buildMemberSession(
  room: Room,
  member: Member,
  now: number,
  p?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...buildRoomView(room, now, p, member.host),
    token: member.token,
    memberId: member.id,
    host: member.host,
    ...(member.clientId ? { clientId: member.clientId } : {}),
  };
}

function applyRoomUpdate(
  room: Room,
  member: Member,
  p: Record<string, unknown>,
  requireAuthGlobal: boolean,
) {
  if (!member.host) {
    throw new JamError('Somente o anfitrião pode alterar as opções da JAM.', 403, 'FORBIDDEN');
  }
  if (typeof p.roomName === 'string') {
    room.roomName = safeRoomName(p.roomName, member.name);
  }
  if (typeof p.locked === 'boolean') {
    room.locked = p.locked;
  }
  if (typeof p.requireAuth === 'boolean') {
    room.requireAuth = requireAuthGlobal || p.requireAuth;
  }
  if (typeof p.requireApproval === 'boolean') {
    room.requireApproval = p.requireApproval;
  }
  if (p.permissions !== undefined) {
    room.permissions = sanitizePermissions(p.permissions, room.permissions);
  }
}

function handleRequestJoin(
  room: Room,
  p: Record<string, unknown>,
  now: number,
  authUserId?: string,
): InternalJoinRequest {
  if (room.inviteExpiresAt <= now) {
    throw new JamError(
      'Este convite expirou. Peça um novo link ao anfitrião.',
      410,
      'INVITE_EXPIRED',
      previewFromRoom(room, now),
    );
  }
  const clientId = safeClientId(p.clientId);
  if (isBlockedRequester(room, authUserId, clientId)) {
    throw new JamError(
      'Você foi bloqueado pelo anfitrião desta JAM.',
      403,
      'BLOCKED',
      previewFromRoom(room, now),
    );
  }
  if (room.locked) {
    throw new JamError(
      'Esta JAM está trancada pelo anfitrião.',
      403,
      'ROOM_LOCKED',
      previewFromRoom(room, now),
    );
  }
  if (room.members.size >= room.maxParticipants) {
    throw new JamError(
      `Esta JAM já tem ${room.maxParticipants} pessoas.`,
      409,
      'ROOM_FULL',
      previewFromRoom(room, now),
    );
  }
  const alreadyMember = [...room.members.values()].some(
    m => (authUserId && m.userId === authUserId) || (clientId && m.clientId === clientId),
  );
  if (alreadyMember) {
    throw new JamError('Você já está participando desta JAM.', 409, 'REQUEST_DUPLICATE');
  }
  pruneJoinRequests(room, now);
  const duplicatePending = [...room.joinRequests.values()].find(
    req =>
      req.status === 'pending' &&
      req.expiresAt > now &&
      ((authUserId && req.userId === authUserId) || (clientId && req.clientId === clientId)),
  );
  if (duplicatePending) {
    throw new JamError(
      'Você já enviou uma solicitação pendente para esta JAM.',
      409,
      'REQUEST_DUPLICATE',
      previewFromRoom(room, now),
    );
  }
  const pendingCount = pendingRequestsList(room, now).length;
  if (pendingCount >= MAX_PENDING_JOIN_REQUESTS) {
    throw new JamError(
      'Muitas solicitações pendentes no momento. Aguarde o anfitrião.',
      429,
      'RATE_LIMITED',
    );
  }
  const req: InternalJoinRequest = {
    id: `jrq_${id().slice(0, 12)}`,
    requestToken: id(),
    name: safeName(p.name),
    avatar: sanitizeAvatar(p.avatar),
    userId: authUserId,
    clientId,
    requestedAt: now,
    expiresAt: now + JOIN_REQUEST_TTL_MS,
    status: 'pending',
  };
  room.joinRequests.set(req.id, req);
  return req;
}

function handleCheckJoinRequest(
  room: Room,
  p: Record<string, unknown>,
  now: number,
): { changed: boolean; body: Record<string, unknown> } {
  const reqId = safeRequestId(p.requestId);
  if (!reqId) {
    throw new JamError('Solicitação inválida.', 400);
  }
  if (!validToken(p.requestToken)) {
    throw new JamError('Token da solicitação inválido.', 401, 'SESSION_EXPIRED');
  }
  const expiredSome = pruneJoinRequests(room, now);
  const req = room.joinRequests.get(reqId);
  if (!req || req.requestToken !== p.requestToken) {
    return {
      changed: expiredSome,
      body: {
        status: 'expired',
        requestId: reqId,
        reason: 'Solicitação expirada ou cancelada.',
        errorCode: 'INVITE_EXPIRED',
        serverTime: now,
      },
    };
  }
  if (req.status === 'approved' && req.approvedSession) {
    const claimed = req.approvedSession;
    const targetMemberId = typeof claimed.memberId === 'string' ? claimed.memberId : '';
    const memberObj = [...room.members.values()].find(m => m.id === targetMemberId);
    delete req.approvedSession;
    room.joinRequests.delete(reqId);
    const sessionOut = memberObj ? buildMemberSession(room, memberObj, now, p) : claimed;
    return {
      changed: true,
      body: {
        status: 'approved',
        requestId: reqId,
        session: sessionOut,
        serverTime: now,
      },
    };
  }
  return {
    changed: expiredSome,
    body: {
      status: req.status,
      requestId: req.id,
      ...(req.expiresAt ? { expiresAt: req.expiresAt } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.errorCode ? { errorCode: req.errorCode } : {}),
      serverTime: now,
    },
  };
}

function handleCancelJoinRequest(
  room: Room,
  p: Record<string, unknown>,
  now: number,
): { changed: boolean; body: Record<string, unknown> } {
  const reqId = safeRequestId(p.requestId);
  if (!reqId) throw new JamError('Solicitação inválida.', 400);
  if (!validToken(p.requestToken)) {
    throw new JamError('Token da solicitação inválido.', 401, 'SESSION_EXPIRED');
  }
  const req = room.joinRequests.get(reqId);
  if (req && req.requestToken === p.requestToken) {
    room.joinRequests.delete(reqId);
    return {
      changed: true,
      body: { status: 'cancelled', requestId: reqId, serverTime: now },
    };
  }
  return {
    changed: false,
    body: { status: 'cancelled', requestId: reqId, serverTime: now },
  };
}

function handleApproveJoin(
  room: Room,
  member: Member,
  p: Record<string, unknown>,
  now: number,
): Member {
  if (!member.host) {
    throw new JamError('Somente o anfitrião pode aprovar participantes.', 403, 'FORBIDDEN');
  }
  const reqId = safeRequestId(p.requestId);
  if (!reqId) throw new JamError('Solicitação inválida.', 400);
  pruneJoinRequests(room, now);
  const req = room.joinRequests.get(reqId);
  if (!req) {
    throw new JamError('Solicitação de entrada não encontrada.', 404);
  }
  if (req.status !== 'pending') {
    throw new JamError('Esta solicitação já foi processada.', 409, 'REQUEST_DUPLICATE');
  }
  if (req.expiresAt <= now) {
    req.status = 'expired';
    req.expiresAt = now + RESOLVED_STATUS_TTL_MS;
    throw new JamError('Esta solicitação expirou.', 410, 'INVITE_EXPIRED');
  }
  if (isBlockedRequester(room, req.userId, req.clientId)) {
    req.status = 'blocked';
    req.errorCode = 'BLOCKED';
    req.expiresAt = now + RESOLVED_STATUS_TTL_MS;
    throw new JamError('Este usuário está bloqueado nesta JAM.', 403, 'BLOCKED');
  }
  const alreadyMember = [...room.members.values()].some(
    m => (req.userId && m.userId === req.userId) || (req.clientId && m.clientId === req.clientId),
  );
  if (alreadyMember) {
    room.joinRequests.delete(reqId);
    throw new JamError('Este usuário já entrou na JAM.', 409, 'REQUEST_DUPLICATE');
  }
  if (room.members.size >= room.maxParticipants) {
    throw new JamError(`Esta JAM já tem ${room.maxParticipants} pessoas.`, 409, 'ROOM_FULL');
  }
  const newMember: Member = {
    id: id(),
    token: id(),
    clientId: req.clientId,
    userId: req.userId,
    name: req.name,
    avatar: req.avatar,
    host: false,
    online: true,
    joinedAt: now,
    seen: now,
  };
  room.members.set(newMember.token, newMember);
  req.status = 'approved';
  req.expiresAt = now + APPROVED_CLAIM_TTL_MS;
  req.approvedSession = buildMemberSession(room, newMember, now);
  return newMember;
}

function handleRejectJoin(
  room: Room,
  member: Member,
  p: Record<string, unknown>,
  now: number,
) {
  if (!member.host) {
    throw new JamError('Somente o anfitrião pode recusar participantes.', 403, 'FORBIDDEN');
  }
  const reqId = safeRequestId(p.requestId);
  if (!reqId) throw new JamError('Solicitação inválida.', 400);
  pruneJoinRequests(room, now);
  const req = room.joinRequests.get(reqId);
  if (!req) {
    throw new JamError('Solicitação de entrada não encontrada.', 404);
  }
  if (req.status !== 'pending') {
    throw new JamError('Esta solicitação já foi processada.', 409, 'REQUEST_DUPLICATE');
  }
  if (p.block === true) {
    req.status = 'blocked';
    req.errorCode = 'BLOCKED';
    req.reason = 'Sua entrada foi bloqueada pelo anfitrião.';
    req.expiresAt = now + RESOLVED_STATUS_TTL_MS;
    addBlockKeysForMember(
      room,
      {
        id: req.id,
        name: req.name,
        token: req.requestToken,
        clientId: req.clientId,
        userId: req.userId,
      },
      now,
      false,
    );
  } else {
    req.status = 'rejected';
    req.errorCode = 'REQUEST_REJECTED';
    req.reason = 'O anfitrião recusou sua solicitação de entrada.';
    req.expiresAt = now + RESOLVED_STATUS_TTL_MS;
  }
}

function handleBlockMember(
  room: Room,
  member: Member,
  p: Record<string, unknown>,
  now: number,
): Member | RecentMember {
  if (!member.host) {
    throw new JamError('Somente o anfitrião pode bloquear participantes.', 403, 'FORBIDDEN');
  }
  const targetId = safeMemberId(p.memberId);
  if (!targetId) throw new JamError('Participante inválido.', 400);
  const active = [...room.members.values()].find(m => m.id === targetId);
  const recent = active ? undefined : [...room.recentMembers.values()].find(m => m.id === targetId);
  const target = active || recent;
  if (!target) throw new JamError('Participante não encontrado.', 404);
  if (target.host) throw new JamError('Não é possível bloquear o anfitrião.', 400);
  room.members.delete(target.token);
  room.recentMembers.delete(target.token);
  addBlockKeysForMember(room, target, now, true);
  return target;
}

function handleUnblockMember(
  room: Room,
  member: Member,
  p: Record<string, unknown>,
) {
  if (!member.host) {
    throw new JamError('Somente o anfitrião pode desbloquear participantes.', 403, 'FORBIDDEN');
  }
  const blockKey = safeBlockKey(p.blockKey);
  if (!blockKey) throw new JamError('Identificador de bloqueio inválido.', 400);
  room.blockedList.delete(blockKey);
  room.blockedKeys.delete(blockKey);
  room.kickedKeys.delete(blockKey);
}

/** Ephemeral + optional SQLite coordinator: no audio relay or listening history persisted. */
export function createJam(env: NodeJS.ProcessEnv = process.env, clock = Date.now) {
  const rooms = new Map<string, Room>();
  const tombstones = new Map<string, InviteTombstone>();
  const rates = new Map<string, { until: number; count: number }>();
  const seenNonces = new Map<string, number>();

  // Real-time subscriber indexes (WebSockets with quotas + backpressure, plus SSE streams)
  const roomSockets = new Map<string, Set<NodeJamSocket>>();
  const allSockets = new Set<NodeJamSocket>();
  const socketIpCounts = new Map<string, number>();
  const socketMemberCounts = new Map<string, number>();
  const roomSse = new Map<string, Set<NodeSseSubscriber>>();

  const roomLimit = Math.max(1, Math.min(10000, Number(env.JAM_MAX_ROOMS) || 1000));
  const ttl = Math.max(30000, Math.min(3600000, Number(env.JAM_IDLE_TTL_MS) || 900000));
  const memberGraceMs = Math.max(5000, Math.min(300000, Number(env.JAM_MEMBER_TTL_MS) || 35000));
  const defaultInviteTtlMs = Math.max(
    60000,
    Math.min(86400000, Number(env.JAM_INVITE_TTL_MS) || DEFAULT_INVITE_TTL_MS),
  );
  const replayWindowMs = Math.max(
    10000,
    Math.min(300000, Number(env.JAM_REPLAY_WINDOW_MS) || 60000),
  );
  const strictReplay = env.JAM_STRICT_REPLAY === '1';
  const entryLimit = Math.max(1, Math.min(300, Number(env.JAM_ENTRY_REQUESTS_PER_MINUTE) || 30));
  const activeLimit = Math.max(
    1,
    Math.min(10000, Number(env.JAM_ACTIVE_REQUESTS_PER_MINUTE) || 1800),
  );
  const lookupLimit = Math.max(10, Math.min(600, Number(env.JAM_LOOKUP_REQUESTS_PER_MINUTE) || 120));
  const roomEntryLimit = Math.max(
    8,
    Math.min(600, Number(env.JAM_ROOM_ENTRY_REQUESTS_PER_MINUTE) || 120),
  );
  const roomActiveLimit = Math.max(
    8,
    Math.min(80000, Number(env.JAM_ROOM_REQUESTS_PER_MINUTE) || 14400),
  );
  const wsGlobalLimit = Math.max(1, Math.min(50000, Number(env.JAM_WS_MAX_CONNECTIONS) || 10000));
  const wsIpLimit = Math.max(1, Math.min(1000, Number(env.JAM_WS_MAX_PER_IP) || 100));
  const wsMemberLimit = Math.max(1, Math.min(32, Number(env.JAM_WS_MAX_PER_MEMBER) || 4));
  const wsRoomLimit = Math.max(1, Math.min(256, Number(env.JAM_WS_MAX_PER_ROOM) || 64));
  const wsHeartbeatMs = Math.max(10, Math.min(60000, Number(env.JAM_WS_HEARTBEAT_MS) || 30000));
  const wsTimeoutMs = Math.max(
    wsHeartbeatMs * 2,
    Math.max(20, Math.min(300000, Number(env.JAM_WS_TIMEOUT_MS) || 90000)),
  );
  const trustedProxies = new Set(
    (env.JAM_TRUSTED_PROXY_IPS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
  const requireAuthGlobal = env.JAM_REQUIRE_AUTH === '1';
  const requireApprovalGlobal = env.JAM_REQUIRE_APPROVAL === '1';
  const authPublicKey = importEd25519PublicKeyFromX(env.JAM_AUTH_PUBLIC_KEY);
  const downloadUrl = env.JAM_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL;
  const db = openSqlite(env.JAM_DB_PATH || ':memory:');
  let dbClosed = false;

  function address(req: IncomingMessage) {
    const direct = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const forwarded = req.headers['x-liquid-client-ip'] ?? req.headers['x-glass-client-ip'];
    if (trustedProxies.has(direct) && typeof forwarded === 'string' && isIP(forwarded)) {
      return forwarded;
    }
    const flyClient = req.headers['fly-client-ip'];
    if (env.JAM_TRUST_FLY_CLIENT_IP === '1' && typeof flyClient === 'string' && isIP(flyClient)) {
      return flyClient;
    }
    return direct;
  }

  function findRoomById(roomId: string): Room | undefined {
    for (const room of rooms.values()) {
      if (room.roomId === roomId) return room;
    }
    return undefined;
  }

  function loadPersistedState() {
    if (!db) return;
    const now = clock();
    try {
      db.prepare('DELETE FROM jam_rooms WHERE touched < ?').run(now - ttl);
      db.prepare('DELETE FROM jam_invite_tombstones WHERE expires_at <= ?').run(now);
      const roomRows = db.prepare('SELECT * FROM jam_rooms').all();
      const memberStmt = db.prepare('SELECT * FROM jam_members WHERE room_id = ?');
      for (const r of roomRows) {
        const roomId = String(r.room_id);
        const code = normalizeJamCode(String(r.code));
        if (!code) continue;
        let playback: JamPlayback;
        try {
          playback = JSON.parse(String(r.playback_json)) as JamPlayback;
        } catch {
          playback = { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 };
        }
        const members = new Map<string, Member>();
        for (const m of memberStmt.all(roomId)) {
          const tok = String(m.token);
          members.set(tok, {
            id: String(m.member_id),
            token: tok,
            clientId: typeof m.client_id === 'string' && m.client_id ? m.client_id : undefined,
            userId: typeof m.user_id === 'string' && m.user_id ? m.user_id : undefined,
            name: String(m.name),
            avatar: typeof m.avatar === 'string' && m.avatar ? m.avatar : undefined,
            host: Boolean(m.host),
            online: false,
            joinedAt: Number(m.joined_at) || now,
            seen: Number(m.seen) || now,
          });
        }
        if (members.size === 0) continue;
        let meta: {
          requireApproval?: boolean;
          permissions?: Partial<JamRoomPermissions>;
          blockedKeys?: string[];
          blockedList?: [string, JamBlockedParticipant][];
        } = {};
        if (typeof r.meta_json === 'string' && r.meta_json) {
          try {
            meta = JSON.parse(r.meta_json);
          } catch {}
        }
        rooms.set(code, {
          roomId,
          code,
          roomName: String(r.room_name),
          hostAvatar: typeof r.host_avatar === 'string' && r.host_avatar ? r.host_avatar : undefined,
          locked: Boolean(r.locked),
          requireAuth: Boolean(r.require_auth),
          requireApproval: requireApprovalGlobal || Boolean(meta.requireApproval),
          permissions: sanitizePermissions(meta.permissions, DEFAULT_JAM_PERMISSIONS),
          maxParticipants: Number(r.max_participants) || MAX_PARTICIPANTS,
          inviteExpiresAt: Number(r.invite_expires_at) || now + defaultInviteTtlMs,
          inviteTtlMs: defaultInviteTtlMs,
          createdAt: Number(r.created_at) || now,
          members,
          recentMembers: new Map(),
          kickedKeys: new Set(),
          blockedKeys: new Set(meta.blockedKeys || []),
          blockedList: new Map(meta.blockedList || []),
          joinRequests: new Map(),
          playback,
          touched: Number(r.touched) || now,
        });
      }
      const tombRows = db.prepare('SELECT * FROM jam_invite_tombstones').all();
      for (const t of tombRows) {
        const code = normalizeJamCode(String(t.code));
        if (!code) continue;
        tombstones.set(code, {
          code,
          roomId: String(t.room_id),
          roomName: String(t.room_name),
          hostName: String(t.host_name),
          hostAvatar: typeof t.host_avatar === 'string' && t.host_avatar ? t.host_avatar : undefined,
          reason: t.reason === 'expired' ? 'expired' : 'ended',
          createdAt: Number(t.created_at) || now,
          endedAt: Number(t.ended_at) || now,
          expiresAt: Number(t.expires_at) || now + TOMBSTONE_RETENTION_MS,
        });
      }
    } catch {}
  }

  function persistRoom(room: Room) {
    if (!db || dbClosed) return;
    const metaJson = JSON.stringify({
      requireApproval: room.requireApproval,
      permissions: room.permissions,
      blockedKeys: [...room.blockedKeys],
      blockedList: [...room.blockedList.entries()],
    });
    try {
      db.exec('BEGIN');
      db.prepare(
        `INSERT INTO jam_rooms(room_id, code, room_name, host_avatar, locked, require_auth, max_participants, playback_json, invite_expires_at, created_at, touched, meta_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           code=excluded.code,
           room_name=excluded.room_name,
           host_avatar=excluded.host_avatar,
           locked=excluded.locked,
           require_auth=excluded.require_auth,
           max_participants=excluded.max_participants,
           playback_json=excluded.playback_json,
           invite_expires_at=excluded.invite_expires_at,
           touched=excluded.touched,
           meta_json=excluded.meta_json`,
      ).run(
        room.roomId,
        room.code,
        room.roomName,
        room.hostAvatar ?? null,
        room.locked ? 1 : 0,
        room.requireAuth ? 1 : 0,
        room.maxParticipants,
        JSON.stringify(room.playback),
        room.inviteExpiresAt,
        room.createdAt,
        room.touched,
        metaJson,
      );
      db.prepare('DELETE FROM jam_members WHERE room_id = ?').run(room.roomId);
      const insertMember = db.prepare(
        `INSERT INTO jam_members(token, room_id, member_id, client_id, user_id, name, avatar, host, online, joined_at, seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of room.members.values()) {
        insertMember.run(
          m.token,
          room.roomId,
          m.id,
          m.clientId ?? null,
          m.userId ?? null,
          m.name,
          m.avatar ?? null,
          m.host ? 1 : 0,
          m.online === false ? 0 : 1,
          m.joinedAt ?? room.createdAt,
          m.seen,
        );
      }
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
  }

  function deletePersistedRoom(roomId: string) {
    if (!db || dbClosed) return;
    try {
      db.prepare('DELETE FROM jam_rooms WHERE room_id = ?').run(roomId);
    } catch {}
  }

  function recordTombstone(room: Room, code: string, reason: 'ended' | 'expired', now: number) {
    if (tombstones.size >= 4096) {
      const oldest = tombstones.keys().next().value;
      if (oldest) tombstones.delete(oldest);
    }
    const host = [...room.members.values()].find(m => m.host);
    const tomb: InviteTombstone = {
      code,
      roomId: room.roomId,
      roomName: room.roomName,
      hostName: host?.name || 'Anfitrião',
      hostAvatar: room.hostAvatar || host?.avatar,
      reason,
      createdAt: room.createdAt,
      endedAt: now,
      expiresAt: now + TOMBSTONE_RETENTION_MS,
    };
    tombstones.set(code, tomb);
    if (db && !dbClosed) {
      try {
        db.prepare(
          `INSERT INTO jam_invite_tombstones(code, room_id, room_name, host_name, host_avatar, reason, created_at, ended_at, expires_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET
             room_id=excluded.room_id,
             room_name=excluded.room_name,
             host_name=excluded.host_name,
             host_avatar=excluded.host_avatar,
             reason=excluded.reason,
             ended_at=excluded.ended_at,
             expires_at=excluded.expires_at`,
        ).run(
          tomb.code,
          tomb.roomId,
          tomb.roomName,
          tomb.hostName,
          tomb.hostAvatar ?? null,
          tomb.reason,
          tomb.createdAt,
          tomb.endedAt,
          tomb.expiresAt,
        );
      } catch {}
    }
  }

  loadPersistedState();

  function decrementCount(counts: Map<string, number>, key: string) {
    const next = (counts.get(key) || 1) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }

  function trackSocket(managed: NodeJamSocket) {
    allSockets.add(managed);
    let roomSet = roomSockets.get(managed.roomId);
    if (!roomSet) {
      roomSet = new Set();
      roomSockets.set(managed.roomId, roomSet);
    }
    roomSet.add(managed);
    socketIpCounts.set(managed.ip, (socketIpCounts.get(managed.ip) || 0) + 1);
    const memberKey = `${managed.roomId}:${managed.token}`;
    socketMemberCounts.set(memberKey, (socketMemberCounts.get(memberKey) || 0) + 1);
  }

  function untrackSocket(managed: NodeJamSocket) {
    if (!allSockets.delete(managed)) return;
    const roomSet = roomSockets.get(managed.roomId);
    roomSet?.delete(managed);
    if (roomSet?.size === 0) roomSockets.delete(managed.roomId);
    decrementCount(socketIpCounts, managed.ip);
    decrementCount(socketMemberCounts, `${managed.roomId}:${managed.token}`);
  }

  function closeSocket(managed: NodeJamSocket) {
    untrackSocket(managed);
    if (!managed.socket.destroyed) managed.socket.destroy();
  }

  function closeMemberSubscribers(roomId: string, token: string, eventName?: string, payload?: unknown) {
    for (const managed of [...(roomSockets.get(roomId) || [])]) {
      if (managed.token === token) closeSocket(managed);
    }
    const sseSet = roomSse.get(roomId);
    if (sseSet) {
      for (const sub of [...sseSet]) {
        if (sub.token === token) {
          if (eventName && payload !== undefined && !sub.res.writableEnded && !sub.res.destroyed) {
            try {
              sub.res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch {}
          }
          sseSet.delete(sub);
          try {
            sub.res.end();
          } catch {}
        }
      }
      if (sseSet.size === 0) roomSse.delete(roomId);
    }
  }

  function closeRoomSubscribers(roomId: string) {
    for (const managed of [...(roomSockets.get(roomId) || [])]) closeSocket(managed);
    const sseSet = roomSse.get(roomId);
    if (sseSet) {
      for (const sub of [...sseSet]) {
        try {
          sub.res.end();
        } catch {}
      }
      roomSse.delete(roomId);
    }
  }

  function sendSocket(managed: NodeJamSocket, frame: Buffer) {
    const room = findRoomById(managed.roomId);
    const member = room?.members.get(managed.token);
    if (!member || managed.socket.destroyed) {
      closeSocket(managed);
      return false;
    }
    if (managed.socket.writableLength > 262144) {
      closeSocket(managed);
      return false;
    }
    try {
      const flushed = managed.socket.write(frame);
      if (managed.socket.writableLength > 262144) {
        closeSocket(managed);
        return false;
      }
      if (!flushed && !managed.draining) {
        managed.draining = true;
        managed.socket.pause();
        managed.socket.once('drain', () => {
          managed.draining = false;
          if (!managed.socket.destroyed) managed.socket.resume();
        });
      }
      return true;
    } catch {
      closeSocket(managed);
      return false;
    }
  }

  function broadcastRoom(roomId: string, eventName: string, payload: unknown) {
    const json = JSON.stringify(payload);
    const sockets = roomSockets.get(roomId);
    if (sockets?.size) {
      const frame = encodeWsTextFrame(json);
      const room = findRoomById(roomId);
      for (const managed of [...sockets]) {
        if (!room?.members.has(managed.token)) closeSocket(managed);
        else sendSocket(managed, frame);
      }
    }
    const sseSet = roomSse.get(roomId);
    if (sseSet?.size) {
      const sseFrame = `event: ${eventName}\ndata: ${json}\n\n`;
      for (const sub of [...sseSet]) {
        if (!sub.res.writableEnded && !sub.res.destroyed) {
          try {
            sub.res.write(sseFrame);
          } catch {}
        }
      }
    }
  }

  function broadcastRoomState(
    room: Room,
    now: number,
    eventName: 'state' | 'playback' = 'state',
    hostOnly = false,
  ) {
    const guestJson = hostOnly ? '' : JSON.stringify(buildRoomView(room, now, undefined, false));
    let hostJson = '';
    const payloadFor = (tok: string): string | null => {
      const mbr = room.members.get(tok);
      if (!mbr) return null;
      if (mbr.host) {
        if (!hostJson) hostJson = JSON.stringify(buildRoomView(room, now, undefined, true));
        return hostJson;
      }
      return hostOnly ? null : guestJson;
    };
    const sockets = roomSockets.get(room.roomId);
    if (sockets?.size) {
      let guestFrame: Buffer | null = null;
      let hostFrame: Buffer | null = null;
      for (const managed of [...sockets]) {
        const mbr = room.members.get(managed.token);
        if (!mbr) {
          closeSocket(managed);
          continue;
        }
        if (hostOnly && !mbr.host) continue;
        if (mbr.host) {
          if (!hostFrame) hostFrame = encodeWsTextFrame(payloadFor(managed.token)!);
          sendSocket(managed, hostFrame);
        } else {
          if (!guestFrame) guestFrame = encodeWsTextFrame(payloadFor(managed.token)!);
          sendSocket(managed, guestFrame);
        }
      }
    }
    const sseSet = roomSse.get(room.roomId);
    if (sseSet?.size) {
      for (const sub of [...sseSet]) {
        if (sub.res.writableEnded || sub.res.destroyed) continue;
        const raw = payloadFor(sub.token);
        if (!raw) continue;
        try {
          sub.res.write(`event: ${eventName}\ndata: ${raw}\n\n`);
        } catch {}
      }
    }
  }

  function lookupInvite(rawCode: string, now: number): JamInvitePreview {
    const code = normalizeJamCode(rawCode);
    if (!code) {
      throw new JamError('Código da JAM inválido.', 400, 'INVITE_INVALID');
    }
    const room = rooms.get(code);
    if (room) {
      if (room.inviteExpiresAt <= now) {
        const preview = previewFromRoom(room, now);
        throw new JamError(
          'Este convite expirou. Peça um novo link ao anfitrião.',
          410,
          'INVITE_EXPIRED',
          preview,
        );
      }
      return previewFromRoom(room, now);
    }
    const tomb = tombstones.get(code);
    if (tomb && tomb.expiresAt > now) {
      const preview = previewFromTombstone(tomb, now);
      if (tomb.reason === 'ended') {
        throw new JamError('Esta JAM foi encerrada pelo anfitrião.', 410, 'ROOM_ENDED', preview);
      }
      throw new JamError(
        'Este convite expirou. Peça um novo link ao anfitrião.',
        410,
        'INVITE_EXPIRED',
        preview,
      );
    }
    throw new JamError('Nenhuma JAM encontrada com este código.', 404, 'INVITE_NOT_FOUND');
  }

  function prune(now: number) {
    for (const [code, room] of rooms) {
      let changed = false;
      for (const [token, member] of room.members) {
        if (!member.host && now - member.seen > memberGraceMs) {
          room.members.delete(token);
          if (room.recentMembers.size >= 32) {
            const oldest = room.recentMembers.keys().next().value;
            if (oldest) room.recentMembers.delete(oldest);
          }
          room.recentMembers.set(token, {
            id: member.id,
            token: member.token,
            clientId: member.clientId,
            userId: member.userId,
            name: member.name,
            avatar: member.avatar,
            host: member.host,
            joinedAt: member.joinedAt ?? room.createdAt,
            expiredAt: now,
          });
          closeMemberSubscribers(room.roomId, token);
          changed = true;
        }
      }
      if (pruneJoinRequests(room, now)) {
        changed = true;
      }
      if (now - room.touched > ttl) {
        recordTombstone(room, code, 'expired', now);
        rooms.delete(code);
        deletePersistedRoom(room.roomId);
        broadcastRoom(room.roomId, 'closed', {
          closed: true,
          reason: 'Esta JAM expirou por inatividade.',
          errorCode: 'ROOM_ENDED',
          serverTime: now,
        });
        closeRoomSubscribers(room.roomId);
      } else if (changed) {
        persistRoom(room);
        broadcastRoomState(room, now);
      }
    }
    for (const [code, tomb] of tombstones) {
      if (tomb.expiresAt <= now) tombstones.delete(code);
    }
    for (const [ip, rate] of rates) if (rate.until <= now) rates.delete(ip);
    for (const [nonce, until] of seenNonces) if (until <= now) seenNonces.delete(nonce);
  }

  function consumeRate(
    bucket: string,
    limit: number,
    now: number,
    customMessage = 'Muitas tentativas. Aguarde um minuto.',
    errorCode?: JamErrorCode,
  ) {
    let rate = rates.get(bucket);
    if (!rate || rate.until <= now) {
      if (rates.size >= 8192 && !rate) throw new JamError('Serviço ocupado.', 503);
      rate = { until: now + 60000, count: 0 };
      rates.set(bucket, rate);
    }
    if (++rate.count > limit) {
      throw new JamError(customMessage, 429, errorCode);
    }
  }

  function allow(ipAddr: string, action: string, now: number) {
    const isEntry = ['create', 'join', 'resume', 'requestJoin'].includes(action);
    const isLookup = ['lookup', 'checkJoinRequest', 'cancelJoinRequest'].includes(action);
    const maxCount = isEntry ? entryLimit : isLookup ? lookupLimit : activeLimit;
    const kind = isEntry ? 'entry' : isLookup ? 'lookup' : 'active';
    consumeRate(`ip:${ipAddr}:${kind}`, maxCount, now);
  }

  function allowMember(code: string, memberId: string, now: number) {
    consumeRate(`mbr:${code}:${memberId}:active`, activeLimit, now);
    consumeRate(`room:${code}:active`, roomActiveLimit, now);
  }

  function verifyReplayProtection(p: Record<string, unknown>, now: number, action: string) {
    const hasNonce = p.nonce !== undefined;
    const hasTs = p.timestamp !== undefined;
    if (!hasNonce && !hasTs) {
      if (
        strictReplay &&
        [
          'create',
          'join',
          'resume',
          'sync',
          'leave',
          'rotateInvite',
          'updateRoom',
          'kick',
          'approveJoin',
          'rejectJoin',
          'blockMember',
          'unblockMember',
        ].includes(action)
      ) {
        throw new JamError('Nonce e timestamp obrigatórios.', 401);
      }
      return;
    }
    if (!hasNonce || !hasTs) {
      throw new JamError('Informe nonce e timestamp juntos.', 400);
    }
    if (
      typeof p.nonce !== 'string' ||
      p.nonce.length < 16 ||
      p.nonce.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(p.nonce)
    ) {
      throw new JamError('Nonce inválido.', 400);
    }
    if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) {
      throw new JamError('Timestamp inválido.', 400);
    }
    if (Math.abs(now - p.timestamp) > replayWindowMs) {
      throw new JamError('Solicitação expirada (timestamp fora da janela).', 401);
    }
    if (seenNonces.has(p.nonce)) {
      throw new JamError('Replay detectado: nonce já utilizado.', 409);
    }
    if (seenNonces.size >= 32768) {
      const oldest = seenNonces.keys().next().value;
      if (oldest) seenNonces.delete(oldest);
    }
    seenNonces.set(p.nonce, now + replayWindowMs * 2);
  }

  function view(room: Room, now: number, p?: Record<string, unknown>, forHost = false): JamRoom {
    return buildRoomView(room, now, p, forHost);
  }

  function session(room: Room, member: Member, now: number, p?: Record<string, unknown>) {
    return buildMemberSession(room, member, now, p);
  }

  function executeCommand(
    p: Record<string, unknown>,
    ipAddr: string,
    authHeader?: string,
  ): { status: number; body: unknown } {
    assertNoUnknownKeys(p, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
    const now = clock();
    const action = String(p.action || '');
    prune(now);
    allow(ipAddr, action, now);

    if (action === 'ping') {
      if (typeof p.code === 'string' && validToken(p.token)) {
        const pingCode = normalizeJamCode(p.code);
        const pingRoom = pingCode ? rooms.get(pingCode) : undefined;
        const pingMember = pingRoom?.members.get(p.token);
        if (pingMember) {
          pingMember.seen = now;
          pingMember.online = true;
          if (pingMember.host && pingRoom) pingRoom.touched = now;
        }
      }
      verifyReplayProtection(p, now, action);
      return {
        status: 200,
        body: {
          pong: true,
          serverTime: now,
          ...(typeof p.clientTime === 'number' && Number.isFinite(p.clientTime)
            ? { echoClientTime: p.clientTime }
            : {}),
        },
      };
    }

    if (action === 'lookup') {
      verifyReplayProtection(p, now, action);
      return { status: 200, body: lookupInvite(String(p.code || ''), now) };
    }

    if (action === 'create') {
      if (rooms.size >= roomLimit) {
        throw new JamError('As salas estão ocupadas. Tente novamente em instantes.', 503, 'UNAVAILABLE');
      }
      const auth = verifyBearerJwt(authHeader, authPublicKey, now, requireAuthGlobal);
      verifyReplayProtection(p, now, action);

      const preferred =
        typeof p.preferredCode === 'string' ? normalizeJamCode(p.preferredCode) : '';
      let code: string;
      if (preferred) {
        if (rooms.has(preferred)) {
          throw new JamError('Esta JAM já foi criada.', 409);
        }
        code = preferred;
      } else {
        code = generateInviteCode(rooms);
      }
      tombstones.delete(code);

      const hostName = safeName(p.name);
      const avatar = sanitizeAvatar(p.avatar);
      const clientId = safeClientId(p.clientId);
      const inviteTtl =
        typeof p.inviteTtlMs === 'number' && Number.isFinite(p.inviteTtlMs)
          ? Math.max(60000, Math.min(86400000, Math.round(p.inviteTtlMs)))
          : defaultInviteTtlMs;

      const member: Member = {
        id: id(),
        token: id(),
        clientId,
        userId: auth?.userId,
        name: hostName,
        avatar,
        host: true,
        online: true,
        joinedAt: now,
        seen: now,
      };
      const room: Room = {
        roomId: makeRoomId(),
        code,
        roomName: safeRoomName(p.roomName, hostName),
        hostAvatar: avatar,
        locked: false,
        requireAuth: requireAuthGlobal || p.requireAuth === true,
        requireApproval: requireApprovalGlobal || p.requireApproval === true,
        permissions: sanitizePermissions(p.permissions, DEFAULT_JAM_PERMISSIONS),
        maxParticipants: MAX_PARTICIPANTS,
        inviteExpiresAt: now + inviteTtl,
        inviteTtlMs: inviteTtl,
        createdAt: now,
        members: new Map([[member.token, member]]),
        recentMembers: new Map(),
        kickedKeys: new Set(),
        blockedKeys: new Set(),
        blockedList: new Map(),
        joinRequests: new Map(),
        playback: { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 },
        touched: now,
      };
      rooms.set(code, room);
      persistRoom(room);
      return { status: 201, body: session(room, member, now, p) };
    }

    const code = typeof p.code === 'string' ? normalizeJamCode(p.code) : '';
    if (!code) {
      throw new JamError('Código da JAM inválido.', 400, 'INVITE_INVALID');
    }
    const room = rooms.get(code);
    if (!room) {
      const tomb = tombstones.get(code);
      if (tomb && tomb.expiresAt > now) {
        const preview = previewFromTombstone(tomb, now);
        if (tomb.reason === 'ended') {
          throw new JamError('Esta JAM foi encerrada ou expirou.', 410, 'ROOM_ENDED', preview);
        }
        throw new JamError(
          'Este convite expirou. Peça um novo link ao anfitrião.',
          410,
          'INVITE_EXPIRED',
          preview,
        );
      }
      throw new JamError('Esta JAM foi encerrada ou expirou.', 410, 'ROOM_ENDED');
    }

    if (action === 'requestJoin') {
      consumeRate(
        `req:${room.code}:${ipAddr}`,
        REQUEST_JOIN_IP_LIMIT_PER_MIN,
        now,
        'Muitas solicitações de entrada. Aguarde um minuto.',
        'RATE_LIMITED',
      );
      const needAuth = requireAuthGlobal || room.requireAuth;
      const auth = verifyBearerJwt(authHeader, authPublicKey, now, needAuth);
      verifyReplayProtection(p, now, action);
      const req = handleRequestJoin(room, p, now, auth?.userId);
      persistRoom(room);
      broadcastRoomState(room, now, 'state', true);
      return {
        status: 202,
        body: {
          status: req.status,
          requestId: req.id,
          requestToken: req.requestToken,
          expiresAt: req.expiresAt,
          preview: previewFromRoom(room, now),
          serverTime: now,
        },
      };
    }

    if (action === 'checkJoinRequest') {
      verifyReplayProtection(p, now, action);
      const { changed, body } = handleCheckJoinRequest(room, p, now);
      if (changed) {
        persistRoom(room);
        broadcastRoomState(room, now, 'state', true);
      }
      return { status: 200, body };
    }

    if (action === 'cancelJoinRequest') {
      verifyReplayProtection(p, now, action);
      const { changed, body } = handleCancelJoinRequest(room, p, now);
      if (changed) {
        persistRoom(room);
        broadcastRoomState(room, now, 'state', true);
      }
      return { status: 200, body };
    }

    if (action === 'join' || action === 'resume') {
      consumeRate(`room:${room.code}:entry`, roomEntryLimit, now);
      if (action === 'join' && room.inviteExpiresAt <= now) {
        throw new JamError(
          'Este convite expirou. Peça um novo link ao anfitrião.',
          410,
          'INVITE_EXPIRED',
          previewFromRoom(room, now),
        );
      }

      const needAuth = requireAuthGlobal || room.requireAuth;
      const auth = verifyBearerJwt(authHeader, authPublicKey, now, needAuth);
      const clientId = safeClientId(p.clientId);
      const resumeToken = validToken(p.resumeToken)
        ? p.resumeToken
        : validToken(p.token)
          ? p.token
          : undefined;

      if (isBlockedRequester(room, auth?.userId, clientId)) {
        throw new JamError('Você foi bloqueado pelo anfitrião desta JAM.', 403, 'BLOCKED');
      }

      if (
        (resumeToken && room.kickedKeys.has(`tok:${resumeToken}`)) ||
        (clientId && room.kickedKeys.has(`cid:${clientId}`)) ||
        (auth?.userId && room.kickedKeys.has(`uid:${auth.userId}`))
      ) {
        throw new JamError('Você foi removido desta JAM pelo anfitrião.', 403, 'KICKED');
      }

      let existing: Member | undefined;
      if (resumeToken && room.members.has(resumeToken)) {
        existing = room.members.get(resumeToken);
      } else if (auth?.userId) {
        existing = [...room.members.values()].find(m => m.userId === auth.userId);
      } else if (clientId) {
        existing = [...room.members.values()].find(m => m.clientId === clientId);
      }

      if (existing) {
        verifyReplayProtection(p, now, action);
        existing.seen = now;
        existing.online = true;
        if (typeof p.name === 'string' && p.name.trim()) existing.name = safeName(p.name);
        const av = sanitizeAvatar(p.avatar);
        if (av) existing.avatar = av;
        if (existing.host) room.touched = now;
        persistRoom(room);
        const resp = session(room, existing, now, p);
        broadcastRoomState(room, now);
        return { status: 200, body: resp };
      }

      let recent: RecentMember | undefined;
      if (resumeToken && room.recentMembers.has(resumeToken)) {
        recent = room.recentMembers.get(resumeToken);
      } else if (auth?.userId) {
        recent = [...room.recentMembers.values()].find(m => m.userId === auth.userId);
      } else if (clientId) {
        recent = [...room.recentMembers.values()].find(m => m.clientId === clientId);
      }

      if (recent) {
        if (room.members.size >= room.maxParticipants) {
          throw new JamError(
            `Esta JAM já tem ${room.maxParticipants} pessoas.`,
            409,
            'ROOM_FULL',
            previewFromRoom(room, now),
          );
        }
        verifyReplayProtection(p, now, action);
        room.recentMembers.delete(recent.token);
        const restored: Member = {
          id: recent.id,
          token: recent.token,
          clientId: clientId || recent.clientId,
          userId: auth?.userId || recent.userId,
          name: typeof p.name === 'string' && p.name.trim() ? safeName(p.name) : recent.name,
          avatar: sanitizeAvatar(p.avatar) || recent.avatar,
          host: recent.host,
          online: true,
          joinedAt: recent.joinedAt,
          seen: now,
        };
        room.members.set(restored.token, restored);
        persistRoom(room);
        const resp = session(room, restored, now, p);
        broadcastRoomState(room, now);
        return { status: 200, body: resp };
      }

      if (action === 'resume') {
        throw new JamError('Sua sessão expirou. Entre novamente.', 401, 'SESSION_EXPIRED');
      }

      if (room.requireApproval) {
        throw new JamError(
          'Esta JAM exige aprovação do anfitrião. Solicite entrada para participar.',
          403,
          'APPROVAL_REQUIRED',
          previewFromRoom(room, now),
        );
      }

      if (room.locked) {
        throw new JamError(
          'Esta JAM está trancada pelo anfitrião.',
          403,
          'ROOM_LOCKED',
          previewFromRoom(room, now),
        );
      }
      if (room.members.size >= room.maxParticipants) {
        throw new JamError(
          `Esta JAM já tem ${room.maxParticipants} pessoas.`,
          409,
          'ROOM_FULL',
          previewFromRoom(room, now),
        );
      }
      verifyReplayProtection(p, now, action);
      const member: Member = {
        id: id(),
        token: id(),
        clientId,
        userId: auth?.userId,
        name: safeName(p.name),
        avatar: sanitizeAvatar(p.avatar),
        host: false,
        online: true,
        joinedAt: now,
        seen: now,
      };
      room.members.set(member.token, member);
      persistRoom(room);
      const resp = session(room, member, now, p);
      broadcastRoomState(room, now);
      return { status: 200, body: resp };
    }

    if (!validToken(p.token)) {
      throw new JamError('Sessão da JAM inválida.', 401, 'SESSION_EXPIRED');
    }
    const member = room.members.get(p.token);
    if (!member) {
      if (room.kickedKeys.has(`tok:${p.token}`)) {
        throw new JamError('Você foi removido desta JAM pelo anfitrião.', 403, 'KICKED');
      }
      throw new JamError('Sua sessão expirou. Entre novamente.', 401, 'SESSION_EXPIRED');
    }
    allowMember(room.code, member.id, now);
    member.seen = now;
    member.online = true;
    if (member.host) room.touched = now;

    if (action === 'leave') {
      verifyReplayProtection(p, now, action);
      if (member.host) {
        recordTombstone(room, room.code, 'ended', now);
        broadcastRoom(room.roomId, 'closed', {
          closed: true,
          reason: 'O anfitrião encerrou a JAM.',
          errorCode: 'ROOM_ENDED',
          serverTime: now,
        });
        rooms.delete(room.code);
        deletePersistedRoom(room.roomId);
        closeRoomSubscribers(room.roomId);
      } else {
        room.members.delete(p.token);
        persistRoom(room);
        closeMemberSubscribers(room.roomId, p.token);
        broadcastRoomState(room, now);
      }
      return { status: 200, body: { closed: member.host, serverTime: now } };
    }

    if (action === 'rotateInvite') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode gerar um novo convite.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      const oldCode = room.code;
      const newCode = generateInviteCode(rooms);
      const nextTtl =
        typeof p.inviteTtlMs === 'number' && Number.isFinite(p.inviteTtlMs)
          ? Math.max(60000, Math.min(86400000, Math.round(p.inviteTtlMs)))
          : room.inviteTtlMs;
      recordTombstone(room, oldCode, 'expired', now);
      rooms.delete(oldCode);
      room.code = newCode;
      room.inviteTtlMs = nextTtl;
      room.inviteExpiresAt = now + nextTtl;
      tombstones.delete(newCode);
      rooms.set(newCode, room);
      for (const s of roomSockets.get(room.roomId) || []) {
        s.code = newCode;
      }
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'updateRoom') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode alterar as opções da JAM.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      applyRoomUpdate(room, member, p, requireAuthGlobal);
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'approveJoin') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode aprovar participantes.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      handleApproveJoin(room, member, p, now);
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'rejectJoin') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode recusar participantes.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      handleRejectJoin(room, member, p, now);
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'kick') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode remover participantes.', 403, 'FORBIDDEN');
      }
      const targetId = safeMemberId(p.memberId);
      if (!targetId) throw new JamError('Participante inválido.', 400);
      verifyReplayProtection(p, now, action);
      const target = [...room.members.values()].find(m => m.id === targetId);
      if (!target) throw new JamError('Participante não encontrado.', 404);
      if (target.host) throw new JamError('Não é possível remover o anfitrião.', 400);
      room.members.delete(target.token);
      room.recentMembers.delete(target.token);
      room.kickedKeys.add(`tok:${target.token}`);
      if (target.clientId) room.kickedKeys.add(`cid:${target.clientId}`);
      if (target.userId) room.kickedKeys.add(`uid:${target.userId}`);
      persistRoom(room);
      closeMemberSubscribers(room.roomId, target.token, 'kicked', {
        kicked: true,
        reason: 'Você foi removido desta JAM pelo anfitrião.',
        errorCode: 'KICKED',
        serverTime: now,
      });
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'blockMember') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode bloquear participantes.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      const blockedTarget = handleBlockMember(room, member, p, now);
      persistRoom(room);
      closeMemberSubscribers(room.roomId, blockedTarget.token, 'kicked', {
        kicked: true,
        reason: 'Você foi bloqueado nesta JAM pelo anfitrião.',
        errorCode: 'BLOCKED',
        serverTime: now,
      });
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action === 'unblockMember') {
      if (!member.host) {
        throw new JamError('Somente o anfitrião pode desbloquear participantes.', 403, 'FORBIDDEN');
      }
      verifyReplayProtection(p, now, action);
      handleUnblockMember(room, member, p);
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now, 'state', true);
      return { status: 200, body: nextView };
    }

    if (action === 'sync') {
      if (!member.host) {
        throw new JamError('Somente quem criou a JAM controla a reprodução.', 403, 'FORBIDDEN');
      }
      const play = p.playback as Record<string, unknown> | undefined;
      if (
        !play ||
        typeof play !== 'object' ||
        Array.isArray(play) ||
        typeof play.playing !== 'boolean' ||
        typeof play.position !== 'number' ||
        !Number.isFinite(play.position) ||
        play.position < 0 ||
        play.position > 86400
      ) {
        throw new JamError('Reprodução inválida.');
      }
      assertNoUnknownKeys(play, ALLOWED_PLAYBACK_KEYS, 'Playback JAM');
      const song = sanitizeTrack(play.track);
      verifyReplayProtection(p, now, action);
      if (song?.id !== room.playback.track?.id) {
        room.skipVotes?.clear();
        room.skipTriggeredAt = 0;
      }
      room.playback = {
        track: song,
        playing: !!song && play.playing,
        position: Math.min(song?.duration || 86400, play.position),
        updatedAt: now,
        sequence: room.playback.sequence + 1,
      };
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now, 'playback');
      return { status: 200, body: nextView };
    }

    if (
      ['voteSkip', 'queueAdd', 'queueRemove', 'recommendPlaylist', 'chat'].includes(action)
    ) {
      verifyReplayProtection(p, now, action);
      applyJamInteractiveAction(room, member, action, p, now);
      persistRoom(room);
      const nextView = view(room, now, p, member.host);
      broadcastRoomState(room, now);
      return { status: 200, body: nextView };
    }

    if (action !== 'poll') throw new JamError('Operação inválida.');
    verifyReplayProtection(p, now, action);
    return { status: 200, body: view(room, now, p, member.host) };
  }

  const wsHeartbeat = setInterval(() => {
    const now = clock();
    prune(now);
    for (const managed of [...allSockets]) {
      if (now - managed.lastSeen > wsTimeoutMs) closeSocket(managed);
      else sendSocket(managed, Buffer.from([0x89, 0]));
    }
  }, wsHeartbeatMs);
  wsHeartbeat.unref();

  const sseKeepalive = setInterval(() => {
    const now = clock();
    for (const subs of roomSse.values()) {
      for (const sub of subs) {
        const room = findRoomById(sub.roomId);
        const mbr = room?.members.get(sub.token);
        if (mbr) {
          mbr.seen = now;
          mbr.online = true;
          if (mbr.host && room) room.touched = now;
        }
        if (!sub.res.writableEnded && !sub.res.destroyed) {
          try {
            sub.res.write(': ping\n\n');
            sub.lastHeartbeat = now;
          } catch {}
        }
      }
    }
  }, 15000);
  sseKeepalive.unref();

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://jam.internal');
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

    const sendJson = (status: number, value: unknown) => {
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Service', 'liquid-hub-jam');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (status === 429) res.setHeader('Retry-After', '60');
      const json = JSON.stringify(value);
      if (acceptsGzip && json.length >= 256) {
        const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 4 });
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.writeHead(status).end(compressed);
      } else {
        res.writeHead(status).end(json);
      }
    };

    try {
      const ipAddr = address(req);

      if (req.method === 'GET' && reqUrl.pathname === '/health') {
        sendJson(200, {
          service: 'liquid-hub-jam',
          version: 3,
          runtime: 'node',
          activeRooms: rooms.size,
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname.startsWith('/v1/jam/invites/')) {
        const now = clock();
        prune(now);
        allow(ipAddr, 'lookup', now);
        const rawCode = decodeURIComponent(reqUrl.pathname.slice('/v1/jam/invites/'.length));
        const preview = lookupInvite(rawCode, now);
        sendJson(200, preview);
        return;
      }

      if (
        req.method === 'GET' &&
        (reqUrl.pathname.startsWith('/jam/join/') || reqUrl.pathname.startsWith('/join/'))
      ) {
        const now = clock();
        prune(now);
        allow(ipAddr, 'lookup', now);
        const rawCode = reqUrl.pathname.startsWith('/jam/join/')
          ? reqUrl.pathname.slice('/jam/join/'.length)
          : reqUrl.pathname.slice('/join/'.length);
        const decoded = decodeURIComponent(rawCode.split('/')[0] || '');
        const cleanCode = normalizeJamCode(decoded) || decoded.trim().toUpperCase().slice(0, 16);
        const origin = resolveRequestOrigin(req);
        const nonce = randomBytes(16).toString('base64');

        let preview: JamInvitePreview | null = null;
        let errMessage = '';
        let errCode: JamErrorCode | undefined;
        let status = 200;
        try {
          preview = lookupInvite(decoded, now);
        } catch (err) {
          if (err instanceof JamError) {
            status = err.status === 400 ? 404 : err.status;
            errMessage = err.message;
            errCode = err.errorCode;
            preview = err.preview ?? null;
          } else {
            status = 500;
            errMessage = 'Não foi possível carregar o convite.';
          }
        }

        const html = renderInviteLandingHtml({
          code: cleanCode || 'INVÁLIDO',
          origin,
          preview,
          errorMessage: errMessage,
          errorCode: errCode,
          downloadUrl,
          nonce,
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Service', 'liquid-hub-jam');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        res.writeHead(status).end(html);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/jam/events') {
        const now = clock();
        prune(now);
        const code = normalizeJamCode(reqUrl.searchParams.get('code') || '');
        const authHeader =
          typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const headerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
        const token = headerToken || reqUrl.searchParams.get('token') || '';
        const room = code ? rooms.get(code) : undefined;
        if (!room || !validToken(token) || !room.members.has(token)) {
          sendJson(401, {
            error: 'Sessão da JAM inválida ou expirada.',
            errorCode: 'SESSION_EXPIRED',
          });
          return;
        }
        const member = room.members.get(token)!;
        member.online = true;
        member.seen = now;
        if (member.host) room.touched = now;
        persistRoom(room);

        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Service': 'liquid-hub-jam',
          'X-Content-Type-Options': 'nosniff',
        });
        res.flushHeaders?.();

        const sub: NodeSseSubscriber = { res, roomId: room.roomId, token, lastHeartbeat: now };
        let set = roomSse.get(room.roomId);
        if (!set) {
          set = new Set();
          roomSse.set(room.roomId, set);
        }
        set.add(sub);

        const currentView = view(room, now, undefined, member.host);
        res.write(`event: state\ndata: ${JSON.stringify(currentView)}\n\n`);
        broadcastRoomState(room, now);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          const subs = roomSse.get(room.roomId);
          subs?.delete(sub);
          if (subs && subs.size === 0) roomSse.delete(room.roomId);
          const stillSse = subs ? [...subs].some(s => s.token === token) : false;
          const stillWs = [...(roomSockets.get(room.roomId) || [])].some(s => s.token === token);
          const liveRoom = findRoomById(room.roomId);
          if (!stillSse && !stillWs && liveRoom) {
            const mbr = liveRoom.members.get(token);
            if (mbr) {
              mbr.online = false;
              mbr.seen = clock();
              persistRoom(liveRoom);
              broadcastRoomState(liveRoom, clock());
            }
          }
        };
        res.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }

      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new JamError('Método não permitido.', 405);
      }
      if (reqUrl.pathname !== '/v1/jam') throw new JamError('Não encontrado.', 404);
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        throw new JamError('Envie JSON.', 415);
      }
      const p = await readBody(req);
      const authHeader =
        typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const result = executeCommand(p, ipAddr, authHeader);
      sendJson(result.status, result.body);
    } catch (error) {
      sendJson(error instanceof JamError ? error.status : 500, {
        error:
          error instanceof JamError ? error.message : 'Não foi possível concluir a operação.',
        ...(error instanceof JamError && error.errorCode ? { errorCode: error.errorCode } : {}),
        ...(error instanceof JamError && error.preview !== undefined
          ? { preview: error.preview }
          : {}),
      });
    }
  });

  // Real-time WebSocket endpoint (/v1/jam/ws?code=...&token=...)
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://jam.internal');
      const wsKey = req.headers['sec-websocket-key'];
      if (
        url.pathname !== '/v1/jam/ws' ||
        typeof wsKey !== 'string' ||
        String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
      ) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const code = normalizeJamCode(url.searchParams.get('code') || '');
      const authHeader =
        typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const token =
        authHeader.replace(/^Bearer\s+/i, '').trim() || url.searchParams.get('token') || '';
      const room = code && code.length >= 8 ? rooms.get(code) : undefined;
      const member = room && validToken(token) ? room.members.get(token) : undefined;
      if (!room || !member) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const ipAddr = address(req);
      const memberKey = `${room.roomId}:${token}`;
      if (
        allSockets.size >= wsGlobalLimit ||
        (socketIpCounts.get(ipAddr) || 0) >= wsIpLimit ||
        (socketMemberCounts.get(memberKey) || 0) >= wsMemberLimit ||
        (roomSockets.get(room.roomId)?.size || 0) >= wsRoomLimit
      ) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
        socket.destroy();
        return;
      }
      const now = clock();
      member.online = true;
      member.seen = now;
      if (member.host) room.touched = now;
      persistRoom(room);

      const accept = createHash('sha1')
        .update(`${wsKey.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          'X-Service: liquid-hub-jam',
          '\r\n',
        ].join('\r\n'),
      );

      const managed: NodeJamSocket = {
        socket,
        roomId: room.roomId,
        code: room.code,
        token,
        memberId: member.id,
        ip: ipAddr,
        lastSeen: now,
      };
      trackSocket(managed);
      sendSocket(managed, encodeWsTextFrame(JSON.stringify(view(room, now, undefined, member.host))));

      let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        managed.lastSeen = clock();
        const activeRoom = findRoomById(managed.roomId);
        const activeMember = activeRoom?.members.get(token);
        if (!activeRoom || !activeMember) {
          closeSocket(managed);
          return;
        }
        activeMember.seen = managed.lastSeen;
        activeMember.online = true;
        if (activeMember.host) activeRoom.touched = managed.lastSeen;
        if (buffer.length + chunk.length > 32768) {
          closeSocket(managed);
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        try {
          while (true) {
            const frame = decodeWsClientFrame(buffer);
            if (!frame) break;
            buffer = buffer.subarray(frame.consumed);
            if (frame.opcode === 0x08) {
              socket.end();
              return;
            }
            if (frame.opcode === 0x0a) continue;
            if (frame.opcode === 0x09) {
              sendSocket(
                managed,
                Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]),
              );
              continue;
            }
            if (frame.opcode === 0x01) {
              const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
              const res = executeCommand({ ...msg, code: activeRoom.code, token }, ipAddr);
              sendSocket(managed, encodeWsTextFrame(JSON.stringify(res.body)));
            }
          }
        } catch (err) {
          buffer = Buffer.alloc(0);
          sendSocket(
            managed,
            encodeWsTextFrame(
              JSON.stringify({
                error: err instanceof JamError ? err.message : 'Frame inválido.',
                ...(err instanceof JamError && err.errorCode ? { errorCode: err.errorCode } : {}),
              }),
            ),
          );
        }
      });

      const cleanupSocket = () => untrackSocket(managed);
      socket.on('close', cleanupSocket);
      socket.on('error', cleanupSocket);
    } catch {
      socket.destroy();
    }
  });

  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    clearInterval(wsHeartbeat);
    clearInterval(sseKeepalive);
    for (const managed of [...allSockets]) closeSocket(managed);
    for (const roomId of [...roomSse.keys()]) closeRoomSubscribers(roomId);
    return origClose(err => {
      dbClosed = true;
      db?.close?.();
      cb?.(err);
    });
  }) as typeof server.close;

  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  return server;
}

/* ==========================================================================
   Cloudflare Workers + Durable Objects (with WebSocket Hibernation API)
   Zero-cost idle hibernation on Cloudflare Free Tier
   ========================================================================== */

export interface CfDurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm?(): Promise<void>;
    sql?: CloudflareDoSqlStorage;
    transactionSync?: <T>(fn: () => T) => T;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
  getWebSocketAutoResponseTimestamp?(ws: WebSocket): Date | null;
}

export interface CfJamEnv {
  JAM_ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  JAM_IDLE_TTL_MS?: string;
  JAM_INVITE_TTL_MS?: string;
  JAM_REPLAY_WINDOW_MS?: string;
  JAM_NONCE_LIMIT?: string;
  JAM_NONCE_BYTES?: string;
  JAM_ENTRY_REQUESTS_PER_MINUTE?: string;
  JAM_ACTIVE_REQUESTS_PER_MINUTE?: string;
  JAM_ROOM_ENTRY_REQUESTS_PER_MINUTE?: string;
  JAM_ROOM_REQUESTS_PER_MINUTE?: string;
  JAM_MAX_ROOMS_PER_ISOLATE?: string;
  JAM_WS_MAX_PER_ROOM?: string;
  JAM_WS_MAX_PER_MEMBER?: string;
  JAM_WS_MAX_PER_IP?: string;
  JAM_ALLOWED_ORIGINS?: string;
  JAM_REQUIRE_AUTH?: string;
  JAM_REQUIRE_APPROVAL?: string;
  JAM_AUTH_PUBLIC_KEY?: string;
  JAM_DOWNLOAD_URL?: string;
  BROKER_ED25519_PRIVATE_KEY?: string;
  BROKER_PUBLIC_URL?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_AUTH_URL?: string;
  DISCORD_TOKEN_URL?: string;
  DISCORD_USER_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_AUTH_URL?: string;
  GITHUB_TOKEN_URL?: string;
  GITHUB_USER_URL?: string;
  GITHUB_EMAILS_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_USER_URL?: string;
}

const workerRates = new Map<string, { until: number; count: number }>();
const workerNonces = new Map<string, number>();
const workerRoomCreates = new WeakMap<
  object,
  Map<string, { reservation: symbol; createdAt: number }>
>();

function boundedCfSetting(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Number(raw) || fallback));
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  return contentType?.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

async function readCfJson(request: Request): Promise<Record<string, unknown>> {
  if (!hasJsonContentType(request)) throw new JamError('Envie JSON.', 415);
  if (Number(request.headers.get('Content-Length')) > JAM_BODY_LIMIT) {
    throw new JamError('Solicitação muito grande.', 413);
  }
  if (!request.body) throw new JamError('Solicitação inválida.', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > JAM_BODY_LIMIT) {
      await reader.cancel().catch(() => {});
      throw new JamError('Solicitação muito grande.', 413);
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch {
    throw new JamError('Solicitação inválida.', 400);
  }
}

function replayFields(
  p: Record<string, unknown>,
  now: number,
  action: string,
  windowMs: number,
): { nonce: string; until: number } | null {
  const hasNonce = p.nonce !== undefined;
  const hasTimestamp = p.timestamp !== undefined;
  if (!hasNonce && !hasTimestamp) {
    if (
      [
        'create',
        'join',
        'resume',
        'sync',
        'leave',
        'rotateInvite',
        'updateRoom',
        'kick',
        'approveJoin',
        'rejectJoin',
        'blockMember',
        'unblockMember',
      ].includes(action)
    ) {
      throw new JamError('Nonce e timestamp obrigatórios.', 401);
    }
    return null;
  }
  if (!hasNonce || !hasTimestamp) {
    throw new JamError('Informe nonce e timestamp juntos.', 400);
  }
  if (
    typeof p.nonce !== 'string' ||
    p.nonce.length < 16 ||
    p.nonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(p.nonce)
  ) {
    throw new JamError('Nonce inválido.', 400);
  }
  if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) {
    throw new JamError('Timestamp inválido.', 400);
  }
  if (Math.abs(now - p.timestamp) > windowMs) {
    throw new JamError('Solicitação expirada (timestamp fora da janela).', 401);
  }
  return { nonce: p.nonce, until: now + windowMs * 2 };
}

function acceptNonce(
  nonces: Map<string, number>,
  p: Record<string, unknown>,
  now: number,
  action: string,
  windowMs: number,
  cap: number,
  maxBytes = Number.POSITIVE_INFINITY,
) {
  for (const [nonce, until] of nonces) if (until <= now) nonces.delete(nonce);
  const fields = replayFields(p, now, action, windowMs);
  if (!fields) return;
  if (nonces.has(fields.nonce)) throw new JamError('Replay detectado.', 409);
  nonces.set(fields.nonce, fields.until);
  while (
    nonces.size > cap ||
    Buffer.byteLength(JSON.stringify([...nonces.entries()]), 'utf8') > maxBytes
  ) {
    const oldest = nonces.keys().next().value;
    if (!oldest) break;
    nonces.delete(oldest);
  }
}

function consumeCfRate(
  rates: Map<string, { until: number; count: number }>,
  key: string,
  limit: number,
  now: number,
  customMessage = 'Muitas tentativas. Aguarde um minuto.',
  errorCode?: JamErrorCode,
) {
  if (rates.size >= 8192) {
    for (const [bucket, rate] of rates) if (rate.until <= now) rates.delete(bucket);
  }
  let rate = rates.get(key);
  if (!rate || rate.until <= now) {
    if (rates.size >= 8192 && !rate) throw new JamError('Serviço ocupado.', 503);
    rate = { until: now + 60000, count: 0 };
    rates.set(key, rate);
  }
  if (++rate.count > limit) throw new JamError(customMessage, 429, errorCode);
}

function cfClientAddress(request: Request) {
  const value = request.headers.get('CF-Connecting-IP')?.trim() || '';
  return isIP(value) ? value : 'unknown';
}

function isAllowedWsOrigin(originHeader: string | null, requestOrigin: string, env: CfJamEnv): boolean {
  if (!originHeader) return true;
  const normalized = originHeader.trim();
  if (!normalized || normalized === 'null') return false;
  if (normalized === requestOrigin) return true;
  const trustedExact = new Set([
    'https://tauri.localhost',
    'http://tauri.localhost',
    'tauri://localhost',
    'https://jam.test',
  ]);
  if (trustedExact.has(normalized)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(normalized)) return true;
  if (env.JAM_ALLOWED_ORIGINS) {
    const allowed = env.JAM_ALLOWED_ORIGINS.split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    if (allowed.includes(normalized)) return true;
  }
  return false;
}

function jamLog(event: string, fields: Record<string, string | number | boolean> = {}) {
  try {
    console.log(JSON.stringify({ service: 'liquid-hub-jam', event, ...fields }));
  } catch {}
}

const INVITE_LANDING_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Liquid Hub JAM</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b10;color:#eef2f7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
main{max-width:460px;background:#111622;border:1px solid #242d40;border-radius:18px;padding:28px;line-height:1.5}
h1{margin:0 0 8px;font-size:1.25rem}
p{margin:8px 0;color:#b6c0d2;font-size:.95rem}
code{background:#1b2335;padding:2px 6px;border-radius:6px;color:#fff}
</style>
</head>
<body>
<main>
<h1>Liquid Hub · JAM</h1>
<p>Estamos abrindo o Liquid Hub. Se o navegador pedir permissão, confirme para abrir o aplicativo.</p>
<p><a id="open" hidden style="color:#8ce2b4">Abrir Liquid Hub</a></p>
<p>Se não abrir, instale ou atualize o Liquid Hub. Você também pode copiar este link e colar em <strong>Configurações → JAM</strong>.</p>
</main>
<script src="/invite.js" defer></script>
</body>
</html>`;

const INVITE_SCRIPT = `const p=new URLSearchParams(location.hash.slice(1));
const code=(p.get('jam')||'').replace(/[^a-z0-9]/gi,''); const endpoint=p.get('endpoint')||location.origin;
try { const u=new URL(endpoint);
  if(!/^[a-z0-9]{6,16}$/i.test(code)||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw 0;
  const link='liquidhub://join?'+new URLSearchParams({code,endpoint:u.origin});
  const button=document.getElementById('open'); button.href=link; button.hidden=false;
  location.href=link;
} catch {}`;

function cfError(error: unknown) {
  const status = error instanceof JamError ? error.status : 500;
  return Response.json(
    {
      error: error instanceof JamError ? error.message : 'Erro interno na JAM.',
      ...(error instanceof JamError && error.errorCode ? { errorCode: error.errorCode } : {}),
      ...(error instanceof JamError && error.preview !== undefined ? { preview: error.preview } : {}),
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Service': 'liquid-hub-jam',
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      },
    },
  );
}

function isBrokerAuthOrSocialPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/jwks.json' ||
    pathname === '/v1/version' ||
    pathname.startsWith('/v1/auth/') ||
    pathname.startsWith('/v1/profiles/') ||
    pathname.startsWith('/v1/users/') ||
    pathname === '/v1/playlists' ||
    pathname.startsWith('/v1/playlists/') ||
    pathname.startsWith('/v1/plus/') ||
    pathname.startsWith('/u/') ||
    pathname.startsWith('/p/')
  );
}

type StoredDoRoom = {
  roomId?: string;
  code: string;
  roomName?: string;
  hostAvatar?: string;
  locked?: boolean;
  requireAuth?: boolean;
  requireApproval?: boolean;
  permissions?: JamRoomPermissions;
  maxParticipants?: number;
  inviteExpiresAt?: number;
  inviteTtlMs?: number;
  createdAt?: number;
  members: [string, Member][];
  recentMembers?: [string, RecentMember][];
  kickedKeys?: string[];
  blockedKeys?: string[];
  blockedList?: [string, JamBlockedParticipant][];
  joinRequests?: [string, InternalJoinRequest][];
  playback: JamPlayback;
  skipVotes?: string[];
  skipTriggeredAt?: number;
  jamQueue?: JamQueueItem[];
  recommendations?: JamPlaylistRecommendation[];
  messages?: JamChatMessage[];
  touched: number;
  nonces?: [string, number][];
};

export class JamRoomDO {
  private readonly ctx: CfDurableObjectState;
  private readonly env: CfJamEnv;
  private readonly clock: () => number;
  private room: Room | null = null;
  private tombstone: InviteTombstone | null = null;
  private mutationNonces = new Map<string, number>();
  private volatileNonces = new Map<string, number>();
  private rates = new Map<string, { until: number; count: number }>();
  private authEngine: ZeroTrustAuthEngine | null = null;

  constructor(
    ctx: CfDurableObjectState,
    env: CfJamEnv,
    clock: () => number = Date.now,
  ) {
    this.ctx = ctx;
    this.env = env;
    this.clock = clock;
    const AutoPair = (globalThis as Record<string, any>).WebSocketRequestResponsePair;
    if (AutoPair && this.ctx.setWebSocketAutoResponse) {
      // Responds to lightweight pings while keeping the Durable Object hibernated!
      this.ctx.setWebSocketAutoResponse(new AutoPair('{"action":"ping"}', '{"pong":true}'));
    }
  }

  private getAuthEngine(): ZeroTrustAuthEngine {
    if (!this.authEngine) {
      const sql = this.ctx.storage.sql;
      const txSync = this.ctx.storage.transactionSync
        ? <T>(fn: () => T) => this.ctx.storage.transactionSync!(fn)
        : undefined;
      const dbPath = sql ? createDoSqliteAdapter(sql, txSync) : ':memory:';
      this.authEngine = new ZeroTrustAuthEngine({
        clock: this.clock,
        dbPath,
        privateKeyPem: this.env.BROKER_ED25519_PRIVATE_KEY,
      });
    }
    return this.authEngine;
  }

  private hydrateRoom(saved: StoredDoRoom) {
    this.room = {
      roomId: saved.roomId || makeRoomId(),
      code: saved.code,
      roomName: saved.roomName || 'Liquid Hub JAM',
      hostAvatar: saved.hostAvatar,
      locked: Boolean(saved.locked),
      requireAuth: Boolean(saved.requireAuth),
      requireApproval: this.env.JAM_REQUIRE_APPROVAL === '1' || Boolean(saved.requireApproval),
      permissions: sanitizePermissions(saved.permissions, DEFAULT_JAM_PERMISSIONS),
      maxParticipants: saved.maxParticipants || MAX_PARTICIPANTS,
      inviteExpiresAt: saved.inviteExpiresAt || saved.touched + DEFAULT_INVITE_TTL_MS,
      inviteTtlMs: saved.inviteTtlMs || DEFAULT_INVITE_TTL_MS,
      createdAt: saved.createdAt || saved.touched,
      members: new Map(saved.members),
      recentMembers: new Map(saved.recentMembers || []),
      kickedKeys: new Set(saved.kickedKeys || []),
      blockedKeys: new Set(saved.blockedKeys || []),
      blockedList: new Map(saved.blockedList || []),
      joinRequests: new Map(saved.joinRequests || []),
      playback: saved.playback,
      skipVotes: new Set(saved.skipVotes || []),
      skipTriggeredAt: saved.skipTriggeredAt || 0,
      jamQueue: saved.jamQueue || [],
      recommendations: saved.recommendations || [],
      messages: saved.messages || [],
      touched: saved.touched,
    };
    this.mutationNonces = new Map(saved.nonces || []);
    this.tombstone = null;
  }

  private serializeRoom(room: Room): StoredDoRoom {
    return {
      roomId: room.roomId,
      code: room.code,
      roomName: room.roomName,
      hostAvatar: room.hostAvatar,
      locked: room.locked,
      requireAuth: room.requireAuth,
      requireApproval: room.requireApproval,
      permissions: room.permissions,
      maxParticipants: room.maxParticipants,
      inviteExpiresAt: room.inviteExpiresAt,
      inviteTtlMs: room.inviteTtlMs,
      createdAt: room.createdAt,
      members: [...room.members.entries()],
      recentMembers: [...room.recentMembers.entries()],
      kickedKeys: [...room.kickedKeys],
      blockedKeys: [...room.blockedKeys],
      blockedList: [...room.blockedList.entries()],
      joinRequests: [...room.joinRequests.entries()],
      playback: room.playback,
      skipVotes: [...(room.skipVotes || [])],
      skipTriggeredAt: room.skipTriggeredAt || 0,
      jamQueue: room.jamQueue || [],
      recommendations: room.recommendations || [],
      messages: room.messages || [],
      touched: room.touched,
      nonces: [...this.mutationNonces.entries()],
    };
  }

  private async loadRoom(): Promise<Room | null> {
    if (this.room) return this.room;
    const saved = await this.ctx.storage.get<StoredDoRoom>('room');
    if (saved) {
      this.hydrateRoom(saved);
    } else if (!this.tombstone) {
      const savedTomb = await this.ctx.storage.get<InviteTombstone>('tombstone');
      if (savedTomb && savedTomb.expiresAt > this.clock()) {
        this.tombstone = savedTomb;
      }
    }
    return this.room;
  }

  private ttl() {
    return boundedCfSetting(this.env.JAM_IDLE_TTL_MS, 900000, 30000, 3600000);
  }

  private defaultInviteTtl() {
    return boundedCfSetting(this.env.JAM_INVITE_TTL_MS, DEFAULT_INVITE_TTL_MS, 60000, 86400000);
  }

  private async persistRoom() {
    const room = this.room;
    if (!room) {
      await this.ctx.storage.deleteAlarm?.();
      await this.ctx.storage.deleteAll();
      if (this.tombstone && this.tombstone.expiresAt > this.clock()) {
        await this.ctx.storage.put('tombstone', this.tombstone);
      }
      return;
    }
    await this.ctx.storage.put('room', this.serializeRoom(room));
    await this.ctx.storage.setAlarm(this.clock() + this.ttl());
  }

  private verifyReplay(p: Record<string, unknown>, now: number, action: string) {
    const persistent = [
      'create',
      'join',
      'resume',
      'sync',
      'leave',
      'rotateInvite',
      'updateRoom',
      'kick',
      'approveJoin',
      'rejectJoin',
      'blockMember',
      'unblockMember',
    ].includes(action);
    acceptNonce(
      persistent ? this.mutationNonces : this.volatileNonces,
      p,
      now,
      action,
      boundedCfSetting(this.env.JAM_REPLAY_WINDOW_MS, 60000, 10000, 300000),
      boundedCfSetting(this.env.JAM_NONCE_LIMIT, 4096, 1, 32768),
      persistent
        ? boundedCfSetting(this.env.JAM_NONCE_BYTES, 16384, 512, 32768)
        : Number.POSITIVE_INFINITY,
    );
  }

  private allowIp(ip: string, action: string, now: number) {
    for (const [bucket, rate] of this.rates) if (rate.until <= now) this.rates.delete(bucket);
    const entry = ['create', 'join', 'resume', 'requestJoin'].includes(action);
    const isLookup = ['lookup', 'checkJoinRequest', 'cancelJoinRequest'].includes(action);
    consumeCfRate(
      this.rates,
      `ip:${ip}:${entry ? 'entry' : isLookup ? 'lookup' : 'active'}`,
      isLookup
        ? 120
        : boundedCfSetting(
            entry ? this.env.JAM_ENTRY_REQUESTS_PER_MINUTE : this.env.JAM_ACTIVE_REQUESTS_PER_MINUTE,
            entry ? 30 : 1800,
            1,
            10000,
          ),
      now,
    );
  }

  private allowMember(code: string, memberId: string, now: number) {
    consumeCfRate(
      this.rates,
      `mbr:${code}:${memberId}:active`,
      boundedCfSetting(this.env.JAM_ACTIVE_REQUESTS_PER_MINUTE, 1800, 1, 10000),
      now,
    );
    consumeCfRate(
      this.rates,
      `room:${code}:active`,
      boundedCfSetting(this.env.JAM_ROOM_REQUESTS_PER_MINUTE, 14400, 8, 80000),
      now,
    );
  }

  private closeToken(token: string, reason = 'Sessão encerrada.') {
    for (const ws of this.ctx.getWebSockets(token)) {
      try {
        ws.close(1008, reason);
      } catch {}
    }
  }

  private closeAll(reason: string, closeCode = 1008) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(closeCode, reason);
      } catch {}
    }
  }

  private async pruneRoom(now: number) {
    if (!this.room) {
      if (this.tombstone && now >= this.tombstone.expiresAt) {
        this.tombstone = null;
        await this.ctx.storage.deleteAll();
      }
      return;
    }
    let changed = false;
    for (const [token, member] of this.room.members) {
      for (const ws of this.ctx.getWebSockets(token)) {
        const at = this.ctx.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
        if (at > member.seen) member.seen = Math.min(at, now);
      }
      if (member.host && member.seen > this.room.touched) this.room.touched = member.seen;
      if (!member.host && now - member.seen > 35000) {
        this.room.members.delete(token);
        this.room.recentMembers.set(token, {
          id: member.id,
          token: member.token,
          clientId: member.clientId,
          userId: member.userId,
          name: member.name,
          avatar: member.avatar,
          host: member.host,
          joinedAt: member.joinedAt ?? this.room.createdAt,
          expiredAt: now,
        });
        this.closeToken(token, 'Sessão expirada.');
        changed = true;
      }
    }
    if (pruneJoinRequests(this.room, now)) {
      changed = true;
    }
    if (now - this.room.touched > this.ttl()) {
      const host = [...this.room.members.values()].find(m => m.host);
      const expiredCode = this.room.code;
      this.tombstone = {
        code: expiredCode,
        roomId: this.room.roomId,
        roomName: this.room.roomName,
        hostName: host?.name || 'Anfitrião',
        hostAvatar: this.room.hostAvatar || host?.avatar,
        reason: 'expired',
        createdAt: this.room.createdAt,
        endedAt: now,
        expiresAt: now + TOMBSTONE_RETENTION_MS,
      };
      this.closeAll('JAM expirada.');
      this.room = null;
      this.mutationNonces.clear();
      this.volatileNonces.clear();
      this.rates.clear();
      await this.ctx.storage.deleteAlarm?.();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put('tombstone', this.tombstone);
      jamLog('room_expired', { code: expiredCode });
      return;
    }
    if (changed) await this.persistRoom();
  }

  private broadcast(payload: unknown) {
    if (!this.room) return;
    const raw = JSON.stringify(payload);
    const sent = new Set<WebSocket>();
    for (const token of this.room.members.keys()) {
      for (const ws of this.ctx.getWebSockets(token)) {
        if (sent.has(ws)) continue;
        sent.add(ws);
        try {
          ws.send(raw);
        } catch {}
      }
    }
  }

  private broadcastRoomState(room: Room, now: number, hostOnly = false) {
    const guestRaw = hostOnly ? '' : JSON.stringify(buildRoomView(room, now, undefined, false));
    let hostRaw = '';
    const sent = new Set<WebSocket>();
    for (const [tok, mbr] of room.members) {
      if (hostOnly && !mbr.host) continue;
      let raw: string;
      if (mbr.host) {
        if (!hostRaw) hostRaw = JSON.stringify(buildRoomView(room, now, undefined, true));
        raw = hostRaw;
      } else {
        raw = guestRaw;
      }
      for (const ws of this.ctx.getWebSockets(tok)) {
        if (sent.has(ws)) continue;
        sent.add(ws);
        try {
          ws.send(raw);
        } catch {}
      }
    }
  }

  private roomView(room: Room, now: number, p?: Record<string, unknown>, forHost = false): JamRoom {
    return buildRoomView(room, now, p, forHost);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isBrokerAuthOrSocialPath(url.pathname)) {
      const engine = this.getAuthEngine();
      const baseProviders = resolveOAuthProviders(this.env as unknown as NodeJS.ProcessEnv);
      return handleFetchAuthRequest({
        request,
        auth: engine,
        baseOAuthProviders: baseProviders,
        publicBase: this.env.BROKER_PUBLIC_URL || url.origin,
      });
    }
    if (
      url.pathname === '/__internal/migrate' &&
      request.method === 'POST' &&
      request.headers.get('X-Liquid-Internal-Migrate') === '1'
    ) {
      const now = this.clock();
      await this.loadRoom();
      await this.pruneRoom(now);
      if (this.room) {
        return new Response(JSON.stringify({ error: 'Código em uso.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const rawSaved = await request.text();
      if (Buffer.byteLength(rawSaved, 'utf8') > 4 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Snapshot da sala muito grande.' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const saved = JSON.parse(rawSaved) as StoredDoRoom;
      this.hydrateRoom(saved);
      this.tombstone = null;
      await this.persistRoom();
      return Response.json({ ok: true });
    }
    const now = this.clock();
    await this.loadRoom();
    await this.pruneRoom(now);
    const room = this.room;
    const ip = request.headers.get('X-Liquid-Client-IP') || 'unknown';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const token = url.searchParams.get('token') || '';
      if (!room || !room.members.has(token)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (
        this.ctx.getWebSockets().length >=
          boundedCfSetting(this.env.JAM_WS_MAX_PER_ROOM, 64, 1, 256) ||
        this.ctx.getWebSockets(token).length >=
          boundedCfSetting(this.env.JAM_WS_MAX_PER_MEMBER, 4, 1, 32) ||
        this.ctx.getWebSockets(`ip:${ip}`).length >=
          boundedCfSetting(this.env.JAM_WS_MAX_PER_IP, 100, 1, 256)
      ) {
        return new Response('WebSocket capacity exceeded', { status: 429 });
      }
      const connectedMember = room.members.get(token)!;
      connectedMember.seen = now;
      connectedMember.online = true;
      if (connectedMember.host) room.touched = now;
      const PairCtor = (globalThis as Record<string, any>).WebSocketPair;
      const pair = new PairCtor();
      const [client, server] = [
        pair[0] as WebSocket,
        pair[1] as WebSocket & { serializeAttachment?(value: unknown): void },
      ];
      server.serializeAttachment?.({ token, code: room.code, ip });
      this.ctx.acceptWebSocket(server, [token, `ip:${ip}`]);
      return new Response(null, {
        status: 101,
        headers: { 'X-Service': 'liquid-hub-jam' },
        webSocket: client,
      } as ResponseInit);
    }

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Service': 'liquid-hub-jam',
      'X-Content-Type-Options': 'nosniff',
    };

    try {
      const p = await readCfJson(request);
      assertNoUnknownKeys(p, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
      const action = String(p.action || '');
      this.allowIp(ip, action, now);
      const authHeader = request.headers.get('Authorization') || undefined;
      const requireAuthGlobal = this.env.JAM_REQUIRE_AUTH === '1';
      const authPublicKey = requireAuthGlobal || this.env.JAM_AUTH_PUBLIC_KEY
        ? importEd25519PublicKeyFromX(this.env.JAM_AUTH_PUBLIC_KEY)
        : null;

      if (action === 'ping') {
        if (this.room && p.code === this.room.code && validToken(p.token)) {
          const pingMember = this.room.members.get(p.token);
          if (pingMember) {
            pingMember.seen = now;
            if (pingMember.host) this.room.touched = now;
          }
        }
        this.verifyReplay(p, now, action);
        return new Response(
          JSON.stringify({ pong: true, serverTime: now, echoClientTime: p.clientTime }),
          { status: 200, headers },
        );
      }

      if (action === 'lookup') {
        if (this.room) {
          if (this.room.inviteExpiresAt <= now) {
            throw new JamError(
              'Este convite expirou. Peça um novo link ao anfitrião.',
              410,
              'INVITE_EXPIRED',
              previewFromRoom(this.room, now),
            );
          }
          return new Response(JSON.stringify(previewFromRoom(this.room, now)), { status: 200, headers });
        }
        if (this.tombstone && this.tombstone.expiresAt > now) {
          const preview = previewFromTombstone(this.tombstone, now);
          if (this.tombstone.reason === 'ended') {
            throw new JamError('Esta JAM foi encerrada pelo anfitrião.', 410, 'ROOM_ENDED', preview);
          }
          throw new JamError(
            'Este convite expirou. Peça um novo link ao anfitrião.',
            410,
            'INVITE_EXPIRED',
            preview,
          );
        }
        throw new JamError('Nenhuma JAM encontrada com este código.', 404, 'INVITE_NOT_FOUND');
      }

      if (action === 'create') {
        if (this.room) throw new JamError('Esta JAM já foi criada.', 409);
        const auth = verifyBearerJwt(authHeader, authPublicKey, now, requireAuthGlobal);
        this.verifyReplay(p, now, action);
        const code = normalizeJamCode(String(p.code || '')) || generateInviteCode(new Set());
        if (!code) throw new JamError('Código da JAM inválido.', 400, 'INVITE_INVALID');
        const hostName = safeName(p.name);
        const avatar = sanitizeAvatar(p.avatar);
        const clientId = safeClientId(p.clientId);
        const inviteTtl =
          typeof p.inviteTtlMs === 'number' && Number.isFinite(p.inviteTtlMs)
            ? Math.max(60000, Math.min(86400000, Math.round(p.inviteTtlMs)))
            : this.defaultInviteTtl();

        const host: Member = {
          id: id(),
          token: id(),
          clientId,
          userId: auth?.userId,
          name: hostName,
          avatar,
          host: true,
          online: true,
          joinedAt: now,
          seen: now,
        };
        this.tombstone = null;
        this.room = {
          roomId: makeRoomId(),
          code,
          roomName: safeRoomName(p.roomName, hostName),
          hostAvatar: avatar,
          locked: false,
          requireAuth: requireAuthGlobal || p.requireAuth === true,
          requireApproval: this.env.JAM_REQUIRE_APPROVAL === '1' || p.requireApproval === true,
          permissions: sanitizePermissions(p.permissions, DEFAULT_JAM_PERMISSIONS),
          maxParticipants: MAX_PARTICIPANTS,
          inviteExpiresAt: now + inviteTtl,
          inviteTtlMs: inviteTtl,
          createdAt: now,
          members: new Map([[host.token, host]]),
          recentMembers: new Map(),
          kickedKeys: new Set(),
          blockedKeys: new Set(),
          blockedList: new Map(),
          joinRequests: new Map(),
          playback: { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 },
          touched: now,
        };
        const created = this.room;
        await this.persistRoom();
        return new Response(
          JSON.stringify({
            ...this.roomView(created, now, p, true),
            token: host.token,
            memberId: host.id,
            host: true,
            ...(host.clientId ? { clientId: host.clientId } : {}),
          }),
          { status: 201, headers },
        );
      }

      if (!this.room) {
        if (this.tombstone && this.tombstone.expiresAt > now) {
          throw new JamError(
            'Esta JAM foi encerrada ou expirou.',
            410,
            this.tombstone.reason === 'ended' ? 'ROOM_ENDED' : 'INVITE_EXPIRED',
            previewFromTombstone(this.tombstone, now),
          );
        }
        throw new JamError('Esta JAM foi encerrada ou expirou.', 410, 'ROOM_ENDED');
      }
      const current = this.room;

      if (action === 'requestJoin') {
        consumeCfRate(
          this.rates,
          `req:${current.code}:${ip}`,
          REQUEST_JOIN_IP_LIMIT_PER_MIN,
          now,
          'Muitas solicitações de entrada. Aguarde um minuto.',
          'RATE_LIMITED',
        );
        const needAuth = requireAuthGlobal || current.requireAuth;
        const auth = verifyBearerJwt(authHeader, authPublicKey, now, needAuth);
        this.verifyReplay(p, now, action);
        const req = handleRequestJoin(current, p, now, auth?.userId);
        await this.persistRoom();
        this.broadcastRoomState(current, now, true);
        return new Response(
          JSON.stringify({
            status: req.status,
            requestId: req.id,
            requestToken: req.requestToken,
            expiresAt: req.expiresAt,
            preview: previewFromRoom(current, now),
            serverTime: now,
          }),
          { status: 202, headers },
        );
      }

      if (action === 'checkJoinRequest') {
        this.verifyReplay(p, now, action);
        const { changed, body } = handleCheckJoinRequest(current, p, now);
        if (changed) {
          await this.persistRoom();
          this.broadcastRoomState(current, now, true);
        }
        return new Response(JSON.stringify(body), { status: 200, headers });
      }

      if (action === 'cancelJoinRequest') {
        this.verifyReplay(p, now, action);
        const { changed, body } = handleCancelJoinRequest(current, p, now);
        if (changed) {
          await this.persistRoom();
          this.broadcastRoomState(current, now, true);
        }
        return new Response(JSON.stringify(body), { status: 200, headers });
      }

      if (action === 'join' || action === 'resume') {
        consumeCfRate(
          this.rates,
          `room:${current.code}:entry`,
          boundedCfSetting(this.env.JAM_ROOM_ENTRY_REQUESTS_PER_MINUTE, 120, 8, 600),
          now,
        );
        if (action === 'join' && current.inviteExpiresAt <= now) {
          throw new JamError(
            'Este convite expirou. Peça um novo link ao anfitrião.',
            410,
            'INVITE_EXPIRED',
            previewFromRoom(current, now),
          );
        }
        const needAuth = requireAuthGlobal || current.requireAuth;
        const auth = verifyBearerJwt(authHeader, authPublicKey, now, needAuth);
        const clientId = safeClientId(p.clientId);
        const resumeToken = validToken(p.resumeToken)
          ? p.resumeToken
          : validToken(p.token)
            ? p.token
            : undefined;

        if (isBlockedRequester(current, auth?.userId, clientId)) {
          throw new JamError('Você foi bloqueado pelo anfitrião desta JAM.', 403, 'BLOCKED');
        }

        if (
          (resumeToken && current.kickedKeys.has(`tok:${resumeToken}`)) ||
          (clientId && current.kickedKeys.has(`cid:${clientId}`)) ||
          (auth?.userId && current.kickedKeys.has(`uid:${auth.userId}`))
        ) {
          throw new JamError('Você foi removido desta JAM pelo anfitrião.', 403, 'KICKED');
        }

        const existing =
          (resumeToken && current.members.get(resumeToken)) ||
          (auth?.userId && [...current.members.values()].find(m => m.userId === auth.userId)) ||
          (clientId && [...current.members.values()].find(m => m.clientId === clientId)) ||
          undefined;

        if (existing) {
          this.verifyReplay(p, now, action);
          existing.seen = now;
          existing.online = true;
          if (typeof p.name === 'string' && p.name.trim()) existing.name = safeName(p.name);
          const av = sanitizeAvatar(p.avatar);
          if (av) existing.avatar = av;
          await this.persistRoom();
          const bodyView = this.roomView(current, now, p, existing.host);
          this.broadcastRoomState(current, now);
          return new Response(
            JSON.stringify({
              ...bodyView,
              token: existing.token,
              memberId: existing.id,
              host: existing.host,
              ...(existing.clientId ? { clientId: existing.clientId } : {}),
            }),
            { status: 200, headers },
          );
        }

        const recent =
          (resumeToken && current.recentMembers.get(resumeToken)) ||
          (auth?.userId && [...current.recentMembers.values()].find(m => m.userId === auth.userId)) ||
          (clientId && [...current.recentMembers.values()].find(m => m.clientId === clientId)) ||
          undefined;

        if (recent) {
          if (current.members.size >= current.maxParticipants) {
            throw new JamError(
              `Esta JAM já tem ${current.maxParticipants} pessoas.`,
              409,
              'ROOM_FULL',
              previewFromRoom(current, now),
            );
          }
          this.verifyReplay(p, now, action);
          current.recentMembers.delete(recent.token);
          const restored: Member = {
            id: recent.id,
            token: recent.token,
            clientId: clientId || recent.clientId,
            userId: auth?.userId || recent.userId,
            name: typeof p.name === 'string' && p.name.trim() ? safeName(p.name) : recent.name,
            avatar: sanitizeAvatar(p.avatar) || recent.avatar,
            host: recent.host,
            online: true,
            joinedAt: recent.joinedAt,
            seen: now,
          };
          current.members.set(restored.token, restored);
          await this.persistRoom();
          const bodyView = this.roomView(current, now, p, restored.host);
          this.broadcastRoomState(current, now);
          return new Response(
            JSON.stringify({
              ...bodyView,
              token: restored.token,
              memberId: restored.id,
              host: restored.host,
              ...(restored.clientId ? { clientId: restored.clientId } : {}),
            }),
            { status: 200, headers },
          );
        }

        if (action === 'resume') {
          throw new JamError('Sua sessão expirou. Entre novamente.', 401, 'SESSION_EXPIRED');
        }
        if (current.requireApproval) {
          throw new JamError(
            'Esta JAM exige aprovação do anfitrião. Solicite entrada para participar.',
            403,
            'APPROVAL_REQUIRED',
            previewFromRoom(current, now),
          );
        }
        if (current.locked) {
          throw new JamError(
            'Esta JAM está trancada pelo anfitrião.',
            403,
            'ROOM_LOCKED',
            previewFromRoom(current, now),
          );
        }
        if (current.members.size >= current.maxParticipants) {
          throw new JamError(
            `Esta JAM já tem ${current.maxParticipants} pessoas.`,
            409,
            'ROOM_FULL',
            previewFromRoom(current, now),
          );
        }
        this.verifyReplay(p, now, action);
        const guest: Member = {
          id: id(),
          token: id(),
          clientId,
          userId: auth?.userId,
          name: safeName(p.name),
          avatar: sanitizeAvatar(p.avatar),
          host: false,
          online: true,
          joinedAt: now,
          seen: now,
        };
        current.members.set(guest.token, guest);
        await this.persistRoom();
        const bodyView = this.roomView(current, now, p, false);
        this.broadcastRoomState(current, now);
        return new Response(
          JSON.stringify({
            ...bodyView,
            token: guest.token,
            memberId: guest.id,
            host: false,
            ...(guest.clientId ? { clientId: guest.clientId } : {}),
          }),
          { status: 200, headers },
        );
      }

      const member = validToken(p.token) ? current.members.get(p.token) : undefined;
      if (!member) {
        if (typeof p.token === 'string' && current.kickedKeys.has(`tok:${p.token}`)) {
          throw new JamError('Você foi removido desta JAM pelo anfitrião.', 403, 'KICKED');
        }
        throw new JamError('Sua sessão expirou. Entre novamente.', 401, 'SESSION_EXPIRED');
      }
      this.allowMember(current.code, member.id, now);
      member.seen = now;
      member.online = true;
      if (member.host) current.touched = now;

      if (action === 'leave') {
        this.verifyReplay(p, now, action);
        if (member.host) {
          this.broadcast({ closed: true, errorCode: 'ROOM_ENDED', serverTime: now });
          this.closeAll('JAM encerrada.');
          this.tombstone = {
            code: current.code,
            roomId: current.roomId,
            roomName: current.roomName,
            hostName: member.name,
            hostAvatar: current.hostAvatar || member.avatar,
            reason: 'ended',
            createdAt: current.createdAt,
            endedAt: now,
            expiresAt: now + TOMBSTONE_RETENTION_MS,
          };
          this.room = null;
          this.mutationNonces.clear();
          this.volatileNonces.clear();
          this.rates.clear();
        } else {
          current.members.delete(member.token);
          this.closeToken(member.token);
          this.broadcastRoomState(current, now);
        }
        await this.persistRoom();
        return new Response(JSON.stringify({ closed: member.host, serverTime: now }), {
          status: 200,
          headers,
        });
      }

      if (action === 'rotateInvite') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode gerar um novo convite.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        const oldCode = current.code;
        const nextTtl =
          typeof p.inviteTtlMs === 'number' && Number.isFinite(p.inviteTtlMs)
            ? Math.max(60000, Math.min(86400000, Math.round(p.inviteTtlMs)))
            : current.inviteTtlMs;
        current.touched = now;
        current.inviteTtlMs = nextTtl;
        current.inviteExpiresAt = now + nextTtl;

        let newCode = '';
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = generateInviteCode(new Set([oldCode]));
          const snapshot: StoredDoRoom = {
            ...this.serializeRoom(current),
            code: candidate,
          };
          const migrateRes = await this.env.JAM_ROOMS.get(
            this.env.JAM_ROOMS.idFromName(candidate),
          ).fetch(
            new Request('https://jam.internal/__internal/migrate', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Liquid-Internal-Migrate': '1',
              },
              body: JSON.stringify(snapshot),
            }),
          );
          if (migrateRes.ok) {
            newCode = candidate;
            break;
          }
          if (migrateRes.status !== 409) break;
        }
        if (!newCode) {
          throw new JamError('Não foi possível gerar um novo convite agora.', 500);
        }

        current.code = newCode;
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        this.closeAll('Código da JAM atualizado.', 4001);
        this.tombstone = {
          code: oldCode,
          roomId: current.roomId,
          roomName: current.roomName,
          hostName: member.name,
          hostAvatar: current.hostAvatar || member.avatar,
          reason: 'expired',
          createdAt: current.createdAt,
          endedAt: now,
          expiresAt: now + TOMBSTONE_RETENTION_MS,
        };
        this.room = null;
        this.mutationNonces.clear();
        this.volatileNonces.clear();
        this.rates.clear();
        await this.persistRoom();
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'updateRoom') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode alterar as opções da JAM.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        applyRoomUpdate(current, member, p, requireAuthGlobal);
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'approveJoin') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode aprovar participantes.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        handleApproveJoin(current, member, p, now);
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'rejectJoin') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode recusar participantes.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        handleRejectJoin(current, member, p, now);
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'kick') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode remover participantes.', 403, 'FORBIDDEN');
        }
        const targetId = safeMemberId(p.memberId);
        if (!targetId) throw new JamError('Participante inválido.', 400);
        this.verifyReplay(p, now, action);
        const target = [...current.members.values()].find(m => m.id === targetId);
        if (!target) throw new JamError('Participante não encontrado.', 404);
        if (target.host) throw new JamError('Não é possível remover o anfitrião.', 400);
        current.members.delete(target.token);
        current.recentMembers.delete(target.token);
        current.kickedKeys.add(`tok:${target.token}`);
        if (target.clientId) current.kickedKeys.add(`cid:${target.clientId}`);
        if (target.userId) current.kickedKeys.add(`uid:${target.userId}`);
        this.closeToken(target.token, 'Você foi removido desta JAM pelo anfitrião.');
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'blockMember') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode bloquear participantes.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        const target = handleBlockMember(current, member, p, now);
        this.closeToken(target.token, 'Você foi bloqueado nesta JAM pelo anfitrião.');
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'unblockMember') {
        if (!member.host) {
          throw new JamError('Somente o anfitrião pode desbloquear participantes.', 403, 'FORBIDDEN');
        }
        this.verifyReplay(p, now, action);
        handleUnblockMember(current, member, p);
        await this.persistRoom();
        const viewBody = this.roomView(current, now, p, member.host);
        this.broadcastRoomState(current, now, true);
        return new Response(JSON.stringify(viewBody), { status: 200, headers });
      }

      if (action === 'sync') {
        if (!member.host) throw new JamError('Somente quem criou a JAM controla a reprodução.', 403);
        const play = p.playback as Record<string, unknown> | undefined;
        if (
          !play ||
          typeof play !== 'object' ||
          Array.isArray(play) ||
          typeof play.playing !== 'boolean' ||
          typeof play.position !== 'number' ||
          !Number.isFinite(play.position) ||
          play.position < 0 ||
          play.position > 86400
        ) {
          throw new JamError('Reprodução inválida.');
        }
        assertNoUnknownKeys(play, ALLOWED_PLAYBACK_KEYS, 'Playback JAM');
        const song = sanitizeTrack(play.track);
        this.verifyReplay(p, now, action);
        if (song?.id !== current.playback.track?.id) {
          current.skipVotes?.clear();
          current.skipTriggeredAt = 0;
        }
        current.playback = {
          track: song,
          playing: !!song && play.playing,
          position: Math.min(song?.duration || 86400, play.position),
          updatedAt: now,
          sequence: current.playback.sequence + 1,
        };
      } else if (
        ['voteSkip', 'queueAdd', 'queueRemove', 'recommendPlaylist', 'chat'].includes(action)
      ) {
        this.verifyReplay(p, now, action);
        applyJamInteractiveAction(current, member, action, p, now);
      } else if (action === 'poll') {
        this.verifyReplay(p, now, action);
      } else {
        throw new JamError('Operação inválida.');
      }
      const isMutation = action !== 'poll';
      if (isMutation) await this.persistRoom();
      const viewBody = this.roomView(current, now, p, member.host);
      if (isMutation) this.broadcastRoomState(current, now);
      return new Response(JSON.stringify(viewBody), { status: 200, headers });
    } catch (error) {
      const status = error instanceof JamError ? error.status : 500;
      return new Response(
        JSON.stringify({
          error: error instanceof JamError ? error.message : 'Erro interno na JAM.',
          ...(error instanceof JamError && error.errorCode ? { errorCode: error.errorCode } : {}),
          ...(error instanceof JamError && error.preview !== undefined
            ? { preview: error.preview }
            : {}),
        }),
        {
          status,
          headers: { ...headers, ...(status === 429 ? { 'Retry-After': '60' } : {}) },
        },
      );
    }
  }

  async webSocketMessage(
    ws: WebSocket & {
      deserializeAttachment?(): { token: string; code: string; ip?: string };
    },
    raw: string | ArrayBuffer,
  ) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const meta = ws.deserializeAttachment?.();
    if (!meta) return;
    try {
      if (Buffer.byteLength(text, 'utf8') > JAM_BODY_LIMIT) {
        ws.close(1009, 'Mensagem muito grande.');
        return;
      }
      const msg = JSON.parse(text) as Record<string, unknown>;
      const room = await this.loadRoom();
      if (!room?.members.has(meta.token)) {
        ws.close(1008, 'Sessão encerrada.');
        return;
      }
      const response = await this.fetch(
        new Request('https://jam.internal/v1/jam', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Liquid-Client-IP': meta.ip || 'unknown',
          },
          body: JSON.stringify({ ...msg, code: meta.code, token: meta.token }),
        }),
      );
      if (msg.action === 'sync' && response.status === 200) return;
      ws.send(await response.text());
    } catch {
      try {
        ws.close(1008, 'Mensagem inválida.');
      } catch {}
    }
  }

  async webSocketClose(ws?: WebSocket, code = 1000, reason = 'Conexão encerrada.') {
    try {
      const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
      ws?.close(safeCode, reason.slice(0, 120));
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, 'Erro de conexão.');
    } catch {}
  }

  async alarm() {
    await this.loadRoom();
    await this.pruneRoom(this.clock());
    if (this.room) await this.ctx.storage.setAlarm(this.clock() + this.ttl());
  }
}

export async function handleCloudflareJamFetch(request: Request, env: CfJamEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/invite.js' && request.method === 'GET') {
    return new Response(INVITE_SCRIPT, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (url.pathname === '/' && request.method === 'GET') {
    return new Response(INVITE_LANDING_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Service': 'liquid-hub-jam',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    });
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json(
      { service: 'liquid-hub-jam', runtime: 'cloudflare-workers-do', version: 3 },
      { headers: { 'X-Service': 'liquid-hub-jam', 'Cache-Control': 'no-store' } },
    );
  }

  const ip = cfClientAddress(request);
  const now = Date.now();
  try {
    if (isBrokerAuthOrSocialPath(url.pathname)) {
      consumeCfRate(workerRates, `ip:${ip}:auth`, 120, now);
      const headers = new Headers(request.headers);
      headers.set('X-Liquid-Client-IP', ip);
      headers.delete('CF-Connecting-IP');
      headers.delete('Content-Length');
      const body =
        request.method !== 'GET' && request.method !== 'HEAD'
          ? await request.arrayBuffer()
          : undefined;
      const forwarded = new Request(request.url, {
        method: request.method,
        headers,
        redirect: 'manual',
        body,
      });
      return await env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName('__hub_auth_v1__')).fetch(forwarded);
    }

    if (url.pathname.startsWith('/v1/jam/invites/') && request.method === 'GET') {
      consumeCfRate(workerRates, `ip:${ip}:lookup`, 120, now);
      const code = normalizeJamCode(decodeURIComponent(url.pathname.slice('/v1/jam/invites/'.length)));
      if (!code) throw new JamError('Código da JAM inválido.', 400, 'INVITE_INVALID');
      return env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(
        new Request(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Liquid-Client-IP': ip },
          body: JSON.stringify({ action: 'lookup', code }),
        }),
      );
    }

    if ((url.pathname.startsWith('/jam/join/') || url.pathname.startsWith('/join/')) && request.method === 'GET') {
      consumeCfRate(workerRates, `ip:${ip}:lookup`, 120, now);
      const raw = url.pathname.startsWith('/jam/join/')
        ? url.pathname.slice('/jam/join/'.length)
        : url.pathname.slice('/join/'.length);
      const decoded = decodeURIComponent(raw.split('/')[0] || '');
      const code = normalizeJamCode(decoded);
      const nonce = randomBytes(16).toString('base64');
      let preview: JamInvitePreview | null = null;
      let errMessage = 'Código da JAM inválido.';
      let errCode: JamErrorCode | undefined = 'INVITE_INVALID';
      let status = 404;
      if (code) {
        const res = await env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(
          new Request(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Liquid-Client-IP': ip },
            body: JSON.stringify({ action: 'lookup', code }),
          }),
        );
        if (res.ok) {
          preview = (await res.json()) as JamInvitePreview;
          status = 200;
          errMessage = '';
          errCode = undefined;
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: JamErrorCode };
          status = res.status;
          errMessage = body.error || 'Convite indisponível.';
          errCode = body.errorCode;
        }
      }
      const html = renderInviteLandingHtml({
        code: code || decoded.trim().toUpperCase().slice(0, 16) || 'INVÁLIDO',
        origin: url.origin,
        preview,
        errorMessage: errMessage,
        errorCode: errCode,
        downloadUrl: env.JAM_DOWNLOAD_URL,
        nonce,
      });
      return new Response(html, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Service': 'liquid-hub-jam',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        },
      });
    }

    if (url.pathname === '/v1/jam/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        throw new JamError('Upgrade WebSocket obrigatório.', 426);
      }
      if (!isAllowedWsOrigin(request.headers.get('Origin'), url.origin, env)) {
        jamLog('ws_origin_rejected', { status: 403 });
        throw new JamError('Origem WebSocket não autorizada.', 403);
      }
      const code = normalizeJamCode(url.searchParams.get('code') || '');
      if (!code || code.length < 8) throw new JamError('Código da JAM inválido.', 400);
      const token = url.searchParams.get('token') || '';
      if (!validToken(token)) throw new JamError('Sessão WebSocket não autorizada.', 401);
      consumeCfRate(workerRates, `ip:${ip}:ws`, 60, now);
      const headers = new Headers(request.headers);
      headers.set('X-Liquid-Client-IP', ip);
      headers.delete('CF-Connecting-IP');
      const forwarded = new Request(request, { headers });
      return env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(forwarded);
    }

    if (url.pathname === '/v1/jam' && request.method === 'POST') {
      const cloned = await readCfJson(request);
      assertNoUnknownKeys(cloned, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
      const action = String(cloned.action || '');
      const entry = ['create', 'join', 'resume', 'requestJoin'].includes(action);
      const isLookup = ['lookup', 'checkJoinRequest', 'cancelJoinRequest'].includes(action);
      consumeCfRate(
        workerRates,
        `ip:${ip}:${entry ? 'entry' : isLookup ? 'lookup' : 'active'}`,
        entry ? 30 : isLookup ? 120 : 1800,
        now,
      );
      if (action === 'ping' && !cloned.code && !cloned.token) {
        acceptNonce(workerNonces, cloned, now, action, 60000, 2048);
        return Response.json(
          { pong: true, serverTime: now, echoClientTime: cloned.clientTime },
          { headers: { 'X-Service': 'liquid-hub-jam', 'Cache-Control': 'no-store' } },
        );
      }
      const code =
        action === 'create'
          ? normalizeJamCode(String(cloned.preferredCode || '')) || generateInviteCode(new Set())
          : normalizeJamCode(String(cloned.code || ''));
      if (!code) throw new JamError('Código da JAM inválido.', 400, 'INVITE_INVALID');
      const body = JSON.stringify({ ...cloned, code });
      if (Buffer.byteLength(body, 'utf8') > JAM_BODY_LIMIT) {
        throw new JamError('Solicitação muito grande.', 413);
      }

      let reservation: symbol | null = null;
      let roomCreates = workerRoomCreates.get(env.JAM_ROOMS);
      if (!roomCreates) {
        roomCreates = new Map();
        workerRoomCreates.set(env.JAM_ROOMS, roomCreates);
      }
      const releaseCapacity = (owner?: symbol) => {
        const current = roomCreates?.get(code);
        if (current && (!owner || current.reservation === owner)) roomCreates?.delete(code);
      };
      if (action === 'create') {
        const ttl = boundedCfSetting(env.JAM_IDLE_TTL_MS, 900000, 30000, 3600000);
        for (const [key, entry] of roomCreates) {
          if (now - entry.createdAt >= ttl) roomCreates.delete(key);
        }
        const capacity = boundedCfSetting(env.JAM_MAX_ROOMS_PER_ISOLATE, 2500, 1, 10000);
        if (!roomCreates.has(code) && roomCreates.size >= capacity) {
          throw new JamError('As salas estão ocupadas. Tente novamente em instantes.', 503);
        }
        if (!roomCreates.has(code)) {
          reservation = Symbol(code);
          roomCreates.set(code, { reservation, createdAt: now });
        }
      }

      const headers = new Headers(request.headers);
      headers.set('X-Liquid-Client-IP', ip);
      headers.set('Content-Type', 'application/json');
      headers.delete('CF-Connecting-IP');
      headers.delete('Content-Length');
      const forwarded = new Request(request.url, { method: 'POST', headers, body });
      try {
        const response = await env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(forwarded);
        if (reservation && response.status !== 201) releaseCapacity(reservation);
        if (action !== 'create' && action !== 'lookup' && [404, 410].includes(response.status)) releaseCapacity();
        if (action === 'leave' && response.status === 200) {
          const result = (await response.clone().json().catch(() => null)) as {
            closed?: unknown;
          } | null;
          if (result?.closed === true) releaseCapacity();
        }
        if (action === 'rotateInvite' && response.status === 200) {
          const rotated = (await response.clone().json().catch(() => null)) as {
            code?: unknown;
          } | null;
          const nextCode = typeof rotated?.code === 'string' ? normalizeJamCode(rotated.code) : '';
          releaseCapacity();
          if (nextCode) {
            roomCreates.set(nextCode, { reservation: Symbol(nextCode), createdAt: now });
          }
        }
        return response;
      } catch (error) {
        if (reservation) releaseCapacity(reservation);
        throw error;
      }
    }
    return Response.json({ error: 'Não encontrado.' }, { status: 404 });
  } catch (error) {
    return cfError(error);
  }
}

export default {
  fetch: handleCloudflareJamFetch,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8789);
  createJam().listen(port, process.env.JAM_HOST || '127.0.0.1', () =>
    console.log(`Liquid Hub JAM ready on port ${port}`),
  );
}
