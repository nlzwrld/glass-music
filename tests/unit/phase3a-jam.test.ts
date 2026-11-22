import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

import {
  createJam,
  handleCloudflareJamFetch,
  JamRoomDO,
  type CfDurableObjectState,
  type CfJamEnv,
} from '../../server/jam';
import {
  DEFAULT_JAM_PERMISSIONS,
  type JamJoinRequestResult,
  type JamRoom,
  type JamSession,
} from '../../shared/jam';
import type { Track } from '../../shared/types';
import { JamClient, type JamSend } from '../../src/lib/jam';
import { sanitizeJamSnapshotForWindow } from '../../src/lib/jamWindow';
import { useJam } from '../../src/components/jam/state';
import { useAccounts } from '../../src/stores/accounts';
import { useApp } from '../../src/stores/app';

const track: Track = {
  id: 'youtube:M7lc1UVf-VE',
  source: 'youtube',
  sourceId: 'M7lc1UVf-VE',
  kind: 'track',
  title: 'Test Track Phase 3A',
  artist: 'Liquid Hub',
  duration: 210,
  url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  addedAt: 0,
};

const ROOT = process.cwd();

async function withNodeJam(
  run: (ctx: {
    send: JamSend;
    raw: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
    clock: { now: number };
  }) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const clock = { now: Date.now() };
  const server = createJam(env, () => clock.now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/jam`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const send: JamSend = async <T>(body: unknown) => {
    const res = await raw(body);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json as T;
  };
  try {
    await run({ send, raw, clock });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

let cfSeq = 0;
function makeCfRequest(body: Record<string, unknown>, ip = '198.51.100.22') {
  return new Request('https://liquid-hub-jam.workers.dev/v1/jam', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({
      nonce: `cf_p3a_${++cfSeq}_${'z'.repeat(16)}`,
      timestamp: Date.now(),
      ...body,
    }),
  });
}

function makeCfEnv(): CfJamEnv {
  const rooms = new Map<string, JamRoomDO>();
  return {
    JAM_ROOMS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const key = String(id);
        let room = rooms.get(key);
        if (!room) {
          const data = new Map<string, unknown>();
          const state: CfDurableObjectState = {
            storage: {
              get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
              put: async <T>(k: string, v: T) => {
                data.set(k, structuredClone(v));
              },
              deleteAll: async () => {
                data.clear();
              },
              setAlarm: async () => {},
              deleteAlarm: async () => {},
            },
            acceptWebSocket: () => {},
            getWebSockets: () => [],
          };
          room = new JamRoomDO(state, { JAM_ROOMS: undefined as never });
          rooms.set(key, room);
        }
        return {
          fetch: (request: Request) => room!.fetch(request),
        };
      },
    },
  };
}

function signEd25519Jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  sub: string,
  nowMs: number,
) {
  const iat = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'liquid-hub-auth',
      aud: 'liquid-hub-desktop',
      sub,
      fam: 'fam_p3a',
      iat,
      exp: iat + 600,
    }),
  ).toString('base64url');
  const sig = sign(null, Buffer.from(`${header}.${claims}`, 'ascii'), privateKey).toString(
    'base64url',
  );
  return `${header}.${claims}.${sig}`;
}

describe('Phase 3A: Approval-based JAM entry, permissions & block controls (Node server)', () => {
  it('enforces approval-required entry, single-claim approval, duplicate/rate/expiration/capacity guards, block & kick separation', async () => {
    await withNodeJam(
      async ({ send, raw, clock }) => {
        const makeClientForIp = (clientIp: string) =>
          new JamClient(async <T>(body: unknown) => {
            const res = await raw(body, { 'x-liquid-client-ip': clientIp });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            return json as T;
          });

        const host = makeClientForIp('198.51.100.1');
        const h = await host.enter('create', 'Anfitrião', undefined, undefined, {
          roomName: 'Sala Segura P3A',
          clientId: 'client_host_p3a_1',
          requireApproval: true,
        });
        expect(h.requireApproval).toBe(true);
        expect(h.joinRequests).toEqual([]);

        // Invite link NEVER auto-joins when requireApproval=true
        const directAttempt = await raw(
          {
            action: 'join',
            code: h.code,
            name: 'Intruso',
            clientId: 'client_intruder_1',
          },
          { 'x-liquid-client-ip': '198.51.100.9' },
        );
        expect(directAttempt.status).toBe(403);
        expect((await directAttempt.json()).errorCode).toBe('APPROVAL_REQUIRED');

        // Requester submits join request
        const guest = makeClientForIp('198.51.100.2');
        const reqRes = await guest.requestJoin(h.code, 'Marina', undefined, {
          clientId: 'client_marina_1',
        });
        expect(reqRes.status).toBe('pending');
        expect(reqRes.requestId).toBeTruthy();
        expect(reqRes.requestToken).toBeTruthy();

        // Duplicate pending request rejected with 409 REQUEST_DUPLICATE
        const dupRes = await raw(
          {
            action: 'requestJoin',
            code: h.code,
            name: 'Marina',
            clientId: 'client_marina_1',
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect(dupRes.status).toBe(409);
        expect((await dupRes.json()).errorCode).toBe('REQUEST_DUPLICATE');

        // Host sees pending request in room state
        const hostView = await host.update();
        expect(hostView.pendingRequestCount).toBe(1);
        expect(hostView.joinRequests).toHaveLength(1);
        expect(hostView.joinRequests?.[0]?.name).toBe('Marina');

        // Pending requester approves -> receives session ONCE; second claim reports expired
        const approvedRoom = await host.approveJoin(reqRes.requestId);
        expect(approvedRoom.members).toHaveLength(2);

        // Double-approve race returns 409 REQUEST_DUPLICATE
        const doubleApprove = await raw(
          {
            action: 'approveJoin',
            code: h.code,
            token: h.token,
            requestId: reqRes.requestId,
          },
          { 'x-liquid-client-ip': '198.51.100.1' },
        );
        expect(doubleApprove.status).toBe(409);
        expect((await doubleApprove.json()).errorCode).toBe('REQUEST_DUPLICATE');

        const claim1 = await guest.checkJoinRequest(
          h.code,
          reqRes.requestId,
          reqRes.requestToken!,
        );
        expect(claim1.status).toBe('approved');
        expect(claim1.session?.memberId).toBeTruthy();
        // Host-only fields never exposed to guests
        expect(claim1.session?.joinRequests).toBeUndefined();
        expect(claim1.session?.blockedList).toBeUndefined();

        const claim2 = await raw(
          {
            action: 'checkJoinRequest',
            code: h.code,
            requestId: reqRes.requestId,
            requestToken: reqRes.requestToken,
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect((await claim2.json()).status).toBe('expired');

        // Guest cannot invoke host moderation commands
        const forbiddenApprove = await raw(
          {
            action: 'approveJoin',
            code: h.code,
            token: claim1.session!.token,
            requestId: 'jrq_fake1234',
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect(forbiddenApprove.status).toBe(403);
        expect((await forbiddenApprove.json()).errorCode).toBe('FORBIDDEN');

        // Reject without block -> status rejected, requester can request again
        const g2 = makeClientForIp('198.51.100.3');
        const r2 = await g2.requestJoin(h.code, 'Lucas', undefined, {
          clientId: 'client_lucas_1',
        });
        await host.rejectJoin(r2.requestId, false);
        const r2Check = await g2.checkJoinRequest(h.code, r2.requestId, r2.requestToken!);
        expect(r2Check.status).toBe('rejected');
        expect(r2Check.errorCode).toBe('REQUEST_REJECTED');

        // Reject WITH block -> blocks requester, unblockMember restores
        const r2Retry = await g2.requestJoin(h.code, 'Lucas', undefined, {
          clientId: 'client_lucas_1',
        });
        const afterBlock = await host.rejectJoin(r2Retry.requestId, true);
        expect(afterBlock.blockedList?.length).toBe(1);
        const r2BlockedCheck = await g2.checkJoinRequest(
          h.code,
          r2Retry.requestId,
          r2Retry.requestToken!,
        );
        expect(r2BlockedCheck.status).toBe('blocked');
        expect(r2BlockedCheck.errorCode).toBe('BLOCKED');

        const blockedReqAttempt = await raw(
          {
            action: 'requestJoin',
            code: h.code,
            name: 'Lucas',
            clientId: 'client_lucas_1',
          },
          { 'x-liquid-client-ip': '198.51.100.3' },
        );
        expect(blockedReqAttempt.status).toBe(403);
        expect((await blockedReqAttempt.json()).errorCode).toBe('BLOCKED');

        // blockMember revokes active guest token & adds to blockedList; unblockMember restores
        const marinaId = claim1.session!.memberId;
        const roomAfterMemberBlock = await host.blockMember(marinaId);
        const marinaKey = roomAfterMemberBlock.blockedList?.find(b => b.name === 'Marina')?.key;
        expect(marinaKey).toBeTruthy();

        const marinaPoll = await raw(
          {
            action: 'poll',
            code: h.code,
            token: claim1.session!.token,
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect(marinaPoll.status).toBe(403);
        expect((await marinaPoll.json()).errorCode).toBe('KICKED');

        const marinaReReq = await raw(
          {
            action: 'requestJoin',
            code: h.code,
            name: 'Marina',
            clientId: 'client_marina_1',
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect(marinaReReq.status).toBe(403);
        expect((await marinaReReq.json()).errorCode).toBe('BLOCKED');

        await host.unblockMember(marinaKey!);
        const marinaRetry = await guest.requestJoin(h.code, 'Marina', undefined, {
          clientId: 'client_marina_1',
        });
        expect(marinaRetry.status).toBe('pending');

        // Request expiration after TTL (> 5 minutes)
        clock.now += 6 * 60 * 1000;
        const expiredRes = await raw(
          {
            action: 'checkJoinRequest',
            code: h.code,
            requestId: marinaRetry.requestId,
            requestToken: marinaRetry.requestToken,
          },
          { 'x-liquid-client-ip': '198.51.100.2' },
        );
        expect(expiredRes.status).toBe(200);
        const expiredCheck = (await expiredRes.json()) as JamJoinRequestResult;
        expect(expiredCheck.status).toBe('expired');
        expect(expiredCheck.errorCode).toBe('INVITE_EXPIRED');

        // Per-IP+room rate limit: > 6 requests/min returns 429 RATE_LIMITED
        for (let i = 0; i < 6; i++) {
          const res = await raw(
            {
              action: 'requestJoin',
              code: h.code,
              name: `Flood ${i}`,
              clientId: `client_flood_${i}_aa`,
            },
            { 'x-liquid-client-ip': '203.0.113.55' },
          );
          expect(res.status).toBe(202);
        }
        const rateErr = await raw(
          {
            action: 'requestJoin',
            code: h.code,
            name: 'Flood 7',
            clientId: 'client_flood_7_aa',
          },
          { 'x-liquid-client-ip': '203.0.113.55' },
        );
        expect(rateErr.status).toBe(429);
        expect((await rateErr.json()).errorCode).toBe('RATE_LIMITED');
        void send;
      },
      { JAM_TRUSTED_PROXY_IPS: '127.0.0.1' },
    );
  });

  it('distinguishes plain kick (KICKED) from blockMember (BLOCKED) and enforces capacity race on approve', async () => {
    await withNodeJam(
      async ({ send, raw }) => {
        const makeClientForIp = (clientIp: string) =>
          new JamClient(async <T>(body: unknown) => {
            const res = await raw(body, { 'x-liquid-client-ip': clientIp });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            return json as T;
          });

        const host = makeClientForIp('198.51.100.10');
        const h = await host.enter('create', 'Host', undefined, undefined, {
          clientId: 'cap_host_123',
          requireApproval: true,
        });

        // Plain kick returns 403 KICKED (not BLOCKED) on rejoin attempt
        const g1 = makeClientForIp('198.51.100.11');
        const r1 = await g1.requestJoin(h.code, 'G1', undefined, { clientId: 'cap_guest_001' });
        await host.approveJoin(r1.requestId);
        const c1 = await g1.checkJoinRequest(h.code, r1.requestId, r1.requestToken!);
        await host.kick(c1.session!.memberId);
        const kickedJoin = await raw(
          {
            action: 'resume',
            code: h.code,
            resumeToken: c1.session!.token,
            clientId: 'cap_guest_001',
          },
          { 'x-liquid-client-ip': '198.51.100.11' },
        );
        expect(kickedJoin.status).toBe(403);
        expect((await kickedJoin.json()).errorCode).toBe('KICKED');

        // Fill 6 of the 7 remaining guest seats (total = 7/8)
        for (let i = 2; i <= 7; i++) {
          const gi = makeClientForIp(`198.51.100.${10 + i}`);
          const req = await gi.requestJoin(h.code, `Guest ${i}`, undefined, {
            clientId: `cap_guest_00${i}`,
          });
          await host.approveJoin(req.requestId);
          await gi.checkJoinRequest(h.code, req.requestId, req.requestToken!);
        }

        // Two simultaneous pending requests arrive for the last remaining seat
        const g8 = makeClientForIp('198.51.100.28');
        const g9 = makeClientForIp('198.51.100.29');
        const r8 = await g8.requestJoin(h.code, 'Guest 8', undefined, {
          clientId: 'cap_guest_008',
        });
        const r9 = await g9.requestJoin(h.code, 'Guest 9', undefined, {
          clientId: 'cap_guest_009',
        });

        // Approving Guest 8 succeeds (room reaches 8/8); approving Guest 9 fails with 409 ROOM_FULL
        await host.approveJoin(r8.requestId);
        const capRaceErr = await raw(
          {
            action: 'approveJoin',
            code: h.code,
            token: h.token,
            requestId: r9.requestId,
          },
          { 'x-liquid-client-ip': '198.51.100.10' },
        );
        expect(capRaceErr.status).toBe(409);
        expect((await capRaceErr.json()).errorCode).toBe('ROOM_FULL');
        void send;
      },
      { JAM_TRUSTED_PROXY_IPS: '127.0.0.1' },
    );
  });

  it('enforces server-side permissions on queueAdd, voteSkip, chat and recommendPlaylist', async () => {
    await withNodeJam(async ({ send, raw }) => {
      const host = new JamClient(send);
      const h = await host.enter('create', 'Host', undefined, undefined, {
        clientId: 'perm_host_1',
        requireApproval: true,
        permissions: {
          ...DEFAULT_JAM_PERMISSIONS,
          allowQueueAdd: false,
          allowVoteSkip: false,
          allowChat: false,
          allowRecommendations: false,
        },
      });
      const guest = new JamClient(send);
      const req = await guest.requestJoin(h.code, 'Convidado', undefined, {
        clientId: 'perm_guest_1',
      });
      await host.approveJoin(req.requestId);
      const claimed = await guest.checkJoinRequest(h.code, req.requestId, req.requestToken!);
      const gTok = claimed.session!.token;

      for (const body of [
        { action: 'queueAdd', code: h.code, token: gTok, track },
        { action: 'voteSkip', code: h.code, token: gTok },
        { action: 'chat', code: h.code, token: gTok, message: 'Bloqueado' },
        {
          action: 'recommendPlaylist',
          code: h.code,
          token: gTok,
          playlistName: 'Top',
          playlistTracks: [track],
        },
      ]) {
        const res = await raw(body);
        expect(res.status).toBe(403);
        expect((await res.json()).errorCode).toBe('FORBIDDEN');
      }

      // Host still has full control regardless of guest restrictions
      await host.queueAdd(track);
      const updated = await host.sendChat('Somente o anfitrião por enquanto');
      expect(updated.jamQueue).toHaveLength(1);
      expect(updated.messages).toHaveLength(1);

      // Host re-enables guest chat -> guest succeeds
      await host.updateRoom({ permissions: { allowChat: true } });
      await guest.sendChat('Agora liberou!');
      expect((await host.update()).messages).toHaveLength(2);
    });
  });

  it('requires Hub Ed25519 JWT on requestJoin when JAM_REQUIRE_AUTH=1', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };

    await withNodeJam(
      async ({ send, raw, clock }) => {
        const hostJwt = signEd25519Jwt(privateKey, 'user_host_01', clock.now);
        const guestJwt = signEd25519Jwt(privateKey, 'user_guest_02', clock.now);

        const authSend: JamSend = async <T>(body: unknown) => {
          const res = await raw(body, { authorization: `Bearer ${hostJwt}` });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
          return json as T;
        };

        const host = new JamClient(authSend);
        const h = await host.enter('create', 'AuthHost', undefined, undefined, {
          requireApproval: true,
        });

        const unauthReq = await raw({
          action: 'requestJoin',
          code: h.code,
          name: 'Visitante',
        });
        expect(unauthReq.status).toBe(401);
        expect((await unauthReq.json()).errorCode).toBe('AUTH_REQUIRED');

        const authReq = await raw(
          { action: 'requestJoin', code: h.code, name: 'Autenticado' },
          { authorization: `Bearer ${guestJwt}` },
        );
        expect(authReq.status).toBe(202);
        const parsedReq = (await authReq.json()) as JamJoinRequestResult;
        expect(parsedReq.status).toBe('pending');
      },
      { JAM_REQUIRE_AUTH: '1', JAM_AUTH_PUBLIC_KEY: jwk.x },
    );
  });
});

describe('Phase 3A: Cloudflare JamRoomDO approval flow, permissions & blocking', () => {
  it('enforces approval-only join, single-claim session, permissions and blockMember on Durable Object', async () => {
    const env = makeCfEnv();
    const cfSend = async (body: Record<string, unknown>, ip?: string) => {
      const res = await handleCloudflareJamFetch(makeCfRequest(body, ip), env);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const createRes = await cfSend({
      action: 'create',
      name: 'CloudHost',
      roomName: 'CF Approval Room',
      requireApproval: true,
      clientId: 'cf_host_001',
    });
    expect(createRes.status).toBe(201);
    const code = String(createRes.json.code);
    const hostTok = String(createRes.json.token);

    // Direct join blocked by APPROVAL_REQUIRED
    const directJoin = await cfSend({
      action: 'join',
      code,
      name: 'DirectGuest',
      clientId: 'cf_guest_001',
    });
    expect(directJoin.status).toBe(403);
    expect(directJoin.json.errorCode).toBe('APPROVAL_REQUIRED');

    // Request join -> host approves -> single-claim session
    const reqJoin = await cfSend({
      action: 'requestJoin',
      code,
      name: 'CloudGuest',
      clientId: 'cf_guest_001',
    });
    expect(reqJoin.status).toBe(202);
    const requestId = String(reqJoin.json.requestId);
    const requestToken = String(reqJoin.json.requestToken);

    const approve = await cfSend({
      action: 'approveJoin',
      code,
      token: hostTok,
      requestId,
    });
    expect(approve.status).toBe(200);
    expect((approve.json as unknown as JamRoom).members).toHaveLength(2);

    const claim1 = await cfSend({
      action: 'checkJoinRequest',
      code,
      requestId,
      requestToken,
    });
    expect(claim1.status).toBe(200);
    expect(claim1.json.status).toBe('approved');
    const guestSession = claim1.json.session as JamSession;
    expect(guestSession.token).toBeTruthy();

    const claim2 = await cfSend({
      action: 'checkJoinRequest',
      code,
      requestId,
      requestToken,
    });
    expect(claim2.json.status).toBe('expired');

    // Permissions enforced server-side
    await cfSend({
      action: 'updateRoom',
      code,
      token: hostTok,
      permissions: { allowChat: false },
    });
    const chatForbidden = await cfSend({
      action: 'chat',
      code,
      token: guestSession.token,
      message: 'Sem permissão',
    });
    expect(chatForbidden.status).toBe(403);
    expect(chatForbidden.json.errorCode).toBe('FORBIDDEN');

    // Block member revokes token and prevents requestJoin
    const blockedRes = await cfSend({
      action: 'blockMember',
      code,
      token: hostTok,
      memberId: guestSession.memberId,
    });
    expect(blockedRes.status).toBe(200);
    const blockKey = (blockedRes.json as unknown as JamRoom).blockedList?.[0]?.key;
    expect(blockKey).toBeTruthy();

    const blockedReq = await cfSend({
      action: 'requestJoin',
      code,
      name: 'CloudGuest',
      clientId: 'cf_guest_001',
    });
    expect(blockedReq.status).toBe(403);
    expect(blockedReq.json.errorCode).toBe('BLOCKED');

    // Unblock restores ability to request
    await cfSend({
      action: 'unblockMember',
      code,
      token: hostTok,
      blockKey,
    });
    const reRequest = await cfSend({
      action: 'requestJoin',
      code,
      name: 'CloudGuest',
      clientId: 'cf_guest_001',
    });
    expect(reRequest.status).toBe(202);
    expect(reRequest.json.status).toBe('pending');
  });
});

describe('Phase 3A: Window bridge sanitization, visitor gate & UI wiring', () => {
  it('strips session.token and requestToken across JamWindowSnapshot boundary', () => {
    const fakeSession: JamSession = {
      roomId: 'jam_123',
      code: 'ABCDEFGH',
      roomName: 'Sala Teste',
      status: 'active',
      requireApproval: true,
      maxParticipants: 8,
      inviteExpiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      members: [{ id: 'm1', name: 'Host', host: true, online: true }],
      playback: { track: null, playing: false, position: 0, updatedAt: Date.now(), sequence: 0 },
      serverTime: Date.now(),
      token: 'SECRET_SESSION_TOKEN_DO_NOT_LEAK',
      memberId: 'm1',
      host: true,
    };
    const fakeJamState = {
      ...useJam.getState(),
      session: fakeSession,
      room: fakeSession,
      pendingJoinRequest: {
        code: 'ABCDEFGH',
        requestId: 'jrq_1',
        requestToken: 'SECRET_REQUEST_TOKEN_DO_NOT_LEAK',
        roomName: 'Sala Teste',
        hostName: 'Host',
        status: 'pending' as const,
      },
    };
    const snap = sanitizeJamSnapshotForWindow(
      fakeJamState,
      useApp.getState(),
      useAccounts.getState(),
    );
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('SECRET_SESSION_TOKEN_DO_NOT_LEAK');
    expect(serialized).not.toContain('SECRET_REQUEST_TOKEN_DO_NOT_LEAK');
    expect((snap.session as unknown as Record<string, unknown>)?.token).toBeUndefined();
    expect(
      (snap.pendingJoinRequest as unknown as Record<string, unknown>)?.requestToken,
    ).toBeUndefined();
  });

  it('blocks visitors (unauthenticated accounts) from enter and requestJoin in useJam', async () => {
    useAccounts.setState(s => ({
      hub: {
        ...s.hub,
        authenticated: false,
        needsTermsAcceptance: false,
      },
    }));
    const enterOk = await useJam.getState().enter('create', 'Visitante');
    expect(enterOk).toBe(false);
    expect(useJam.getState().error).toContain('login');

    const reqOk = await useJam.getState().requestJoin('ABCDEFGH', 'Visitante');
    expect(reqOk).toBe(false);
    expect(useJam.getState().error).toContain('login');
  });

  it('wires independent JAM window across main.tsx, App.tsx, GlassPlayer, Sidebar, capabilities and removes JamSettings from Settings.tsx', () => {
    const settingsSrc = readFileSync(join(ROOT, 'src/pages/Settings.tsx'), 'utf8');
    expect(settingsSrc).not.toContain('JamSettings');

    const playerSrc = readFileSync(join(ROOT, 'src/components/player/GlassPlayer.tsx'), 'utf8');
    expect(playerSrc).toContain('openJamWindow');
    expect(playerSrc).not.toContain("setPage('settings')");

    const sidebarSrc = readFileSync(join(ROOT, 'src/components/sidebar/Sidebar.tsx'), 'utf8');
    expect(sidebarSrc).toContain('openJamWindow');

    const mainTsxSrc = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8');
    expect(mainTsxSrc).toContain("view === 'jam'");
    expect(mainTsxSrc).toContain('DetachedJam');

    const appTsxSrc = readFileSync(join(ROOT, 'src/app/App.tsx'), 'utf8');
    expect(appTsxSrc).toContain('<JamWindowBridge />');

    const caps = JSON.parse(
      readFileSync(join(ROOT, 'src-tauri/capabilities/main.json'), 'utf8'),
    ) as { windows: string[] };
    expect(caps.windows).toContain('jam');
  });
});
