import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../shared/auth';
import {
  computePkceS256Challenge,
  createBroker,
  hashPasswordArgon2id,
  verifyPasswordArgon2id,
  verifyPasswordArgon2idAsync,
  ZeroTrustAuthEngine,
  type Argon2AsyncAdapter,
} from '../../server/broker';

const TEST_ARGON2 = { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function credentialPayload(username: string, password: string) {
  return {
    username,
    password,
    client_id: 'liquid-hub-desktop',
    code_challenge: computePkceS256Challenge(randomBytes(48).toString('base64url')),
    code_challenge_method: 'S256',
  };
}

function mockSoundcloudFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'platform-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3600,
        }),
      ),
    )
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            collection: [
              {
                id: 123,
                urn: 'soundcloud:tracks:123',
                title: 'Public song',
                duration: 1000,
                user: { username: 'Artist' },
                permalink_url: 'https://soundcloud.com/artist/public-song',
                access: 'playable',
              },
            ],
          }),
        ),
    );
}

describe('Zero-Trust Broker & Auth Engine', () => {
  it('authenticates desktop clients, keeps secrets server-side and reuses OAuth tokens', async () => {
    const api = mockSoundcloudFetch();
    const secret = 'test-personal-broker-token-123456';
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: secret,
        SOUNDCLOUD_CLIENT_ID: 'client-id',
        SOUNDCLOUD_CLIENT_SECRET: 'client-secret',
      },
      api as typeof fetch,
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}/search?q=test&kind=track`;
      expect((await fetch(url)).status).toBe(401);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      const raw = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get('x-service')).toBe('liquid-hub-broker');
      expect(raw).toContain('Public song');
      expect(raw).not.toContain('platform-secret');
      expect(raw).not.toContain('client-secret');
      await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      expect(api.mock.calls.filter(c => String(c[0]).includes('/oauth/token'))).toHaveLength(1);
      expect((api.mock.calls[0][1] as RequestInit).headers).toHaveProperty(
        'Authorization',
        'Basic ' + Buffer.from('client-id:client-secret').toString('base64'),
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('hashes credentials with Argon2id, enforces PKCE S256 and signs 15-minute Ed25519 JWTs verifiable via JWKS', async () => {
    const encoded = hashPasswordArgon2id('StrongPassword#2026!', { memory: 16384, passes: 2 });
    expect(encoded.startsWith('$argon2id$v=19$')).toBe(true);
    expect(verifyPasswordArgon2id('StrongPassword#2026!', encoded)).toBe(true);
    expect(verifyPasswordArgon2id('WrongPassword#2026!', encoded)).toBe(false);
    expect(await verifyPasswordArgon2idAsync('StrongPassword#2026!', encoded)).toBe(true);
    expect(await verifyPasswordArgon2idAsync('WrongPassword#2026!', encoded)).toBe(false);

    const api = mockSoundcloudFetch();
    let now = Date.now();
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'owner-static-broker-secret-token-9999',
        SOUNDCLOUD_CLIENT_ID: 'client-id',
        SOUNDCLOUD_CLIENT_SECRET: 'client-secret',
      },
      api as typeof fetch,
      () => now,
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = computePkceS256Challenge(verifier);

      // Rejects registration without S256 PKCE or with unknown extra fields
      const badMethod = await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'alice_zero',
          password: 'SuperSecretPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'plain',
        }),
      });
      expect(badMethod.status).toBe(400);

      const extraField = await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'alice_zero',
          password: 'SuperSecretPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          role: 'admin',
        }),
      });
      expect(extraField.status).toBe(400);

      // Valid Argon2id registration + PKCE S256 challenge
      const reg = await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'alice_zero',
          password: 'SuperSecretPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      });
      expect(reg.status).toBe(201);
      const { code } = (await reg.json()) as { code: string };
      expect(typeof code).toBe('string');

      // Wrong PKCE verifier is rejected with 401
      const wrongVerifier = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: 'liquid-hub-desktop',
          code_verifier: randomBytes(48).toString('base64url'),
        }),
      });
      expect(wrongVerifier.status).toBe(401);

      // Valid PKCE S256 token exchange issues 15-min Ed25519 JWT + opaque refresh token
      const tokenRes = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: 'liquid-hub-desktop',
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const session = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
      };
      expect(session.token_type).toBe('Bearer');
      expect(session.expires_in).toBe(900);

      // Cryptographically verify Ed25519 JWT against /.well-known/jwks.json
      const jwksRes = await fetch(`${base}/.well-known/jwks.json`);
      expect(jwksRes.status).toBe(200);
      const { keys } = (await jwksRes.json()) as {
        keys: Array<{ kty: string; crv: string; x: string; alg: string }>;
      };
      expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });

      const [hB64, pB64, sigB64] = session.access_token.split('.');
      const pubKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: keys[0].x },
        format: 'jwk',
      });
      expect(
        verify(
          null,
          Buffer.from(`${hB64}.${pB64}`, 'utf8'),
          pubKey,
          Buffer.from(sigB64, 'base64url'),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8')) as {
        exp: number;
        iat: number;
        iss: string;
        aud: string;
      };
      expect(claims.exp - claims.iat).toBe(900);
      expect(claims.iss).toBe('liquid-hub-auth');
      expect(claims.aud).toBe('liquid-hub-desktop');

      // Authorized search succeeds before 15m TTL and fails once 15m TTL elapses
      const okSearch = await fetch(`${base}/search?q=daft&kind=track`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      expect(okSearch.status).toBe(200);

      now += 15 * 60 * 1000 + 2000;
      const expiredSearch = await fetch(`${base}/search?q=daft&kind=track`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      expect(expiredSearch.status).toBe(401);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rotates Refresh Tokens strictly and revokes the entire token family immediately upon reuse', async () => {
    const api = mockSoundcloudFetch();
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'owner-static-broker-secret-token-9999',
        SOUNDCLOUD_CLIENT_ID: 'client-id',
        SOUNDCLOUD_CLIENT_SECRET: 'client-secret',
        BROKER_ADMIN_USER: 'hub_operator',
        BROKER_ADMIN_PASSWORD: 'OperatorStrongPassword!99',
      },
      api as typeof fetch,
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = computePkceS256Challenge(verifier);

      const login = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'hub_operator',
          password: 'OperatorStrongPassword!99',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      });
      expect(login.status).toBe(200);
      const { code } = (await login.json()) as { code: string };

      const first = (await (
        await fetch(`${base}/v1/auth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            client_id: 'liquid-hub-desktop',
            code_verifier: verifier,
          }),
        })
      ).json()) as { access_token: string; refresh_token: string };

      // 1st legitimate rotation -> issues rotated pair #2
      const rotRes = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: 'liquid-hub-desktop',
        }),
      });
      expect(rotRes.status).toBe(200);
      const second = (await rotRes.json()) as { access_token: string; refresh_token: string };
      expect(second.refresh_token).not.toBe(first.refresh_token);

      // Attacker/replayed reuse of consumed refresh_token #1 -> 401 compromised_token_family
      const replayRes = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: 'liquid-hub-desktop',
        }),
      });
      expect(replayRes.status).toBe(401);
      expect(((await replayRes.json()) as { code: string }).code).toBe('compromised_token_family');

      // Entire family is now poisoned: rotated refresh_token #2 AND unexpired Ed25519 access_token #2 are BOTH rejected!
      const secondRefreshAttempt = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: second.refresh_token,
          client_id: 'liquid-hub-desktop',
        }),
      });
      expect(secondRefreshAttempt.status).toBe(401);

      const secondAccessAttempt = await fetch(`${base}/search?q=test&kind=track`, {
        headers: { Authorization: `Bearer ${second.access_token}` },
      });
      expect(secondAccessAttempt.status).toBe(401);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('enforces strict query parameter allowlists and per-IP/per-user rate limits', async () => {
    const api = mockSoundcloudFetch();
    const secret = 'rate-limit-static-broker-token-12345';
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: secret,
        SOUNDCLOUD_CLIENT_ID: 'client-id',
        SOUNDCLOUD_CLIENT_SECRET: 'client-secret',
        BROKER_REQUESTS_PER_MINUTE: '2',
      },
      api as typeof fetch,
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // Unexpected query parameter is blocked with 400
      const unexpectedParam = await fetch(`${base}/search?q=test&kind=track&debug=true`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(unexpectedParam.status).toBe(400);

      // 2nd valid call hits limit=2, 3rd call is rate-limited (429)
      const ok = await fetch(`${base}/search?q=test&kind=track`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(ok.status).toBe(200);

      const limited = await fetch(`${base}/search?q=test&kind=track`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps health responsive while an HTTP login awaits Argon2', async () => {
    const started = deferred<void>();
    const release = deferred<boolean>();
    const adapter: Argon2AsyncAdapter = {
      hash: async () => {
        throw new Error('O login não deve gerar um hash novo.');
      },
      verify: vi.fn(() => {
        started.resolve(undefined);
        return release.promise;
      }),
    };
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'owner-static-broker-secret-token-9999',
        SOUNDCLOUD_CLIENT_ID: 'client-id',
        SOUNDCLOUD_CLIENT_SECRET: 'client-secret',
        BROKER_ADMIN_USER: 'responsive_user',
        BROKER_ADMIN_PASSWORD: 'ResponsiveStrongPassword!99',
      },
      mockSoundcloudFetch() as typeof fetch,
      Date.now,
      { argon2Params: TEST_ARGON2, argon2Adapter: adapter, argon2Concurrency: 1 },
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let login: Promise<Response> | undefined;
    try {
      login = fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentialPayload('responsive_user', 'ResponsiveStrongPassword!99')),
      });
      await started.promise;

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ service: 'liquid-hub-broker', version: 2 });
      expect(adapter.verify).toHaveBeenCalledTimes(1);

      release.resolve(true);
      expect((await login).status).toBe(200);
    } finally {
      release.resolve(false);
      if (login) await login.catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('limits concurrent Argon2 operations without blocking queued authentication', async () => {
    const count = 5;
    const started = Array.from({ length: count }, () => deferred<void>());
    const gates: Array<ReturnType<typeof deferred<boolean>>> = [];
    let active = 0;
    let maxActive = 0;
    const adapter: Argon2AsyncAdapter = {
      hash: async () => {
        throw new Error('O login não deve gerar um hash novo.');
      },
      verify: vi.fn(() => {
        const index = gates.length;
        const gate = deferred<boolean>();
        gates.push(gate);
        active++;
        maxActive = Math.max(maxActive, active);
        started[index].resolve(undefined);
        return gate.promise.finally(() => {
          active--;
        });
      }),
    };
    const password = 'LimitedStrongPassword!99';
    const engine = new ZeroTrustAuthEngine({
      argon2Params: TEST_ARGON2,
      argon2Adapter: adapter,
      argon2Concurrency: 2,
    });
    engine.registerUser('limited_user', password);
    const requests = Array.from({ length: count }, () =>
      engine.authenticateCredentials(credentialPayload('limited_user', password)),
    );
    try {
      await Promise.all([started[0].promise, started[1].promise]);
      expect(gates).toHaveLength(2);
      expect(maxActive).toBe(2);

      for (let i = 0; i < count; i++) {
        gates[i].resolve(true);
        if (i + 2 < count) await started[i + 2].promise;
      }
      const issued = await Promise.all(requests);
      expect(issued.every(result => typeof result.code === 'string')).toBe(true);
      expect(adapter.verify).toHaveBeenCalledTimes(count);
      expect(maxActive).toBe(2);
    } finally {
      for (const gate of gates) gate.resolve(false);
    }
  });

  it('bounds the Argon2 waiting queue and accepts new work after it drains', async () => {
    const started = Array.from({ length: 3 }, () => deferred<void>());
    const gates: Array<ReturnType<typeof deferred<boolean>>> = [];
    const adapter: Argon2AsyncAdapter = {
      hash: async () => {
        throw new Error('O login não deve gerar um hash novo.');
      },
      verify: vi.fn(() => {
        const index = gates.length;
        const gate = deferred<boolean>();
        gates.push(gate);
        started[index].resolve(undefined);
        return gate.promise;
      }),
    };
    const password = 'BoundedStrongPassword!99';
    const engine = new ZeroTrustAuthEngine({
      argon2Params: TEST_ARGON2,
      argon2Adapter: adapter,
      argon2Concurrency: 1,
      argon2QueueSize: 1,
    });
    engine.registerUser('bounded_user', password);
    const first = engine.authenticateCredentials(credentialPayload('bounded_user', password));
    const second = engine.authenticateCredentials(credentialPayload('bounded_user', password));
    try {
      await started[0].promise;
      await expect(
        engine.authenticateCredentials(credentialPayload('bounded_user', password)),
      ).rejects.toMatchObject({ status: 503, code: 'service_busy' });
      expect(adapter.verify).toHaveBeenCalledTimes(1);

      gates[0].resolve(true);
      await started[1].promise;
      const recovered = engine.authenticateCredentials(credentialPayload('bounded_user', password));
      gates[1].resolve(true);
      await started[2].promise;
      gates[2].resolve(true);

      const recoveredResults = await Promise.all([first, second, recovered]);
      expect(recoveredResults.every(result => typeof result.code === 'string')).toBe(true);
      expect(adapter.verify).toHaveBeenCalledTimes(3);
    } finally {
      for (const gate of gates) gate.resolve(false);
    }
  });

  it('rechecks a username after async hashing and never overwrites a simultaneous registration', async () => {
    const firstPassword = 'FirstStrongPassword!99';
    const secondPassword = 'SecondStrongPassword!99';
    const firstHash = hashPasswordArgon2id(firstPassword, TEST_ARGON2);
    const secondHash = hashPasswordArgon2id(secondPassword, TEST_ARGON2);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstRelease = deferred<string>();
    const secondRelease = deferred<string>();
    const adapter: Argon2AsyncAdapter = {
      hash: vi.fn((password: string) => {
        if (password === firstPassword) {
          firstStarted.resolve(undefined);
          return firstRelease.promise;
        }
        secondStarted.resolve(undefined);
        return secondRelease.promise;
      }),
      verify: verifyPasswordArgon2idAsync,
    };
    const engine = new ZeroTrustAuthEngine({
      argon2Params: TEST_ARGON2,
      argon2Adapter: adapter,
      argon2Concurrency: 2,
    });
    const firstRegistration = engine.authenticateCredentials(
      credentialPayload('race_user', firstPassword),
      true,
    );
    const secondRegistration = engine.authenticateCredentials(
      credentialPayload('race_user', secondPassword),
      true,
    );
    const registrations = Promise.allSettled([firstRegistration, secondRegistration]);
    try {
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      firstRelease.resolve(firstHash);
      await expect(firstRegistration).resolves.toMatchObject({ code: expect.any(String) });
      secondRelease.resolve(secondHash);

      const [, second] = await registrations;
      expect(second.status).toBe('rejected');
      if (second.status === 'rejected') {
        expect(second.reason).toMatchObject({ status: 409, code: 'user_exists' });
      }
      await expect(
        engine.authenticateCredentials(credentialPayload('race_user', firstPassword)),
      ).resolves.toMatchObject({ code: expect.any(String) });
      await expect(
        engine.authenticateCredentials(credentialPayload('race_user', secondPassword)),
      ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    } finally {
      firstRelease.resolve(firstHash);
      secondRelease.resolve(secondHash);
    }
  });
});

interface MockOAuthBehavior {
  mode?: 'approve' | 'cancel';
  id: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  avatar?: string | null;
  privateGithubEmailsForbidden?: boolean;
}

async function startMockOAuthProvider(provider: 'discord' | 'github', initial: MockOAuthBehavior) {
  let behavior = initial;
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/authorize') {
      const redirectUri = u.searchParams.get('redirect_uri')!;
      const state = u.searchParams.get('state')!;
      const target = new URL(redirectUri);
      target.searchParams.set('state', state);
      if (behavior.mode === 'cancel') {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'Usuário cancelou no provedor');
      } else {
        target.searchParams.set('code', `mock_code_${behavior.id}_${Date.now()}`);
      }
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ access_token: `mock_tok_${behavior.id}`, token_type: 'Bearer' }),
      );
      return;
    }
    if (req.method === 'GET' && u.pathname === '/user') {
      if (provider === 'discord') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: behavior.id,
            username: behavior.username,
            global_name: behavior.displayName ?? null,
            avatar: behavior.avatar ?? null,
            email: behavior.email ?? null,
            verified: behavior.emailVerified ?? Boolean(behavior.email),
          }),
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: Number(behavior.id) || behavior.id,
            login: behavior.username,
            name: behavior.displayName ?? null,
            avatar_url: behavior.avatar ?? null,
            email: behavior.privateGithubEmailsForbidden ? null : (behavior.email ?? null),
          }),
        );
      }
      return;
    }
    if (req.method === 'GET' && u.pathname === '/user/emails') {
      if (behavior.privateGithubEmailsForbidden) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Forbidden' }));
        return;
      }
      const list = behavior.email
        ? [{ email: behavior.email, primary: true, verified: behavior.emailVerified ?? true }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    setBehavior(next: MockOAuthBehavior) {
      behavior = next;
    },
    config() {
      return {
        clientId: `${provider}_client_id`,
        clientSecret: `${provider}_super_secret`,
        authorizeUrl: `${base}/authorize`,
        tokenUrl: `${base}/token`,
        userInfoUrl: `${base}/user`,
        emailsUrl: `${base}/user/emails`,
      };
    },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

async function runHttpOAuthPkce(input: {
  brokerUrl: string;
  provider: 'discord' | 'github';
  mode?: 'login' | 'link';
  bearerToken?: string;
  terms?: boolean;
}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computePkceS256Challenge(verifier);
  const state = randomBytes(24).toString('base64url');
  const redirectUri = 'http://127.0.0.1:49999/callback';

  const startRes = await fetch(`${input.brokerUrl}/v1/auth/oauth/${input.provider}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(input.bearerToken ? { Authorization: `Bearer ${input.bearerToken}` } : {}),
    },
    body: JSON.stringify({
      provider: input.provider,
      client_id: 'liquid-hub-desktop',
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      mode: input.mode || 'login',
      ...(input.terms
        ? { termsVersion: CURRENT_TERMS_VERSION, privacyVersion: CURRENT_PRIVACY_VERSION }
        : {}),
    }),
  });
  expect(startRes.status).toBe(200);
  const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };

  const authHop = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authHop.status).toBe(302);
  const brokerCallbackUrl = authHop.headers.get('location')!;
  const cbHop = await fetch(brokerCallbackUrl, { redirect: 'manual' });
  expect(cbHop.status).toBe(302);
  const finalRedirect = new URL(cbHop.headers.get('location')!);
  expect(finalRedirect.origin + finalRedirect.pathname).toBe(redirectUri);
  expect(finalRedirect.searchParams.get('state')).toBe(state);

  const err = finalRedirect.searchParams.get('error');
  if (err) {
    return {
      ok: false as const,
      error: err,
      description: finalRedirect.searchParams.get('error_description') || '',
    };
  }
  const code = finalRedirect.searchParams.get('code')!;
  const tokenRes = await fetch(`${input.brokerUrl}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: 'liquid-hub-desktop',
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as any;
  return { ok: true as const, tokens };
}

describe('Multi-Provider Identity, OAuth & SQLite Persistence', () => {
  it('supports email signup, verification, email/username login, and password recovery revoking old sessions', async () => {
    const emails: Array<{ kind: string; to: string; token: string }> = [];
    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'owner-secret-token-value-123456',
        SOUNDCLOUD_CLIENT_ID: 'sc_id',
        SOUNDCLOUD_CLIENT_SECRET: 'sc_secret',
      },
      mockSoundcloudFetch(),
      Date.now,
      {
        argon2Params: TEST_ARGON2,
        onAuthEmail: msg => {
          emails.push({ kind: msg.kind, to: msg.to, token: msg.token });
        },
      },
    );
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = computePkceS256Challenge(verifier);
      const regRes = await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'Maria.Silva@Example.COM',
          displayName: 'Maria Silva',
          password: 'StrongEmailPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          termsVersion: CURRENT_TERMS_VERSION,
          privacyVersion: CURRENT_PRIVACY_VERSION,
        }),
      });
      expect(regRes.status).toBe(201);
      const regData = (await regRes.json()) as any;
      expect(regData.user.email).toBe('maria.silva@example.com');
      expect(regData.user.emailVerified).toBe(false);
      expect(regData.user.needsTermsAcceptance).toBe(false);
      expect(emails).toHaveLength(1);
      expect(emails[0].kind).toBe('verify_email');

      const tokRes = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: regData.code,
          client_id: 'liquid-hub-desktop',
          code_verifier: verifier,
        }),
      });
      const sess1 = (await tokRes.json()) as any;
      expect(sess1.access_token).toBeTruthy();

      // Verify email token (single-use)
      const verifyOk = await fetch(`${base}/v1/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: emails[0].token }),
      });
      expect(verifyOk.status).toBe(200);
      const verifyBody = (await verifyOk.json()) as any;
      expect(verifyBody.user.emailVerified).toBe(true);

      const reuseVerify = await fetch(`${base}/v1/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: emails[0].token }),
      });
      expect(reuseVerify.status).toBe(400);

      // Login using email directly
      const v2 = randomBytes(32).toString('base64url');
      const loginByEmail = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'maria.silva@example.com',
          password: 'StrongEmailPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: computePkceS256Challenge(v2),
          code_challenge_method: 'S256',
        }),
      });
      expect(loginByEmail.status).toBe(200);

      // Password recovery flow revokes old refresh token family
      const forgotRes = await fetch(`${base}/v1/auth/password/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'maria.silva@example.com' }),
      });
      expect(forgotRes.status).toBe(200);
      const resetEmail = emails.find(e => e.kind === 'reset_password')!;
      expect(resetEmail).toBeTruthy();

      const resetRes = await fetch(`${base}/v1/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: resetEmail.token,
          newPassword: 'BrandNewStrongPassword!99',
        }),
      });
      expect(resetRes.status).toBe(200);

      // Old refresh token is revoked after password reset
      const oldRefresh = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: sess1.refresh_token,
          client_id: 'liquid-hub-desktop',
        }),
      });
      expect(oldRefresh.status).toBe(401);

      // Old password fails, new password succeeds
      const oldPwRes = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'maria.silva@example.com',
          password: 'StrongEmailPassword!2026',
          client_id: 'liquid-hub-desktop',
          code_challenge: computePkceS256Challenge(v2),
          code_challenge_method: 'S256',
        }),
      });
      expect(oldPwRes.status).toBe(401);

      const newPwRes = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'maria.silva@example.com',
          password: 'BrandNewStrongPassword!99',
          client_id: 'liquid-hub-desktop',
          code_challenge: computePkceS256Challenge(v2),
          code_challenge_method: 'S256',
        }),
      });
      expect(newPwRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('handles Discord/GitHub OAuth, private/missing emails, cancellation, anti-auto-merge, linking, cross-user rejection & SQLite persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-broker-db-'));
    const dbPath = join(dir, 'broker.sqlite');
    const keypair = generateKeyPairSync('ed25519');
    const privateKeyPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const discord = await startMockOAuthProvider('discord', {
      id: '9001001',
      username: 'discord_kai',
      displayName: 'Kai Discord',
      email: null,
      avatar: 'a_hash123',
    });
    const github = await startMockOAuthProvider('github', {
      id: '7002002',
      username: 'gh_kai',
      displayName: 'Kai GitHub',
      email: null,
      privateGithubEmailsForbidden: true,
      avatar: 'https://avatars.githubusercontent.com/u/7002002?v=4',
    });

    const server = createBroker(
      {
        BROKER_ACCESS_TOKEN: 'owner-secret-token-value-123456',
        BROKER_ED25519_PRIVATE_KEY: privateKeyPem,
        BROKER_REQUESTS_PER_MINUTE: '300',
        BROKER_AUTH_REQUESTS_PER_MINUTE: '100',
        SOUNDCLOUD_CLIENT_ID: 'sc_id',
        SOUNDCLOUD_CLIENT_SECRET: 'sc_secret',
      },
      mockSoundcloudFetch(),
      Date.now,
      {
        dbPath,
        argon2Params: TEST_ARGON2,
        discord: discord.config(),
        github: github.config(),
      },
    );
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      // 1. Discord without email (Scenario 7) + deferred Terms acceptance
      const discordLogin = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'discord',
        terms: false,
      });
      expect(discordLogin.ok).toBe(true);
      if (!discordLogin.ok) throw new Error('expected ok');
      const user1 = discordLogin.tokens.user;
      expect(user1.email).toBeNull();
      expect(user1.displayName).toBe('Kai Discord');
      expect(user1.avatarUrl).toContain('cdn.discordapp.com/avatars/9001001');
      expect(user1.needsTermsAcceptance).toBe(true);

      // Cannot unlink sole provider
      const denyUnlinkSole = await fetch(`${base}/v1/auth/identities/discord`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${discordLogin.tokens.access_token}` },
      });
      expect(denyUnlinkSole.status).toBe(400);
      expect(((await denyUnlinkSole.json()) as any).code).toBe('cannot_unlink_last_method');

      // Explicit Terms acceptance records version and clears needsTermsAcceptance
      const termsRes = await fetch(`${base}/v1/auth/terms/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${discordLogin.tokens.access_token}`,
        },
        body: JSON.stringify({
          termsVersion: CURRENT_TERMS_VERSION,
          privacyVersion: CURRENT_PRIVACY_VERSION,
        }),
      });
      expect(termsRes.status).toBe(200);
      const acceptedUser = (await termsRes.json()) as any;
      expect(acceptedUser.termsVersion).toBe(CURRENT_TERMS_VERSION);
      expect(acceptedUser.privacyVersion).toBe(CURRENT_PRIVACY_VERSION);
      expect(typeof acceptedUser.termsAcceptedAt).toBe('number');
      expect(acceptedUser.needsTermsAcceptance).toBe(false);

      // 2. Link GitHub (with private email 403!) to Kai's central account (Scenario 6 & 8)
      const linkedGh = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'github',
        mode: 'link',
        bearerToken: discordLogin.tokens.access_token,
      });
      expect(linkedGh.ok).toBe(true);
      if (!linkedGh.ok) throw new Error('expected linked github');
      expect(linkedGh.tokens.user.userId).toBe(user1.userId);
      expect(linkedGh.tokens.user.identities.map((i: any) => i.provider)).toEqual([
        'discord',
        'github',
      ]);

      // Logging in via GitHub now resolves to the SAME central user!
      const ghRelogin = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'github',
        mode: 'login',
      });
      expect(ghRelogin.ok).toBe(true);
      if (!ghRelogin.ok) throw new Error('expected gh relogin');
      expect(ghRelogin.tokens.user.userId).toBe(user1.userId);

      // 3. OAuth cancellation (Scenario 5)
      discord.setBehavior({
        mode: 'cancel',
        id: '9999999',
        username: 'canceled',
      });
      const canceled = await runHttpOAuthPkce({ brokerUrl: base, provider: 'discord' });
      expect(canceled.ok).toBe(false);
      if (!canceled.ok) expect(canceled.error).toBe('access_denied');

      // 4. Separate user creation & anti-hijacking rules (Scenario 9 + anti-auto-merge)
      discord.setBehavior({
        id: '9008888',
        username: 'devuser',
        displayName: 'Bob Distinct',
        email: 'bob@liquidhub.dev',
        emailVerified: true,
      });
      const bobRes = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'discord',
        terms: true,
      });
      expect(bobRes.ok).toBe(true);
      if (!bobRes.ok) throw new Error('expected bob');
      expect(bobRes.tokens.user.userId).not.toBe(user1.userId);

      // Bob tries to link Kai's already-linked GitHub -> REJECTED (Scenario 9)
      const crossLink = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'github',
        mode: 'link',
        bearerToken: bobRes.tokens.access_token,
      });
      expect(crossLink.ok).toBe(false);
      if (!crossLink.ok) expect(crossLink.error).toBe('identity_already_linked');

      // New GitHub user with same email as Bob AND matching username 'devuser' -> REJECTED for email collision (no auto-merge)
      github.setBehavior({
        id: '7009999',
        username: 'devuser',
        displayName: 'Impostor',
        email: 'bob@liquidhub.dev',
        emailVerified: true,
      });
      const autoMergeAttempt = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'github',
        terms: true,
      });
      expect(autoMergeAttempt.ok).toBe(false);
      if (!autoMergeAttempt.ok) expect(autoMergeAttempt.error).toBe('account_exists_link_required');

      // New GitHub user with SAME username 'devuser' but DIFFERENT email -> creates separate user (no username auto-merge)
      github.setBehavior({
        id: '7005555',
        username: 'devuser',
        displayName: 'Different Owner',
        email: 'charlie@liquidhub.dev',
        emailVerified: true,
      });
      const charlieRes = await runHttpOAuthPkce({
        brokerUrl: base,
        provider: 'github',
        terms: true,
      });
      expect(charlieRes.ok).toBe(true);
      if (!charlieRes.ok) throw new Error('expected charlie');
      expect(charlieRes.tokens.user.userId).not.toBe(bobRes.tokens.user.userId);
      expect(charlieRes.tokens.user.username).not.toBe(bobRes.tokens.user.username);

      // 5. SQLite Persistence across broker restart!
      await new Promise<void>(r => server.close(() => r()));

      const server2 = createBroker(
        {
          BROKER_ACCESS_TOKEN: 'owner-secret-token-value-123456',
          BROKER_ED25519_PRIVATE_KEY: privateKeyPem,
          SOUNDCLOUD_CLIENT_ID: 'sc_id',
          SOUNDCLOUD_CLIENT_SECRET: 'sc_secret',
        },
        mockSoundcloudFetch(),
        Date.now,
        {
          dbPath,
          argon2Params: TEST_ARGON2,
          discord: discord.config(),
          github: github.config(),
        },
      );
      await new Promise<void>(r => server2.listen(0, '127.0.0.1', r));
      const base2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;
      try {
        // Refresh token minted by server 1 STILL rotates on server 2 with same SQLite DB!
        const rotRes = await fetch(`${base2}/v1/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: ghRelogin.tokens.refresh_token,
            client_id: 'liquid-hub-desktop',
          }),
        });
        expect(rotRes.status).toBe(200);
        const rotBody = (await rotRes.json()) as any;
        expect(rotBody.user.userId).toBe(user1.userId);
        expect(rotBody.user.identities.map((i: any) => i.provider)).toEqual([
          'discord',
          'github',
        ]);
      } finally {
        server2.close();
      }
    } finally {
      server.close();
      await discord.close();
      await github.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
