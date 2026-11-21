import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
