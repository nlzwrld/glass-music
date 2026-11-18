import { describe, expect, it, vi } from 'vitest';
import { createJam } from '../../server/jam';
import { computeBackoffMs, JamClient, JamClock, type JamSend } from '../../src/lib/jam';
import { canJam, jamDriftMs, jamPosition, type JamRoom } from '../../shared/jam';
import type { Track } from '../../shared/types';

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

async function withServer(
  run: (
    send: JamSend,
    raw: (body: unknown, headers?: Record<string, string>) => Promise<Response>,
    clock: { now: number },
  ) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const clock = { now: Date.now() },
    server = createJam(env, () => clock.now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/jam`, {
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
    await run(send, raw, clock);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('JAM coordinator and two independent clients', () => {
  it('follows host track, play, pause, seek and next without sharing private session tokens', async () => {
    await withServer(async (send, raw, clock) => {
      const host = new JamClient(send),
        friend = new JamClient(send);
      const h = await host.enter('create', 'Casa');
      const f = await friend.enter('join', 'Amigo', h.code);
      expect(h.code).toMatch(/^[A-F0-9]{10}$/);
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
      code: '1122334455',
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
      code: '1122334455',
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
      code: '0000000000',
      members: [],
      serverTime: 1000,
      playback: { track: song, playing: true, position: 179.5, updatedAt: 1000, sequence: 1 },
    };
    expect(jamPosition(room.playback, 900000)).toBe(180);
    expect(jamPosition({ ...room.playback, playing: false }, 900000)).toBe(179.5);
    expect(jamPosition({ ...room.playback, position: 0 }, 0)).toBe(0);
  });
});
