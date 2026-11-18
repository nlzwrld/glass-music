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
  const roomSockets = new Map<string, Set<Duplex>>();
  const roomLimit = Math.max(1, Math.min(10000, Number(env.JAM_MAX_ROOMS) || 1000));
  const ttl = Math.max(30000, Math.min(3600000, Number(env.JAM_IDLE_TTL_MS) || 900000));
  const replayWindowMs = Math.max(
    10000,
    Math.min(300000, Number(env.JAM_REPLAY_WINDOW_MS) || 60000),
  );
  const strictReplay = env.JAM_STRICT_REPLAY === '1';

  function prune(now: number) {
    for (const [code, room] of rooms) {
      for (const [token, member] of room.members) {
        if (!member.host && now - member.seen > 35000) room.members.delete(token);
      }
      if (now - room.touched > ttl) {
        rooms.delete(code);
        const sockets = roomSockets.get(code);
        if (sockets) {
          for (const s of sockets) s.destroy();
          roomSockets.delete(code);
        }
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

  function allow(ipAddr: string, action: string, now: number, memberId?: string) {
    const isEntry = ['create', 'join'].includes(action);
    const maxCount = isEntry ? 30 : 1800;
    consumeRate(`ip:${ipAddr}:${isEntry ? 'entry' : 'active'}`, maxCount, now);
    if (memberId) {
      consumeRate(`mbr:${memberId}:active`, 1800, now);
    }
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
    for (const sock of sockets) {
      if (!sock.destroyed) sock.write(frame);
    }
  }

  function executeCommand(p: Record<string, unknown>, ipAddr: string): { status: number; body: unknown } {
    assertNoUnknownKeys(p, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
    const now = clock();
    const action = String(p.action || '');
    prune(now);
    allow(ipAddr, action, now);

    if (action === 'ping') {
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
    allow(ipAddr, action, now, member.id);
    member.seen = now;
    if (member.host) room.touched = now;

    if (action === 'leave') {
      verifyReplayProtection(p, now, action);
      if (member.host) {
        rooms.delete(room.code);
        broadcastRoom(room.code, { closed: true, serverTime: now });
        const sockets = roomSockets.get(room.code);
        if (sockets) {
          for (const s of sockets) s.destroy();
          roomSockets.delete(room.code);
        }
      } else {
        room.members.delete(p.token);
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
      const ipAddr = req.socket.remoteAddress || 'unknown';
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
      if (!room || !validToken(token) || !room.members.has(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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

      let set = roomSockets.get(code);
      if (!set) {
        set = new Set();
        roomSockets.set(code, set);
      }
      set.add(socket);
      socket.write(encodeWsTextFrame(JSON.stringify(view(room, clock()))));

      let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
      const ipAddr = req.socket.remoteAddress || 'unknown';

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 32768) {
          socket.destroy();
          return;
        }
        try {
          while (true) {
            const frame = decodeWsClientFrame(buffer);
            if (!frame) break;
            buffer = buffer.subarray(frame.consumed);
            if (frame.opcode === 0x08) {
              socket.end();
              return;
            }
            if (frame.opcode === 0x09) {
              // Respond with WS Pong (0x8A)
              socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]));
              continue;
            }
            if (frame.opcode === 0x01) {
              const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
              const res = executeCommand({ ...msg, code, token }, ipAddr);
              socket.write(encodeWsTextFrame(JSON.stringify(res.body)));
            }
          }
        } catch (err) {
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({
                error: err instanceof JamError ? err.message : 'Frame inválido.',
              }),
            ),
          );
        }
      });

      const cleanupSocket = () => {
        const current = roomSockets.get(code);
        current?.delete(socket);
        if (current && current.size === 0) roomSockets.delete(code);
      };
      socket.on('close', cleanupSocket);
      socket.on('error', cleanupSocket);
    } catch {
      socket.destroy();
    }
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
}

export interface CfJamEnv {
  JAM_ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  JAM_IDLE_TTL_MS?: string;
}

export class JamRoomDO {
  private room: Room | null = null;
  private nonces = new Map<string, number>();

  constructor(
    private readonly ctx: CfDurableObjectState,
    private readonly env: CfJamEnv,
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
    }>('room');
    if (saved) {
      this.room = {
        code: saved.code,
        members: new Map(saved.members),
        playback: saved.playback,
        touched: saved.touched,
      };
    }
    return this.room;
  }

  private async persistRoom() {
    if (!this.room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const ttl = Math.max(30000, Math.min(3600000, Number(this.env.JAM_IDLE_TTL_MS) || 900000));
    await this.ctx.storage.put('room', {
      code: this.room.code,
      members: [...this.room.members.entries()],
      playback: this.room.playback,
      touched: this.room.touched,
    });
    await this.ctx.storage.setAlarm(Date.now() + ttl);
  }

  private broadcast(payload: unknown) {
    const raw = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(raw);
      } catch {}
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const room = await this.loadRoom();

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const token = url.searchParams.get('token') || '';
      if (!room || !room.members.has(token)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const PairCtor = (globalThis as Record<string, any>).WebSocketPair;
      const pair = new PairCtor();
      const [client, server] = [pair[0] as WebSocket, pair[1] as WebSocket & { serializeAttachment?(v: unknown): void }];
      server.serializeAttachment?.({ token, code: room.code });
      this.ctx.acceptWebSocket(server, [token]);
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
      const p = (await request.json()) as Record<string, unknown>;
      assertNoUnknownKeys(p, ALLOWED_REQUEST_KEYS, 'Solicitação JAM');
      if (typeof p.nonce === 'string') {
        if (this.nonces.has(p.nonce)) throw new JamError('Replay detectado.', 409);
        this.nonces.set(p.nonce, now + 120000);
      }
      if (p.action === 'ping') {
        return new Response(
          JSON.stringify({ pong: true, serverTime: now, echoClientTime: p.clientTime }),
          { status: 200, headers },
        );
      }
      if (p.action === 'create') {
        const code = String(p.code || randomBytes(5).toString('hex').toUpperCase());
        const host: Member = { id: id(), token: id(), name: safeName(p.name), host: true, seen: now };
        this.room = {
          code,
          members: new Map([[host.token, host]]),
          playback: { track: null, playing: false, position: 0, updatedAt: now, sequence: 0 },
          touched: now,
        };
        await this.persistRoom();
        return new Response(
          JSON.stringify({
            code,
            members: [{ id: host.id, name: host.name, host: true }],
            playback: this.room.playback,
            serverTime: now,
            token: host.token,
            memberId: host.id,
            host: true,
          }),
          { status: 201, headers },
        );
      }
      if (!this.room) throw new JamError('Esta JAM foi encerrada ou expirou.', 410);

      for (const [tok, mbr] of this.room.members) {
        if (!mbr.host && now - mbr.seen > 35000) this.room.members.delete(tok);
      }

      if (p.action === 'join') {
        if (this.room.members.size >= 8) throw new JamError('Esta JAM já tem 8 pessoas.', 409);
        const guest: Member = { id: id(), token: id(), name: safeName(p.name), host: false, seen: now };
        this.room.members.set(guest.token, guest);
        await this.persistRoom();
        const members = [...this.room.members.values()].map(m => ({ id: m.id, name: m.name, host: m.host }));
        this.broadcast({ code: this.room.code, members, playback: this.room.playback, serverTime: now });
        return new Response(
          JSON.stringify({
            code: this.room.code,
            members,
            playback: this.room.playback,
            serverTime: now,
            token: guest.token,
            memberId: guest.id,
            host: false,
          }),
          { status: 200, headers },
        );
      }

      const member = validToken(p.token) ? this.room.members.get(p.token) : undefined;
      if (!member) throw new JamError('Sua sessão expirou. Entre novamente.', 401);
      member.seen = now;
      if (member.host) this.room.touched = now;

      if (p.action === 'leave') {
        if (member.host) {
          this.broadcast({ closed: true, serverTime: now });
          this.room = null;
        } else {
          this.room.members.delete(member.token);
        }
        await this.persistRoom();
        return new Response(JSON.stringify({ closed: member.host, serverTime: now }), {
          status: 200,
          headers,
        });
      }

      if (p.action === 'sync') {
        if (!member.host) throw new JamError('Somente quem criou a JAM controla a reprodução.', 403);
        const play = p.playback as Record<string, unknown>;
        const song = sanitizeTrack(play?.track);
        this.room.playback = {
          track: song,
          playing: !!song && Boolean(play?.playing),
          position: Math.min(song?.duration || 86400, Math.max(0, Number(play?.position || 0))),
          updatedAt: now,
          sequence: this.room.playback.sequence + 1,
        };
      }
      await this.persistRoom();
      const viewBody = {
        code: this.room.code,
        members: [...this.room.members.values()].map(m => ({ id: m.id, name: m.name, host: m.host })),
        playback: this.room.playback,
        serverTime: now,
      };
      if (p.action === 'sync') this.broadcast(viewBody);
      return new Response(JSON.stringify(viewBody), { status: 200, headers });
    } catch (e) {
      const status = e instanceof JamError ? e.status : 500;
      return new Response(
        JSON.stringify({ error: e instanceof JamError ? e.message : 'Erro interno na JAM.' }),
        { status, headers },
      );
    }
  }

  async webSocketMessage(ws: WebSocket & { deserializeAttachment?(): { token: string } }, raw: string | ArrayBuffer) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const meta = ws.deserializeAttachment?.();
    if (!meta) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    const res = await this.fetch(
      new Request('https://jam.internal/v1/jam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...msg, token: meta.token }),
      }),
    );
    ws.send(await res.text());
  }

  async webSocketClose() {
    // Hibernated socket closed cleanly; member expiry handled by seen TTL / explicit leave.
  }

  async alarm() {
    const room = await this.loadRoom();
    const ttl = Math.max(30000, Math.min(3600000, Number(this.env.JAM_IDLE_TTL_MS) || 900000));
    if (room && Date.now() - room.touched > ttl) {
      this.room = null;
      await this.ctx.storage.deleteAll();
    }
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
  if (url.pathname === '/v1/jam/ws') {
    const code = (url.searchParams.get('code') || '').toUpperCase();
    if (!/^[A-F0-9]{10}$/.test(code)) return new Response('Invalid room code', { status: 400 });
    return env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(request);
  }
  if (url.pathname === '/v1/jam' && request.method === 'POST') {
    const cloned = (await request.clone().json()) as Record<string, unknown>;
    if (cloned.action === 'ping') {
      return Response.json(
        { pong: true, serverTime: Date.now(), echoClientTime: cloned.clientTime },
        { headers: { 'X-Service': 'liquid-hub-jam', 'Cache-Control': 'no-store' } },
      );
    }
    const code =
      cloned.action === 'create'
        ? typeof cloned.preferredCode === 'string' && /^[A-F0-9]{10}$/.test(cloned.preferredCode)
          ? cloned.preferredCode
          : randomBytes(5).toString('hex').toUpperCase()
        : String(cloned.code || '');
    if (!/^[A-F0-9]{10}$/.test(code)) {
      return Response.json({ error: 'Código da JAM inválido.' }, { status: 400 });
    }
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ ...cloned, code }),
    });
    return env.JAM_ROOMS.get(env.JAM_ROOMS.idFromName(code)).fetch(forwarded);
  }
  return Response.json({ error: 'Não encontrado.' }, { status: 404 });
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
