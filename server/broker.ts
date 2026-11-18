/**
 * Liquid Hub — Zero-Trust Auth & Personal API Broker
 * - OAuth2 Authorization Code + Mandatory PKCE (S256)
 * - Credential Authentication with Argon2id (RFC 9106)
 * - Short-lived Ed25519 (EdDSA) Access JWTs (15 min TTL)
 * - Opaque Refresh Tokens with strict rotation & immediate token-family revocation on reuse
 * - Per-IP and Per-User-ID rate limiting & strict schema validation
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  argon2Sync,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Track } from '../shared/types.ts';
import {
  credentialLoginSchema,
  credentialRegisterSchema,
  pkceAuthorizeSchema,
  tokenGrantSchema,
} from '../shared/validation.ts';

type UpstreamToken = { access_token: string; refresh_token?: string; expires: number };

export interface EdJwtClaims {
  iss: 'liquid-hub-auth';
  aud: 'liquid-hub-desktop';
  sub: string;
  fam: string;
  jti: string;
  scope: string;
  iat: number;
  exp: number;
}

interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}

interface PendingAuthCode {
  code: string;
  userId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri?: string;
  scope: string;
  expiresAt: number;
  consumed: boolean;
  issuedFamilyId?: string;
}

interface RefreshRecord {
  tokenHash: string;
  familyId: string;
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  consumed: boolean;
}

export class BrokerHttpError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes strict TTL
const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const AUTH_CODE_TTL_MS = 60 * 1000; // 60 seconds single-use PKCE authorization code

const ARGON2_DEFAULTS = {
  memory: 65536,
  passes: 3,
  parallelism: 4,
  tagLength: 32,
};

export function hashPasswordArgon2id(
  password: string,
  params: Partial<typeof ARGON2_DEFAULTS> = {},
): string {
  const memory = params.memory ?? ARGON2_DEFAULTS.memory;
  const passes = params.passes ?? ARGON2_DEFAULTS.passes;
  const parallelism = params.parallelism ?? ARGON2_DEFAULTS.parallelism;
  const tagLength = params.tagLength ?? ARGON2_DEFAULTS.tagLength;
  const salt = randomBytes(16);
  const tag = argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength,
  });
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${salt.toString('base64')}$${tag.toString('base64')}`;
}

export function verifyPasswordArgon2id(password: string, encoded: string): boolean {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return false;
    const kv = Object.fromEntries(
      parts[3].split(',').map(pair => {
        const [k, v] = pair.split('=');
        return [k, Number(v)];
      }),
    );
    if (!kv.m || !kv.t || !kv.p) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length < 8 || expected.length < 16) return false;
    const computed = argon2Sync('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      memory: kv.m,
      passes: kv.t,
      parallelism: kv.p,
      tagLength: expected.length,
    });
    return computed.length === expected.length && timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

export function computePkceS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class ZeroTrustAuthEngine {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;
  private readonly usersByName = new Map<string, StoredUser>();
  private readonly usersById = new Map<string, StoredUser>();
  private readonly authCodes = new Map<string, PendingAuthCode>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();
  private readonly revokedFamilies = new Set<string>();
  private readonly dummyHash: string;
  private readonly argon2Params: Partial<typeof ARGON2_DEFAULTS>;

  constructor(
    options: {
      privateKeyPem?: string;
      clock?: () => number;
      argon2Params?: Partial<typeof ARGON2_DEFAULTS>;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.argon2Params = options.argon2Params ?? { memory: 19456, passes: 2, parallelism: 1 };
    if (options.privateKeyPem) {
      this.privateKey = createPrivateKey(options.privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string };
    this.kid = createHash('sha256').update(jwk.x).digest('base64url').slice(0, 16);
    this.dummyHash = hashPasswordArgon2id('dummy-zero-trust-anti-timing-secret', this.argon2Params);
  }

  private clock: () => number;

  publicJwk() {
    const exported = this.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
    return {
      kty: exported.kty,
      crv: exported.crv,
      alg: 'EdDSA',
      use: 'sig',
      kid: this.kid,
      x: exported.x,
    };
  }

  prune() {
    const now = this.clock();
    for (const [k, v] of this.authCodes) {
      if (v.expiresAt <= now) this.authCodes.delete(k);
    }
    for (const [k, v] of this.refreshTokens) {
      if (v.expiresAt <= now) this.refreshTokens.delete(k);
    }
  }

  registerUser(username: string, password: string): StoredUser {
    const normalized = username.trim().toLowerCase();
    if (this.usersByName.has(normalized)) {
      throw new BrokerHttpError('Usuário já registrado.', 409, 'user_exists');
    }
    if (this.usersByName.size >= 10_000) {
      throw new BrokerHttpError('Capacidade de contas atingida.', 503, 'capacity_exceeded');
    }
    const user: StoredUser = {
      id: `usr_${randomBytes(12).toString('hex')}`,
      username: normalized,
      passwordHash: hashPasswordArgon2id(password, this.argon2Params),
      createdAt: this.clock(),
    };
    this.usersByName.set(normalized, user);
    this.usersById.set(user.id, user);
    return user;
  }

  authenticateCredentials(raw: unknown, autoRegister = false) {
    this.prune();
    const parsed = (autoRegister ? credentialRegisterSchema : credentialLoginSchema).safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Payload de autenticação fora do contrato.', 400, 'invalid_request');
    }
    const { username, password, client_id, code_challenge, redirect_uri } = parsed.data;
    const normalized = username.trim().toLowerCase();
    let user = this.usersByName.get(normalized);
    if (autoRegister) {
      user = this.registerUser(normalized, password);
    } else if (!user) {
      // Constant-time dummy Argon2id verification prevents username enumeration
      verifyPasswordArgon2id(password, this.dummyHash);
      throw new BrokerHttpError('Credenciais inválidas.', 401, 'invalid_credentials');
    } else if (!verifyPasswordArgon2id(password, user.passwordHash)) {
      throw new BrokerHttpError('Credenciais inválidas.', 401, 'invalid_credentials');
    }

    return this.issueAuthorizationCode({
      userId: user.id,
      clientId: client_id,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      scope: 'hub:access',
    });
  }

  authorizePkceRequest(query: Record<string, unknown>, userId: string) {
    this.prune();
    const parsed = pkceAuthorizeSchema.safeParse(query);
    if (!parsed.success) {
      throw new BrokerHttpError(
        'PKCE S256 obrigatório e parâmetros estritos exigidos.',
        400,
        'invalid_request',
      );
    }
    if (!this.usersById.has(userId)) {
      throw new BrokerHttpError('Sessão de usuário inválida.', 401, 'unauthorized');
    }
    const issued = this.issueAuthorizationCode({
      userId,
      clientId: parsed.data.client_id,
      codeChallenge: parsed.data.code_challenge,
      redirectUri: parsed.data.redirect_uri,
      scope: parsed.data.scope || 'hub:access',
    });
    return { ...issued, state: parsed.data.state };
  }

  private issueAuthorizationCode(input: {
    userId: string;
    clientId: string;
    codeChallenge: string;
    redirectUri?: string;
    scope: string;
  }) {
    if (this.authCodes.size >= 4096) {
      const oldest = this.authCodes.keys().next().value;
      if (oldest) this.authCodes.delete(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    this.authCodes.set(code, {
      code,
      userId: input.userId,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      scope: input.scope,
      expiresAt: this.clock() + AUTH_CODE_TTL_MS,
      consumed: false,
    });
    return { code, expires_in: 60 };
  }

  exchangeToken(raw: unknown) {
    this.prune();
    const parsed = tokenGrantSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Solicitação de token inválida.', 400, 'invalid_request');
    }
    const now = this.clock();

    if (parsed.data.grant_type === 'authorization_code') {
      const { code, client_id, code_verifier, redirect_uri } = parsed.data;
      const record = this.authCodes.get(code);
      if (!record || record.expiresAt <= now) {
        this.authCodes.delete(code);
        throw new BrokerHttpError('Código de autorização inválido ou expirado.', 400, 'invalid_grant');
      }
      if (record.consumed) {
        if (record.issuedFamilyId) this.revokeFamily(record.issuedFamilyId);
        this.authCodes.delete(code);
        throw new BrokerHttpError(
          'Reuso de código detectado; família de tokens invalidada.',
          401,
          'compromised_authorization_code',
        );
      }
      if (
        record.clientId !== client_id ||
        (record.redirectUri && record.redirectUri !== redirect_uri)
      ) {
        throw new BrokerHttpError('Cliente ou redirect_uri divergente.', 400, 'invalid_grant');
      }
      const computedChallenge = computePkceS256Challenge(code_verifier);
      if (!constantTimeStringEqual(computedChallenge, record.codeChallenge)) {
        throw new BrokerHttpError('Verificador PKCE S256 inválido.', 401, 'invalid_grant');
      }

      const familyId = `fam_${randomUUID()}`;
      record.consumed = true;
      record.issuedFamilyId = familyId;
      return this.mintSessionPair(record.userId, client_id, familyId, record.scope, now);
    }

    // Strict Refresh Token Rotation + Family Reuse Detection
    const { refresh_token, client_id } = parsed.data;
    const tokenHash = sha256Hex(refresh_token);
    const existing = this.refreshTokens.get(tokenHash);
    if (!existing) {
      throw new BrokerHttpError('Refresh token inválido.', 401, 'invalid_grant');
    }
    if (existing.consumed || this.revokedFamilies.has(existing.familyId)) {
      // Reuse of a rotated refresh token compromises the entire family immediately!
      this.revokeFamily(existing.familyId);
      throw new BrokerHttpError(
        'Reuso de refresh token detectado; família inteira invalidada.',
        401,
        'compromised_token_family',
      );
    }
    if (existing.expiresAt <= now || existing.clientId !== client_id) {
      this.revokeFamily(existing.familyId);
      throw new BrokerHttpError('Refresh token expirado ou cliente divergente.', 401, 'invalid_grant');
    }

    existing.consumed = true;
    return this.mintSessionPair(
      existing.userId,
      existing.clientId,
      existing.familyId,
      existing.scope,
      now,
    );
  }

  revokeFamily(familyId: string) {
    this.revokedFamilies.add(familyId);
    for (const [hash, rec] of this.refreshTokens) {
      if (rec.familyId === familyId) {
        rec.consumed = true;
        this.refreshTokens.delete(hash);
      }
    }
  }

  private mintSessionPair(
    userId: string,
    clientId: string,
    familyId: string,
    scope: string,
    nowMs: number,
  ) {
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const header = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }),
    ).toString('base64url');
    const claims: EdJwtClaims = {
      iss: 'liquid-hub-auth',
      aud: 'liquid-hub-desktop',
      sub: userId,
      fam: familyId,
      jti: randomUUID(),
      scope,
      iat,
      exp,
    };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = `${header}.${body}`;
    const signature = sign(null, Buffer.from(signingInput, 'ascii'), this.privateKey).toString(
      'base64url',
    );
    const accessToken = `${signingInput}.${signature}`;

    const rawRefresh = randomBytes(36).toString('base64url');
    const refreshHash = sha256Hex(rawRefresh);
    if (this.refreshTokens.size >= 16384) {
      const first = this.refreshTokens.keys().next().value;
      if (first) this.refreshTokens.delete(first);
    }
    this.refreshTokens.set(refreshHash, {
      tokenHash: refreshHash,
      familyId,
      userId,
      clientId,
      scope,
      expiresAt: nowMs + REFRESH_TOKEN_TTL_MS,
      consumed: false,
    });

    const user = this.usersById.get(userId);
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: rawRefresh,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope,
      subject: user?.username || userId,
      family_id: familyId,
    };
  }

  verifyAccessToken(token: string): EdJwtClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 4096) {
      throw new BrokerHttpError('JWT malformado.', 401, 'invalid_token');
    }
    let header: { alg?: string; typ?: string };
    let claims: EdJwtClaims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new BrokerHttpError('Cabeçalho ou claims JWT inválidos.', 401, 'invalid_token');
    }
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') {
      throw new BrokerHttpError('Algoritmo JWT não permitido.', 401, 'invalid_token');
    }
    const sig = Buffer.from(parts[2], 'base64url');
    const validSig = verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
      this.publicKey,
      sig,
    );
    if (!validSig) {
      throw new BrokerHttpError('Assinatura Ed25519 inválida.', 401, 'invalid_token');
    }
    const nowSec = Math.floor(this.clock() / 1000);
    if (
      claims.iss !== 'liquid-hub-auth' ||
      claims.aud !== 'liquid-hub-desktop' ||
      typeof claims.sub !== 'string' ||
      typeof claims.fam !== 'string' ||
      typeof claims.exp !== 'number' ||
      typeof claims.iat !== 'number' ||
      claims.exp - claims.iat > ACCESS_TOKEN_TTL_SECONDS ||
      claims.exp <= nowSec
    ) {
      throw new BrokerHttpError('Token expirado ou fora do escopo.', 401, 'invalid_token');
    }
    if (this.revokedFamilies.has(claims.fam)) {
      throw new BrokerHttpError('Sessão revogada por segurança.', 401, 'revoked_token');
    }
    return claims;
  }
}

export function validNext(raw: string, kind: string) {
  const u = new URL(raw);
  if (
    u.origin !== 'https://api.soundcloud.com' ||
    u.username ||
    u.password ||
    u.hash ||
    u.pathname !== `/${kind}`
  ) {
    throw new Error('Cursor inválido');
  }
  return u;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 16384): Promise<unknown> {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new BrokerHttpError('Content-Type deve ser application/json.', 415, 'unsupported_media_type');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new BrokerHttpError('Payload excede o limite.', 413, 'payload_too_large');
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
    return parsed;
  } catch {
    throw new BrokerHttpError('JSON inválido.', 400, 'invalid_json');
  }
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Service', 'liquid-hub-broker');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function createBroker(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  const secret = env.BROKER_ACCESS_TOKEN || '';
  if (secret.length < 24 || !env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) {
    throw new Error(
      'Configure SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET e BROKER_ACCESS_TOKEN (24+ caracteres) no servidor.',
    );
  }

  const auth = new ZeroTrustAuthEngine({
    privateKeyPem: env.BROKER_ED25519_PRIVATE_KEY,
    clock,
  });

  if (env.BROKER_ADMIN_USER && env.BROKER_ADMIN_PASSWORD && env.BROKER_ADMIN_PASSWORD.length >= 12) {
    try {
      auth.registerUser(env.BROKER_ADMIN_USER, env.BROKER_ADMIN_PASSWORD);
    } catch {}
  }

  let upstreamToken: UpstreamToken | undefined;
  let pendingToken: Promise<string> | undefined;

  async function soundcloudAccess(): Promise<string> {
    if (upstreamToken && upstreamToken.expires > clock() + 60000) return upstreamToken.access_token;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const body = new URLSearchParams(
        upstreamToken?.refresh_token
          ? { grant_type: 'refresh_token', refresh_token: upstreamToken.refresh_token }
          : { grant_type: 'client_credentials' },
      );
      const r = await request('https://secure.soundcloud.com/oauth/token', {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`).toString(
              'base64',
            ),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!r.ok) throw new Error('A autorização do servidor SoundCloud falhou.');
      const value = (await r.json()) as Record<string, unknown>;
      if (typeof value.access_token !== 'string') throw new Error('Resposta de autorização inválida.');
      upstreamToken = {
        access_token: value.access_token,
        refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
        expires: clock() + Number(value.expires_in || 3600) * 1000,
      };
      return upstreamToken.access_token;
    })();
    try {
      return await pendingToken;
    } finally {
      pendingToken = undefined;
    }
  }

  // Per-IP AND Per-User-ID Zero-Trust Rate Limiter
  const rateBuckets = new Map<string, { until: number; count: number }>();
  const apiLimit = Math.max(1, Math.min(600, Number(env.BROKER_REQUESTS_PER_MINUTE) || 40));
  const authLimit = Math.max(1, Math.min(120, Number(env.BROKER_AUTH_REQUESTS_PER_MINUTE) || 15));

  function enforceRateLimit(key: string, maxPerMinute: number) {
    const now = clock();
    if (rateBuckets.size >= 8192) {
      for (const [k, v] of rateBuckets) if (v.until <= now) rateBuckets.delete(k);
    }
    let state = rateBuckets.get(key);
    if (!state || state.until <= now) {
      if (rateBuckets.size >= 8192 && !state) {
        throw new BrokerHttpError('Serviço ocupado.', 503, 'service_busy');
      }
      state = { until: now + 60000, count: 0 };
      rateBuckets.set(key, state);
    }
    if (++state.count > maxPerMinute) {
      throw new BrokerHttpError('Limite de requisições atingido. Aguarde.', 429, 'rate_limited');
    }
  }

  function authenticateBearer(req: IncomingMessage): { userId: string; familyId?: string } {
    const rawHeader = req.headers.authorization || '';
    if (!rawHeader.startsWith('Bearer ')) {
      throw new BrokerHttpError('Não autorizado', 401, 'unauthorized');
    }
    const bearer = rawHeader.slice(7).trim();
    if (!bearer) throw new BrokerHttpError('Não autorizado', 401, 'unauthorized');

    // 1. Constant-time check for owner personal static token (preserves personal local broker flow)
    const providedBuf = Buffer.from(bearer, 'utf8');
    const expectedBuf = Buffer.from(secret, 'utf8');
    if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
      return { userId: 'owner:static' };
    }

    // 2. Cryptographic Ed25519 (EdDSA) short-lived JWT verification + family revocation check
    const claims = auth.verifyAccessToken(bearer);
    return { userId: claims.sub, familyId: claims.fam };
  }

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    const send = (status: number, payload: unknown) => {
      if (!res.destroyed) {
        if (status === 429) res.setHeader('Retry-After', '60');
        res.writeHead(status).end(JSON.stringify(payload));
      }
    };

    try {
      if ((req.url?.length || 0) > 4096) {
        send(414, { error: 'URL muito longa.' });
        return;
      }
      const u = new URL(req.url || '/', 'http://broker.internal');
      const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');

      if (req.method === 'GET' && u.pathname === '/health') {
        enforceRateLimit(`ip:${ip}:health`, 120);
        send(200, { service: 'liquid-hub-broker', version: 2 });
        return;
      }

      if (req.method === 'GET' && u.pathname === '/.well-known/jwks.json') {
        enforceRateLimit(`ip:${ip}:jwks`, 60);
        send(200, { keys: [auth.publicJwk()] });
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/register') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        if (env.BROKER_ALLOW_REGISTRATION === '0') {
          throw new BrokerHttpError('Registro público desativado.', 403, 'registration_disabled');
        }
        const body = await readJsonBody(req);
        const result = auth.authenticateCredentials(body, true);
        send(201, result);
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/login') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const body = await readJsonBody(req);
        const maybeUser =
          body && typeof body === 'object' && 'username' in body
            ? String((body as Record<string, unknown>).username).toLowerCase().slice(0, 80)
            : '';
        if (maybeUser) enforceRateLimit(`acct:${maybeUser}:auth`, authLimit);
        const result = auth.authenticateCredentials(body, false);
        send(200, result);
        return;
      }

      if (req.method === 'GET' && u.pathname === '/v1/auth/authorize') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const identity = authenticateBearer(req);
        enforceRateLimit(`user:${identity.userId}:auth`, authLimit);
        const queryObj: Record<string, string> = {};
        for (const [k, v] of u.searchParams) {
          if (k in queryObj) throw new BrokerHttpError('Parâmetro duplicado.', 400);
          queryObj[k] = v;
        }
        send(200, auth.authorizePkceRequest(queryObj, identity.userId));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/token') {
        enforceRateLimit(`ip:${ip}:token`, authLimit * 2);
        const body = await readJsonBody(req);
        const tokens = auth.exchangeToken(body);
        enforceRateLimit(`user:${tokens.subject}:token`, authLimit * 2);
        send(200, tokens);
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/logout') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit * 2);
        const identity = authenticateBearer(req);
        if (identity.familyId) auth.revokeFamily(identity.familyId);
        send(200, { revoked: true });
        return;
      }

      // Protected /search route
      const identity = authenticateBearer(req);
      enforceRateLimit(`ip:${ip}:api`, apiLimit);
      enforceRateLimit(`user:${identity.userId}:api`, apiLimit);

      if (req.method !== 'GET' || u.pathname !== '/search') {
        send(404, {});
        return;
      }

      // Strict query parameter whitelist
      for (const key of u.searchParams.keys()) {
        if (!['q', 'kind', 'cursor'].includes(key)) {
          send(400, { error: 'Parâmetro de consulta não permitido.' });
          return;
        }
      }

      const q = (u.searchParams.get('q') || '').trim();
      const kind = u.searchParams.get('kind') || 'track';
      if (!q || q.length > 200 || !['all', 'track', 'artist', 'playlist'].includes(kind)) {
        send(400, {});
        return;
      }
      const rawCursor = u.searchParams.get('cursor');
      if (rawCursor && rawCursor.length > 2000) throw new Error('Cursor muito grande');
      const cursors: Record<string, string> | undefined = rawCursor
        ? JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'))
        : undefined;

      const kinds =
        kind === 'all'
          ? ['tracks', 'users', 'playlists']
          : [kind === 'track' ? 'tracks' : kind === 'artist' ? 'users' : 'playlists'];
      const scToken = await soundcloudAccess();
      const next: Record<string, string> = {};
      const items: Track[] = [];

      await Promise.all(
        kinds.map(async endpoint => {
          if (cursors && !cursors[endpoint]) return;
          const target = cursors?.[endpoint]
            ? validNext(cursors[endpoint], endpoint)
            : new URL(
                `https://api.soundcloud.com/${endpoint}?${new URLSearchParams({
                  q,
                  limit: '20',
                  linked_partitioning: 'true',
                })}`,
              );
          const r = await request(target, {
            headers: { Authorization: `OAuth ${scToken}`, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) {
            if (r.status === 401) upstreamToken = undefined;
            res.statusCode = [401, 403, 429].includes(r.status) ? r.status : 502;
            throw new Error('SoundCloud indisponível');
          }
          const data = (await r.json()) as Record<string, unknown>;
          const collection = Array.isArray(data)
            ? data
            : Array.isArray(data.collection)
              ? data.collection
              : [];
          if (typeof data.next_href === 'string') {
            next[endpoint] = validNext(data.next_href, endpoint).toString();
          }
          collection.forEach((v: Record<string, any>) => {
            const sourceId = String(v.urn || v.id).replace(/[^\w:.-]/g, '');
            const trackKind =
              endpoint === 'users' ? 'artist' : endpoint === 'playlists' ? 'playlist' : 'track';
            items.push({
              id: `soundcloud:${sourceId}`,
              sourceId,
              source: 'soundcloud',
              kind: trackKind,
              title: v.title || v.username || 'SoundCloud',
              artist: v.user?.username || v.username || 'SoundCloud',
              artwork: v.artwork_url || v.avatar_url || v.user?.avatar_url,
              duration: (v.duration || 0) / 1000,
              url: v.permalink_url,
              addedAt: clock(),
              available:
                v.access === 'blocked' || v.embeddable_by === 'none' ? false : undefined,
              reason:
                v.access === 'blocked'
                  ? 'Reprodução restrita pela plataforma.'
                  : v.access === 'preview'
                    ? 'A plataforma pode disponibilizar apenas uma prévia.'
                    : undefined,
            });
          });
        }),
      );

      send(200, {
        items,
        next: Object.keys(next).length
          ? Buffer.from(JSON.stringify(next)).toString('base64url')
          : undefined,
      });
    } catch (err) {
      if (err instanceof BrokerHttpError) {
        send(err.status, { error: err.message, code: err.code });
        return;
      }
      if (!res.headersSent) {
        const status = res.statusCode >= 400 ? res.statusCode : 502;
        send(status, { error: 'Não foi possível consultar o SoundCloud.' });
      }
    }
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 5000;
  (server as typeof server & { auth: ZeroTrustAuthEngine }).auth = auth;
  return server as typeof server & { auth: ZeroTrustAuthEngine };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BROKER_PORT || 8787);
  createBroker().listen(port, '127.0.0.1', () =>
    console.log(
      `Liquid Hub Zero-Trust Broker ativo em 127.0.0.1:${port}. Credenciais somente no servidor.`,
    ),
  );
}
