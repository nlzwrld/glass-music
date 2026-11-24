import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createJam,
  handleCloudflareJamFetch,
  JamRoomDO,
  type CfDurableObjectState,
  type CfJamEnv,
} from '../../server/jam';
import {
  buildDiscordShareText,
  buildJamDeepLink,
  buildJamInvite,
  buildJamInviteUrl,
  buildWhatsAppShareUrl,
  computeBackoffMs,
  JamClient,
  JamClock,
  parseJamInvite,
  type JamSend,
} from '../../src/lib/jam';
import {
  canJam,
  jamDriftMs,
  jamPosition,
  normalizeJamCode,
  type JamInviteLookupResult,
  type JamInvitePreview,
  type JamRoom,
  type JamSession,
} from '../../shared/jam';
import type { Track } from '../../shared/types';

describe('JAM invite links', () => {
  it('preserves the room and LAN endpoint in shared and app links', () => {
    const expected = { code: 'ABC1234567', endpoint: 'http://192.168.1.5:1234' };
    expect(parseJamInvite(buildJamInvite(expected.endpoint, expected.code))).toEqual(expected);
    expect(parseJamInvite('liquidhub://join?code=ABC1234567&endpoint=http%3A%2F%2F192.168.1.5%3A1234')).toEqual(expected);
    expect(parseJamInvite('https://jam.example/#jam=ABC1234567')).toEqual({ code: expected.code, endpoint: 'https://jam.example' });
  });
  it('rejects malformed app links and endpoints', () => {
    expect(parseJamInvite('liquidhub://other?code=ABC1234567&endpoint=https%3A%2F%2Fjam.example').code).toBe('');
    expect(parseJamInvite('liquidhub://join?code=ABC1234567&endpoint=javascript%3Aalert(1)').code).toBe('');
  });
});

const song: Track = {
  id: 'youtube:M7lc1UVf-VE',
  source: 'youtube',
  sourceId: 'M7lc1UVf-VE',
  kind: 'track',
  title: 'Teste sincronizado',
  artist: 'Liquid Hub',
  duration: 180,
  url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  addedAt: 0,
};

// A late heartbeat pong can refresh lastSeen to the already-advanced fake clock; re-advance until the stale socket is reaped.
async function advanceUntilClosed(clock: { now: number }, ws: WebSocket, step: number) {
  for (let i = 0; i < 25 && ws.readyState !== WebSocket.CLOSED; i++) {
    clock.now += step;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await nodeWebSocketClosed(ws);
}

async function withServer(
  run: (
    send: JamSend,
    raw: (body: unknown, headers?: Record<string, string>) => Promise<Response>,
    clock: { now: number },
    context: { port: number },
  ) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const clock = { now: Date.now() },
    server = createJam(env, () => clock.now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/jam`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const send: JamSend = async <T>(body: unknown) => {
    const response = await raw(body),
      value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value as T;
  };
  try {
    await run(send, raw, clock, { port });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function openNodeWebSocket(port: number, code: string, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/jam/ws?code=${code}&token=${token}`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 2000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket rejected'));
      },
      { once: true },
    );
  });
  return ws;
}

function nodeWebSocketClosed(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket close timeout')), 2000);
    ws.addEventListener(
      'close',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function closeNodeWebSocket(ws: WebSocket) {
  const closed = nodeWebSocketClosed(ws);
  ws.close();
  await closed;
}

class MockCloudflareWebSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  private attachment: { token: string; code: string; ip?: string } | undefined;

  send(value: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('Socket closed');
    this.sent.push(value);
  }

  close(code = 1000, reason = '') {
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
  }

  serializeAttachment(value: { token: string; code: string; ip?: string }) {
    this.attachment = value;
  }

  deserializeAttachment() {
    return this.attachment;
  }
}

let workerNonceSequence = 0;
let cloudSimulatorSequence = 0;
function workerJamRequest(
  body: Record<string, unknown>,
  contentType = 'application/json',
  automaticReplayFields = true,
) {
  const needsReplay = ['create', 'join', 'sync', 'leave'].includes(String(body.action || ''));
  const payload =
    automaticReplayFields && needsReplay && body.nonce === undefined
      ? {
          ...body,
          nonce: `worker_test_nonce_${++workerNonceSequence}`,
          timestamp: body.timestamp ?? Date.now(),
        }
      : body;
  return new Request('https://jam.test/v1/jam', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(payload),
  });
}

function createCloudflareJamSimulator(envOverrides: Partial<CfJamEnv> = {}) {
  const stores = new Map<string, CfDurableObjectState>();
  const rooms = new Map<string, JamRoomDO>();
  const forwarded: { code: string; headers: Headers }[] = [];
  const socketStates = new Map<string, { ws: WebSocket; tags: string[] }[]>();
  const clock = { now: Date.now() };
  const clientIp = `198.51.100.${++cloudSimulatorSequence}`;

  const storageFor = (code: string) => {
    const existing = stores.get(code);
    if (existing) return existing;
    const data = new Map<string, unknown>();
    const sockets: { ws: WebSocket; tags: string[] }[] = [];
    socketStates.set(code, sockets);
    // Yield in every storage operation so Promise.all exercises DO interleaving.
    const yieldToOtherRequests = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    const state: CfDurableObjectState = {
      storage: {
        get: async <T>(key: string) => {
          await yieldToOtherRequests();
          const value = data.get(key);
          return value === undefined ? undefined : (structuredClone(value) as T);
        },
        put: async <T>(key: string, value: T) => {
          await yieldToOtherRequests();
          data.set(key, structuredClone(value));
        },
        deleteAll: async () => {
          data.clear();
        },
        setAlarm: async () => {},
      },
      acceptWebSocket: (ws, tags = []) => {
        sockets.push({ ws, tags });
      },
      getWebSockets: tag =>
        sockets
          .filter(
            ({ ws, tags }) => ws.readyState !== WebSocket.CLOSED && (!tag || tags.includes(tag)),
          )
          .map(({ ws }) => ws),
    };
    stores.set(code, state);
    return state;
  };

  const roomFor = (code: string) => {
    let room = rooms.get(code);
    if (!room) {
      room = new JamRoomDO(storageFor(code), env, () => clock.now);
      rooms.set(code, room);
    }
    return room;
  };
  const env: CfJamEnv = {
    JAM_ROOMS: {
      idFromName: name => name,
      get: id => ({
        fetch: request => {
          forwarded.push({ code: String(id), headers: new Headers(request.headers) });
          return roomFor(String(id)).fetch(request);
        },
      }),
    },
    ...envOverrides,
  };

  return {
    fetch: (request: Request) => {
      const headers = new Headers(request.headers);
      if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', clientIp);
      return handleCloudflareJamFetch(new Request(request, { headers }), env);
    },
    room: roomFor,
    clock,
    forwarded,
    sockets: (code: string) =>
      (socketStates.get(code) || []).map(({ ws }) => ws as unknown as MockCloudflareWebSocket),
    restart: (code: string) => {
      rooms.delete(code);
    },
  };
}

function installCloudflareSocketRuntime() {
  const NativeResponse = globalThis.Response;
  class LocalCloudflareResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init: ResponseInit = {}) {
      if (init.status === 101) super(null, { ...init, status: 200 });
      else super(body, init);
    }
  }
  class LocalWebSocketPair {
    0 = new MockCloudflareWebSocket();
    1 = new MockCloudflareWebSocket();
  }
  vi.stubGlobal('Response', LocalCloudflareResponse);
  vi.stubGlobal('WebSocketPair', LocalWebSocketPair);
}

function upgradeCloudflareWebSocket(
  cloud: ReturnType<typeof createCloudflareJamSimulator>,
  code: string,
  token: string,
) {
  return cloud.fetch(
    new Request(`https://jam.test/v1/jam/ws?code=${code}&token=${token}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
}

describe('JAM coordinator and two independent clients', () => {
  it('follows host track, play, pause, seek and next without sharing private session tokens', async () => {
    await withServer(async (send, raw, clock) => {
      const host = new JamClient(send),
        friend = new JamClient(send);
      const h = await host.enter('create', 'Casa');
      const f = await friend.enter('join', 'Amigo', h.code);
      expect(h.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(h.roomId).toMatch(/^jam_/);
      expect(h.roomId).not.toBe(h.code);
      expect(h.token).not.toBe(f.token);
      expect(f.members).toHaveLength(2);
      expect(JSON.stringify(f.members)).not.toContain(h.token);
      expect(JSON.stringify(f.members)).not.toContain(f.token);

      await host.update({ track: song, playing: true, position: 25 });
      clock.now += 2600;
      let room = await friend.update();
      expect(room.playback.track?.id).toBe(song.id);
      expect(jamPosition(room.playback, clock.now)).toBeCloseTo(27.6, 5);

      await host.update({ track: song, playing: false, position: 30 });
      clock.now += 5000;
      room = await friend.update();
      expect(room.playback.playing).toBe(false);
      expect(jamPosition(room.playback, clock.now)).toBe(30);

      await host.update({ track: song, playing: true, position: 90 });
      room = await friend.update();
      expect(jamPosition(room.playback, clock.now)).toBe(90);

      const next = {
        ...song,
        id: 'youtube:dQw4w9WgXcQ',
        sourceId: 'dQw4w9WgXcQ',
        title: 'Outra música',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      };
      await host.update({ track: next, playing: true, position: 0 });
      expect((await friend.update()).playback.track?.id).toBe(next.id);

      const forbidden = await raw({
        action: 'sync',
        code: f.code,
        token: f.token,
        playback: { track: song, playing: true, position: 0 },
      });
      expect(forbidden.status).toBe(403);

      await friend.leave();
      expect((await host.update({ track: next, playing: true, position: 0 })).members).toHaveLength(
        1,
      );
      expect(friend.session).toBeNull();

      const guest = new JamClient(send);
      await guest.enter('join', 'Novo', h.code);
      await host.leave();
      await expect(guest.update()).rejects.toThrow(/encerrada|expirou/);
    });
  });

  it('rejects local files, credential-bearing URLs, oversized requests, unknown fields and uninvited requests', async () => {
    await withServer(async (send, raw) => {
      const host = new JamClient(send),
        session = await host.enter('create', 'Host');
      for (const track of [
        { ...song, source: 'local', url: 'file:///C:/music.mp3' },
        { ...song, url: 'https://user:password@www.youtube.com/watch?v=M7lc1UVf-VE' },
        { ...song, url: 'http://169.254.169.254/latest/meta-data' },
      ]) {
        expect(
          (
            await raw({
              action: 'sync',
              code: session.code,
              token: session.token,
              playback: { track, playing: true, position: 0 },
            })
          ).status,
        ).toBe(400);
      }
      expect((await raw({ action: 'create', name: 'Host', unknownKey: true })).status).toBe(400);
      expect((await raw({ action: 'poll', code: session.code, token: 'invalid' })).status).toBe(
        401,
      );
      expect((await raw({ action: 'create', name: 'a'.repeat(18000) })).status).toBe(413);
      expect(canJam({ ...song, source: 'local' })).toBe(false);
    });
  });

  it('caps room members and removes absent guests while host heartbeats keep the room alive', async () => {
    await withServer(async (send, raw, clock) => {
      const host = new JamClient(send),
        h = await host.enter('create', 'Host');
      const guests: JamClient[] = [];
      for (let i = 0; i < 7; i++) {
        const guest = new JamClient(send);
        await guest.enter('join', `Friend ${i}`, h.code);
        guests.push(guest);
      }
      expect((await raw({ action: 'join', code: h.code, name: 'extra' })).status).toBe(409);
      clock.now += 36000;
      const room = await host.update({ track: null, playing: false, position: 0 });
      expect(room.members).toHaveLength(1);
      await expect(guests[0].update()).rejects.toThrow(/expirou/);
      clock.now += 900001;
      await expect(host.update({ track: null, playing: false, position: 0 })).rejects.toThrow(
        /expirou/,
      );
    });
  });

  it('limits room creation to bounded capacity and repeated entry attempts', async () => {
    await withServer(
      async (send, raw) => {
        await new JamClient(send).enter('create', 'Host');
        expect((await raw({ action: 'create', name: 'Other' })).status).toBe(503);
      },
      { JAM_MAX_ROOMS: '1' },
    );
    await withServer(async (_send, raw) => {
      for (let i = 0; i < 30; i++) await raw({ action: 'join', code: '0000000000' });
      expect((await raw({ action: 'join', code: '0000000000' })).status).toBe(429);
    });
  });

  it('charges authenticated IP activity once and permits a legitimate retry after the window', async () => {
    await withServer(
      async (send, raw, clock) => {
        const host = new JamClient(send);
        const session = await host.enter('create', 'Host');
        for (let i = 0; i < 4; i++) {
          expect(
            (await raw({ action: 'poll', code: session.code, token: session.token })).status,
          ).toBe(200);
        }
        expect(
          (await raw({ action: 'poll', code: session.code, token: session.token })).status,
        ).toBe(429);
        clock.now += 60001;
        expect(
          (await raw({ action: 'poll', code: session.code, token: session.token })).status,
        ).toBe(200);
      },
      { JAM_ACTIVE_REQUESTS_PER_MINUTE: '4' },
    );
  });

  it('ignores spoofed forwarding headers on direct connections and trusts only configured proxies', async () => {
    await withServer(async (_send, raw) => {
      for (let i = 0; i < 30; i++) {
        const response = await raw(
          { action: 'join', code: '0000000000' },
          { 'x-liquid-client-ip': `203.0.113.${i + 1}` },
        );
        expect(response.status).toBe(410);
      }
      const limited = await raw(
        { action: 'join', code: '0000000000' },
        { 'x-liquid-client-ip': '203.0.113.250' },
      );
      expect(limited.status).toBe(429);
    });

    await withServer(
      async (_send, raw) => {
        for (let i = 0; i < 30; i++) {
          await raw(
            { action: 'join', code: '0000000000' },
            { 'x-liquid-client-ip': '198.51.100.10' },
          );
        }
        expect(
          (
            await raw(
              { action: 'join', code: '0000000000' },
              { 'x-liquid-client-ip': '198.51.100.10' },
            )
          ).status,
        ).toBe(429);
        expect(
          (
            await raw(
              { action: 'join', code: '0000000000' },
              { 'x-liquid-client-ip': '198.51.100.11' },
            )
          ).status,
        ).toBe(410);
      },
      { JAM_TRUSTED_PROXY_IPS: '127.0.0.1' },
    );
  });

  it('blocks replay attacks (nonce + timestamp), supports RTT ping/pong and delta sinceSequence compression', async () => {
    await withServer(
      async (send, raw, clock) => {
        const host = new JamClient(send);
        const session = await host.enter('create', 'Host');
        const rtt = await host.ping();
        expect(rtt).toBeGreaterThanOrEqual(0);
        expect(host.clock.rttMs).toBeGreaterThanOrEqual(0);

        const rawPing = await raw({ action: 'ping', clientTime: 12345 });
        expect(rawPing.status).toBe(200);
        expect(await rawPing.json()).toMatchObject({ pong: true, echoClientTime: 12345 });

        // Strict replay mode rejects mutating calls without nonce/timestamp with 401
        const missingNonce = await raw({
          action: 'sync',
          code: session.code,
          token: session.token,
          playback: { track: song, playing: true, position: 10 },
        });
        expect(missingNonce.status).toBe(401);

        // Valid stamped sync succeeds once, and replaying the exact nonce returns 409
        const validPayload = {
          action: 'sync',
          code: session.code,
          token: session.token,
          nonce: 'replay_nonce_abcdef123456',
          timestamp: clock.now,
          playback: { track: song, playing: true, position: 12 },
        };
        const firstSync = await raw(validPayload);
        expect(firstSync.status).toBe(200);
        const syncedRoom = (await firstSync.json()) as JamRoom;

        const replayedSync = await raw(validPayload);
        expect(replayedSync.status).toBe(409);

        // Expired timestamp outside the 2-minute window is rejected with 401
        const staleSync = await raw({
          ...validPayload,
          nonce: 'fresh_nonce_999999999999',
          timestamp: clock.now - 180_000,
        });
        expect(staleSync.status).toBe(401);

        // Delta poll with matching sinceSequence flags unchanged: true + supports gzip compression
        const deltaRes = await raw(
          {
            action: 'poll',
            code: session.code,
            token: session.token,
            sinceSequence: syncedRoom.playback.sequence,
          },
          { 'accept-encoding': 'gzip' },
        );
        expect(deltaRes.status).toBe(200);
        const deltaBody = (await deltaRes.json()) as JamRoom;
        expect(deltaBody.unchanged).toBe(true);
        expect(deltaBody.playback.sequence).toBe(syncedRoom.playback.sequence);
      },
      { JAM_STRICT_REPLAY: '1' },
    );
  });

  it('enforces independent global, IP, member and room WebSocket quotas and releases them on close', async () => {
    const cases: { env: NodeJS.ProcessEnv; duplicateMember: boolean }[] = [
      { env: { JAM_WS_MAX_CONNECTIONS: '1' }, duplicateMember: false },
      { env: { JAM_WS_MAX_PER_IP: '1' }, duplicateMember: false },
      { env: { JAM_WS_MAX_PER_MEMBER: '1' }, duplicateMember: true },
      { env: { JAM_WS_MAX_PER_ROOM: '1' }, duplicateMember: true },
    ];
    for (const testCase of cases) {
      await withServer(
        async (send, _raw, _clock, { port }) => {
          const host = await new JamClient(send).enter('create', 'Host');
          const guest = await new JamClient(send).enter('join', 'Guest', host.code);
          const first = await openNodeWebSocket(port, host.code, host.token);
          const secondToken = testCase.duplicateMember ? host.token : guest.token;
          await expect(openNodeWebSocket(port, host.code, secondToken)).rejects.toThrow(
            'WebSocket rejected',
          );
          if (testCase.duplicateMember && testCase.env.JAM_WS_MAX_PER_MEMBER === '1') {
            const otherMember = await openNodeWebSocket(port, host.code, guest.token);
            await closeNodeWebSocket(otherMember);
          }
          await closeNodeWebSocket(first);
          const retry = await openNodeWebSocket(port, host.code, host.token);
          await closeNodeWebSocket(retry);
        },
        testCase.env,
      );
    }
  });

  it('keeps heartbeat clients alive, times out stale sockets and closes oversized input buffers', async () => {
    await withServer(
      async (send, _raw, clock, { port }) => {
        const host = await new JamClient(send).enter('create', 'Host');
        const ws = await openNodeWebSocket(port, host.code, host.token);
        await new Promise(resolve => setTimeout(resolve, 70));
        expect(ws.readyState).toBe(WebSocket.OPEN);
        await advanceUntilClosed(clock, ws, 1000);

        const oversized = await openNodeWebSocket(port, host.code, host.token);
        const closed = nodeWebSocketClosed(oversized);
        oversized.send('x'.repeat(40000));
        await closed;

        const expired = await openNodeWebSocket(port, host.code, host.token);
        await advanceUntilClosed(clock, expired, 900001);
      },
      { JAM_WS_HEARTBEAT_MS: '10', JAM_WS_TIMEOUT_MS: '40' },
    );
  });

  it('revokes sockets on guest leave, stale-member prune and host close without broadcasting to removals', async () => {
    await withServer(async (send, raw, clock, { port }) => {
      const host = await new JamClient(send).enter('create', 'Host');
      const firstGuest = await new JamClient(send).enter('join', 'First', host.code);
      const secondGuest = await new JamClient(send).enter('join', 'Second', host.code);
      const hostWs = await openNodeWebSocket(port, host.code, host.token);
      const firstWs = await openNodeWebSocket(port, host.code, firstGuest.token);
      const secondWs = await openNodeWebSocket(port, host.code, secondGuest.token);
      const removedMessages: string[] = [];
      firstWs.addEventListener('message', event => removedMessages.push(String(event.data)));

      const leaveClosed = nodeWebSocketClosed(firstWs);
      expect(
        (await raw({ action: 'leave', code: host.code, token: firstGuest.token })).status,
      ).toBe(200);
      await leaveClosed;
      expect(secondWs.readyState).toBe(WebSocket.OPEN);
      const messagesAfterLeave = removedMessages.length;
      await raw({
        action: 'sync',
        code: host.code,
        token: host.token,
        playback: { track: song, playing: true, position: 2 },
      });
      expect(removedMessages).toHaveLength(messagesAfterLeave);

      const pruneClosed = nodeWebSocketClosed(secondWs);
      clock.now += 36000;
      expect((await raw({ action: 'poll', code: host.code, token: host.token })).status).toBe(200);
      await pruneClosed;
      expect(hostWs.readyState).toBe(WebSocket.OPEN);

      const hostClosed = nodeWebSocketClosed(hostWs);
      expect((await raw({ action: 'leave', code: host.code, token: host.token })).status).toBe(200);
      await hostClosed;
    });
  });

  it('migrates seamlessly from Cloud to local LAN on network failure for both Host and Guest', async () => {
    const lanEndpoint = 'http://192.168.1.42:43880/v1/jam';
    const lanDiscovery = vi.fn(async () => [
      {
        code: '1122334455',
        hostName: 'Host',
        endpoint: lanEndpoint,
        members: 1,
        updatedAt: Date.now(),
      },
    ]);
    const lanSend = vi.fn(async (body: any) => {
      if (body.action === 'createLocal') {
        return {
          code: body.preferredCode || 'AABBCCDDEE',
          token: 'lan-host-token',
          host: true,
          memberId: 'm-host',
          endpoint: lanEndpoint,
          mode: 'lan-fallback',
          members: [{ id: 'm-host', name: body.name, host: true }],
          serverTime: Date.now(),
          playback: { track: song, playing: true, position: 42, updatedAt: Date.now(), sequence: 1 },
        };
      }
      if (body.action === 'sync') {
        return {
          code: body.code,
          members: [{ id: 'm-host', name: 'Host', host: true }],
          serverTime: Date.now(),
          playback: { ...body.playback, updatedAt: Date.now(), sequence: 2 },
        };
      }
      if (body.action === 'join') {
        return {
          code: body.code,
          token: 'lan-guest-token',
          host: false,
          memberId: 'm-guest',
          endpoint: body.endpoint,
          mode: 'lan-fallback',
          members: [
            { id: 'm-host', name: 'Host', host: true },
            { id: 'm-guest', name: body.name, host: false },
          ],
          serverTime: Date.now(),
          playback: { track: song, playing: true, position: 42, updatedAt: Date.now(), sequence: 2 },
        };
      }
      throw new Error(`Unexpected action: ${body.action}`);
    });

    // Host starts on Cloud, then Cloud dies -> fallbackToLan migrates room & playback to LAN
    const host = new JamClient(lanSend as JamSend, lanDiscovery);
    host.session = {
      roomId: 'jam_cloud_host',
      code: '1122334455',
      roomName: 'Host Cloud',
      status: 'active',
      maxParticipants: 8,
      inviteExpiresAt: Date.now() + 7_200_000,
      createdAt: Date.now(),
      token: 'cloud-host-token',
      host: true,
      memberId: 'c-host',
      endpoint: 'https://jam.cloud.invalid/v1/jam',
      mode: 'cloud',
      members: [{ id: 'c-host', name: 'Host', host: true }],
      serverTime: Date.now(),
      playback: { track: song, playing: true, position: 42, updatedAt: Date.now(), sequence: 5 },
    };

    const migratedHost = await host.fallbackToLan({ track: song, playing: true, position: 42 });
    expect(migratedHost?.mode).toBe('lan-fallback');
    expect(migratedHost?.code).toBe('1122334455');
    expect(migratedHost?.endpoint).toBe(lanEndpoint);

    // Guest on Cloud discovers the migrated room on LAN via UDP discovery and rejoins
    const guest = new JamClient(lanSend as JamSend, lanDiscovery);
    guest.session = {
      roomId: 'jam_cloud_guest',
      code: '1122334455',
      roomName: 'Host Cloud',
      status: 'active',
      maxParticipants: 8,
      inviteExpiresAt: Date.now() + 7_200_000,
      createdAt: Date.now(),
      token: 'cloud-guest-token',
      host: false,
      memberId: 'c-guest',
      endpoint: 'https://jam.cloud.invalid/v1/jam',
      mode: 'cloud',
      members: [
        { id: 'c-host', name: 'Host', host: true },
        { id: 'c-guest', name: 'Amigo', host: false },
      ],
      serverTime: Date.now(),
      playback: { track: song, playing: true, position: 40, updatedAt: Date.now(), sequence: 4 },
    };

    const migratedGuest = await guest.fallbackToLan();
    expect(lanDiscovery).toHaveBeenCalledWith('1122334455');
    expect(migratedGuest?.mode).toBe('lan-fallback');
    expect(migratedGuest?.endpoint).toBe(lanEndpoint);
    expect(migratedGuest?.members).toHaveLength(2);
  });
});

describe('JAM P0 Cloudflare room ownership regressions', () => {
  const code = 'AABBCCDDEE';

  it('rejects creation over a rehydrated room and keeps the original host token authorized', async () => {
    const cloud = createCloudflareJamSimulator();
    const first = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Original', preferredCode: code }),
    );
    expect(first.status).toBe(201);
    const original = (await first.json()) as { token: string };

    // Simulate DO hibernation/restart while retaining only durable storage.
    cloud.restart(code);
    const takeover = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Attacker', preferredCode: code }),
    );
    expect(takeover.status).toBe(409);

    const poll = await cloud.fetch(
      workerJamRequest({ action: 'poll', code, token: original.token }),
    );
    expect(poll.status).toBe(200);
    const room = (await poll.json()) as JamRoom;
    expect(room.members).toEqual([expect.objectContaining({ name: 'Original', host: true })]);
  });

  it('allows exactly one of two simultaneous creates to reserve and persist the room', async () => {
    const cloud = createCloudflareJamSimulator();
    const names = ['Primeiro', 'Segundo'];
    const responses = await Promise.all(
      names.map(name =>
        cloud.fetch(workerJamRequest({ action: 'create', name, preferredCode: code })),
      ),
    );
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);

    const winnerIndex = responses.findIndex(response => response.status === 201);
    const winner = (await responses[winnerIndex].json()) as { token: string; code: string };
    const rejected = (await responses[1 - winnerIndex].json()) as Record<string, unknown>;
    expect(winner.code).toBe(code);
    expect(rejected.token).toBeUndefined();

    const poll = await cloud.fetch(workerJamRequest({ action: 'poll', code, token: winner.token }));
    expect(poll.status).toBe(200);
    const room = (await poll.json()) as JamRoom;
    expect(room.members).toEqual([
      expect.objectContaining({ name: names[winnerIndex], host: true }),
    ]);
  });

  it('returns 415 for plain text without breaking internal JSON WebSocket messages', async () => {
    const cloud = createCloudflareJamSimulator();
    const plainText = await cloud.fetch(
      new Request('https://jam.test/v1/jam', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text',
      }),
    );
    expect(plainText.status).toBe(415);

    const created = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Original', preferredCode: code }),
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as { token: string };

    const directPlainText = await cloud.room(code).fetch(
      new Request('https://jam.internal/v1/jam', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text',
      }),
    );
    expect(directPlainText.status).toBe(415);

    let internalMessage = '';
    const ws = {
      deserializeAttachment: () => ({ token: session.token, code, ip: '198.51.100.10' }),
      send: (value: string) => {
        internalMessage = value;
      },
    } as unknown as Parameters<JamRoomDO['webSocketMessage']>[0];
    await cloud.room(code).webSocketMessage(ws, JSON.stringify({ action: 'poll', code }));
    expect(JSON.parse(internalMessage)).toMatchObject({ code });
  });

  it('keeps Node JSON creation, media-type validation and host authorization unchanged', async () => {
    await withServer(async (_send, raw) => {
      const created = await raw(
        { action: 'create', name: 'Node' },
        { 'content-type': 'application/json; charset=utf-8' },
      );
      expect(created.status).toBe(201);
      const session = (await created.json()) as { code: string; token: string };

      const plainText = await raw('plain text', { 'content-type': 'text/plain' });
      expect(plainText.status).toBe(415);

      const poll = await raw({ action: 'poll', code: session.code, token: session.token });
      expect(poll.status).toBe(200);
    });
  });
});

describe('JAM P1 Cloudflare HTTP security', () => {
  const code = '1122334455';

  it('requires replay fields, returns 400 for malformed JSON and enforces 16KB without Content-Length', async () => {
    const cloud = createCloudflareJamSimulator();
    const missing = await cloud.fetch(
      workerJamRequest(
        { action: 'create', name: 'Host', preferredCode: code },
        'application/json',
        false,
      ),
    );
    expect(missing.status).toBe(401);

    // A rejected attempt neither creates the room nor prevents a valid retry.
    expect(
      (await cloud.fetch(workerJamRequest({ action: 'create', name: 'Host', preferredCode: code })))
        .status,
    ).toBe(201);

    const malformed = await cloud.fetch(
      new Request('https://jam.test/v1/jam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);

    const oversizedRequest = workerJamRequest({
      action: 'create',
      name: 'x'.repeat(17000),
      preferredCode: 'AABBCCDDEE',
    });
    expect(oversizedRequest.headers.has('Content-Length')).toBe(false);
    expect((await cloud.fetch(oversizedRequest)).status).toBe(413);
  });

  it('rejects stale and replayed nonces, allows a corrected retry and prunes/expires bounded state', async () => {
    const cloud = createCloudflareJamSimulator({ JAM_NONCE_LIMIT: '2' });
    const created = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
    );
    const session = (await created.json()) as { token: string };
    const stale = {
      action: 'sync',
      code,
      token: session.token,
      nonce: 'correctable_nonce_123456',
      timestamp: cloud.clock.now - 180000,
      playback: { track: song, playing: true, position: 1 },
    };
    expect((await cloud.fetch(workerJamRequest(stale))).status).toBe(401);

    const corrected = { ...stale, timestamp: cloud.clock.now };
    expect((await cloud.fetch(workerJamRequest(corrected))).status).toBe(200);
    expect((await cloud.fetch(workerJamRequest(corrected))).status).toBe(409);

    const stampedPoll = (nonce: string) =>
      cloud.fetch(
        workerJamRequest({ action: 'poll', code, token: session.token, nonce, timestamp: cloud.clock.now }),
      );
    expect((await stampedPoll('bounded_nonce_aaaaaa')).status).toBe(200);
    expect((await stampedPoll('bounded_nonce_bbbbbb')).status).toBe(200);
    expect((await stampedPoll('bounded_nonce_cccccc')).status).toBe(200);
    // This nonce was evicted by the bounded FIFO cache and can be used with a fresh timestamp.
    expect((await stampedPoll('bounded_nonce_aaaaaa')).status).toBe(200);
    const latest = 'bounded_nonce_aaaaaa';
    expect(
      (
        await cloud.fetch(
          workerJamRequest({ action: 'poll', code, token: session.token, nonce: latest, timestamp: cloud.clock.now }),
        )
      ).status,
    ).toBe(409);

    expect((await stampedPoll('bounded_nonce_dddddd')).status).toBe(200);
    cloud.clock.now += 120001;
    expect((await stampedPoll('bounded_nonce_dddddd')).status).toBe(200);
  });

  it('uses CF-Connecting-IP only at the Worker and overwrites spoofed internal headers', async () => {
    const cloud = createCloudflareJamSimulator();
    const request = workerJamRequest({ action: 'create', name: 'Host', preferredCode: code });
    request.headers.set('CF-Connecting-IP', '203.0.113.44');
    request.headers.set('X-Liquid-Client-IP', '203.0.113.99');
    expect((await cloud.fetch(request)).status).toBe(201);
    const internal = cloud.forwarded[0].headers;
    expect(internal.get('X-Liquid-Client-IP')).toBe('203.0.113.44');
    expect(internal.has('CF-Connecting-IP')).toBe(false);
  });

  it('enforces DO IP/member quotas once and permits retries after the rate window', async () => {
    const cloud = createCloudflareJamSimulator({ JAM_ACTIVE_REQUESTS_PER_MINUTE: '4' });
    const created = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
    );
    const session = (await created.json()) as { token: string };
    for (let i = 0; i < 4; i++) {
      expect(
        (await cloud.fetch(workerJamRequest({ action: 'poll', code, token: session.token }))).status,
      ).toBe(200);
    }
    expect(
      (await cloud.fetch(workerJamRequest({ action: 'poll', code, token: session.token }))).status,
    ).toBe(429);
    cloud.clock.now += 60001;
    expect(
      (await cloud.fetch(workerJamRequest({ action: 'poll', code, token: session.token }))).status,
    ).toBe(200);
  });

  it('shares a room quota across members and bounds Worker entry/capacity by isolate namespace', async () => {
    const cloud = createCloudflareJamSimulator({
      JAM_ACTIVE_REQUESTS_PER_MINUTE: '100',
      JAM_ROOM_REQUESTS_PER_MINUTE: '8',
    });
    const hostResponse = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
    );
    const host = (await hostResponse.json()) as { token: string };
    const guestResponse = await cloud.fetch(workerJamRequest({ action: 'join', code, name: 'Guest' }));
    const guest = (await guestResponse.json()) as { token: string };
    for (let i = 0; i < 8; i++) {
      const token = i % 2 ? guest.token : host.token;
      expect((await cloud.fetch(workerJamRequest({ action: 'poll', code, token }))).status).toBe(200);
    }
    expect(
      (await cloud.fetch(workerJamRequest({ action: 'poll', code, token: host.token }))).status,
    ).toBe(429);

    const capacity = createCloudflareJamSimulator({ JAM_MAX_ROOMS_PER_ISOLATE: '1' });
    expect(
      (
        await capacity.fetch(
          workerJamRequest({ action: 'create', name: 'One', preferredCode: 'AAAAAAAAAA' }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await capacity.fetch(
          workerJamRequest({ action: 'create', name: 'Two', preferredCode: 'BBBBBBBBBB' }),
        )
      ).status,
    ).toBe(503);
  });

  it('releases Worker create capacity when the host leaves', async () => {
    const capacity = createCloudflareJamSimulator({ JAM_MAX_ROOMS_PER_ISOLATE: '1' });
    const created = await capacity.fetch(
      workerJamRequest({ action: 'create', name: 'One', preferredCode: 'AAAAAAAAAA' }),
    );
    expect(created.status).toBe(201);
    const host = (await created.json()) as { token: string };
    expect(
      (await capacity.fetch(workerJamRequest({ action: 'leave', code: 'AAAAAAAAAA', token: host.token })))
        .status,
    ).toBe(200);
    expect(
      (
        await capacity.fetch(
          workerJamRequest({ action: 'create', name: 'Two', preferredCode: 'BBBBBBBBBB' }),
        )
      ).status,
    ).toBe(201);
  });

  it('keeps per-IP entry flood protection across different room objects', async () => {
    const cloud = createCloudflareJamSimulator();
    for (let i = 0; i < 30; i++) {
      const preferredCode = i.toString(16).toUpperCase().padStart(10, '0');
      expect((await cloud.fetch(workerJamRequest({ action: 'create', preferredCode }))).status).toBe(201);
    }
    expect(
      (await cloud.fetch(workerJamRequest({ action: 'create', preferredCode: 'FFFFFFFFFF' }))).status,
    ).toBe(429);
  });
});

describe('JAM P1 Cloudflare WebSocket security', () => {
  const code = '5566778899';

  it('enforces per-member, per-room and per-IP connection quotas', async () => {
    installCloudflareSocketRuntime();
    try {
      const cases: { env: Partial<CfJamEnv>; duplicateMember: boolean }[] = [
        { env: { JAM_WS_MAX_PER_MEMBER: '1' }, duplicateMember: true },
        { env: { JAM_WS_MAX_PER_ROOM: '1' }, duplicateMember: true },
        { env: { JAM_WS_MAX_PER_IP: '1' }, duplicateMember: false },
      ];
      for (const testCase of cases) {
        const cloud = createCloudflareJamSimulator(testCase.env);
        const hostResponse = await cloud.fetch(
          workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
        );
        const host = (await hostResponse.json()) as { token: string };
        const guestResponse = await cloud.fetch(
          workerJamRequest({ action: 'join', code, name: 'Guest' }),
        );
        const guest = (await guestResponse.json()) as { token: string };
        expect((await upgradeCloudflareWebSocket(cloud, code, host.token)).status).toBe(200);
        const secondToken = testCase.duplicateMember ? host.token : guest.token;
        expect((await upgradeCloudflareWebSocket(cloud, code, secondToken)).status).toBe(429);
        if (testCase.env.JAM_WS_MAX_PER_MEMBER === '1') {
          expect((await upgradeCloudflareWebSocket(cloud, code, guest.token)).status).toBe(200);
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes revoked tags on leave, prune and alarm and broadcasts only to current members', async () => {
    installCloudflareSocketRuntime();
    try {
      const cloud = createCloudflareJamSimulator();
      const hostResponse = await cloud.fetch(
        workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
      );
      const host = (await hostResponse.json()) as { token: string };
      const guestResponse = await cloud.fetch(
        workerJamRequest({ action: 'join', code, name: 'Guest' }),
      );
      const guest = (await guestResponse.json()) as { token: string };
      await upgradeCloudflareWebSocket(cloud, code, host.token);
      await upgradeCloudflareWebSocket(cloud, code, guest.token);
      const [hostWs, guestWs] = cloud.sockets(code);

      expect((await cloud.fetch(workerJamRequest({ action: 'leave', code, token: guest.token }))).status).toBe(200);
      expect(guestWs.readyState).toBe(WebSocket.CLOSED);
      expect(guestWs.closeCode).toBe(1008);
      expect(hostWs.readyState).toBe(WebSocket.OPEN);
      expect(guestWs.sent).toHaveLength(0);
      expect(JSON.parse(hostWs.sent.at(-1) || '{}').members).toHaveLength(1);

      await cloud.fetch(
        workerJamRequest({
          action: 'sync',
          code,
          token: host.token,
          playback: { track: song, playing: true, position: 3 },
        }),
      );
      expect(guestWs.sent).toHaveLength(0);
      expect(JSON.parse(hostWs.sent.at(-1) || '{}').playback.position).toBe(3);

      expect((await cloud.fetch(workerJamRequest({ action: 'leave', code, token: host.token }))).status).toBe(200);
      expect(hostWs.readyState).toBe(WebSocket.CLOSED);

      const pruning = createCloudflareJamSimulator();
      const prunedHostResponse = await pruning.fetch(
        workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
      );
      const prunedHost = (await prunedHostResponse.json()) as { token: string };
      const prunedGuestResponse = await pruning.fetch(
        workerJamRequest({ action: 'join', code, name: 'Guest' }),
      );
      const prunedGuest = (await prunedGuestResponse.json()) as { token: string };
      await upgradeCloudflareWebSocket(pruning, code, prunedHost.token);
      await upgradeCloudflareWebSocket(pruning, code, prunedGuest.token);
      const [prunedHostWs, prunedGuestWs] = pruning.sockets(code);
      pruning.clock.now += 36000;
      await pruning.fetch(workerJamRequest({ action: 'poll', code, token: prunedHost.token }));
      expect(prunedGuestWs.readyState).toBe(WebSocket.CLOSED);
      expect(prunedHostWs.readyState).toBe(WebSocket.OPEN);
      pruning.clock.now += 900001;
      await pruning.room(code).alarm();
      expect(prunedHostWs.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applies strict replay validation to internal WebSocket JSON commands', async () => {
    installCloudflareSocketRuntime();
    try {
      const cloud = createCloudflareJamSimulator();
      const created = await cloud.fetch(
        workerJamRequest({ action: 'create', name: 'Host', preferredCode: code }),
      );
      const host = (await created.json()) as { token: string };
      await upgradeCloudflareWebSocket(cloud, code, host.token);
      const [ws] = cloud.sockets(code);
      await cloud.room(code).webSocketMessage(
        ws as unknown as Parameters<JamRoomDO['webSocketMessage']>[0],
        JSON.stringify({
          action: 'sync',
          playback: { track: song, playing: true, position: 4 },
        }),
      );
      expect(JSON.parse(ws.sent.at(-1) || '{}').error).toMatch(/Nonce e timestamp/);

      await cloud.room(code).webSocketMessage(
        ws as unknown as Parameters<JamRoomDO['webSocketMessage']>[0],
        JSON.stringify({
          action: 'sync',
          nonce: 'websocket_nonce_123456789',
          timestamp: cloud.clock.now,
          playback: { track: song, playing: true, position: 4 },
        }),
      );
      expect(JSON.parse(ws.sent.at(-1) || '{}').playback.position).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('JAM timing & drift compensation', () => {
  it('uses round-trip midpoint and favors fast clock samples instead of network queue delay', () => {
    const clock = new JamClock();
    clock.sample(1000, 1100, 1550);
    expect(clock.offset).toBe(500);
    clock.sample(2000, 4000, 2800);
    expect(clock.offset).toBe(500);
    clock.sample(5000, 5100, 5550);
    expect(clock.offset).toBe(500);
    clock.sample(8000, 8050, 8525);
    expect(clock.offset).toBe(500);
  });

  it('computes millisecond clock drift and bounded exponential backoff', () => {
    const playback = {
      track: song,
      playing: true,
      position: 10,
      updatedAt: 1000,
      sequence: 1,
    };
    // At serverTime=2000ms, expected position is 11.000s; local audio at 10.850s -> +150ms drift
    expect(jamDriftMs(10.85, playback, 2000)).toBeCloseTo(150, 1);
    expect(jamDriftMs(11.12, playback, 2000)).toBeCloseTo(-120, 1);

    expect(computeBackoffMs(0, 800, 15000, 0)).toBe(800);
    expect(computeBackoffMs(3, 800, 15000, 0)).toBe(6400);
    expect(computeBackoffMs(10, 800, 15000, 0.15)).toBeLessThanOrEqual(15000);
  });

  it('never seeks behind zero or beyond the end and does not advance a paused song', () => {
    const room: JamRoom = {
      roomId: 'jam_0',
      code: '00000000',
      roomName: 'Teste',
      status: 'active',
      maxParticipants: 8,
      inviteExpiresAt: 99999999,
      createdAt: 0,
      members: [],
      serverTime: 1000,
      playback: { track: song, playing: true, position: 179.5, updatedAt: 1000, sequence: 1 },
    };
    expect(jamPosition(room.playback, 900000)).toBe(180);
    expect(jamPosition({ ...room.playback, playing: false }, 900000)).toBe(179.5);
    expect(jamPosition({ ...room.playback, position: 0 }, 0)).toBe(0);
  });
});

async function withV3Server(
  run: (ctx: {
    baseUrl: string;
    port: number;
    send: JamSend;
    raw: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
    clock: { now: number };
  }) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const clock = { now: Date.now() },
    server = createJam(env, () => clock.now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/v1/jam`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const send: JamSend = async <T>(body: unknown) => {
    const reqBody = body as { action?: string; code?: string; endpoint?: string };
    if (reqBody.action === 'lookup') {
      const targetBase = reqBody.endpoint || baseUrl;
      const response = await fetch(`${targetBase}/v1/jam`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', code: reqBody.code }),
      });
      const val = (await response.json()) as Record<string, unknown>;
      if (response.ok) {
        return {
          found: true,
          preview: { ...(val as object), endpoint: targetBase, mode: 'cloud' },
        } as T;
      }
      return {
        found: false,
        error: String(val.error || 'Erro'),
        errorCode: val.errorCode,
        preview: val.preview ?? null,
      } as T;
    }
    const response = await raw(body),
      value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value as T;
  };
  try {
    await run({ baseUrl, port, send, raw, clock });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function mintTestEd25519Jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  sub: string,
  nowMs: number,
  expOffsetSec = 600,
) {
  const iat = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'liquid-hub-auth',
      aud: 'liquid-hub-desktop',
      sub,
      fam: 'fam_test',
      iat,
      exp: iat + expOffsetSec,
    }),
  ).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const sig = sign(null, Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

describe('JAM v3 invites, persistence, real-time SSE, deduplication and Ed25519 auth', () => {
  it('supports invite lookup, case-insensitive codes, tombstones, rotation, locking and HTML landing bridge', async () => {
    await withV3Server(
      async ({ baseUrl, send, raw, clock }) => {
        const host = new JamClient(send);
        const h = await host.enter('create', 'Ana <script>', undefined, baseUrl, {
          roomName: 'Chill & Lo-Fi "Night"',
          inviteTtlMs: 120_000,
        });

        const lowerCode = `${h.code.slice(0, 4).toLowerCase()}-${h.code.slice(4).toLowerCase()}`;
        const lookupRes = await host.lookup(lowerCode, baseUrl);
        expect(lookupRes.found).toBe(true);
        expect(lookupRes.preview?.code).toBe(h.code);
        expect(lookupRes.preview?.roomId).toBe(h.roomId);
        expect(lookupRes.preview?.roomName).toBe('Chill & Lo-Fi "Night"');
        expect(lookupRes.preview?.hostName).toBe('Ana <script>');
        expect(lookupRes.preview?.participantCount).toBe(1);
        expect(lookupRes.preview?.canJoin).toBe(true);

        const restPreviewRes = await fetch(`${baseUrl}/v1/jam/invites/${lowerCode}`);
        expect(restPreviewRes.status).toBe(200);
        const restPreview = (await restPreviewRes.json()) as JamInvitePreview;
        expect(restPreview.code).toBe(h.code);

        const htmlRes = await fetch(`${baseUrl}/jam/join/${h.code}`);
        expect(htmlRes.status).toBe(200);
        expect(htmlRes.headers.get('content-type')).toContain('text/html');
        const html = await htmlRes.text();
        expect(html).not.toContain('Ana <script>');
        expect(html).toContain('Ana &lt;script&gt;');
        expect(html).toContain(`liquidhub://jam/join/${h.code}?endpoint=`);
        expect(html).toContain('Abrir no Liquid Hub');
        expect(html).toContain('Baixar ou instalar Liquid Hub');

        const unknown = await host.lookup('ZZZZ9999', baseUrl);
        expect(unknown.found).toBe(false);
        expect(unknown.errorCode).toBe('INVITE_NOT_FOUND');

        const invalid = await host.lookup('12', baseUrl);
        expect(invalid.found).toBe(false);
        expect(invalid.errorCode).toBe('INVITE_INVALID');

        await host.updateRoom({ locked: true });
        const lockedLookup = await host.lookup(h.code, baseUrl);
        expect(lockedLookup.preview?.status).toBe('locked');
        expect(lockedLookup.preview?.canJoin).toBe(false);
        const lockedJoin = await raw({ action: 'join', code: h.code, name: 'Bloqueado' });
        expect(lockedJoin.status).toBe(403);
        await host.updateRoom({ locked: false });

        const oldCode = h.code;
        const rotated = await host.rotateInvite();
        expect(rotated.code).not.toBe(oldCode);
        const expiredLookup = (await host.lookup(oldCode, baseUrl)) as JamInviteLookupResult;
        expect(expiredLookup.found).toBe(false);
        expect(expiredLookup.errorCode).toBe('INVITE_EXPIRED');

        clock.now += 125_000;
        const ttlExpired = await host.lookup(rotated.code, baseUrl);
        expect(ttlExpired.found).toBe(false);
        expect(ttlExpired.errorCode).toBe('INVITE_EXPIRED');

        await host.leave();
        const endedLookup = await host.lookup(rotated.code, baseUrl);
        expect(endedLookup.found).toBe(false);
        expect(endedLookup.errorCode).toBe('ROOM_ENDED');
        expect(endedLookup.preview?.status).toBe('ended');
        const endedHtml = await fetch(`${baseUrl}/jam/join/${rotated.code}`);
        expect(endedHtml.status).toBe(410);
      },
      { JAM_REPLAY_WINDOW_MS: '300000' },
    );
  });

  it('persists rooms, members and tombstones in SQLite across server restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liquid-jam-sqlite-'));
    const dbPath = join(dir, 'jam.sqlite');
    let savedCode = '';
    let hostToken = '';
    let guestToken = '';

    try {
      await withV3Server(
        async ({ send }) => {
          const host = new JamClient(send);
          const guest = new JamClient(send);
          const h = await host.enter('create', 'PersistHost', undefined, undefined, {
            roomName: 'Sala Persistida',
          });
          const g = await guest.enter('join', 'PersistGuest', h.code);
          await host.update({ track: song, playing: true, position: 15 });
          savedCode = h.code;
          hostToken = h.token;
          guestToken = g.token;
        },
        { JAM_DB_PATH: dbPath },
      );

      await withV3Server(
        async ({ baseUrl, send, raw }) => {
          const lookup = await new JamClient(send).lookup(savedCode, baseUrl);
          expect(lookup.found).toBe(true);
          expect(lookup.preview?.roomName).toBe('Sala Persistida');
          expect(lookup.preview?.participantCount).toBe(2);
          expect(lookup.preview?.currentTrack?.id).toBe(song.id);

          const pollRes = await raw({ action: 'poll', code: savedCode, token: guestToken });
          expect(pollRes.status).toBe(200);
          const pollRoom = (await pollRes.json()) as JamRoom;
          expect(pollRoom.playback.track?.id).toBe(song.id);

          const leaveRes = await raw({ action: 'leave', code: savedCode, token: hostToken });
          expect(leaveRes.status).toBe(200);
        },
        { JAM_DB_PATH: dbPath },
      );

      await withV3Server(
        async ({ baseUrl, send }) => {
          const ended = await new JamClient(send).lookup(savedCode, baseUrl);
          expect(ended.found).toBe(false);
          expect(ended.errorCode).toBe('ROOM_ENDED');
        },
        { JAM_DB_PATH: dbPath },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pushes real-time events over SSE and WebSocket and handles kick cleanly', async () => {
    await withV3Server(async ({ baseUrl, port, send }) => {
      const host = new JamClient(send);
      const guest = new JamClient(send);
      const h = await host.enter('create', 'StreamHost');
      const g = await guest.enter('join', 'StreamGuest', h.code);

      const sseController = new AbortController();
      const sseRes = await fetch(`${baseUrl}/v1/jam/events?code=${h.code}`, {
        headers: { Authorization: `Bearer ${g.token}` },
        signal: sseController.signal,
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      const readNextEvents = async (needle: string) => {
        const deadline = Date.now() + 3000;
        while (!sseBuffer.includes(needle) && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
        }
        return sseBuffer;
      };

      await readNextEvents('event: state');
      expect(sseBuffer).toContain('StreamGuest');

      const wsChunks: string[] = [];
      const wsSock = createConnection({ host: '127.0.0.1', port });
      await new Promise<void>((resolve, reject) => {
        const key = randomBytes(16).toString('base64');
        const expectedAccept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        wsSock.once('data', chunk => {
          const text = chunk.toString('utf8');
          if (!text.includes(`Sec-WebSocket-Accept: ${expectedAccept}`)) {
            reject(new Error('Invalid WS handshake'));
            return;
          }
          wsChunks.push(text);
          resolve();
        });
        wsSock.on('error', reject);
        wsSock.write(
          `GET /v1/jam/ws?code=${h.code}&token=${h.token} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      wsSock.on('data', chunk => wsChunks.push(chunk.toString('utf8')));

      await host.update({ track: song, playing: true, position: 12 });
      await readNextEvents('event: playback');
      expect(sseBuffer).toContain(song.id);
      await vi.waitFor(() => {
        expect(wsChunks.join('')).toContain(song.id);
      });

      await host.kick(g.memberId);
      await readNextEvents('event: kicked');
      expect(sseBuffer).toContain('KICKED');

      await reader.cancel().catch(() => {});
      sseController.abort();
      wsSock.destroy();
    });
  });

  it('prevents duplicate participants, handles concurrent joins/8th-slot races and supports resume after disconnect', async () => {
    await withV3Server(async ({ send, raw, clock }) => {
      const host = new JamClient(send);
      const h = await host.enter('create', 'Host');

      const g1 = new JamClient(send);
      const g2 = new JamClient(send);
      const [s1, s2] = await Promise.all([
        g1.enter('join', 'UserA', h.code, undefined, { clientId: 'cid_user_a_001' }),
        g2.enter('join', 'UserB', h.code, undefined, { clientId: 'cid_user_b_002' }),
      ]);
      expect(s1.memberId).not.toBe(s2.memberId);
      expect((await host.update({ track: null, playing: false, position: 0 })).members).toHaveLength(3);

      const dupRes = await (
        await raw({
          action: 'join',
          code: h.code,
          name: 'UserA',
          clientId: 'cid_user_a_001',
        })
      ).json();
      expect(dupRes.memberId).toBe(s1.memberId);
      expect(dupRes.members).toHaveLength(3);

      clock.now += 36_000;
      const pruned = await host.update({ track: null, playing: false, position: 0 });
      expect(pruned.members).toHaveLength(1);
      await expect(g1.update()).rejects.toThrow(/expirou/);

      const resumed = await g1.resume();
      expect(resumed.code).toBe(h.code);
      expect(resumed.memberId).toBe(s1.memberId);
      expect(resumed.members).toHaveLength(2);

      for (let i = 0; i < 5; i++) {
        await new JamClient(send).enter('join', `G${i}`, h.code);
      }
      const [rA, rB] = await Promise.all([
        raw({ action: 'join', code: h.code, name: 'RaceA' }),
        raw({ action: 'join', code: h.code, name: 'RaceB' }),
      ]);
      const statuses = [rA.status, rB.status].sort();
      expect(statuses).toEqual([200, 409]);
    });
  });

  it('enforces server-side Ed25519 authentication when JAM_REQUIRE_AUTH=1', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };

    await withV3Server(
      async ({ raw, clock }) => {
        const unauthCreate = await raw({ action: 'create', name: 'Anon' });
        expect(unauthCreate.status).toBe(401);
        expect((await unauthCreate.json()).errorCode).toBe('AUTH_REQUIRED');

        const expiredJwt = mintTestEd25519Jwt(privateKey, 'usr_alice', clock.now - 1200_000, 600);
        const expiredCreate = await raw(
          { action: 'create', name: 'Alice' },
          { authorization: `Bearer ${expiredJwt}` },
        );
        expect(expiredCreate.status).toBe(401);

        const aliceJwt = mintTestEd25519Jwt(privateKey, 'usr_alice', clock.now);
        const aliceCreate = await raw(
          { action: 'create', name: 'Alice' },
          { authorization: `Bearer ${aliceJwt}` },
        );
        expect(aliceCreate.status).toBe(201);
        const created = await aliceCreate.json();

        const unauthJoin = await raw({ action: 'join', code: created.code, name: 'Anon' });
        expect(unauthJoin.status).toBe(401);

        const bobJwt = mintTestEd25519Jwt(privateKey, 'usr_bob', clock.now);
        const bobJoin = await raw(
          { action: 'join', code: created.code, name: 'Bob' },
          { authorization: `Bearer ${bobJwt}` },
        );
        expect(bobJoin.status).toBe(200);
        const joined = await bobJoin.json();
        expect(joined.members).toHaveLength(2);
      },
      { JAM_REQUIRE_AUTH: '1', JAM_AUTH_PUBLIC_KEY: jwk.x },
    );
  });

  it('parses shareable URLs, deep links, pasted messages, raw codes and generates WhatsApp/Discord shares', () => {
    expect(normalizeJamCode('k9m4-p2xr')).toBe('K9M4P2XR');
    expect(parseJamInvite('https://liquidhub.app/jam/join/k9m4p2xr')).toEqual({
      code: 'K9M4P2XR',
      endpoint: 'https://liquidhub.app',
    });
    expect(
      parseJamInvite('liquidhub://jam/join/K9M4P2XR?endpoint=https%3A%2F%2Fjam.liquidhub.app'),
    ).toEqual({
      code: 'K9M4P2XR',
      endpoint: 'https://jam.liquidhub.app',
    });
    expect(parseJamInvite('http://192.168.1.42:8789/jam/join/abc12345')).toEqual({
      code: 'ABC12345',
      endpoint: 'http://192.168.1.42:8789',
    });
    expect(parseJamInvite('Bora ouvir música! https://liquidhub.app/jam/join/XYZ98765')).toEqual({
      code: 'XYZ98765',
      endpoint: 'https://liquidhub.app',
    });
    expect(parseJamInvite('k9m4 p2xr', 'https://jam.liquidhub.app')).toEqual({
      code: 'K9M4P2XR',
      endpoint: 'https://jam.liquidhub.app',
    });
    expect(parseJamInvite('javascript:alert(1)')).toEqual({ code: '', endpoint: '' });
    expect(parseJamInvite('http://evil.example/jam/join/K9M4P2XR')).toEqual({
      code: '',
      endpoint: '',
    });

    const inviteUrl = buildJamInviteUrl('K9M4P2XR', 'https://liquidhub.app');
    expect(inviteUrl).toBe('https://liquidhub.app/jam/join/K9M4P2XR');
    expect(buildJamDeepLink('K9M4P2XR', 'https://liquidhub.app')).toBe(
      'liquidhub://jam/join/K9M4P2XR?endpoint=https%3A%2F%2Fliquidhub.app',
    );
    expect(buildWhatsAppShareUrl('Sextou', inviteUrl, 'K9M4P2XR')).toContain(
      'https://wa.me/?text=',
    );
    expect(buildDiscordShareText('Sextou', inviteUrl, 'K9M4P2XR')).toContain(inviteUrl);
  });

  it('supports rotateInvite in Cloudflare JamRoomDO, migrates room state across restart, blocks non-host, and keeps duplicate join idempotent', async () => {
    installCloudflareSocketRuntime();
    const cloud = createCloudflareJamSimulator({ JAM_REPLAY_WINDOW_MS: '300000' });

    // Internal migration endpoint must never be exposed publicly
    const publicMigrate = await cloud.fetch(
      new Request('https://jam.test/__internal/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Liquid-Internal-Migrate': '1' },
        body: '{}',
      }),
    );
    expect(publicMigrate.status).toBe(404);

    const createRes = await cloud.fetch(
      workerJamRequest({ action: 'create', name: 'HostDO', roomName: 'Sala DO', clientId: 'host_do_1' }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as JamSession;

    // Joining twice with the same clientId must stay idempotent with 2 members (host + 1 guest)
    const join1 = await cloud.fetch(
      workerJamRequest({
        action: 'join',
        code: created.code,
        name: 'GuestDO',
        clientId: 'guest_do_same_client',
      }),
    );
    expect(join1.status).toBe(200);
    const guest1 = (await join1.json()) as JamSession;

    const join2 = await cloud.fetch(
      workerJamRequest({
        action: 'join',
        code: created.code,
        name: 'GuestDO',
        clientId: 'guest_do_same_client',
      }),
    );
    expect(join2.status).toBe(200);
    const guest2 = (await join2.json()) as JamSession;
    expect(guest2.members).toHaveLength(2);
    expect(guest2.token).toBe(guest1.token);

    // Connect WebSocket on old code so we verify broadcast + 4001 close code on rotateInvite
    const wsRes = await upgradeCloudflareWebSocket(cloud, created.code, guest2.token);
    expect(wsRes.status).toBe(200);
    const guestSock = cloud.sockets(created.code)[0]!;

    // Guest cannot rotate invite
    const forbiddenRotate = await cloud.fetch(
      workerJamRequest({
        action: 'rotateInvite',
        code: created.code,
        token: guest2.token,
        nonce: `worker_rotate_forbid_${++workerNonceSequence}`,
        timestamp: cloud.clock.now,
      }),
    );
    expect(forbiddenRotate.status).toBe(403);

    // Host rotates invite
    const rotateRes = await cloud.fetch(
      workerJamRequest({
        action: 'rotateInvite',
        code: created.code,
        token: created.token,
        inviteTtlMs: 180000,
        nonce: `worker_rotate_ok_${++workerNonceSequence}`,
        timestamp: cloud.clock.now,
      }),
    );
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as JamRoom;
    expect(rotated.code).not.toBe(created.code);
    expect(rotated.members).toHaveLength(2);

    // Connected socket got the updated room code broadcast and closed cleanly with 4001 (not 1008)
    expect(guestSock.sent.some(msg => msg.includes(rotated.code))).toBe(true);
    expect(guestSock.closeCode).toBe(4001);

    // Old code returns INVITE_EXPIRED tombstone
    const oldLookup = await cloud.fetch(
      workerJamRequest({ action: 'lookup', code: created.code }),
    );
    expect(oldLookup.status).toBe(410);
    expect(((await oldLookup.json()) as { errorCode?: string }).errorCode).toBe('INVITE_EXPIRED');

    // Cold-restart new DO instance from storage and verify state, lookup, poll, and WS upgrade work on newCode
    cloud.restart(rotated.code);
    const newLookup = await cloud.fetch(
      workerJamRequest({ action: 'lookup', code: rotated.code }),
    );
    expect(newLookup.status).toBe(200);
    expect(((await newLookup.json()) as JamInvitePreview).roomName).toBe('Sala DO');

    const newPoll = await cloud.fetch(
      workerJamRequest({
        action: 'poll',
        code: rotated.code,
        token: guest2.token,
        nonce: `worker_poll_rot_${++workerNonceSequence}`,
        timestamp: cloud.clock.now,
      }),
    );
    expect(newPoll.status).toBe(200);
    expect(((await newPoll.json()) as JamRoom).code).toBe(rotated.code);

    const wsResNew = await upgradeCloudflareWebSocket(cloud, rotated.code, guest2.token);
    expect(wsResNew.status).toBe(200);
  });
});
