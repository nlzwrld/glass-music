import { describe, expect, it, vi } from 'vitest';
import {
  handleCloudflareJamFetch,
  JamRoomDO,
  type CfDurableObjectState,
  type CfJamEnv,
} from '../../server/jam';
import {
  JamClient,
  jamWebSocketUrl,
  shouldHostSync,
  type HostSyncSnapshot,
} from '../../src/lib/jam';
import type { Track } from '../../shared/types';

const song: Track = {
  id: 'youtube:dQw4w9WgXcQ',
  source: 'youtube',
  sourceId: 'dQw4w9WgXcQ',
  kind: 'track',
  title: 'Cloud Sync Track',
  artist: 'Liquid Hub',
  duration: 213,
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  addedAt: 0,
};

let seq = 0;
function req(body: Record<string, unknown>, ip = '198.51.100.77') {
  const stamped = {
    nonce: `cloud_unit_${++seq}_${'a'.repeat(16)}`,
    timestamp: Date.now(),
    ...body,
  };
  return new Request('https://liquid-hub-jam.workers.dev/v1/jam', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(stamped),
  });
}

function makeEnv() {
  const rooms = new Map<string, JamRoomDO>();
  const deleteAlarm = vi.fn(async () => {});
  const doFetches = vi.fn();
  const dataByRoom = new Map<string, Map<string, unknown>>();
  const env: CfJamEnv = {
    JAM_ROOMS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const code = String(id);
        let room = rooms.get(code);
        if (!room) {
          const data = new Map<string, unknown>();
          dataByRoom.set(code, data);
          const state: CfDurableObjectState = {
            storage: {
              get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
              put: async <T>(key: string, value: T) => {
                data.set(key, structuredClone(value));
              },
              deleteAll: async () => {
                data.clear();
              },
              setAlarm: async () => {},
              deleteAlarm,
            },
            acceptWebSocket: () => {},
            getWebSockets: () => [],
          };
          room = new JamRoomDO(state, env);
          rooms.set(code, room);
        }
        return {
          fetch: (request: Request) => {
            doFetches(code, request.url);
            return room!.fetch(request);
          },
        };
      },
    },
  };
  return { env, deleteAlarm, doFetches, dataByRoom };
}

describe('Cloudflare JAM Worker Free-Tier hardening & zero-cost client helpers', () => {
  it('serves a strict-CSP static invite landing page on GET / and health JSON on GET /health', async () => {
    const { env } = makeEnv();
    const landing = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.workers.dev/'),
      env,
    );
    expect(landing.status).toBe(200);
    expect(landing.headers.get('Content-Type')).toContain('text/html');
    expect(landing.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await landing.text()).toContain('Liquid Hub');

    const health = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.workers.dev/health'),
      env,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      service: 'liquid-hub-jam',
      runtime: 'cloudflare-workers-do',
    });
  });

  it('rejects non-WS upgrades, malformed tokens and untrusted origins at the Worker edge before waking DOs', async () => {
    const { env, doFetches } = makeEnv();
    const validTok = 'a'.repeat(32);

    const noUpgrade = await handleCloudflareJamFetch(
      new Request(`https://liquid-hub-jam.workers.dev/v1/jam/ws?code=AABBCCDDEE&token=${validTok}`),
      env,
    );
    expect(noUpgrade.status).toBe(426);

    const badOrigin = await handleCloudflareJamFetch(
      new Request(`https://liquid-hub-jam.workers.dev/v1/jam/ws?code=AABBCCDDEE&token=${validTok}`, {
        headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
      }),
      env,
    );
    expect(badOrigin.status).toBe(403);

    const badToken = await handleCloudflareJamFetch(
      new Request('https://liquid-hub-jam.workers.dev/v1/jam/ws?code=AABBCCDDEE&token=short', {
        headers: { Upgrade: 'websocket', Origin: 'https://tauri.localhost' },
      }),
      env,
    );
    expect(badToken.status).toBe(401);

    // None of those rejected requests should wake a Durable Object.
    expect(doFetches).not.toHaveBeenCalled();

    // Trusted Tauri origin with valid token shape reaches DO (which returns 401 because room does not exist).
    const trustedOrigin = await handleCloudflareJamFetch(
      new Request(`https://liquid-hub-jam.workers.dev/v1/jam/ws?code=AABBCCDDEE&token=${validTok}`, {
        headers: { Upgrade: 'websocket', Origin: 'https://tauri.localhost' },
      }),
      env,
    );
    expect(trustedOrigin.status).toBe(401);
    expect(doFetches).toHaveBeenCalledTimes(1);
  });

  it('supports delta sinceSequence polling and clears alarms when host closes the room', async () => {
    const { env, deleteAlarm } = makeEnv();
    const created = await handleCloudflareJamFetch(
      req({ action: 'create', name: 'Host', preferredCode: '1234567890' }),
      env,
    );
    expect(created.status).toBe(201);
    const host = (await created.json()) as { token: string };

    const synced = await handleCloudflareJamFetch(
      req({
        action: 'sync',
        code: '1234567890',
        token: host.token,
        playback: { track: song, playing: true, position: 12 },
      }),
      env,
    );
    expect(synced.status).toBe(200);
    const state = (await synced.json()) as { playback: { sequence: number } };
    expect(state.playback.sequence).toBe(1);

    const delta = await handleCloudflareJamFetch(
      req({
        action: 'poll',
        code: '1234567890',
        token: host.token,
        sinceSequence: 1,
      }),
      env,
    );
    expect(delta.status).toBe(200);
    const deltaBody = (await delta.json()) as { unchanged?: boolean; playback: { track: unknown } };
    expect(deltaBody.unchanged).toBe(true);
    expect(deltaBody.playback.track).toBeNull();

    const left = await handleCloudflareJamFetch(
      req({ action: 'leave', code: '1234567890', token: host.token }),
      env,
    );
    expect(left.status).toBe(200);
    expect(deleteAlarm).toHaveBeenCalled();
  });

  it('builds valid WSS/WS URLs and suppresses redundant host syncs during smooth playback', () => {
    expect(jamWebSocketUrl('https://liquid-hub-jam.nlzezwrld.workers.dev', 'AABBCCDDEE', 'tok_123')).toBe(
      'wss://liquid-hub-jam.nlzezwrld.workers.dev/v1/jam/ws?code=AABBCCDDEE&token=tok_123',
    );
    expect(jamWebSocketUrl('http://127.0.0.1:8789', 'AABBCCDDEE', 'tok_123')).toBe(
      'ws://127.0.0.1:8789/v1/jam/ws?code=AABBCCDDEE&token=tok_123',
    );
    expect(jamWebSocketUrl('https://evil.example/path', 'AABBCCDDEE', 'tok_123')).toBeNull();
    expect(jamWebSocketUrl('https://liquid-hub-jam.workers.dev', 'INVALID', 'tok_123')).toBeNull();

    const initial: HostSyncSnapshot = { trackId: song.id, playing: true, position: 10, sentAt: 1000 };
    expect(shouldHostSync(null, { trackId: song.id, playing: true, position: 10 }, 1000)).toBe(true);
    // 5 seconds later at position 15.1s -> within 0.75s drift threshold -> NO sync needed!
    expect(shouldHostSync(initial, { trackId: song.id, playing: true, position: 15.1 }, 6000)).toBe(false);
    // User seeked forward to 45s -> sync required!
    expect(shouldHostSync(initial, { trackId: song.id, playing: true, position: 45 }, 6000)).toBe(true);
    // User paused -> sync required!
    expect(shouldHostSync(initial, { trackId: song.id, playing: false, position: 15 }, 6000)).toBe(true);
    // Track changed -> sync required!
    expect(shouldHostSync(initial, { trackId: 'youtube:other123456', playing: true, position: 0 }, 6000)).toBe(true);
  });

  it('sends lightweight poll for host keepalive when update(undefined) is called', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = new JamClient(async body => {
      sent.push(body as Record<string, unknown>);
      if ((body as Record<string, unknown>).action === 'create') {
        return {
          code: 'AABBCCDDEE',
          token: 'a'.repeat(32),
          memberId: 'host-1',
          host: true,
          members: [{ id: 'host-1', name: 'Host', host: true }],
          playback: { track: song, playing: true, position: 5, updatedAt: Date.now(), sequence: 1 },
          serverTime: Date.now(),
        } as never;
      }
      return {
        code: 'AABBCCDDEE',
        members: [{ id: 'host-1', name: 'Host', host: true }],
        playback: { track: null, playing: true, position: 5, updatedAt: Date.now(), sequence: 1 },
        unchanged: true,
        serverTime: Date.now(),
      } as never;
    });

    await client.enter('create', 'Host');
    const keepalive = await client.update(undefined);
    expect(sent.at(-1)?.action).toBe('poll');
    expect(keepalive.playback.track?.id).toBe(song.id);
  });
});
