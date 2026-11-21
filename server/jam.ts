/**
 * Liquid Hub — High-Capacity Ephemeral JAM Coordinator
 * Dual Runtime:
 *   1. Node.js 24+ HTTP + RFC 6455 WebSocket server (`createJam`) for Oracle Cloud Free Tier / Fly.io / Self-Hosted
 *   2. Cloudflare Workers + Durable Objects with WebSocket Hibernation (`JamRoomDO` & default Worker export)
 * Security & Protocol:
 *   - Millisecond Clock Drift Compensation (`ping` / `pong` + `serverTime` + `echoClientTime`)
 *   - Replay Attack Protection (`nonce` + `timestamp` validation & bounded deduplication cache)
 *   - Delta Heartbeat & Gzip Compression (`sinceSequence` + `Content-Encoding: gzip`)
 *   - Per-IP and Per-Session/User Rate Limiting & Strict Payload Key Validation
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import type { Track } from '../shared/types.ts';
import type { JamMember, JamPlayback } from '../shared/jam.ts';

interface Member extends JamMember {
  token: string;
  seen: number;
}

interface Room {
  code: string;
  members: Map<string, Member>;
  playback: JamPlayback;
  touched: number;
}

interface NodeJamSocket {
  socket: Duplex;
  code: string;
  token: string;
  memberId: string;
  ip: string;
  lastSeen: number;
  draining?: boolean;
}

export class JamError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const id = () => randomBytes(24).toString('base64url');
const safeName = (value: unknown) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Ouvinte'
    : 'Ouvinte';
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(value);

const ALLOWED_REQUEST_KEYS = new Set([
  'action',
  'code',
  'preferredCode',
  'token',
  'name',
  'endpoint',
  'playback',
  'nonce',
  'timestamp',
  'clientTime',
  'sinceSequence',
]);

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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16384) throw new JamError('Solicitação muito grande.', 413);
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
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (!masked) throw new JamError('Frame WebSocket sem máscara.', 400);
  if (opcode >= 0x08 && ((buffer[0] & 0x80) === 0 || len > 125)) {
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
    data[i] = buffer[offset + 4 + i] ^ mask[i & 3];
  }
  return { opcode, payload: data, consumed: offset + 4 + len };
}

/** Ephemeral coordinator: no audio relay, accounts, logs of tokens, or persisted listening history. */
export function createJam(env: NodeJS.ProcessEnv = process.env, clock = Date.now) {
  const rooms = new Map<string, Room>();
  const rates = new Map<string, { until: number; count: number }>();
  const seenNonces = new Map<string, number>();
  const roomSockets = new Map<string, Set<NodeJamSocket>>();
  const allSockets = new Set<NodeJamSocket>();
  const socketIpCounts = new Map<string, number>();
  const socketMemberCounts = new Map<string, number>();
  const roomLimit = Math.max(1, Math.min(10000, Number(env.JAM_MAX_ROOMS) || 1000));
  const ttl = Math.max(30000, Math.min(3600000, Number(env.JAM_IDLE_TTL_MS) || 900000));
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

  function decrementCount(counts: Map<string, number>, key: string) {
    const next = (counts.get(key) || 1) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }

  function trackSocket(managed: NodeJamSocket) {
    allSockets.add(managed);
    let roomSet = roomSockets.get(managed.code);
    if (!roomSet) {
      roomSet = new Set();
      roomSockets.set(managed.code, roomSet);
    }
    roomSet.add(managed);
    socketIpCounts.set(managed.ip, (socketIpCounts.get(managed.ip) || 0) + 1);
    const memberKey = `${managed.code}:${managed.token}`;
    socketMemberCounts.set(memberKey, (socketMemberCounts.get(memberKey) || 0) + 1);
  }

  function untrackSocket(managed: NodeJamSocket) {
    if (!allSockets.delete(managed)) return;
    const roomSet = roomSockets.get(managed.code);
    roomSet?.delete(managed);
    if (roomSet?.size === 0) roomSockets.delete(managed.code);
    decrementCount(socketIpCounts, managed.ip);
    decrementCount(socketMemberCounts, `${managed.code}:${managed.token}`);
  }

  function closeSocket(managed: NodeJamSocket) {
    untrackSocket(managed);
    if (!managed.socket.destroyed) managed.socket.destroy();
  }

  function closeMemberSockets(code: string, token: string) {
    for (const managed of [...(roomSockets.get(code) || [])]) {
      if (managed.token === token) closeSocket(managed);
    }
  }

  function closeRoomSockets(code: string) {
    for (const managed of [...(roomSockets.get(code) || [])]) closeSocket(managed);
  }

  function sendSocket(managed: NodeJamSocket, frame: Buffer) {
    const member = rooms.get(managed.code)?.members.get(managed.token);
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

  function prune(now: number) {
    for (const [code, room] of rooms) {
      for (const [token, member] of room.members) {
        if (!member.host && now - member.seen > 35000) {
          room.members.delete(token);
          closeMemberSockets(code, token);
        }
      }
      if (now - room.touched > ttl) {
        rooms.delete(code);
        closeRoomSockets(code);
      }
    }
    for (const [ip, rate] of rates) if (rate.until <= now) rates.delete(ip);
    for (const [nonce, until] of seenNonces) if (until <= now) seenNonces.delete(nonce);
  }

  function consumeRate(bucket: string, limit: number, now: number) {
    let rate = rates.get(bucket);
    if (!rate || rate.until <= now) {
      if (rates.size >= 8192 && !rate) throw new JamError('Serviço ocupado.', 503);
      rate = { until: now + 60000, count: 0 };
      rates.set(bucket, rate);
    }
    if (++rate.count > limit) {
      throw new JamError('Muitas tentativas. Aguarde um minuto.', 429);
    }
  }

  function allow(ipAddr: string, action: string, now: number) {
    const isEntry = ['create', 'join'].includes(action);
    consumeRate(`ip:${ipAddr}:${isEntry ? 'entry' : 'active'}`, isEntry ? entryLimit : activeLimit, now);
  }

  function allowMember(code: string, memberId: string, now: number) {
    consumeRate(`mbr:${code}:${memberId}:active`, activeLimit, now);
    consumeRate(`room:${code}:active`, roomActiveLimit, now);
  }

  function verifyReplayProtection(p: Record<string, unknown>, now: number, action: string) {
    const hasNonce = p.nonce !== undefined;
    const hasTs = p.timestamp !== undefined;
    if (!hasNonce && !hasTs) {
      if (strictReplay && ['create', 'join', 'sync', 'leave'].includes(action)) {
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

  function view(room: Room, now: number, p?: Record<string, unknown>) {
    const unchanged =
      p?.action === 'poll' &&
      typeof p.sinceSequence === 'number' &&
      p.sinceSequence === room.playback.sequence;
    return {
      code: room.code,
      members: [...room.members.values()].map(({ id: mid, name, host }) => ({
        id: mid,
        name,
        host,
      })),
      playback: unchanged
        ? { ...room.playback, track: room.playback.track }
        : room.playback,
      unchanged: unchanged || undefined,
      serverTime: now,
      ...(typeof p?.clientTime === 'number' && Number.isFinite(p.clientTime)
        ? { echoClientTime: p.clientTime }
        : {}),
    };
  }

  function session(room: Room, member: Member, now: number, p?: Record<string, unknown>) {
    return {
      ...view(room, now, p),
      token: member.token,
      memberId: member.id,
      host: member.host,
    };
  }

  function broadcastRoom(code: string, payload: unknown) {
    const sockets = roomSockets.get(code);
    if (!sockets?.size) return;
    const frame = encodeWsTextFrame(JSON.stringify(payload));
    for (const managed of [...sockets]) {
      if (!rooms.get(code)?.members.has(managed.token)) closeSocket(managed);
      else sendSocket(managed, frame);
    }
  }

  function executeCommand(p: Record<string, unknown>, ipAddr: string): { status: number; body: unknown } {
    assertNoUnknownKeys(p, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
    const now = clock();
    const action = String(p.action || '');
    prune(now);
    allow(ipAddr, action, now);

    if (action === 'ping') {
      if (typeof p.code === 'string' && validToken(p.token)) {
        const pingRoom = rooms.get(p.code);
        const pingMember = pingRoom?.members.get(p.token);
        if (pingMember) {
          pingMember.seen = now;
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

    if (action === 'create') {
      if (rooms.size >= roomLimit) {
        throw new JamError('As salas estão ocupadas. Tente novamente em instantes.', 503);
      }
      verifyReplayProtection(p, now, action);
      let code: string;
      if (
        typeof p.preferredCode === 'string' &&
        /^[A-F0-9]{10}$/.test(p.preferredCode) &&
        !rooms.has(p.preferredCode)
      ) {
        code = p.preferredCode;
      } else {
        do {
          code = randomBytes(5).toString('hex').toUpperCase();
        } while (rooms.has(code));
      }
      const member: Member = { id: id(), token: id(), name: safeName(p.name), host: true, seen: now };
      const room: Room = {
        code,
        members: new Map([[member.token, member]]),
        playback: { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 },
        touched: now,
      };
      rooms.set(code, room);
      return { status: 201, body: session(room, member, now, p) };
    }

    if (typeof p.code !== 'string' || !/^[A-F0-9]{10}$/.test(p.code)) {
      throw new JamError('Código da JAM inválido.');
    }
    const room = rooms.get(p.code);
    if (!room) throw new JamError('Esta JAM foi encerrada ou expirou.', 410);

    if (action === 'join') {
      consumeRate(`room:${room.code}:entry`, roomEntryLimit, now);
      if (room.members.size >= 8) throw new JamError('Esta JAM já tem 8 pessoas.', 409);
      verifyReplayProtection(p, now, action);
      const member: Member = {
        id: id(),
        token: id(),
        name: safeName(p.name),
        host: false,
        seen: now,
      };
      room.members.set(member.token, member);
      const resp = session(room, member, now, p);
      broadcastRoom(room.code, view(room, now));
      return { status: 200, body: resp };
    }

    if (!validToken(p.token)) throw new JamError('Sessão da JAM inválida.', 401);
    const member = room.members.get(p.token);
    if (!member) throw new JamError('Sua sessão expirou. Entre novamente.', 401);
    allowMember(room.code, member.id, now);
    member.seen = now;
    if (member.host) room.touched = now;

    if (action === 'leave') {
      verifyReplayProtection(p, now, action);
      if (member.host) {
        broadcastRoom(room.code, { closed: true, serverTime: now });
        rooms.delete(room.code);
        closeRoomSockets(room.code);
      } else {
        room.members.delete(p.token);
        closeMemberSockets(room.code, p.token);
        broadcastRoom(room.code, view(room, now));
      }
      return { status: 200, body: { closed: member.host, serverTime: now } };
    }

    if (action === 'sync') {
      if (!member.host) {
        throw new JamError('Somente quem criou a JAM controla a reprodução.', 403);
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
      room.playback = {
        track: song,
        playing: !!song && play.playing,
        position: Math.min(song?.duration || 86400, play.position),
        updatedAt: now,
        sequence: room.playback.sequence + 1,
      };
      const nextView = view(room, now, p);
      broadcastRoom(room.code, nextView);
      return { status: 200, body: nextView };
    }

    if (action !== 'poll') throw new JamError('Operação inválida.');
    verifyReplayProtection(p, now, action);
    return { status: 200, body: view(room, now, p) };
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Service', 'liquid-hub-jam');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const send = (status: number, value: unknown) => {
      if (res.destroyed) return;
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
      if (req.url === '/health' && req.method === 'GET') {
        send(200, { service: 'liquid-hub-jam', version: 2, activeRooms: rooms.size });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new JamError('Método não permitido.', 405);
      }
      if (req.url !== '/v1/jam') throw new JamError('Não encontrado.', 404);
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        throw new JamError('Envie JSON.', 415);
      }
      const p = await readBody(req);
      const ipAddr = address(req);
      const result = executeCommand(p, ipAddr);
      send(result.status, result.body);
    } catch (error) {
      send(error instanceof JamError ? error.status : 500, {
        error:
          error instanceof JamError
            ? error.message
            : 'Não foi possível concluir a operação.',
      });
    }
  });

  // Real-time WebSocket endpoint (/v1/jam/ws?code=XXXXXXXXXX&token=...)
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
      const code = url.searchParams.get('code') || '';
      const token = url.searchParams.get('token') || '';
      const room = rooms.get(code);
      const member = room && validToken(token) ? room.members.get(token) : undefined;
      if (!room || !member) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const ipAddr = address(req);
      const memberKey = `${code}:${token}`;
      if (
        allSockets.size >= wsGlobalLimit ||
        (socketIpCounts.get(ipAddr) || 0) >= wsIpLimit ||
        (socketMemberCounts.get(memberKey) || 0) >= wsMemberLimit ||
        (roomSockets.get(code)?.size || 0) >= wsRoomLimit
      ) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
        socket.destroy();
        return;
      }
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
        code,
        token,
        memberId: member.id,
        ip: ipAddr,
        lastSeen: clock(),
      };
      trackSocket(managed);
      sendSocket(managed, encodeWsTextFrame(JSON.stringify(view(room, clock()))));

      let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        managed.lastSeen = clock();
        const activeRoom = rooms.get(code);
        const activeMember = activeRoom?.members.get(token);
        if (!activeMember) {
          closeSocket(managed);
          return;
        }
        activeMember.seen = managed.lastSeen;
        if (activeMember.host && activeRoom) activeRoom.touched = managed.lastSeen;
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
              const res = executeCommand({ ...msg, code, token }, ipAddr);
              sendSocket(managed, encodeWsTextFrame(JSON.stringify(res.body)));
            }
          }
        } catch (err) {
          sendSocket(
            managed,
            encodeWsTextFrame(
              JSON.stringify({ error: err instanceof JamError ? err.message : 'Frame inválido.' }),
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

  const heartbeat = setInterval(() => {
    const now = clock();
    prune(now);
    for (const managed of [...allSockets]) {
      if (now - managed.lastSeen > wsTimeoutMs) closeSocket(managed);
      else sendSocket(managed, Buffer.from([0x89, 0]));
    }
  }, wsHeartbeatMs);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const managed of [...allSockets]) closeSocket(managed);
  });

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
}

const JAM_BODY_LIMIT = 16384;
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
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
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
    if (['create', 'join', 'sync', 'leave'].includes(action)) {
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
  if (++rate.count > limit) throw new JamError('Muitas tentativas. Aguarde um minuto.', 429);
}

function cfClientAddress(request: Request) {
  const value = request.headers.get('CF-Connecting-IP')?.trim() || '';
  return isIP(value) ? value : 'unknown';
}

function cfError(error: unknown) {
  const status = error instanceof JamError ? error.status : 500;
  return Response.json(
    { error: error instanceof JamError ? error.message : 'Erro interno na JAM.' },
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

export class JamRoomDO {
  private room: Room | null = null;
  private mutationNonces = new Map<string, number>();
  private volatileNonces = new Map<string, number>();
  private rates = new Map<string, { until: number; count: number }>();

  constructor(
    private readonly ctx: CfDurableObjectState,
    private readonly env: CfJamEnv,
    private readonly clock: () => number = Date.now,
  ) {
    const AutoPair = (globalThis as Record<string, any>).WebSocketRequestResponsePair;
    if (AutoPair && this.ctx.setWebSocketAutoResponse) {
      // Responds to lightweight pings while keeping the Durable Object hibernated!
      this.ctx.setWebSocketAutoResponse(new AutoPair('{"action":"ping"}', '{"pong":true}'));
    }
  }

  private async loadRoom(): Promise<Room | null> {
    if (this.room) return this.room;
    const saved = await this.ctx.storage.get<{
      code: string;
      members: [string, Member][];
      playback: JamPlayback;
      touched: number;
      nonces?: [string, number][];
    }>('room');
    if (saved) {
      this.room = {
        code: saved.code,
        members: new Map(saved.members),
        playback: saved.playback,
        touched: saved.touched,
      };
      this.mutationNonces = new Map(saved.nonces || []);
    }
    return this.room;
  }

  private ttl() {
    return boundedCfSetting(this.env.JAM_IDLE_TTL_MS, 900000, 30000, 3600000);
  }

  private async persistRoom() {
    const room = this.room;
    if (!room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put('room', {
      code: room.code,
      members: [...room.members.entries()],
      playback: room.playback,
      touched: room.touched,
      nonces: [...this.mutationNonces.entries()],
    });
    await this.ctx.storage.setAlarm(this.clock() + this.ttl());
  }

  private verifyReplay(p: Record<string, unknown>, now: number, action: string) {
    const persistent = ['create', 'join', 'sync', 'leave'].includes(action);
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
    const entry = ['create', 'join'].includes(action);
    consumeCfRate(
      this.rates,
      `ip:${ip}:${entry ? 'entry' : 'active'}`,
      boundedCfSetting(
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

  private closeAll(reason: string) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, reason);
      } catch {}
    }
  }

  private async pruneRoom(now: number) {
    if (!this.room) return;
    let changed = false;
    for (const [token, member] of this.room.members) {
      // Auto-responded pings keep a hibernated socket alive without waking this DO;
      // only a real recent auto-response counts as activity, not mere socket existence.
      for (const ws of this.ctx.getWebSockets(token)) {
        const at = this.ctx.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
        if (at > member.seen) member.seen = Math.min(at, now);
      }
      if (member.host && member.seen > this.room.touched) this.room.touched = member.seen;
      if (!member.host && now - member.seen > 35000) {
        this.room.members.delete(token);
        this.closeToken(token, 'Sessão expirada.');
        changed = true;
      }
    }
    if (now - this.room.touched > this.ttl()) {
      this.closeAll('JAM expirada.');
      this.room = null;
      this.mutationNonces.clear();
      this.volatileNonces.clear();
      this.rates.clear();
      await this.ctx.storage.deleteAll();
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
      if (action === 'create') {
        // No await between this check and the reservation closes the DO interleaving race.
        if (this.room) throw new JamError('Esta JAM já foi criada.', 409);
        this.verifyReplay(p, now, action);
        const code = String(p.code || randomBytes(5).toString('hex').toUpperCase());
        if (!/^[A-F0-9]{10}$/.test(code)) throw new JamError('Código da JAM inválido.');
        const host: Member = { id: id(), token: id(), name: safeName(p.name), host: true, seen: now };
        this.room = {
          code,
          members: new Map([[host.token, host]]),
          playback: { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 },
          touched: now,
        };
        const created = this.room;
        await this.persistRoom();
        return new Response(
          JSON.stringify({
            code,
            members: [{ id: host.id, name: host.name, host: true }],
            playback: created.playback,
            serverTime: now,
            token: host.token,
            memberId: host.id,
            host: true,
          }),
          { status: 201, headers },
        );
      }
      if (!this.room) throw new JamError('Esta JAM foi encerrada ou expirou.', 410);
      const current = this.room;

      if (action === 'join') {
        consumeCfRate(
          this.rates,
          `room:${current.code}:entry`,
          boundedCfSetting(this.env.JAM_ROOM_ENTRY_REQUESTS_PER_MINUTE, 120, 8, 600),
          now,
        );
        if (current.members.size >= 8) throw new JamError('Esta JAM já tem 8 pessoas.', 409);
        this.verifyReplay(p, now, action);
        const guest: Member = {
          id: id(),
          token: id(),
          name: safeName(p.name),
          host: false,
          seen: now,
        };
        current.members.set(guest.token, guest);
        await this.persistRoom();
        const members = [...current.members.values()].map(member => ({
          id: member.id,
          name: member.name,
          host: member.host,
        }));
        this.broadcast({
          code: current.code,
          members,
          playback: current.playback,
          serverTime: now,
        });
        return new Response(
          JSON.stringify({
            code: current.code,
            members,
            playback: current.playback,
            serverTime: now,
            token: guest.token,
            memberId: guest.id,
            host: false,
          }),
          { status: 200, headers },
        );
      }

      const member = validToken(p.token) ? current.members.get(p.token) : undefined;
      if (!member) throw new JamError('Sua sessão expirou. Entre novamente.', 401);
      this.allowMember(current.code, member.id, now);
      member.seen = now;
      if (member.host) current.touched = now;

      if (action === 'leave') {
        this.verifyReplay(p, now, action);
        if (member.host) {
          this.broadcast({ closed: true, serverTime: now });
          this.closeAll('JAM encerrada.');
          this.room = null;
          this.mutationNonces.clear();
      this.volatileNonces.clear();
          this.rates.clear();
        } else {
          current.members.delete(member.token);
          this.closeToken(member.token);
          this.broadcast({
            code: current.code,
            members: [...current.members.values()].map(({ id, name, host }) => ({ id, name, host })),
            playback: current.playback,
            serverTime: now,
          });
        }
        await this.persistRoom();
        return new Response(JSON.stringify({ closed: member.host, serverTime: now }), {
          status: 200,
          headers,
        });
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
        current.playback = {
          track: song,
          playing: !!song && play.playing,
          position: Math.min(song?.duration || 86400, play.position),
          updatedAt: now,
          sequence: current.playback.sequence + 1,
        };
      } else if (action === 'poll') {
        this.verifyReplay(p, now, action);
      } else {
        throw new JamError('Operação inválida.');
      }
      if (action === 'sync') await this.persistRoom();
      const viewBody = {
        code: current.code,
        members: [...current.members.values()].map(({ id, name, host }) => ({ id, name, host })),
        playback: current.playback,
        serverTime: now,
      };
      if (action === 'sync') this.broadcast(viewBody);
      return new Response(JSON.stringify(viewBody), { status: 200, headers });
    } catch (error) {
      const status = error instanceof JamError ? error.status : 500;
      return new Response(
        JSON.stringify({ error: error instanceof JamError ? error.message : 'Erro interno na JAM.' }),
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
      ws.send(await response.text());
    } catch {
      try {
        ws.close(1008, 'Mensagem inválida.');
      } catch {}
    }
  }

  async webSocketClose() {
    // Hibernated socket closed cleanly; member expiry handled by seen TTL / explicit leave.
  }

  async alarm() {
    await this.loadRoom();
    await this.pruneRoom(this.clock());
    if (this.room) await this.ctx.storage.setAlarm(this.clock() + this.ttl());
  }
}

export async function handleCloudflareJamFetch(request: Request, env: CfJamEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json(
      { service: 'liquid-hub-jam', runtime: 'cloudflare-workers-do', version: 2 },
      { headers: { 'X-Service': 'liquid-hub-jam', 'Cache-Control': 'no-store' } },
    );
  }

  const ip = cfClientAddress(request);
  const now = Date.now();
  try {
    if (url.pathname === '/v1/jam/ws') {
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-F0-9]{10}$/.test(code)) throw new JamError('Código da JAM inválido.', 400);
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
      const entry = ['create', 'join'].includes(action);
      consumeCfRate(workerRates, `ip:${ip}:${entry ? 'entry' : 'active'}`, entry ? 30 : 1800, now);
      if (action === 'ping' && !cloned.code && !cloned.token) {
        acceptNonce(workerNonces, cloned, now, action, 60000, 2048);
        return Response.json(
          { pong: true, serverTime: now, echoClientTime: cloned.clientTime },
          { headers: { 'X-Service': 'liquid-hub-jam', 'Cache-Control': 'no-store' } },
        );
      }
      const code =
        action === 'create'
          ? typeof cloned.preferredCode === 'string' && /^[A-F0-9]{10}$/.test(cloned.preferredCode)
            ? cloned.preferredCode
            : randomBytes(5).toString('hex').toUpperCase()
          : String(cloned.code || '');
      if (!/^[A-F0-9]{10}$/.test(code)) throw new JamError('Código da JAM inválido.', 400);
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
        // Room no longer exists (e.g. expired by alarm): free its slot.
        if (action !== 'create' && [404, 410].includes(response.status)) releaseCapacity();
        if (action === 'leave' && response.status === 200) {
          const result = (await response.clone().json().catch(() => null)) as {
            closed?: unknown;
          } | null;
          if (result?.closed === true) releaseCapacity();
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
