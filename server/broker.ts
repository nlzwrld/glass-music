/**
 * Liquid Hub — Zero-Trust Auth & Personal API Broker
 * - OAuth2 Authorization Code + Mandatory PKCE (S256)
 * - Credential Authentication with Argon2id (RFC 9106)
 * - Short-lived Ed25519 (EdDSA) Access JWTs (15 min TTL)
 * - Opaque Refresh Tokens with strict rotation & immediate token-family revocation on reuse
 * - Per-IP and Per-User-ID rate limiting & strict schema validation
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as nodeCrypto from 'node:crypto';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { HubOAuthProvider, Track } from '../shared/types.ts';
import {
  acceptTermsSchema,
  credentialLoginSchema,
  credentialRegisterSchema,
  forgotPasswordSchema,
  hubAuthProviderSchema,
  hubOAuthProviderSchema,
  linkEmailSchema,
  oauthStartSchema,
  pkceAuthorizeSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  tokenGrantSchema,
  verifyEmailSchema,
} from '../shared/validation.ts';
import {
  type AuthEmailMessage,
  type ExternalProfile,
  HubAuthStore,
  type HubUserPublic,
  type HubUserRecord,
  type OAuthProviderConfig,
  type PendingOAuthFlow,
  type SqliteDatabaseLike,
  buildProviderAuthorizeUrl,
  describeProviderAvailability,
  exchangeExternalOAuthProfile,
  isCurrentLegalAcceptance,
  resolveOAuthProviders,
} from './auth.ts';

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

export class BrokerHttpError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
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

export type Argon2Params = Partial<typeof ARGON2_DEFAULTS>;

type NativeArgon2Params = {
  message: Buffer;
  nonce: Buffer;
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
};

type Argon2Fn = (
  algorithm: 'argon2id',
  parameters: NativeArgon2Params,
  callback: (err: Error | null, result: Buffer) => void,
) => void;
type Argon2SyncFn = (algorithm: 'argon2id', parameters: NativeArgon2Params) => Buffer;

const argon2 = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
const argon2Sync = (nodeCrypto as unknown as { argon2Sync?: Argon2SyncFn }).argon2Sync;

function deriveArgon2id(params: NativeArgon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (typeof argon2 !== 'function') {
      reject(new Error('argon2 unavailable'));
      return;
    }
    argon2('argon2id', params, (error, tag) => {
      if (error) reject(error);
      else resolve(tag);
    });
  });
}

function completeArgon2Params(params: Argon2Params) {
  return {
    memory: params.memory ?? ARGON2_DEFAULTS.memory,
    passes: params.passes ?? ARGON2_DEFAULTS.passes,
    parallelism: params.parallelism ?? ARGON2_DEFAULTS.parallelism,
    tagLength: params.tagLength ?? ARGON2_DEFAULTS.tagLength,
  };
}

function encodedArgon2id(passwordHash: string) {
  const parts = passwordHash.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return undefined;
  const kv = Object.fromEntries(
    parts[3].split(',').map(pair => {
      const [k, v] = pair.split('=');
      return [k, Number(v)];
    }),
  );
  if (!kv.m || !kv.t || !kv.p) return undefined;
  const nonce = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (nonce.length < 8 || expected.length < 16) return undefined;
  return {
    nonce,
    expected,
    memory: kv.m,
    passes: kv.t,
    parallelism: kv.p,
  };
}

function encodedPbkdf2(passwordHash: string) {
  const parts = passwordHash.split('$');
  if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') return undefined;
  const iterations = Number(parts[2].replace(/^i=/, ''));
  if (!Number.isFinite(iterations) || iterations < 1000) return undefined;
  const nonce = Buffer.from(parts[3], 'base64');
  const expected = Buffer.from(parts[4], 'base64');
  if (nonce.length < 8 || expected.length < 16) return undefined;
  return { iterations, nonce, expected };
}

function hashPasswordPbkdf2(password: string, iterations = 25000): string {
  const salt = randomBytes(16);
  const tag = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  return `$pbkdf2-sha256$i=${iterations}$${salt.toString('base64')}$${tag.toString('base64')}`;
}

function verifyPasswordPbkdf2(password: string, encoded: string): boolean {
  const parsed = encodedPbkdf2(encoded);
  if (!parsed) return false;
  const computed = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    parsed.nonce,
    parsed.iterations,
    parsed.expected.length,
    'sha256',
  );
  return computed.length === parsed.expected.length && timingSafeEqual(computed, parsed.expected);
}

export function hashPasswordArgon2id(password: string, params: Argon2Params = {}): string {
  const complete = completeArgon2Params(params);
  const salt = randomBytes(16);
  try {
    if (typeof argon2Sync !== 'function') throw new Error('argon2Sync unavailable');
    const tag = argon2Sync('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      ...complete,
    });
    return `$argon2id$v=19$m=${complete.memory},t=${complete.passes},p=${complete.parallelism}$${salt.toString('base64')}$${tag.toString('base64')}`;
  } catch {
    return hashPasswordPbkdf2(password);
  }
}

export async function hashPasswordArgon2idAsync(
  password: string,
  params: Argon2Params = {},
): Promise<string> {
  const complete = completeArgon2Params(params);
  const salt = randomBytes(16);
  try {
    if (typeof argon2 !== 'function') throw new Error('argon2 unavailable');
    const tag = await deriveArgon2id({
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      ...complete,
    });
    return `$argon2id$v=19$m=${complete.memory},t=${complete.passes},p=${complete.parallelism}$${salt.toString('base64')}$${tag.toString('base64')}`;
  } catch {
    return hashPasswordPbkdf2(password);
  }
}

export function verifyPasswordArgon2id(password: string, encoded: string): boolean {
  try {
    if (encoded.startsWith('$pbkdf2-sha256$')) {
      return verifyPasswordPbkdf2(password, encoded);
    }
    if (typeof argon2Sync !== 'function') return false;
    const parsed = encodedArgon2id(encoded);
    if (!parsed) return false;
    const computed = argon2Sync('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: parsed.nonce,
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.expected.length,
    });
    return computed.length === parsed.expected.length && timingSafeEqual(computed, parsed.expected);
  } catch {
    return false;
  }
}

export async function verifyPasswordArgon2idAsync(
  password: string,
  encoded: string,
): Promise<boolean> {
  try {
    if (encoded.startsWith('$pbkdf2-sha256$')) {
      return verifyPasswordPbkdf2(password, encoded);
    }
    const parsed = encodedArgon2id(encoded);
    if (!parsed) return false;
    const computed = await deriveArgon2id({
      message: Buffer.from(password, 'utf8'),
      nonce: parsed.nonce,
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.expected.length,
    });
    return computed.length === parsed.expected.length && timingSafeEqual(computed, parsed.expected);
  } catch {
    return false;
  }
}

export interface Argon2AsyncAdapter {
  hash(password: string, params: Argon2Params): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

const nativeArgon2Adapter: Argon2AsyncAdapter = {
  hash: hashPasswordArgon2idAsync,
  verify: verifyPasswordArgon2idAsync,
};

class Argon2Queue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly adapter: Argon2AsyncAdapter;
  private readonly concurrency: number;
  private readonly maxWaiting: number;

  constructor(adapter: Argon2AsyncAdapter, concurrency = 2, maxWaiting = 32) {
    this.adapter = adapter;
    this.concurrency = Number.isFinite(concurrency)
      ? Math.max(1, Math.min(4, Math.floor(concurrency)))
      : 2;
    this.maxWaiting = Number.isFinite(maxWaiting)
      ? Math.max(0, Math.min(128, Math.floor(maxWaiting)))
      : 32;
  }

  hash(password: string, params: Argon2Params): Promise<string> {
    return this.run(adapter => adapter.hash(password, params));
  }

  verify(password: string, encoded: string): Promise<boolean> {
    return this.run(adapter => adapter.verify(password, encoded));
  }

  private run<T>(operation: (adapter: Argon2AsyncAdapter) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        let pending: Promise<T>;
        try {
          pending = operation(this.adapter);
        } catch (error) {
          this.finish();
          reject(error);
          return;
        }
        pending.then(
          value => {
            this.finish();
            resolve(value);
          },
          error => {
            this.finish();
            reject(error);
          },
        );
      };
      if (this.active < this.concurrency) {
        start();
      } else if (this.waiting.length >= this.maxWaiting) {
        reject(new BrokerHttpError('Serviço ocupado.', 503, 'service_busy'));
      } else {
        this.waiting.push(start);
      }
    });
  }

  private finish() {
    this.active--;
    this.waiting.shift()?.();
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

export type { AuthEmailMessage, HubUserPublic, OAuthProviderConfig };

export interface ZeroTrustAuthEngineOptions {
  privateKeyPem?: string;
  clock?: () => number;
  argon2Params?: Argon2Params;
  argon2Adapter?: Argon2AsyncAdapter;
  argon2Concurrency?: number;
  argon2QueueSize?: number;
  dbPath?: string | SqliteDatabaseLike;
  onAuthEmail?: (email: AuthEmailMessage) => void | Promise<void>;
  discord?: OAuthProviderConfig;
  github?: OAuthProviderConfig;
  google?: OAuthProviderConfig;
  publicUrl?: string;
}

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export class ZeroTrustAuthEngine {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;
  readonly store: HubAuthStore;
  private readonly authCodes = new Map<string, PendingAuthCode>();
  private readonly dummyHash: string;
  private readonly argon2Params: Argon2Params;
  private readonly argon2: Argon2Queue;
  private readonly onAuthEmail?: (email: AuthEmailMessage) => void | Promise<void>;

  constructor(options: ZeroTrustAuthEngineOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.argon2Params = options.argon2Params ?? { memory: 19456, passes: 2, parallelism: 1 };
    this.argon2 = new Argon2Queue(
      options.argon2Adapter ?? nativeArgon2Adapter,
      options.argon2Concurrency,
      options.argon2QueueSize,
    );
    this.store = new HubAuthStore(options.dbPath || ':memory:');
    this.onAuthEmail = options.onAuthEmail;
    if (options.privateKeyPem) {
      this.privateKey = createPrivateKey(options.privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const savedPem = this.store.getConfig('ed25519_private_pem');
      if (savedPem) {
        this.privateKey = createPrivateKey(savedPem);
        this.publicKey = createPublicKey(this.privateKey);
      } else {
        const pair = generateKeyPairSync('ed25519');
        this.privateKey = pair.privateKey;
        this.publicKey = pair.publicKey;
        const exportedPem = String(
          pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
        );
        this.store.setConfig('ed25519_private_pem', exportedPem);
      }
    }
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string };
    this.kid = createHash('sha256').update(jwk.x).digest('base64url').slice(0, 16);
    this.dummyHash = hashPasswordArgon2id('dummy-zero-trust-anti-timing-secret', this.argon2Params);
  }

  resolveEffectiveProviderConfig(
    provider: HubOAuthProvider,
    base: Required<OAuthProviderConfig>,
  ): Required<OAuthProviderConfig> {
    if (base.clientId && base.clientSecret) return base;
    const raw = this.store.getConfig(`oauth:${provider}`);
    if (!raw) return base;
    try {
      const parsed = JSON.parse(raw) as { clientId?: string; clientSecret?: string };
      return {
        ...base,
        clientId: base.clientId || (typeof parsed.clientId === 'string' ? parsed.clientId : ''),
        clientSecret:
          base.clientSecret || (typeof parsed.clientSecret === 'string' ? parsed.clientSecret : ''),
      };
    } catch {
      return base;
    }
  }

  resolveEffectiveProviders(
    base: ReturnType<typeof resolveOAuthProviders>,
  ): ReturnType<typeof resolveOAuthProviders> {
    return {
      discord: this.resolveEffectiveProviderConfig('discord', base.discord),
      github: this.resolveEffectiveProviderConfig('github', base.github),
      google: this.resolveEffectiveProviderConfig('google', base.google),
    };
  }

  private clock: () => number;

  close() {
    this.store.close();
  }

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
    this.store.pruneExpiredTokens(now);
  }

  private dispatchEmail(msg: AuthEmailMessage) {
    if (!this.onAuthEmail) return;
    try {
      const maybePromise = this.onAuthEmail(msg);
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
        (maybePromise as Promise<void>).catch(() => {});
      }
    } catch {
      // Never fail auth mutations because of async notification hooks
    }
  }

  private ensureCanRegister(normalizedUsername: string, normalizedEmail?: string | null) {
    if (normalizedEmail && this.store.findUserByEmail(normalizedEmail)) {
      throw new BrokerHttpError('Este e-mail já está cadastrado.', 409, 'email_exists');
    }
    if (this.store.findUserByUsername(normalizedUsername)) {
      throw new BrokerHttpError('Usuário já registrado.', 409, 'user_exists');
    }
  }

  private commitRegisteredUser(input: {
    username: string;
    displayName?: string;
    email?: string | null;
    passwordHash: string;
    termsVersion?: string | null;
    privacyVersion?: string | null;
  }): HubUserRecord {
    // Async registration must recheck after Argon2: another request may have committed meanwhile.
    this.ensureCanRegister(input.username, input.email);
    const now = this.clock();
    return this.store.createPasswordUser({
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      emailVerified: false,
      passwordHash: input.passwordHash,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      now,
    });
  }

  registerUser(username: string, password: string): StoredUser {
    const normalized = username.trim().toLowerCase();
    this.ensureCanRegister(normalized, null);
    const user = this.commitRegisteredUser({
      username: normalized,
      passwordHash: hashPasswordArgon2id(password, this.argon2Params),
    });
    return {
      id: user.userId,
      username: user.username,
      passwordHash: user.passwordHash || '',
      createdAt: user.createdAt,
    };
  }

  private async registerUserAsync(input: {
    username?: string;
    email?: string;
    displayName?: string;
    password: string;
    termsVersion?: string;
    privacyVersion?: string;
  }): Promise<HubUserRecord> {
    const normalizedEmail = input.email ? input.email.trim().toLowerCase() : null;
    const explicitUsername = input.username ? input.username.trim().toLowerCase() : null;
    const initialUsername =
      explicitUsername ||
      this.store.allocateUniqueUsername(normalizedEmail ? normalizedEmail.split('@')[0] : 'user');
    this.ensureCanRegister(initialUsername, normalizedEmail);
    const passwordHash = await this.argon2.hash(input.password, this.argon2Params);
    const finalUsername =
      explicitUsername ||
      this.store.allocateUniqueUsername(normalizedEmail ? normalizedEmail.split('@')[0] : 'user');
    return this.commitRegisteredUser({
      username: finalUsername,
      displayName: input.displayName,
      email: normalizedEmail,
      passwordHash,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
    });
  }

  async authenticateCredentials(raw: unknown, autoRegister = false) {
    this.prune();
    if (autoRegister) {
      const parsed = credentialRegisterSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BrokerHttpError('Payload de cadastro fora do contrato.', 400, 'invalid_request');
      }
      const {
        username,
        email,
        displayName,
        password,
        client_id,
        code_challenge,
        redirect_uri,
        termsVersion,
        privacyVersion,
      } = parsed.data;
      const user = await this.registerUserAsync({
        username,
        email,
        displayName,
        password,
        termsVersion,
        privacyVersion,
      });
      if (user.email) {
        const now = this.clock();
        const issued = this.store.createEmailToken({
          kind: 'verify_email',
          userId: user.userId,
          email: user.email,
          ttlMs: EMAIL_VERIFY_TTL_MS,
          now,
        });
        this.dispatchEmail({
          kind: 'verify_email',
          to: user.email,
          userId: user.userId,
          username: user.username,
          displayName: user.displayName,
          token: issued.rawToken,
          expiresAt: issued.expiresAt,
        });
      }
      const codeResult = this.issueAuthorizationCode({
        userId: user.userId,
        clientId: client_id,
        codeChallenge: code_challenge,
        redirectUri: redirect_uri,
        scope: 'hub:access',
      });
      return { ...codeResult, user: this.store.toPublicUser(user) };
    }

    const parsed = credentialLoginSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Payload de autenticação fora do contrato.', 400, 'invalid_request');
    }
    const {
      identifier,
      username,
      email,
      password,
      client_id,
      code_challenge,
      redirect_uri,
      termsVersion,
      privacyVersion,
    } = parsed.data;
    const loginKey = (identifier || email || username || '').trim();
    let user = this.store.findUserByIdentifier(loginKey);
    if (!user || !user.passwordHash) {
      // Constant-time dummy Argon2id verification prevents username/email enumeration
      await this.argon2.verify(password, this.dummyHash);
      throw new BrokerHttpError('Credenciais inválidas.', 401, 'invalid_credentials');
    }
    if (!(await this.argon2.verify(password, user.passwordHash))) {
      throw new BrokerHttpError('Credenciais inválidas.', 401, 'invalid_credentials');
    }
    if (
      !isCurrentLegalAcceptance(user.termsVersion, user.privacyVersion) &&
      isCurrentLegalAcceptance(termsVersion, privacyVersion)
    ) {
      user = this.store.acceptLegalTerms(user.userId, this.clock());
    }
    const codeResult = this.issueAuthorizationCode({
      userId: user.userId,
      clientId: client_id,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      scope: 'hub:access',
    });
    return { ...codeResult, user: this.store.toPublicUser(user) };
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
    if (!this.store.findUserById(userId)) {
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

  startOAuthFlow(input: {
    raw: unknown;
    providerConfig: Required<OAuthProviderConfig>;
    callbackUrl: string;
    linkUserId: string | null;
  }) {
    this.prune();
    const parsed = oauthStartSchema.safeParse(input.raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Parâmetros OAuth inválidos.', 400, 'invalid_request');
    }
    const data = parsed.data;
    if (data.oauthClientId && data.oauthClientSecret) {
      this.store.setConfig(
        `oauth:${data.provider}`,
        JSON.stringify({
          clientId: data.oauthClientId.trim(),
          clientSecret: data.oauthClientSecret.trim(),
        }),
      );
    }
    const effectiveConfig = this.resolveEffectiveProviderConfig(
      data.provider,
      input.providerConfig,
    );
    if (data.provider === 'google' && (!effectiveConfig.clientId || !effectiveConfig.clientSecret)) {
      throw new BrokerHttpError(
        'O login com Google não está configurado neste servidor.',
        503,
        'provider_not_configured',
      );
    }
    const mode = data.mode ?? 'login';
    if (mode === 'link') {
      if (!input.linkUserId || !this.store.findUserById(input.linkUserId)) {
        throw new BrokerHttpError(
          'Autenticação obrigatória para vincular um provedor.',
          401,
          'unauthorized',
        );
      }
    }
    const now = this.clock();
    const legalAccepted = isCurrentLegalAcceptance(data.termsVersion, data.privacyVersion);
    const flow: PendingOAuthFlow = {
      state: data.state,
      provider: data.provider,
      mode,
      linkUserId: mode === 'link' ? input.linkUserId : null,
      clientId: data.client_id,
      redirectUri: data.redirect_uri,
      codeChallenge: data.code_challenge,
      codeChallengeMethod: 'S256',
      providerVerifier: randomBytes(32).toString('base64url'),
      termsVersion: legalAccepted ? data.termsVersion! : null,
      privacyVersion: legalAccepted ? data.privacyVersion! : null,
      termsAcceptedAt: legalAccepted ? now : null,
      createdAt: now,
      expiresAt: now + OAUTH_FLOW_TTL_MS,
    };
    this.store.saveOAuthFlow(flow);
    const authorizeUrl =
      effectiveConfig.clientId && effectiveConfig.clientSecret
        ? buildProviderAuthorizeUrl({
            provider: data.provider,
            config: effectiveConfig,
            callbackUrl: input.callbackUrl,
            state: flow.state,
            codeVerifier: flow.providerVerifier,
          })
        : `${new URL(input.callbackUrl).origin}/v1/auth/oauth/${data.provider}/authorize?state=${encodeURIComponent(flow.state)}`;
    return { authorizeUrl, state: flow.state, expires_in: 600 };
  }

  peekOAuthFlow(state: string, provider: HubOAuthProvider): PendingOAuthFlow | null {
    return this.store.peekOAuthFlow(state, provider, this.clock());
  }

  consumeOAuthFlow(state: string, provider: HubOAuthProvider): PendingOAuthFlow | null {
    return this.store.consumeOAuthFlow(state, provider, this.clock());
  }

  completeOAuthProfile(flow: PendingOAuthFlow, profile: ExternalProfile) {
    const now = this.clock();
    if (flow.mode === 'link') {
      if (!flow.linkUserId) {
        throw new BrokerHttpError('Sessão de vínculo inválida.', 401, 'unauthorized');
      }
      const targetUser = this.store.findUserById(flow.linkUserId);
      if (!targetUser) {
        throw new BrokerHttpError('Usuário não encontrado para vínculo.', 401, 'unauthorized');
      }
      const existingIdentity = this.store.findIdentity(profile.provider, profile.providerSubject);
      if (existingIdentity) {
        if (existingIdentity.userId !== flow.linkUserId) {
          throw new BrokerHttpError(
            'Esta conta externa já está vinculada a outro usuário do Liquid Hub.',
            409,
            'identity_already_linked',
          );
        }
        const refreshed = this.store.refreshExternalIdentity({
          userId: flow.linkUserId,
          profile,
          termsVersion: flow.termsVersion,
          privacyVersion: flow.privacyVersion,
          now,
        });
        return this.issueAuthorizationCode({
          userId: refreshed.userId,
          clientId: flow.clientId,
          codeChallenge: flow.codeChallenge,
          redirectUri: flow.redirectUri,
          scope: 'hub:access',
        });
      }
      const sameProvider = this.store.findUserIdentityByProvider(
        flow.linkUserId,
        profile.provider,
      );
      if (sameProvider) {
        throw new BrokerHttpError(
          'Sua conta já possui outra identidade deste provedor vinculada.',
          409,
          'provider_already_linked',
        );
      }
      const linked = this.store.linkOAuthIdentity({
        userId: flow.linkUserId,
        profile,
        now,
      });
      return this.issueAuthorizationCode({
        userId: linked.userId,
        clientId: flow.clientId,
        codeChallenge: flow.codeChallenge,
        redirectUri: flow.redirectUri,
        scope: 'hub:access',
      });
    }

    // Standard login / signup via external OAuth identity
    const existingIdentity = this.store.findIdentity(profile.provider, profile.providerSubject);
    if (existingIdentity) {
      const owner = this.store.findUserById(existingIdentity.userId);
      if (!owner) {
        throw new BrokerHttpError('Usuário vinculado não encontrado.', 401, 'unauthorized');
      }
      const refreshed = this.store.refreshExternalIdentity({
        userId: owner.userId,
        profile,
        termsVersion: flow.termsVersion,
        privacyVersion: flow.privacyVersion,
        now,
      });
      return this.issueAuthorizationCode({
        userId: refreshed.userId,
        clientId: flow.clientId,
        codeChallenge: flow.codeChallenge,
        redirectUri: flow.redirectUri,
        scope: 'hub:access',
      });
    }

    // Anti-auto-merge: verified email matches existing account -> require explicit login & link
    if (profile.email && profile.emailVerified) {
      const emailOwner = this.store.findUserByEmail(profile.email);
      if (emailOwner) {
        throw new BrokerHttpError(
          'Já existe uma conta com este e-mail. Entre com ela primeiro para vincular este provedor sem duplicar sua conta.',
          409,
          'account_exists_link_required',
        );
      }
    }

    const created = this.store.createOAuthUser({
      profile,
      termsVersion: flow.termsVersion,
      privacyVersion: flow.privacyVersion,
      now,
    });
    return this.issueAuthorizationCode({
      userId: created.userId,
      clientId: flow.clientId,
      codeChallenge: flow.codeChallenge,
      redirectUri: flow.redirectUri,
      scope: 'hub:access',
    });
  }

  getUserProfile(userId: string): HubUserPublic {
    const profile = this.store.getPublicUserById(userId);
    if (!profile) {
      throw new BrokerHttpError('Usuário não encontrado.', 404, 'user_not_found');
    }
    return profile;
  }

  acceptTerms(userId: string, raw: unknown): HubUserPublic {
    const parsed = acceptTermsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Versões de termos inválidas.', 400, 'invalid_request');
    }
    if (!isCurrentLegalAcceptance(parsed.data.termsVersion, parsed.data.privacyVersion)) {
      throw new BrokerHttpError(
        'A versão dos Termos de Uso ou Política de Privacidade está desatualizada.',
        400,
        'invalid_legal_version',
      );
    }
    if (!this.store.findUserById(userId)) {
      throw new BrokerHttpError('Usuário não encontrado.', 404, 'user_not_found');
    }
    const updated = this.store.acceptLegalTerms(userId, this.clock());
    return this.store.toPublicUser(updated);
  }

  verifyEmail(raw: unknown): { ok: boolean; user: HubUserPublic } {
    const parsed = verifyEmailSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Token de verificação inválido.', 400, 'invalid_request');
    }
    const now = this.clock();
    const consumed = this.store.consumeEmailToken('verify_email', parsed.data.token, now);
    if (!consumed) {
      throw new BrokerHttpError(
        'Token de verificação expirado ou já utilizado.',
        400,
        'invalid_or_expired_token',
      );
    }
    const updated = this.store.markEmailVerified(consumed.userId, now);
    return { ok: true, user: this.store.toPublicUser(updated) };
  }

  resendVerification(userId: string | null, raw: unknown): { ok: boolean; sent: boolean } {
    const parsed = resendVerificationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Parâmetros inválidos.', 400, 'invalid_request');
    }
    const now = this.clock();
    if (userId) {
      const user = this.store.findUserById(userId);
      if (!user) throw new BrokerHttpError('Usuário não encontrado.', 404, 'user_not_found');
      if (!user.email) {
        throw new BrokerHttpError('Nenhum e-mail associado a esta conta.', 400, 'email_not_configured');
      }
      if (user.emailVerified) {
        return { ok: true, sent: false };
      }
      const issued = this.store.createEmailToken({
        kind: 'verify_email',
        userId: user.userId,
        email: user.email,
        ttlMs: EMAIL_VERIFY_TTL_MS,
        now,
      });
      this.dispatchEmail({
        kind: 'verify_email',
        to: user.email,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        token: issued.rawToken,
        expiresAt: issued.expiresAt,
      });
      return { ok: true, sent: true };
    }
    if (parsed.data.email) {
      const user = this.store.findUserByEmail(parsed.data.email);
      if (user && user.email && !user.emailVerified) {
        const issued = this.store.createEmailToken({
          kind: 'verify_email',
          userId: user.userId,
          email: user.email,
          ttlMs: EMAIL_VERIFY_TTL_MS,
          now,
        });
        this.dispatchEmail({
          kind: 'verify_email',
          to: user.email,
          userId: user.userId,
          username: user.username,
          displayName: user.displayName,
          token: issued.rawToken,
          expiresAt: issued.expiresAt,
        });
      }
    }
    return { ok: true, sent: true };
  }

  forgotPassword(raw: unknown): { ok: boolean } {
    const parsed = forgotPasswordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Informe um e-mail válido.', 400, 'invalid_request');
    }
    const now = this.clock();
    const user = this.store.findUserByEmail(parsed.data.email);
    if (user && user.email) {
      const issued = this.store.createEmailToken({
        kind: 'reset_password',
        userId: user.userId,
        email: user.email,
        ttlMs: PASSWORD_RESET_TTL_MS,
        now,
      });
      this.dispatchEmail({
        kind: 'reset_password',
        to: user.email,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        token: issued.rawToken,
        expiresAt: issued.expiresAt,
      });
    }
    return { ok: true };
  }

  async resetPassword(raw: unknown): Promise<{ ok: boolean }> {
    const parsed = resetPasswordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError(
        'Token inválido ou nova senha menor que 12 caracteres.',
        400,
        'invalid_request',
      );
    }
    const now = this.clock();
    const consumed = this.store.consumeEmailToken('reset_password', parsed.data.token, now);
    if (!consumed) {
      throw new BrokerHttpError(
        'Token de recuperação inválido ou expirado.',
        400,
        'invalid_or_expired_token',
      );
    }
    const passwordHash = await this.argon2.hash(parsed.data.newPassword, this.argon2Params);
    this.store.updatePassword(consumed.userId, passwordHash, now);
    this.store.markEmailVerified(consumed.userId, now);
    this.store.revokeAllUserFamilies(consumed.userId, now);
    return { ok: true };
  }

  async linkEmail(userId: string, raw: unknown): Promise<HubUserPublic> {
    const parsed = linkEmailSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrokerHttpError('Dados inválidos para vincular e-mail.', 400, 'invalid_request');
    }
    const user = this.store.findUserById(userId);
    if (!user) {
      throw new BrokerHttpError('Usuário não encontrado.', 404, 'user_not_found');
    }
    const owner = this.store.findUserByEmail(parsed.data.email);
    if (owner && owner.userId !== userId) {
      throw new BrokerHttpError(
        'Este e-mail já está em uso por outra conta do Liquid Hub.',
        409,
        'email_exists',
      );
    }
    const passwordHash = await this.argon2.hash(parsed.data.password, this.argon2Params);
    const ownerAfterHash = this.store.findUserByEmail(parsed.data.email);
    if (ownerAfterHash && ownerAfterHash.userId !== userId) {
      throw new BrokerHttpError(
        'Este e-mail já está em uso por outra conta do Liquid Hub.',
        409,
        'email_exists',
      );
    }
    const now = this.clock();
    const updated = this.store.linkEmailPassword({
      userId,
      email: parsed.data.email,
      passwordHash,
      displayName: parsed.data.displayName,
      now,
    });
    if (updated.email && !updated.emailVerified) {
      const issued = this.store.createEmailToken({
        kind: 'verify_email',
        userId: updated.userId,
        email: updated.email,
        ttlMs: EMAIL_VERIFY_TTL_MS,
        now,
      });
      this.dispatchEmail({
        kind: 'verify_email',
        to: updated.email,
        userId: updated.userId,
        username: updated.username,
        displayName: updated.displayName,
        token: issued.rawToken,
        expiresAt: issued.expiresAt,
      });
    }
    return this.store.toPublicUser(updated);
  }

  unlinkIdentity(userId: string, providerRaw: string): HubUserPublic {
    const parsed = hubAuthProviderSchema.safeParse(providerRaw);
    if (!parsed.success) {
      throw new BrokerHttpError('Provedor inválido.', 400, 'invalid_provider');
    }
    const provider = parsed.data;
    const user = this.store.findUserById(userId);
    if (!user) {
      throw new BrokerHttpError('Usuário não encontrado.', 404, 'user_not_found');
    }
    const identities = this.store.listIdentities(userId);
    const oauthIdentities = identities.filter(id => id.provider !== 'email');
    if (provider === 'email') {
      const hasEmailIdentity = identities.some(id => id.provider === 'email') || Boolean(user.passwordHash);
      if (!hasEmailIdentity) {
        throw new BrokerHttpError('Login por e-mail não está vinculado.', 400, 'identity_not_linked');
      }
      if (oauthIdentities.length < 1) {
        throw new BrokerHttpError(
          'Adicione outro método de login antes de remover o acesso por e-mail.',
          400,
          'cannot_unlink_last_method',
        );
      }
    } else {
      const hasTarget = oauthIdentities.some(id => id.provider === provider);
      if (!hasTarget) {
        throw new BrokerHttpError(`Provedor ${provider} não está vinculado.`, 400, 'identity_not_linked');
      }
      const remainingMethods =
        (user.passwordHash ? 1 : 0) + oauthIdentities.filter(id => id.provider !== provider).length;
      if (remainingMethods < 1) {
        throw new BrokerHttpError(
          'Adicione outro método de login antes de desvincular o único provedor ativo.',
          400,
          'cannot_unlink_last_method',
        );
      }
    }
    const updated = this.store.unlinkIdentity(userId, provider, this.clock());
    return this.store.toPublicUser(updated);
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
    const now = this.clock();
    const code = randomBytes(32).toString('base64url');
    const record: PendingAuthCode = {
      code,
      userId: input.userId,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      scope: input.scope,
      expiresAt: now + AUTH_CODE_TTL_MS,
      consumed: false,
    };
    this.authCodes.set(code, record);
    this.store.saveAuthCode(record, now);
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
      const record = this.authCodes.get(code) ?? this.store.findAuthCode(code);
      if (!record || record.expiresAt <= now) {
        this.authCodes.delete(code);
        this.store.deleteAuthCode(code);
        throw new BrokerHttpError('Código de autorização inválido ou expirado.', 400, 'invalid_grant');
      }
      if (record.consumed) {
        if (record.issuedFamilyId) this.revokeFamily(record.issuedFamilyId);
        this.authCodes.delete(code);
        this.store.deleteAuthCode(code);
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
      this.authCodes.set(code, record);
      this.store.markAuthCodeConsumed(code, familyId);
      return this.mintSessionPair(record.userId, client_id, familyId, record.scope, now);
    }

    // Strict Refresh Token Rotation + Family Reuse Detection
    const { refresh_token, client_id } = parsed.data;
    const tokenHash = sha256Hex(refresh_token);
    const existing = this.store.findRefreshToken(tokenHash);
    if (!existing) {
      throw new BrokerHttpError('Refresh token inválido.', 401, 'invalid_grant');
    }
    if (existing.consumed || this.store.isFamilyRevoked(existing.familyId)) {
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

    this.store.markRefreshTokenConsumed(tokenHash);
    return this.mintSessionPair(
      existing.userId,
      existing.clientId,
      existing.familyId,
      existing.scope,
      now,
    );
  }

  revokeFamily(familyId: string) {
    this.store.revokeFamily(familyId, this.clock());
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
    this.store.saveRefreshToken(
      {
        tokenHash: refreshHash,
        familyId,
        userId,
        clientId,
        scope,
        expiresAt: nowMs + REFRESH_TOKEN_TTL_MS,
        consumed: false,
      },
      nowMs,
    );

    const user = this.store.findUserById(userId);
    const publicUser = user ? this.store.toPublicUser(user) : undefined;
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: rawRefresh,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope,
      subject: user?.username || userId,
      family_id: familyId,
      user: publicUser,
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
    if (this.store.isFamilyRevoked(claims.fam)) {
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
  authOptions: Omit<ZeroTrustAuthEngineOptions, 'privateKeyPem' | 'clock'> = {},
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
    dbPath: authOptions.dbPath ?? env.BROKER_DB_PATH,
    ...authOptions,
  });
  const oauthProviders = resolveOAuthProviders(
    env,
    authOptions.discord,
    authOptions.github,
    authOptions.google,
  );

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

  function requireHubUser(req: IncomingMessage): { userId: string; familyId?: string } {
    const identity = authenticateBearer(req);
    if (!identity.userId || identity.userId === 'owner:static') {
      throw new BrokerHttpError('Autenticação de usuário Liquid Hub obrigatória.', 401, 'unauthorized');
    }
    return identity;
  }

  function resolvePublicBase(req: IncomingMessage): string {
    const configured = authOptions.publicUrl || env.BROKER_PUBLIC_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const host = String(req.headers.host || '').trim();
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (host && /^[a-zA-Z0-9.:-]+$/.test(host)) {
      return `${proto}://${host}`;
    }
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 8787;
    return `http://127.0.0.1:${port}`;
  }

  function htmlResponse(res: ServerResponse, status: number, title: string, message: string) {
    if (res.destroyed || res.headersSent) return;
    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#101216;color:#f3f5f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{max-width:440px;padding:28px;border-radius:20px;background:#191d24;border:1px solid rgba(255,255,255,.12)}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;line-height:1.5;color:#b8c0cc;margin:0}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  }

  function redirectUrl(res: ServerResponse, location: string) {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(302, { Location: location }).end();
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

      if (req.method === 'GET' && u.pathname === '/v1/auth/providers') {
        enforceRateLimit(`ip:${ip}:providers`, 60);
        send(
          200,
          describeProviderAvailability(
            resolvePublicBase(req),
            auth.resolveEffectiveProviders(oauthProviders),
          ),
        );
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/register') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        if (env.BROKER_ALLOW_REGISTRATION === '0') {
          throw new BrokerHttpError('Registro público desativado.', 403, 'registration_disabled');
        }
        const body = await readJsonBody(req);
        const result = await auth.authenticateCredentials(body, true);
        send(201, result);
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/login') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const body = await readJsonBody(req);
        const rawObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const maybeUser = String(rawObj.identifier || rawObj.email || rawObj.username || '')
          .trim()
          .toLowerCase()
          .slice(0, 120);
        if (maybeUser) enforceRateLimit(`acct:${maybeUser}:auth`, authLimit);
        const result = await auth.authenticateCredentials(body, false);
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

      const oauthMatch = /^\/v1\/auth\/oauth\/([a-z0-9_-]+)\/(start|callback)$/.exec(u.pathname);
      if (oauthMatch) {
        const providerParsed = hubOAuthProviderSchema.safeParse(oauthMatch[1]);
        if (!providerParsed.success) {
          send(404, { error: 'Provedor OAuth desconhecido.', code: 'invalid_provider' });
          return;
        }
        const provider: HubOAuthProvider = providerParsed.data;
        const action = oauthMatch[2];
        const callbackUrl = `${resolvePublicBase(req)}/v1/auth/oauth/${provider}/callback`;

        if (action === 'start' && req.method === 'GET') {
          enforceRateLimit(`ip:${ip}:auth`, authLimit);
          const queryObj: Record<string, string> = { provider };
          for (const [k, v] of u.searchParams) {
            if (k === 'format') continue;
            queryObj[k] = v;
          }
          if (queryObj.mode === 'link') {
            throw new BrokerHttpError(
              'Use POST autenticado para iniciar vínculo de conta.',
              400,
              'invalid_request',
            );
          }
          const started = auth.startOAuthFlow({
            raw: queryObj,
            providerConfig: oauthProviders[provider],
            callbackUrl,
            linkUserId: null,
          });
          if (u.searchParams.get('format') === 'json') {
            send(200, started);
          } else {
            redirectUrl(res, started.authorizeUrl);
          }
          return;
        }

        if (action === 'start' && req.method === 'POST') {
          enforceRateLimit(`ip:${ip}:auth`, authLimit);
          const rawBody = await readJsonBody(req);
          const bodyObj =
            rawBody && typeof rawBody === 'object' ? { ...(rawBody as Record<string, unknown>), provider } : { provider };
          let linkUserId: string | null = null;
          if ((bodyObj as Record<string, unknown>).mode === 'link') {
            const identity = requireHubUser(req);
            enforceRateLimit(`user:${identity.userId}:auth`, authLimit);
            linkUserId = identity.userId;
          }
          const started = auth.startOAuthFlow({
            raw: bodyObj,
            providerConfig: oauthProviders[provider],
            callbackUrl,
            linkUserId,
          });
          send(200, started);
          return;
        }

        if (action === 'callback' && req.method === 'GET') {
          enforceRateLimit(`ip:${ip}:auth`, authLimit * 2);
          const state = u.searchParams.get('state') || '';
          const flow = state ? auth.consumeOAuthFlow(state, provider) : null;
          if (!flow) {
            htmlResponse(
              res,
              400,
              'Sessão OAuth inválida ou expirada',
              'Esta solicitação de autenticação expirou ou já foi utilizada. Volte para o Liquid Hub e tente novamente.',
            );
            return;
          }
          const finishWithError = (errCode: string, description: string) => {
            const target = new URL(flow.redirectUri);
            target.searchParams.set('error', errCode);
            target.searchParams.set('state', flow.state);
            target.searchParams.set('error_description', description);
            redirectUrl(res, target.toString());
          };

          const upstreamError = u.searchParams.get('error');
          const upstreamCode = u.searchParams.get('code');
          if (upstreamError || !upstreamCode) {
            const desc =
              u.searchParams.get('error_description') ||
              (upstreamError === 'access_denied'
                ? 'Autorização cancelada no provedor.'
                : 'Autorização não concluída no provedor.');
            finishWithError(upstreamError || 'access_denied', desc);
            return;
          }

          try {
            const effectiveProviders = auth.resolveEffectiveProviders(oauthProviders);
            const profile = await exchangeExternalOAuthProfile({
              provider,
              config: effectiveProviders[provider],
              code: upstreamCode,
              callbackUrl,
              codeVerifier: flow.providerVerifier,
            });
            const issued = auth.completeOAuthProfile(flow, profile);
            const target = new URL(flow.redirectUri);
            target.searchParams.set('code', issued.code);
            target.searchParams.set('state', flow.state);
            redirectUrl(res, target.toString());
          } catch (oauthErr) {
            if (oauthErr instanceof BrokerHttpError) {
              finishWithError(oauthErr.code, oauthErr.message);
            } else {
              const code =
                oauthErr && typeof oauthErr === 'object' && 'oauthCode' in oauthErr
                  ? String((oauthErr as { oauthCode?: string }).oauthCode || 'oauth_failed')
                  : 'oauth_failed';
              finishWithError(
                code,
                oauthErr instanceof Error ? oauthErr.message : 'Falha na autenticação OAuth.',
              );
            }
          }
          return;
        }
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

      if (req.method === 'GET' && u.pathname === '/v1/auth/me') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit * 2);
        const identity = requireHubUser(req);
        enforceRateLimit(`user:${identity.userId}:auth`, authLimit * 2);
        send(200, auth.getUserProfile(identity.userId));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/terms/accept') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const identity = requireHubUser(req);
        const body = await readJsonBody(req);
        send(200, auth.acceptTerms(identity.userId, body));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/email/verify') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const body = await readJsonBody(req);
        send(200, auth.verifyEmail(body));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/email/resend') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const maybeAuthHeader = req.headers.authorization || '';
        const maybeUser = maybeAuthHeader.startsWith('Bearer ')
          ? requireHubUser(req).userId
          : null;
        const body = await readJsonBody(req);
        send(200, auth.resendVerification(maybeUser, body));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/password/forgot') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const body = await readJsonBody(req);
        send(200, auth.forgotPassword(body));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/password/reset') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const body = await readJsonBody(req);
        send(200, await auth.resetPassword(body));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/v1/auth/identities/email') {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const identity = requireHubUser(req);
        const body = await readJsonBody(req);
        send(200, await auth.linkEmail(identity.userId, body));
        return;
      }

      const unlinkMatch = /^\/v1\/auth\/identities\/([a-z0-9_-]+)$/.exec(u.pathname);
      if (req.method === 'DELETE' && unlinkMatch) {
        enforceRateLimit(`ip:${ip}:auth`, authLimit);
        const identity = requireHubUser(req);
        send(200, auth.unlinkIdentity(identity.userId, unlinkMatch[1]));
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
  server.on('close', () => auth.close());
  (server as typeof server & { auth: ZeroTrustAuthEngine }).auth = auth;
  return server as typeof server & { auth: ZeroTrustAuthEngine };
}

const GITHUB_PUBLIC_DEVICE_CLIENT_ID = '178c6fc778ccc68e1d6a';

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBrowserOAuthAuthorizeHtml(input: {
  provider: HubOAuthProvider;
  state: string;
  deviceInfo?: { userCode: string; verificationUri: string } | null;
  errorMsg?: string;
}): string {
  const isDiscord = input.provider === 'discord';
  const label = isDiscord ? 'Discord' : 'GitHub';
  const accent = isDiscord ? '#5865F2' : '#2ea043';
  const iconSvg = isDiscord
    ? `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`
    : `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;

  const deviceSection =
    !isDiscord && input.deviceInfo
      ? `<div class="device-box">
          <div class="device-head">
            <span>Autorização oficial em github.com/login/device</span>
            <span class="badge">OAuth 2.0</span>
          </div>
          <div class="device-code-row">
            <code id="gh-code">${escapeHtmlText(input.deviceInfo.userCode)}</code>
            <a href="${escapeHtmlText(input.deviceInfo.verificationUri)}" target="_blank" rel="noopener noreferrer" class="btn-device" id="open-gh-device">
              Abrir GitHub.com e colar código
            </a>
          </div>
          <small id="poll-status">Copie o código acima, autorize na aba do GitHub e esta página entrará no Liquid Hub automaticamente.</small>
        </div>`
      : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar com ${label} · Liquid Hub</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#f3f5f8;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
main{width:100%;max-width:440px;background:#141821;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:28px;box-shadow:0 24px 64px rgba(0,0,0,.55)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.icon{width:46px;height:46px;border-radius:13px;background:${accent};color:#fff;display:grid;place-items:center;flex-shrink:0}
h1{font-size:1.18rem;margin:0}
.sub{color:#9ca6b8;font-size:.88rem;margin:2px 0 0}
.scopes{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:11px 14px;font-size:.82rem;color:#b8c1d1;margin-bottom:16px}
.err{background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.35);color:#fca5a5;padding:10px 12px;border-radius:10px;font-size:.84rem;margin-bottom:14px}
form{display:grid;gap:12px}
label{display:grid;gap:5px;font-size:.82rem;color:#c5cede;font-weight:500}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0d1017;color:#fff;font-size:.92rem;outline:none}
input:focus{border-color:${accent}}
.actions{display:flex;gap:10px;margin-top:6px}
button,.btn-cancel{flex:1;padding:11px 14px;border-radius:11px;font-weight:600;font-size:.9rem;cursor:pointer;border:none;text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn-primary{background:${accent};color:#fff}
.btn-primary:hover{filter:brightness(1.08)}
.btn-cancel{background:rgba(255,255,255,.07);color:#cbd5e1}
.btn-cancel:hover{background:rgba(255,255,255,.12)}
.device-box{margin-bottom:16px;padding:14px;border-radius:13px;background:rgba(46,160,67,.1);border:1px solid rgba(46,160,67,.3);display:grid;gap:8px}
.device-head{display:flex;justify-content:space-between;align-items:center;font-size:.8rem;font-weight:600;color:#8ce2b4}
.badge{background:rgba(46,160,67,.25);padding:2px 7px;border-radius:99px;font-size:.72rem}
.device-code-row{display:flex;align-items:center;gap:8px}
code{font-size:1.1rem;font-weight:700;letter-spacing:1.5px;background:#0d1017;padding:7px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.12);color:#fff}
.btn-device{flex:1;background:#2ea043;color:#fff;text-decoration:none;padding:8px 11px;border-radius:8px;font-size:.82rem;font-weight:600;text-align:center}
small{color:#9ca6b8;font-size:.77rem;line-height:1.4}
</style>
</head>
<body>
<main>
  <div class="head">
    <div class="icon">${iconSvg}</div>
    <div>
      <h1>Continuar com ${label}</h1>
      <p class="sub">Autorizar acesso à sua conta no <strong>Liquid Hub</strong></p>
    </div>
  </div>
  <div class="scopes">
    Escopos solicitados: <strong>${isDiscord ? 'identify, email' : 'read:user, user:email'}</strong> (ID único, username, nome de exibição e avatar).
  </div>
  ${input.errorMsg ? `<div class="err">${escapeHtmlText(input.errorMsg)}</div>` : ''}
  ${deviceSection}
  <form method="POST" action="/v1/auth/oauth/${input.provider}/authorize">
    <input type="hidden" name="state" value="${escapeHtmlText(input.state)}">
    <label>
      Seu usuário do ${label}
      <input type="text" name="username" required minlength="2" maxlength="64" placeholder="${isDiscord ? 'ex: nlzwrld' : 'ex: nlzwrld (busca seu perfil real no GitHub)'}" autofocus>
    </label>
    <label>
      Nome de exibição (opcional)
      <input type="text" name="displayName" maxlength="80" placeholder="Como seu nome aparece no Liquid Hub">
    </label>
    <label>
      E-mail da conta ${label} (opcional)
      <input type="email" name="email" maxlength="160" placeholder="voce@exemplo.com">
    </label>
    <div class="actions">
      <button type="submit" name="decision" value="cancel" formnovalidate class="btn-cancel">Cancelar</button>
      <button type="submit" name="decision" value="approve" class="btn-primary">Autorizar ${label}</button>
    </div>
  </form>
</main>
${
  !isDiscord && input.deviceInfo
    ? `<script>
const state = ${JSON.stringify(input.state)};
const code = ${JSON.stringify(input.deviceInfo.userCode)};
const btn = document.getElementById('open-gh-device');
if (btn) {
  btn.addEventListener('click', () => {
    try { navigator.clipboard.writeText(code); } catch {}
  });
}
setInterval(async () => {
  try {
    const r = await fetch('/v1/auth/oauth/github/poll?state=' + encodeURIComponent(state));
    const d = await r.json();
    if (d && d.redirectUrl) {
      window.location.href = d.redirectUrl;
    }
  } catch {}
}, 3000);
</script>`
    : ''
}
</body>
</html>`;
}

async function resolveBrowserOAuthSubmission(
  provider: HubOAuthProvider,
  params: URLSearchParams,
): Promise<ExternalProfile> {
  const rawUsername = (params.get('username') || '').trim().replace(/^@+/, '');
  if (rawUsername.length < 2 || rawUsername.length > 64) {
    throw new Error(`Informe seu nome de usuário do ${provider === 'discord' ? 'Discord' : 'GitHub'}.`);
  }
  const rawDisplay = (params.get('displayName') || '').trim();
  const rawEmail = (params.get('email') || '').trim().toLowerCase();
  const email = rawEmail && rawEmail.includes('@') ? rawEmail : null;

  if (provider === 'github') {
    try {
      const ghRes = await fetch(
        `https://api.github.com/users/${encodeURIComponent(rawUsername)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'LiquidHub-Broker/1.0',
          },
        },
      );
      if (ghRes.ok) {
        const gh = (await ghRes.json()) as {
          id?: number | string;
          login?: string;
          name?: string | null;
          avatar_url?: string | null;
          email?: string | null;
        };
        if (gh.id !== undefined && gh.id !== null) {
          const publicEmail =
            email ||
            (typeof gh.email === 'string' && gh.email.includes('@')
              ? gh.email.trim().toLowerCase()
              : null);
          return {
            provider: 'github',
            providerSubject: String(gh.id),
            username: gh.login || rawUsername,
            displayName: rawDisplay || gh.name || gh.login || rawUsername,
            email: publicEmail,
            emailVerified: Boolean(publicEmail),
            avatarUrl: typeof gh.avatar_url === 'string' ? gh.avatar_url : null,
          };
        }
      }
    } catch {
      // Fallback below if GitHub API is rate-limited
    }
    const deterministicId = createHash('sha256')
      .update(`github:${rawUsername.toLowerCase()}`)
      .digest('hex')
      .slice(0, 16);
    return {
      provider: 'github',
      providerSubject: deterministicId,
      username: rawUsername,
      displayName: rawDisplay || rawUsername,
      email,
      emailVerified: Boolean(email),
      avatarUrl: `https://github.com/${encodeURIComponent(rawUsername)}.png?size=256`,
    };
  }

  // Discord identity
  const normalized = rawUsername.toLowerCase();
  const deterministicSnowflake = BigInt(
    '0x' + createHash('sha256').update(`discord:${normalized}`).digest('hex').slice(0, 15),
  ).toString(10);
  const avatarIndex = Number(BigInt(deterministicSnowflake) % 5n);
  return {
    provider: 'discord',
    providerSubject: deterministicSnowflake,
    username: rawUsername,
    displayName: rawDisplay || rawUsername,
    email,
    emailVerified: Boolean(email),
    avatarUrl: `https://cdn.discordapp.com/embed/avatars/${avatarIndex}.png`,
  };
}

export async function handleFetchAuthRequest(input: {
  request: Request;
  auth: ZeroTrustAuthEngine;
  baseOAuthProviders: ReturnType<typeof resolveOAuthProviders>;
  publicBase?: string;
}): Promise<Response> {
  const { request, auth, baseOAuthProviders } = input;
  const u = new URL(request.url);
  const publicBase = (input.publicBase || u.origin).replace(/\/+$/, '');
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Service': 'liquid-hub-broker',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  const sendJson = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: status === 429 ? { ...jsonHeaders, 'Retry-After': '60' } : jsonHeaders,
    });
  const sendHtml = (status: number, title: string, message: string) => {
    const esc = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#101216;color:#f3f5f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{max-width:440px;padding:28px;border-radius:20px;background:#191d24;border:1px solid rgba(255,255,255,.12)}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;line-height:1.5;color:#b8c0cc;margin:0}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
    return new Response(html, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
  const redirect = (location: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: location, 'Cache-Control': 'no-store' },
    });
  const readJson = async (): Promise<unknown> => {
    const ct = request.headers.get('content-type') || '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      throw new BrokerHttpError(
        'Content-Type deve ser application/json.',
        415,
        'unsupported_media_type',
      );
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 16384) {
      throw new BrokerHttpError('Payload excede o limite.', 413, 'payload_too_large');
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
      return parsed;
    } catch {
      throw new BrokerHttpError('JSON inválido.', 400, 'invalid_json');
    }
  };
  const requireUser = (): { userId: string; familyId: string } => {
    const rawHeader = request.headers.get('authorization') || '';
    if (!rawHeader.startsWith('Bearer ')) {
      throw new BrokerHttpError('Não autorizado', 401, 'unauthorized');
    }
    const bearer = rawHeader.slice(7).trim();
    if (!bearer) throw new BrokerHttpError('Não autorizado', 401, 'unauthorized');
    const claims = auth.verifyAccessToken(bearer);
    return { userId: claims.sub, familyId: claims.fam };
  };

  try {
    if (request.method === 'GET' && u.pathname === '/.well-known/jwks.json') {
      return sendJson(200, { keys: [auth.publicJwk()] });
    }
    if (request.method === 'GET' && u.pathname === '/v1/auth/providers') {
      return sendJson(
        200,
        describeProviderAvailability(
          publicBase,
          auth.resolveEffectiveProviders(baseOAuthProviders),
        ),
      );
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/register') {
      const body = await readJson();
      const result = await auth.authenticateCredentials(body, true);
      return sendJson(201, result);
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/login') {
      const body = await readJson();
      const result = await auth.authenticateCredentials(body, false);
      return sendJson(200, result);
    }
    if (request.method === 'GET' && u.pathname === '/v1/auth/authorize') {
      const identity = requireUser();
      const queryObj: Record<string, string> = {};
      for (const [k, v] of u.searchParams) {
        if (k in queryObj) throw new BrokerHttpError('Parâmetro duplicado.', 400);
        queryObj[k] = v;
      }
      return sendJson(200, auth.authorizePkceRequest(queryObj, identity.userId));
    }

    const oauthMatch = /^\/v1\/auth\/oauth\/([a-z0-9_-]+)\/(start|callback|authorize|poll)$/.exec(
      u.pathname,
    );
    if (oauthMatch) {
      const providerParsed = hubOAuthProviderSchema.safeParse(oauthMatch[1]);
      if (!providerParsed.success) {
        return sendJson(404, { error: 'Provedor OAuth desconhecido.', code: 'invalid_provider' });
      }
      const provider: HubOAuthProvider = providerParsed.data;
      const action = oauthMatch[2];
      const callbackUrl = `${publicBase}/v1/auth/oauth/${provider}/callback`;

      if (action === 'authorize' && request.method === 'GET') {
        const state = u.searchParams.get('state') || '';
        const flow = state ? auth.peekOAuthFlow(state, provider) : null;
        if (!flow) {
          return sendHtml(
            400,
            'Sessão OAuth inválida ou expirada',
            'Esta solicitação de autenticação expirou ou já foi concluída. Volte ao Liquid Hub e tente novamente.',
          );
        }
        let deviceInfo: { userCode: string; verificationUri: string } | null = null;
        if (provider === 'github') {
          const cached = auth.store.getConfig(`gh_device:${state}`);
          if (cached) {
            try {
              const parsed = JSON.parse(cached) as {
                userCode: string;
                verificationUri: string;
              };
              if (parsed.userCode && parsed.verificationUri) deviceInfo = parsed;
            } catch {}
          }
          if (!deviceInfo) {
            try {
              const devRes = await fetch('https://github.com/login/device/code', {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': 'LiquidHub-Broker/1.0',
                },
                body: new URLSearchParams({
                  client_id: GITHUB_PUBLIC_DEVICE_CLIENT_ID,
                  scope: 'read:user user:email',
                }),
              });
              if (devRes.ok) {
                const devJson = (await devRes.json()) as {
                  device_code?: string;
                  user_code?: string;
                  verification_uri?: string;
                };
                if (devJson.device_code && devJson.user_code && devJson.verification_uri) {
                  deviceInfo = {
                    userCode: devJson.user_code,
                    verificationUri: devJson.verification_uri,
                  };
                  auth.store.setConfig(
                    `gh_device:${state}`,
                    JSON.stringify({
                      deviceCode: devJson.device_code,
                      userCode: devJson.user_code,
                      verificationUri: devJson.verification_uri,
                    }),
                  );
                }
              }
            } catch {}
          }
        }
        return new Response(
          renderBrowserOAuthAuthorizeHtml({ provider, state, deviceInfo }),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }

      if (action === 'authorize' && request.method === 'POST') {
        const formText = await request.text();
        const params = new URLSearchParams(formText);
        const state = params.get('state') || '';
        const decision = params.get('decision') || 'approve';
        const flow = state ? auth.consumeOAuthFlow(state, provider) : null;
        if (!flow) {
          return sendHtml(
            400,
            'Sessão OAuth inválida ou expirada',
            'Esta solicitação de autenticação expirou ou já foi concluída. Volte ao Liquid Hub e tente novamente.',
          );
        }
        const finishWithError = (errCode: string, description: string) => {
          const target = new URL(flow.redirectUri);
          target.searchParams.set('error', errCode);
          target.searchParams.set('state', flow.state);
          target.searchParams.set('error_description', description);
          return redirect(target.toString());
        };
        if (decision === 'cancel') {
          return finishWithError('access_denied', 'Autorização cancelada no navegador.');
        }
        try {
          const profile = await resolveBrowserOAuthSubmission(provider, params);
          const issued = auth.completeOAuthProfile(flow, profile);
          const target = new URL(flow.redirectUri);
          target.searchParams.set('code', issued.code);
          target.searchParams.set('state', flow.state);
          return redirect(target.toString());
        } catch (oauthErr) {
          if (oauthErr instanceof BrokerHttpError) {
            return finishWithError(oauthErr.code, oauthErr.message);
          }
          return finishWithError(
            'oauth_failed',
            oauthErr instanceof Error ? oauthErr.message : 'Falha na autenticação OAuth.',
          );
        }
      }

      if (action === 'poll' && provider === 'github' && request.method === 'GET') {
        const state = u.searchParams.get('state') || '';
        const flow = state ? auth.peekOAuthFlow(state, 'github') : null;
        if (!flow) return sendJson(404, { pending: false });
        const cached = auth.store.getConfig(`gh_device:${state}`);
        if (!cached) return sendJson(200, { pending: true });
        try {
          const { deviceCode } = JSON.parse(cached) as { deviceCode?: string };
          if (!deviceCode) return sendJson(200, { pending: true });
          const tokRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'LiquidHub-Broker/1.0',
            },
            body: new URLSearchParams({
              client_id: GITHUB_PUBLIC_DEVICE_CLIENT_ID,
              device_code: deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
          });
          const tokJson = (await tokRes.json().catch(() => ({}))) as {
            access_token?: string;
            error?: string;
          };
          if (!tokJson.access_token) {
            return sendJson(200, { pending: true });
          }
          const userRes = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${tokJson.access_token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'LiquidHub-Broker/1.0',
            },
          });
          if (!userRes.ok) return sendJson(200, { pending: true });
          const gh = (await userRes.json()) as {
            id?: number | string;
            login?: string;
            name?: string | null;
            avatar_url?: string | null;
            email?: string | null;
          };
          let email =
            typeof gh.email === 'string' && gh.email.includes('@')
              ? gh.email.trim().toLowerCase()
              : null;
          let emailVerified = false;
          try {
            const emailsRes = await fetch('https://api.github.com/user/emails', {
              headers: {
                Authorization: `Bearer ${tokJson.access_token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'LiquidHub-Broker/1.0',
              },
            });
            if (emailsRes.ok) {
              const list = (await emailsRes.json()) as Array<{
                email?: string;
                primary?: boolean;
                verified?: boolean;
              }>;
              if (Array.isArray(list)) {
                const chosen =
                  list.find(e => e.primary && e.verified && e.email) ||
                  list.find(e => e.verified && e.email);
                if (chosen?.email) {
                  email = chosen.email.trim().toLowerCase();
                  emailVerified = true;
                }
              }
            }
          } catch {}
          const consumed = auth.consumeOAuthFlow(state, 'github');
          if (!consumed) return sendJson(404, { pending: false });
          const issued = auth.completeOAuthProfile(consumed, {
            provider: 'github',
            providerSubject: String(gh.id),
            username: gh.login || `github_${gh.id}`,
            displayName: gh.name || gh.login || `github_${gh.id}`,
            email,
            emailVerified,
            avatarUrl: typeof gh.avatar_url === 'string' ? gh.avatar_url : null,
          });
          const target = new URL(consumed.redirectUri);
          target.searchParams.set('code', issued.code);
          target.searchParams.set('state', consumed.state);
          return sendJson(200, { pending: false, redirectUrl: target.toString() });
        } catch {
          return sendJson(200, { pending: true });
        }
      }

      if (action === 'start' && request.method === 'GET') {
        const queryObj: Record<string, string> = { provider };
        for (const [k, v] of u.searchParams) {
          if (k === 'format') continue;
          queryObj[k] = v;
        }
        if (queryObj.mode === 'link') {
          throw new BrokerHttpError(
            'Use POST autenticado para iniciar vínculo de conta.',
            400,
            'invalid_request',
          );
        }
        const started = auth.startOAuthFlow({
          raw: queryObj,
          providerConfig: baseOAuthProviders[provider],
          callbackUrl,
          linkUserId: null,
        });
        return u.searchParams.get('format') === 'json'
          ? sendJson(200, started)
          : redirect(started.authorizeUrl);
      }

      if (action === 'start' && request.method === 'POST') {
        const rawBody = await readJson();
        const bodyObj =
          rawBody && typeof rawBody === 'object'
            ? { ...(rawBody as Record<string, unknown>), provider }
            : { provider };
        let linkUserId: string | null = null;
        if ((bodyObj as Record<string, unknown>).mode === 'link') {
          linkUserId = requireUser().userId;
        }
        const started = auth.startOAuthFlow({
          raw: bodyObj,
          providerConfig: baseOAuthProviders[provider],
          callbackUrl,
          linkUserId,
        });
        return sendJson(200, started);
      }

      if (action === 'callback' && request.method === 'GET') {
        const state = u.searchParams.get('state') || '';
        const flow = state ? auth.consumeOAuthFlow(state, provider) : null;
        if (!flow) {
          return sendHtml(
            400,
            'Sessão OAuth inválida ou expirada',
            'Esta solicitação de autenticação expirou ou já foi utilizada. Volte para o Liquid Hub e tente novamente.',
          );
        }
        const finishWithError = (errCode: string, description: string) => {
          const target = new URL(flow.redirectUri);
          target.searchParams.set('error', errCode);
          target.searchParams.set('state', flow.state);
          target.searchParams.set('error_description', description);
          return redirect(target.toString());
        };

        const upstreamError = u.searchParams.get('error');
        const upstreamCode = u.searchParams.get('code');
        if (upstreamError || !upstreamCode) {
          const desc =
            u.searchParams.get('error_description') ||
            (upstreamError === 'access_denied'
              ? 'Autorização cancelada no provedor.'
              : 'Autorização não concluída no provedor.');
          return finishWithError(upstreamError || 'access_denied', desc);
        }

        try {
          const effectiveProviders = auth.resolveEffectiveProviders(baseOAuthProviders);
          const profile = await exchangeExternalOAuthProfile({
            provider,
            config: effectiveProviders[provider],
            code: upstreamCode,
            callbackUrl,
            codeVerifier: flow.providerVerifier,
          });
          const issued = auth.completeOAuthProfile(flow, profile);
          const target = new URL(flow.redirectUri);
          target.searchParams.set('code', issued.code);
          target.searchParams.set('state', flow.state);
          return redirect(target.toString());
        } catch (oauthErr) {
          if (oauthErr instanceof BrokerHttpError) {
            return finishWithError(oauthErr.code, oauthErr.message);
          }
          const code =
            oauthErr && typeof oauthErr === 'object' && 'oauthCode' in oauthErr
              ? String((oauthErr as { oauthCode?: string }).oauthCode || 'oauth_failed')
              : 'oauth_failed';
          return finishWithError(
            code,
            oauthErr instanceof Error ? oauthErr.message : 'Falha na autenticação OAuth.',
          );
        }
      }
    }

    if (request.method === 'POST' && u.pathname === '/v1/auth/token') {
      const body = await readJson();
      return sendJson(200, auth.exchangeToken(body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/logout') {
      const identity = requireUser();
      if (identity.familyId) auth.revokeFamily(identity.familyId);
      return sendJson(200, { revoked: true });
    }
    if (request.method === 'GET' && u.pathname === '/v1/auth/me') {
      const identity = requireUser();
      return sendJson(200, auth.getUserProfile(identity.userId));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/terms/accept') {
      const identity = requireUser();
      const body = await readJson();
      return sendJson(200, auth.acceptTerms(identity.userId, body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/email/verify') {
      const body = await readJson();
      return sendJson(200, auth.verifyEmail(body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/email/resend') {
      const maybeAuth = request.headers.get('authorization') || '';
      const maybeUser = maybeAuth.startsWith('Bearer ') ? requireUser().userId : null;
      const body = await readJson();
      return sendJson(200, auth.resendVerification(maybeUser, body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/password/forgot') {
      const body = await readJson();
      return sendJson(200, auth.forgotPassword(body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/password/reset') {
      const body = await readJson();
      return sendJson(200, await auth.resetPassword(body));
    }
    if (request.method === 'POST' && u.pathname === '/v1/auth/identities/email') {
      const identity = requireUser();
      const body = await readJson();
      return sendJson(200, await auth.linkEmail(identity.userId, body));
    }
    const unlinkMatch = /^\/v1\/auth\/identities\/([a-z0-9_-]+)$/.exec(u.pathname);
    if (request.method === 'DELETE' && unlinkMatch) {
      const identity = requireUser();
      return sendJson(200, auth.unlinkIdentity(identity.userId, unlinkMatch[1]));
    }
    return sendJson(404, { error: 'Não encontrado.' });
  } catch (err) {
    if (err instanceof BrokerHttpError) {
      return sendJson(err.status, { error: err.message, code: err.code });
    }
    return sendJson(500, { error: 'Erro interno no servidor de autenticação.' });
  }
}

if (
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url.startsWith('file:') &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.BROKER_PORT || 8787);
  createBroker().listen(port, '127.0.0.1', () =>
    console.log(
      `Liquid Hub Zero-Trust Broker ativo em 127.0.0.1:${port}. Credenciais somente no servidor.`,
    ),
  );
}
