import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../shared/auth';
import type {
  MySharedPlaylistsResponse,
  PublicUserProfile,
  SharedPlaylistDetail,
  Track,
  UserSearchItem,
} from '../../shared/types';
import { computePkceS256Challenge, createBroker } from '../../server/broker';
import { handleCloudflareJamFetch, JamRoomDO, type CfJamEnv } from '../../server/jam';
import {
  parseLiquidHubLink,
  reorderTrackIds,
  syncActiveQueueOrder,
} from '../../src/lib/playlist';

const ROOT = process.cwd();
const TEST_ARGON2 = { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 };

function makeTrack(idSuffix: string, overrides: Partial<Track> = {}): Track {
  const clean = idSuffix.padEnd(11, '0').slice(0, 11);
  return {
    id: `youtube:${clean}`,
    source: 'youtube',
    sourceId: clean,
    kind: 'track',
    title: `Faixa ${idSuffix}`,
    artist: `Artista ${idSuffix}`,
    duration: 185,
    url: `https://www.youtube.com/watch?v=${clean}`,
    addedAt: 0,
    ...overrides,
  };
}

async function withNodeBroker(
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'phase3b-broker-token-secret-value-1234',
      SOUNDCLOUD_CLIENT_ID: 'sc-test-id',
      SOUNDCLOUD_CLIENT_SECRET: 'sc-test-secret',
    },
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
    Date.now,
    { argon2Params: TEST_ARGON2 },
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function registerUserViaFetch(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  input: {
    username: string;
    email: string;
    displayName: string;
    password: string;
  },
) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computePkceS256Challenge(verifier);
  const regRes = await fetcher('/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      password: input.password,
      client_id: 'liquid-hub-desktop',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    }),
  });
  expect(regRes.status).toBe(201);
  const { code } = (await regRes.json()) as { code: string };
  const tokRes = await fetcher('/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: 'liquid-hub-desktop',
      code_verifier: verifier,
    }),
  });
  expect(tokRes.status).toBe(200);
  const session = (await tokRes.json()) as {
    access_token: string;
    user: {
      userId: string;
      username: string;
      displayName: string;
      publicHandle: string;
      email: string | null;
    };
  };
  return session;
}

describe('Phase 3B — Perfis Compartilháveis, Busca de Usuários, Playlists Compartilhadas & Colaborativas', () => {
  it('enforces unique public handles, strict privacy (public/restricted/private), and zero leak on profiles & HTML endpoints', async () => {
    await withNodeBroker(async base => {
      const fetcher = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

      const alice = await registerUserViaFetch(fetcher, {
        username: 'alice_music',
        email: 'alice.secret@example.com',
        displayName: 'Alice Waves',
        password: 'StrongPasswordAlice!2026',
      });
      const bob = await registerUserViaFetch(fetcher, {
        username: 'bob_beats',
        email: 'bob.secret@example.com',
        displayName: 'Bob Beats',
        password: 'StrongPasswordBob!2026',
      });

      expect(alice.user.publicHandle).toBeTruthy();
      expect(alice.user.publicHandle).not.toBe(alice.user.userId);
      expect(alice.user.publicHandle).not.toBe(bob.user.publicHandle);

      // Update Alice's shareable profile with custom handle, bio, socialLinks & showPublicTracks
      const updRes = await fetcher('/v1/auth/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          displayName: 'Alice <script>alert(1)</script>',
          publicHandle: 'alice.live',
          bio: 'Curadora de playlists <img onerror=x>',
          profileVisibility: 'public',
          socialLinks: {
            website: 'https://alice.example.com',
            github: 'https://github.com/alice',
          },
          showPublicTracks: true,
        }),
      });
      expect(updRes.status).toBe(200);
      const updatedUser = (await updRes.json()) as typeof alice.user;
      expect(updatedUser.publicHandle).toBe('alice.live');

      // Duplicate handle taken by Alice must reject Bob with 409
      const dupHandle = await fetcher('/v1/auth/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.access_token}`,
        },
        body: JSON.stringify({ publicHandle: 'alice.live' }),
      });
      expect(dupHandle.status).toBe(409);

      // Unsafe javascript: social link must be rejected
      const badSocial = await fetcher('/v1/auth/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          socialLinks: { website: 'javascript:alert(1)' },
        }),
      });
      expect(badSocial.status).toBe(400);

      // Alice publishes one public playlist (with a local track that must be stripped) and one private playlist
      const t1 = makeTrack('AAA11111111');
      const localTr: Track = {
        id: 'local:secret-file',
        source: 'local',
        sourceId: 'secret-file',
        kind: 'track',
        title: 'LocalOnlyTrack',
        artist: 'PrivateDisk',
        duration: 120,
        addedAt: 0,
      };
      const pubPlRes = await fetcher('/v1/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          name: 'Mix Solar <script>evil()</script>',
          description: 'Suns out',
          visibility: 'public',
          collaborative: false,
          tracks: [t1, localTr],
        }),
      });
      expect(pubPlRes.status).toBe(201);
      const pubPl = (await pubPlRes.json()) as SharedPlaylistDetail;
      expect(pubPl.tracks.map(t => t.id)).toEqual([t1.id]);

      const privPlRes = await fetcher('/v1/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          name: 'Cofre Secreto',
          visibility: 'private',
          collaborative: false,
          tracks: [makeTrack('BBB22222222')],
        }),
      });
      expect(privPlRes.status).toBe(201);
      const privPl = (await privPlRes.json()) as SharedPlaylistDetail;

      // Guest fetches Alice's public profile: no email, no userId, no private playlist, no local track
      const guestProfRes = await fetcher('/v1/profiles/alice.live');
      expect(guestProfRes.status).toBe(200);
      const guestProf = (await guestProfRes.json()) as PublicUserProfile;
      const profRaw = JSON.stringify(guestProf);
      expect(guestProf.handle).toBe('alice.live');
      expect(guestProf.publicPlaylists.map(p => p.id)).toEqual([pubPl.id]);
      expect(guestProf.publicTracks.map(t => t.id)).toEqual([t1.id]);
      expect(profRaw).not.toContain('alice.secret@example.com');
      expect(profRaw).not.toContain(alice.user.userId);
      expect(profRaw).not.toContain('Cofre Secreto');
      expect(profRaw).not.toContain('LocalOnlyTrack');

      // HTML /u/:handle and /p/:shareId escape XSS and emit CSP nonce
      const htmlProfRes = await fetcher('/u/alice.live');
      expect(htmlProfRes.status).toBe(200);
      expect(htmlProfRes.headers.get('content-security-policy')).toContain('nonce-');
      const htmlProf = await htmlProfRes.text();
      expect(htmlProf).not.toContain('<script>alert(1)</script>');
      expect(htmlProf).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(htmlProf).toContain('liquidhub://profile/alice.live');

      const htmlPlRes = await fetcher(`/p/${pubPl.id}`);
      expect(htmlPlRes.status).toBe(200);
      expect(htmlPlRes.headers.get('content-security-policy')).toContain('nonce-');
      const htmlPl = await htmlPlRes.text();
      expect(htmlPl).not.toContain('<script>evil()</script>');
      expect(htmlPl).toContain('&lt;script&gt;evil()&lt;/script&gt;');
      expect(htmlPl).toContain(`liquidhub://playlist/${pubPl.id}`);

      // Private /p/:id URL never leaks title or tracks
      const htmlPrivRes = await fetcher(`/p/${privPl.id}`);
      expect([401, 403]).toContain(htmlPrivRes.status);
      const htmlPriv = await htmlPrivRes.text();
      expect(htmlPriv).not.toContain('Cofre Secreto');

      // User Search when profileVisibility === 'public'
      const searchPublicGuest = await fetcher('/v1/users/search?q=alice');
      expect(searchPublicGuest.status).toBe(200);
      const guestUsers = ((await searchPublicGuest.json()) as { users: UserSearchItem[] }).users;
      expect(guestUsers.some(u => u.handle === 'alice.live' && u.accountType === 'user')).toBe(true);

      // Switch Alice to 'restricted': guest blocked (401) & omitted from guest search, Bob allowed (200)
      await fetcher('/v1/auth/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({ profileVisibility: 'restricted' }),
      });
      expect((await fetcher('/v1/profiles/alice.live')).status).toBe(401);
      const guestRestrictedSearch = await fetcher('/v1/users/search?q=alice');
      expect(((await guestRestrictedSearch.json()) as { users: UserSearchItem[] }).users).toEqual([]);
      expect(
        (
          await fetcher('/v1/profiles/alice.live', {
            headers: { Authorization: `Bearer ${bob.access_token}` },
          })
        ).status,
      ).toBe(200);
      const bobRestrictedSearch = await fetcher('/v1/users/search?q=alice', {
        headers: { Authorization: `Bearer ${bob.access_token}` },
      });
      expect(
        ((await bobRestrictedSearch.json()) as { users: UserSearchItem[] }).users.some(
          u => u.handle === 'alice.live',
        ),
      ).toBe(true);

      // Switch Alice to 'private': guest & Bob both rejected (403/401), excluded from search, Alice self allowed (200)
      await fetcher('/v1/auth/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({ profileVisibility: 'private' }),
      });
      expect((await fetcher('/v1/profiles/alice.live')).status).toBe(403);
      expect(
        (
          await fetcher('/v1/profiles/alice.live', {
            headers: { Authorization: `Bearer ${bob.access_token}` },
          })
        ).status,
      ).toBe(403);
      const bobPrivateSearch = await fetcher('/v1/users/search?q=alice', {
        headers: { Authorization: `Bearer ${bob.access_token}` },
      });
      expect(((await bobPrivateSearch.json()) as { users: UserSearchItem[] }).users).toEqual([]);
      expect(
        (
          await fetcher('/v1/profiles/alice.live', {
            headers: { Authorization: `Bearer ${alice.access_token}` },
          })
        ).status,
      ).toBe(200);
    });
  });

  it('supports unlisted/private links, collaborative invites, edits, optimistic concurrency 409, delta polling, revoke & leave', async () => {
    await withNodeBroker(async base => {
      const fetcher = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

      const alice = await registerUserViaFetch(fetcher, {
        username: 'dj_alice',
        email: 'djalice@example.com',
        displayName: 'DJ Alice',
        password: 'StrongPasswordAlice!2026',
      });
      const bob = await registerUserViaFetch(fetcher, {
        username: 'dj_bob',
        email: 'djbob@example.com',
        displayName: 'DJ Bob',
        password: 'StrongPasswordBob!2026',
      });

      const t1 = makeTrack('11111111111');
      const t2 = makeTrack('22222222222');
      const t3 = makeTrack('33333333333');

      // Publish unlisted collaborative playlist
      const unlistedRes = await fetcher('/v1/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          name: 'Sessão Noturna',
          visibility: 'unlisted',
          collaborative: true,
          tracks: [t1],
        }),
      });
      expect(unlistedRes.status).toBe(201);
      const unlisted = (await unlistedRes.json()) as SharedPlaylistDetail;
      // Guest can view unlisted by link, but it is hidden from Alice's public profile
      expect((await fetcher(`/v1/playlists/${unlisted.id}`)).status).toBe(200);
      const aliceProf = (await (
        await fetcher(`/v1/profiles/${alice.user.publicHandle}`)
      ).json()) as PublicUserProfile;
      expect(aliceProf.publicPlaylists).toHaveLength(0);

      // Publish private collaborative playlist
      const privRes = await fetcher('/v1/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          name: 'Colab Privada',
          visibility: 'private',
          collaborative: true,
          tracks: [t1, t2],
        }),
      });
      expect(privRes.status).toBe(201);
      const priv = (await privRes.json()) as SharedPlaylistDetail;

      // URL alone NEVER grants access to private playlist (guest = 401, uninvited Bob = 403)
      expect((await fetcher(`/v1/playlists/${priv.id}`)).status).toBe(401);
      expect(
        (
          await fetcher(`/v1/playlists/${priv.id}`, {
            headers: { Authorization: `Bearer ${bob.access_token}` },
          })
        ).status,
      ).toBe(403);

      // Invite Bob -> appears in pendingInvites -> still 403 before accept -> accept succeeds
      const invRes = await fetcher(`/v1/playlists/${priv.id}/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({ handle: bob.user.publicHandle }),
      });
      expect(invRes.status).toBe(200);

      const bobMineBefore = (await (
        await fetcher('/v1/playlists/mine', {
          headers: { Authorization: `Bearer ${bob.access_token}` },
        })
      ).json()) as MySharedPlaylistsResponse;
      expect(bobMineBefore.pendingInvites.map(p => p.id)).toContain(priv.id);

      const acceptRes = await fetcher(`/v1/playlists/${priv.id}/invites/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bob.access_token}` },
      });
      expect(acceptRes.status).toBe(200);
      const acceptedDetail = (await acceptRes.json()) as SharedPlaylistDetail;

      // Bob adds track t3 using current server version
      const addRes = await fetcher(`/v1/playlists/${priv.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.access_token}`,
        },
        body: JSON.stringify({
          op: 'addTracks',
          expectedVersion: acceptedDetail.version,
          tracks: [t3],
        }),
      });
      expect(addRes.status).toBe(200);
      const afterAdd = (await addRes.json()) as SharedPlaylistDetail;
      expect(afterAdd.version).toBe(acceptedDetail.version + 1);
      expect(afterAdd.tracks.map(t => t.id)).toEqual([t1.id, t2.id, t3.id]);

      // Bob reorders [t3, t1, t2] (v2 -> v3)
      const reorderRes = await fetcher(`/v1/playlists/${priv.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.access_token}`,
        },
        body: JSON.stringify({
          op: 'reorder',
          expectedVersion: afterAdd.version,
          trackIds: [t3.id, t1.id, t2.id],
        }),
      });
      expect(reorderRes.status).toBe(200);
      const afterReorder = (await reorderRes.json()) as SharedPlaylistDetail;
      expect(afterReorder.version).toBe(afterAdd.version + 1);
      expect(afterReorder.tracks.map(t => t.id)).toEqual([t3.id, t1.id, t2.id]);
      expect(afterReorder.activity[0]?.actorHandle).toBe(bob.user.publicHandle);

      // Optimistic concurrency: stale expectedVersion returns 409 version_conflict with latest
      const conflictRes = await fetcher(`/v1/playlists/${priv.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          op: 'removeTrack',
          expectedVersion: 1,
          trackId: t2.id,
        }),
      });
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as {
        code: string;
        latest: SharedPlaylistDetail;
      };
      expect(conflictBody.code).toBe('version_conflict');
      expect(conflictBody.latest.version).toBe(afterReorder.version);

      // Editor Bob cannot mutate playlist metadata ('meta' -> 403)
      const metaForbidden = await fetcher(`/v1/playlists/${priv.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.access_token}`,
        },
        body: JSON.stringify({
          op: 'meta',
          expectedVersion: afterReorder.version,
          visibility: 'public',
        }),
      });
      expect(metaForbidden.status).toBe(403);

      // Delta sync returns unchanged: true when sinceVersion matches current version
      const deltaRes = await fetcher(
        `/v1/playlists/${priv.id}?sinceVersion=${afterReorder.version}`,
        { headers: { Authorization: `Bearer ${alice.access_token}` } },
      );
      expect(deltaRes.status).toBe(200);
      const deltaJson = (await deltaRes.json()) as SharedPlaylistDetail;
      expect(deltaJson.unchanged).toBe(true);
      expect(deltaJson.version).toBe(afterReorder.version);

      // Remove track as Alice -> Bob revoked immediately loses access
      const remRes = await fetcher(`/v1/playlists/${priv.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({
          op: 'removeTrack',
          expectedVersion: afterReorder.version,
          trackId: t2.id,
        }),
      });
      expect(remRes.status).toBe(200);

      const revokeRes = await fetcher(
        `/v1/playlists/${priv.id}/collaborators/${bob.user.publicHandle}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${alice.access_token}` },
        },
      );
      expect(revokeRes.status).toBe(200);
      expect(
        (
          await fetcher(`/v1/playlists/${priv.id}`, {
            headers: { Authorization: `Bearer ${bob.access_token}` },
          })
        ).status,
      ).toBe(403);

      // Re-invite + accept + Bob self-leaves collaborative playlist
      await fetcher(`/v1/playlists/${priv.id}/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify({ handle: bob.user.publicHandle }),
      });
      await fetcher(`/v1/playlists/${priv.id}/invites/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bob.access_token}` },
      });
      const leaveRes = await fetcher(
        `/v1/playlists/${priv.id}/collaborators/${bob.user.publicHandle}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${bob.access_token}` },
        },
      );
      expect(leaveRes.status).toBe(200);
      expect(
        (
          await fetcher(`/v1/playlists/${priv.id}`, {
            headers: { Authorization: `Bearer ${bob.access_token}` },
          })
        ).status,
      ).toBe(403);
    });
  });

  it('maintains Cloudflare Worker + Durable Object parity for profiles, search and shared playlists', async () => {
    let authDo: JamRoomDO | null = null;
    const cfEnv: CfJamEnv = {
      BROKER_PUBLIC_URL: 'https://liquid-hub-jam.nlzezwrld.workers.dev',
      JAM_ROOMS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) => {
            if (!authDo) {
              authDo = new JamRoomDO(
                {
                  storage: {
                    get: async () => undefined,
                    put: async () => {},
                    deleteAll: async () => {},
                    setAlarm: async () => {},
                  },
                  acceptWebSocket: () => {},
                  getWebSockets: () => [],
                },
                cfEnv,
              );
            }
            return authDo.fetch(req);
          },
        }),
      },
    };

    const cfFetch = (path: string, init?: RequestInit) =>
      handleCloudflareJamFetch(
        new Request(`https://liquid-hub-jam.nlzezwrld.workers.dev${path}`, init),
        cfEnv,
      );

    const session = await registerUserViaFetch(cfFetch, {
      username: 'cf_artist_user',
      email: 'cf.user@example.com',
      displayName: 'CF Creator',
      password: 'StrongCloudPassword!2026',
    });

    const profUpdate = await cfFetch('/v1/auth/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        publicHandle: 'cf.creator',
        bio: 'Edge worker parity',
        profileVisibility: 'public',
      }),
    });
    expect(profUpdate.status).toBe(200);

    const plCreate = await cfFetch('/v1/playlists', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        name: 'CF Public List',
        visibility: 'public',
        collaborative: true,
        tracks: [makeTrack('CF123456789')],
      }),
    });
    expect(plCreate.status).toBe(201);
    const createdPl = (await plCreate.json()) as SharedPlaylistDetail;

    const getProf = await cfFetch('/v1/profiles/cf.creator');
    expect(getProf.status).toBe(200);
    const getSearch = await cfFetch('/v1/users/search?q=cf.creator');
    expect(getSearch.status).toBe(200);
    expect(((await getSearch.json()) as { users: UserSearchItem[] }).users[0]?.handle).toBe(
      'cf.creator',
    );
    const mine = await cfFetch('/v1/playlists/mine', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as MySharedPlaylistsResponse).owned.map(p => p.id)).toContain(
      createdPl.id,
    );
    expect((await cfFetch(`/u/cf.creator`)).status).toBe(200);
    expect((await cfFetch(`/p/${createdPl.id}`)).status).toBe(200);
  });

  it('reorders playlists immutably, syncs active queue & shuffle pointers, and parses deep links safely', () => {
    // reorderTrackIds
    expect(reorderTrackIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderTrackIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderTrackIds(['a', 'b'], 'a', 'a')).toBeNull();
    expect(reorderTrackIds(['a', 'b'], 'missing', 'b')).toBeNull();

    // syncActiveQueueOrder preserves playing track and remaps shuffle indices
    const tA = makeTrack('aaaaaaaaaaa');
    const tB = makeTrack('bbbbbbbbbbb');
    const tC = makeTrack('ccccccccccc');
    const synced = syncActiveQueueOrder([tA, tB, tC], 1, [tC.id, tA.id, tB.id], [0, 1], 2);
    expect(synced).not.toBeNull();
    expect(synced!.queue.map(t => t.id)).toEqual([tC.id, tA.id, tB.id]);
    expect(synced!.index).toBe(2); // tB moved from index 1 to 2 without interrupting playback
    expect(synced!.shufflePlayed).toEqual([1, 2]); // tA (1), tB (2)
    expect(synced!.shuffleNext).toBe(0); // tC moved from 2 to 0

    // Different queue set must NOT be touched
    expect(
      syncActiveQueueOrder([tA, tB], 0, [tA.id, tC.id], [], null),
    ).toBeNull();

    // parseLiquidHubLink
    expect(parseLiquidHubLink('liquidhub://profile/Ana-Silva')).toEqual({
      kind: 'profile',
      handle: 'ana-silva',
    });
    expect(parseLiquidHubLink('https://liquidhub.app/u/ana.silva')).toEqual({
      kind: 'profile',
      handle: 'ana.silva',
    });
    expect(parseLiquidHubLink('liquidhub://playlist/pl_abc123def')).toEqual({
      kind: 'playlist',
      shareId: 'pl_abc123def',
    });
    expect(parseLiquidHubLink('https://liquidhub.app/p/pl_abc123def')).toEqual({
      kind: 'playlist',
      shareId: 'pl_abc123def',
    });
    expect(parseLiquidHubLink('liquidhub://profile/../admin')).toBeNull();
    expect(parseLiquidHubLink('https://liquidhub.app/u/%2e%2e/admin')).toBeNull();
    expect(parseLiquidHubLink('liquidhub://profile/a\\b')).toBeNull();
    expect(parseLiquidHubLink('javascript:alert(1)')).toBeNull();
  });

  it('wires Phase 3B UI routes, user search, verified artist badge, touch/step reordering and sharing modals', () => {
    const appSrc = readFileSync(join(ROOT, 'src/app/App.tsx'), 'utf8');
    expect(appSrc).toContain("page.startsWith('profile:')");
    expect(appSrc).toContain("page.startsWith('shared-playlist:')");
    expect(appSrc).toContain('parseLiquidHubLink');

    const searchSrc = readFileSync(join(ROOT, 'src/pages/Search.tsx'), 'utf8');
    expect(searchSrc).toContain("['user', 'Usuários']");
    expect(searchSrc).toContain('hubSearchUsers');

    const collectionSrc = readFileSync(join(ROOT, 'src/pages/Collection.tsx'), 'utf8');
    expect(collectionSrc).toContain('Artista verificado');

    const trackListSrc = readFileSync(join(ROOT, 'src/components/library/TrackList.tsx'), 'utf8');
    expect(trackListSrc).toContain('onPointerDown');
    expect(trackListSrc).toContain('ChevronUp');
    expect(trackListSrc).toContain('ChevronDown');

    const profileSrc = readFileSync(join(ROOT, 'src/pages/UserProfile.tsx'), 'utf8');
    expect(profileSrc).toContain('hubGetProfile');

    const sharedPlSrc = readFileSync(join(ROOT, 'src/pages/SharedPlaylist.tsx'), 'utf8');
    expect(sharedPlSrc).toContain('hubGetSharedPlaylist');
    expect(sharedPlSrc).toContain('hubMutateSharedPlaylist');
    expect(sharedPlSrc).toContain('hubRemoveCollaborator');

    const shareModalSrc = readFileSync(
      join(ROOT, 'src/components/library/PlaylistShareModal.tsx'),
      'utf8',
    );
    expect(shareModalSrc).toContain('hubPublishPlaylist');
    expect(shareModalSrc).toContain('hubInviteCollaborator');
  });
});
