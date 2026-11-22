import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../shared/auth.ts';
import type {
  HubAuthProvider,
  HubIdentityPublic,
  HubOAuthProvider,
  HubProvidersAvailability,
} from '../shared/types.ts';

export interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  emailsUrl?: string;
}

export interface AuthEmailMessage {
  kind: 'verify_email' | 'reset_password';
  to: string;
  userId: string;
  username: string;
  displayName: string;
  token: string;
  expiresAt: number;
}

export interface HubUserRecord {
  userId: string;
  username: string;
  normalizedUsername: string;
  displayName: string;
  email: string | null;
  normalizedEmail: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  avatarUrl: string | null;
  termsVersion: string | null;
  privacyVersion: string | null;
  termsAcceptedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface HubUserPublic {
  userId: string;
  subject: string;
  username: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  hasPassword: boolean;
  identities: HubIdentityPublic[];
  termsVersion: string | null;
  privacyVersion: string | null;
  termsAcceptedAt: number | null;
  needsTermsAcceptance: boolean;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  familyId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  consumed: boolean;
}

export interface PendingOAuthFlow {
  state: string;
  provider: HubOAuthProvider;
  mode: 'login' | 'link';
  linkUserId: string | null;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  providerVerifier: string;
  termsVersion: string | null;
  privacyVersion: string | null;
  termsAcceptedAt: number | null;
  createdAt: number;
  expiresAt: number;
}

export interface ExternalProfile {
  provider: HubOAuthProvider;
  providerSubject: string;
  username: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface PendingAuthCodeRecord {
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

export interface StatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
  transaction?: <T>(fn: () => T) => T;
}

export interface CloudflareDoSqlStorage {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Array<Record<string, unknown>>;
  };
}

export function createDoSqliteAdapter(
  sql: CloudflareDoSqlStorage,
  transactionSync?: <T>(fn: () => T) => T,
): SqliteDatabaseLike {
  const adapter: SqliteDatabaseLike = {
    exec(rawSql: string) {
      const statements = rawSql
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        if (/^PRAGMA\s+journal_mode/i.test(stmt)) continue;
        sql.exec(stmt);
      }
    },
    prepare(query: string): StatementLike {
      return {
        run(...params: unknown[]) {
          sql.exec(query, ...params);
          return {};
        },
        get(...params: unknown[]) {
          const rows = sql.exec(query, ...params).toArray();
          return rows[0];
        },
        all(...params: unknown[]) {
          return sql.exec(query, ...params).toArray();
        },
      };
    },
    close() {
      // Managed by Cloudflare Durable Object runtime
    },
    transaction: transactionSync ? <T>(fn: () => T) => transactionSync(fn) : <T>(fn: () => T) => fn(),
  };
  initAuthSchema(adapter);
  return adapter;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function sanitizeUsernameSeed(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  if (cleaned.length >= 3) return cleaned.slice(0, 64);
  return `user_${randomBytes(3).toString('hex')}`;
}

export function isCurrentLegalAcceptance(
  termsVersion?: string | null,
  privacyVersion?: string | null,
): boolean {
  return (
    termsVersion === CURRENT_TERMS_VERSION && privacyVersion === CURRENT_PRIVACY_VERSION
  );
}

const AUTH_SCHEMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON',
  `CREATE TABLE IF NOT EXISTS hub_users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    normalized_username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    normalized_email TEXT UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    avatar_url TEXT,
    terms_version TEXT,
    privacy_version TEXT,
    terms_accepted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hub_identities (
    provider TEXT NOT NULL CHECK (provider IN ('email', 'discord', 'github')),
    provider_subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
    username TEXT,
    display_name TEXT,
    email TEXT,
    avatar_url TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (provider, provider_subject)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hub_identities_user ON hub_identities(user_id)',
  `CREATE TABLE IF NOT EXISTS hub_email_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
    user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hub_oauth_flows (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('discord', 'github')),
    mode TEXT NOT NULL CHECK (mode IN ('login', 'link')),
    link_user_id TEXT,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    provider_verifier TEXT NOT NULL,
    terms_version TEXT,
    privacy_version TEXT,
    terms_accepted_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hub_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
    family_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS hub_revoked_families (
    family_id TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hub_auth_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    issued_family_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS hub_server_config (
    config_key TEXT PRIMARY KEY,
    config_value TEXT NOT NULL
  )`,
];

export function initAuthSchema(db: SqliteDatabaseLike) {
  for (const stmt of AUTH_SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
}

function openAuthDatabase(dbPath: string): SqliteDatabaseLike {
  if (dbPath && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const req = createRequire(import.meta.url);
  const mod = req('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabaseLike };
  const db = new mod.DatabaseSync(dbPath || ':memory:');
  if (dbPath && dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  initAuthSchema(db);
  return db;
}

function rowToUser(row: Record<string, unknown> | undefined): HubUserRecord | null {
  if (!row) return null;
  return {
    userId: String(row.user_id),
    username: String(row.username),
    normalizedUsername: String(row.normalized_username),
    displayName: String(row.display_name),
    email: row.email ? String(row.email) : null,
    normalizedEmail: row.normalized_email ? String(row.normalized_email) : null,
    emailVerified: Number(row.email_verified) === 1,
    passwordHash: row.password_hash ? String(row.password_hash) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    termsVersion: row.terms_version ? String(row.terms_version) : null,
    privacyVersion: row.privacy_version ? String(row.privacy_version) : null,
    termsAcceptedAt:
      typeof row.terms_accepted_at === 'number' ? row.terms_accepted_at : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToIdentity(row: Record<string, unknown>): HubIdentityPublic {
  return {
    provider: String(row.provider) as HubAuthProvider,
    providerSubject: String(row.provider_subject),
    username: row.username ? String(row.username) : undefined,
    displayName: row.display_name ? String(row.display_name) : undefined,
    email: row.email ? String(row.email) : undefined,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
    verified: Number(row.verified) === 1,
    linkedAt: Number(row.linked_at),
  };
}

export class HubAuthStore {
  private readonly db: SqliteDatabaseLike;
  private closed = false;

  constructor(dbOrPath: string | SqliteDatabaseLike = ':memory:') {
    this.db = typeof dbOrPath === 'string' ? openAuthDatabase(dbOrPath) : dbOrPath;
  }

  private tx<T>(fn: () => T): T {
    if (this.db.transaction) {
      return this.db.transaction(fn);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw error;
    }
  }

  getConfig(key: string): string | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT config_value FROM hub_server_config WHERE config_key = ?')
      .get(key);
    return row && typeof row.config_value === 'string' ? row.config_value : null;
  }

  setConfig(key: string, value: string) {
    this.assertOpen();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO hub_server_config (config_key, config_value) VALUES (?, ?)',
      )
      .run(key, value);
  }

  saveAuthCode(record: PendingAuthCodeRecord, now: number) {
    this.assertOpen();
    this.db.prepare('DELETE FROM hub_auth_codes WHERE expires_at <= ?').run(now);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO hub_auth_codes (
           code, user_id, client_id, code_challenge, redirect_uri,
           scope, expires_at, consumed, issued_family_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.code,
        record.userId,
        record.clientId,
        record.codeChallenge,
        record.redirectUri ?? null,
        record.scope,
        record.expiresAt,
        record.consumed ? 1 : 0,
        record.issuedFamilyId ?? null,
      );
  }

  findAuthCode(code: string): PendingAuthCodeRecord | null {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM hub_auth_codes WHERE code = ?').get(code);
    if (!row) return null;
    return {
      code: String(row.code),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      codeChallenge: String(row.code_challenge),
      redirectUri: row.redirect_uri ? String(row.redirect_uri) : undefined,
      scope: String(row.scope),
      expiresAt: Number(row.expires_at),
      consumed: Number(row.consumed) === 1,
      issuedFamilyId: row.issued_family_id ? String(row.issued_family_id) : undefined,
    };
  }

  markAuthCodeConsumed(code: string, familyId: string) {
    this.assertOpen();
    this.db
      .prepare('UPDATE hub_auth_codes SET consumed = 1, issued_family_id = ? WHERE code = ?')
      .run(familyId, code);
  }

  deleteAuthCode(code: string) {
    this.assertOpen();
    this.db.prepare('DELETE FROM hub_auth_codes WHERE code = ?').run(code);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Ignore double close during shutdown
    }
  }

  private assertOpen() {
    if (this.closed) {
      throw new Error('Auth database is closed');
    }
  }

  findUserById(userId: string): HubUserRecord | null {
    this.assertOpen();
    return rowToUser(
      this.db.prepare('SELECT * FROM hub_users WHERE user_id = ?').get(userId),
    );
  }

  findUserByUsername(username: string): HubUserRecord | null {
    this.assertOpen();
    return rowToUser(
      this.db
        .prepare('SELECT * FROM hub_users WHERE normalized_username = ?')
        .get(normalizeUsername(username)),
    );
  }

  findUserByEmail(email: string): HubUserRecord | null {
    this.assertOpen();
    return rowToUser(
      this.db
        .prepare('SELECT * FROM hub_users WHERE normalized_email = ?')
        .get(normalizeEmail(email)),
    );
  }

  findUserByIdentifier(identifier: string): HubUserRecord | null {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) {
      const byEmail = this.findUserByEmail(trimmed);
      if (byEmail) return byEmail;
    }
    return this.findUserByUsername(trimmed);
  }

  findIdentity(
    provider: HubAuthProvider,
    providerSubject: string,
  ): { userId: string; identity: HubIdentityPublic } | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_identities WHERE provider = ? AND provider_subject = ?')
      .get(provider, providerSubject);
    if (!row) return null;
    return {
      userId: String(row.user_id),
      identity: rowToIdentity(row),
    };
  }

  findUserIdentityByProvider(
    userId: string,
    provider: HubAuthProvider,
  ): HubIdentityPublic | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_identities WHERE user_id = ? AND provider = ?')
      .get(userId, provider);
    return row ? rowToIdentity(row) : null;
  }

  listIdentities(userId: string): HubIdentityPublic[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM hub_identities WHERE user_id = ? ORDER BY linked_at ASC')
      .all(userId);
    return rows.map(rowToIdentity);
  }

  toPublicUser(user: HubUserRecord): HubUserPublic {
    const identities = this.listIdentities(user.userId);
    const legalOk = isCurrentLegalAcceptance(user.termsVersion, user.privacyVersion);
    return {
      userId: user.userId,
      subject: user.username || user.userId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      avatarUrl: user.avatarUrl,
      hasPassword: Boolean(user.passwordHash),
      identities,
      termsVersion: user.termsVersion,
      privacyVersion: user.privacyVersion,
      termsAcceptedAt: user.termsAcceptedAt,
      needsTermsAcceptance: !legalOk,
    };
  }

  getPublicUserById(userId: string): HubUserPublic | null {
    const user = this.findUserById(userId);
    return user ? this.toPublicUser(user) : null;
  }

  allocateUniqueUsername(seed: string): string {
    this.assertOpen();
    const base = sanitizeUsernameSeed(seed);
    if (!this.findUserByUsername(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base.slice(0, 70)}_${i}`;
      if (!this.findUserByUsername(candidate)) return candidate;
    }
    return `${base.slice(0, 60)}_${randomBytes(4).toString('hex')}`;
  }

  createPasswordUser(input: {
    username: string;
    displayName?: string;
    email?: string | null;
    emailVerified?: boolean;
    passwordHash: string;
    termsVersion?: string | null;
    privacyVersion?: string | null;
    now: number;
  }): HubUserRecord {
    this.assertOpen();
    const userId = `hub_${randomBytes(12).toString('hex')}`;
    const trimmedUsername = input.username.trim();
    const normUsername = normalizeUsername(trimmedUsername);
    const rawEmail = input.email ? input.email.trim() : null;
    const normEmail = rawEmail ? normalizeEmail(rawEmail) : null;
    const displayName = input.displayName?.trim() || trimmedUsername;
    const acceptLegal = isCurrentLegalAcceptance(input.termsVersion, input.privacyVersion);

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO hub_users (
             user_id, username, normalized_username, display_name, email, normalized_email,
             email_verified, password_hash, avatar_url, terms_version, privacy_version,
             terms_accepted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          trimmedUsername,
          normUsername,
          displayName,
          rawEmail,
          normEmail,
          input.emailVerified ? 1 : 0,
          input.passwordHash,
          acceptLegal ? CURRENT_TERMS_VERSION : null,
          acceptLegal ? CURRENT_PRIVACY_VERSION : null,
          acceptLegal ? input.now : null,
          input.now,
          input.now,
        );

      if (rawEmail && normEmail) {
        this.db
          .prepare(
            `INSERT INTO hub_identities (
               provider, provider_subject, user_id, username, display_name, email, avatar_url, verified, linked_at
             ) VALUES ('email', ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            normEmail,
            userId,
            trimmedUsername,
            displayName,
            rawEmail,
            input.emailVerified ? 1 : 0,
            input.now,
          );
      }
    });
    return this.findUserById(userId)!;
  }

  createOAuthUser(input: {
    profile: ExternalProfile;
    termsVersion?: string | null;
    privacyVersion?: string | null;
    now: number;
  }): HubUserRecord {
    this.assertOpen();
    const userId = `hub_${randomBytes(12).toString('hex')}`;
    const username = this.allocateUniqueUsername(input.profile.username);
    const normUsername = normalizeUsername(username);
    const rawEmail = input.profile.email ? input.profile.email.trim() : null;
    const normEmail = rawEmail && input.profile.emailVerified ? normalizeEmail(rawEmail) : null;
    const acceptLegal = isCurrentLegalAcceptance(input.termsVersion, input.privacyVersion);

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO hub_users (
             user_id, username, normalized_username, display_name, email, normalized_email,
             email_verified, password_hash, avatar_url, terms_version, privacy_version,
             terms_accepted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          username,
          normUsername,
          input.profile.displayName || username,
          normEmail ? rawEmail : null,
          normEmail,
          normEmail ? 1 : 0,
          input.profile.avatarUrl,
          acceptLegal ? CURRENT_TERMS_VERSION : null,
          acceptLegal ? CURRENT_PRIVACY_VERSION : null,
          acceptLegal ? input.now : null,
          input.now,
          input.now,
        );

      this.db
        .prepare(
          `INSERT INTO hub_identities (
             provider, provider_subject, user_id, username, display_name, email, avatar_url, verified, linked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.profile.provider,
          input.profile.providerSubject,
          userId,
          input.profile.username,
          input.profile.displayName,
          input.profile.email,
          input.profile.avatarUrl,
          input.now,
        );
    });
    return this.findUserById(userId)!;
  }

  refreshExternalIdentity(input: {
    userId: string;
    profile: ExternalProfile;
    termsVersion?: string | null;
    privacyVersion?: string | null;
    now: number;
  }): HubUserRecord {
    this.assertOpen();
    this.db
      .prepare(
        `UPDATE hub_identities
         SET username = ?, display_name = ?, email = ?, avatar_url = ?, verified = 1
         WHERE provider = ? AND provider_subject = ? AND user_id = ?`,
      )
      .run(
        input.profile.username,
        input.profile.displayName,
        input.profile.email,
        input.profile.avatarUrl,
        input.profile.provider,
        input.profile.providerSubject,
        input.userId,
      );

    const user = this.findUserById(input.userId)!;
    const nextAvatar = user.avatarUrl || input.profile.avatarUrl;
    const acceptLegal =
      !isCurrentLegalAcceptance(user.termsVersion, user.privacyVersion) &&
      isCurrentLegalAcceptance(input.termsVersion, input.privacyVersion);
    if (acceptLegal) {
      this.db
        .prepare(
          `UPDATE hub_users
           SET avatar_url = ?, terms_version = ?, privacy_version = ?, terms_accepted_at = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(
          nextAvatar,
          CURRENT_TERMS_VERSION,
          CURRENT_PRIVACY_VERSION,
          input.now,
          input.now,
          input.userId,
        );
    } else if (nextAvatar !== user.avatarUrl) {
      this.db
        .prepare('UPDATE hub_users SET avatar_url = ?, updated_at = ? WHERE user_id = ?')
        .run(nextAvatar, input.now, input.userId);
    }
    return this.findUserById(input.userId)!;
  }

  linkOAuthIdentity(input: {
    userId: string;
    profile: ExternalProfile;
    now: number;
  }): HubUserRecord {
    this.assertOpen();
    const user = this.findUserById(input.userId)!;
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO hub_identities (
             provider, provider_subject, user_id, username, display_name, email, avatar_url, verified, linked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.profile.provider,
          input.profile.providerSubject,
          input.userId,
          input.profile.username,
          input.profile.displayName,
          input.profile.email,
          input.profile.avatarUrl,
          input.now,
        );

      const nextAvatar = user.avatarUrl || input.profile.avatarUrl;
      let nextEmail = user.email;
      let nextNormEmail = user.normalizedEmail;
      let nextEmailVerified = user.emailVerified;
      if (!nextEmail && input.profile.email && input.profile.emailVerified) {
        const collision = this.findUserByEmail(input.profile.email);
        if (!collision) {
          nextEmail = input.profile.email.trim();
          nextNormEmail = normalizeEmail(nextEmail);
          nextEmailVerified = true;
        }
      }
      this.db
        .prepare(
          `UPDATE hub_users
           SET avatar_url = ?, email = ?, normalized_email = ?, email_verified = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(
          nextAvatar,
          nextEmail,
          nextNormEmail,
          nextEmailVerified ? 1 : 0,
          input.now,
          input.userId,
        );
    });
    return this.findUserById(input.userId)!;
  }

  linkEmailPassword(input: {
    userId: string;
    email: string;
    passwordHash: string;
    displayName?: string;
    now: number;
  }): HubUserRecord {
    this.assertOpen();
    const user = this.findUserById(input.userId)!;
    const rawEmail = input.email.trim();
    const normEmail = normalizeEmail(rawEmail);
    const sameVerifiedEmail =
      user.normalizedEmail === normEmail && user.emailVerified;
    const nextDisplayName = input.displayName?.trim() || user.displayName;

    this.tx(() => {
      this.db
        .prepare(
          `UPDATE hub_users
           SET email = ?, normalized_email = ?, email_verified = ?, password_hash = ?, display_name = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(
          rawEmail,
          normEmail,
          sameVerifiedEmail ? 1 : 0,
          input.passwordHash,
          nextDisplayName,
          input.now,
          input.userId,
        );
      this.db
        .prepare("DELETE FROM hub_identities WHERE user_id = ? AND provider = 'email'")
        .run(input.userId);
      this.db
        .prepare(
          `INSERT INTO hub_identities (
             provider, provider_subject, user_id, username, display_name, email, avatar_url, verified, linked_at
           ) VALUES ('email', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          normEmail,
          input.userId,
          user.username,
          nextDisplayName,
          rawEmail,
          sameVerifiedEmail ? 1 : 0,
          input.now,
        );
    });
    return this.findUserById(input.userId)!;
  }

  unlinkIdentity(
    userId: string,
    provider: HubAuthProvider,
    now: number,
  ): HubUserRecord {
    this.assertOpen();
    this.tx(() => {
      if (provider === 'email') {
        const remainingOauth = this.db
          .prepare(
            "SELECT email, verified FROM hub_identities WHERE user_id = ? AND provider != 'email' ORDER BY linked_at ASC",
          )
          .all(userId);
        const fallback = remainingOauth.find(
          r => typeof r.email === 'string' && r.email.length > 0 && Number(r.verified) === 1,
        );
        let fallbackEmail = fallback ? String(fallback.email) : null;
        if (fallbackEmail) {
          const emailOwner = this.findUserByEmail(fallbackEmail);
          if (emailOwner && emailOwner.userId !== userId) {
            fallbackEmail = null;
          }
        }
        this.db
          .prepare("DELETE FROM hub_identities WHERE user_id = ? AND provider = 'email'")
          .run(userId);
        this.db
          .prepare(
            `UPDATE hub_users
             SET password_hash = NULL, email = ?, normalized_email = ?, email_verified = ?, updated_at = ?
             WHERE user_id = ?`,
          )
          .run(
            fallbackEmail,
            fallbackEmail ? normalizeEmail(fallbackEmail) : null,
            fallbackEmail ? 1 : 0,
            now,
            userId,
          );
      } else {
        this.db
          .prepare('DELETE FROM hub_identities WHERE user_id = ? AND provider = ?')
          .run(userId, provider);
        this.db
          .prepare('UPDATE hub_users SET updated_at = ? WHERE user_id = ?')
          .run(now, userId);
      }
    });
    return this.findUserById(userId)!;
  }

  acceptLegalTerms(userId: string, now: number): HubUserRecord {
    this.assertOpen();
    this.db
      .prepare(
        `UPDATE hub_users
         SET terms_version = ?, privacy_version = ?, terms_accepted_at = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, now, now, userId);
    return this.findUserById(userId)!;
  }

  createEmailToken(input: {
    kind: 'verify_email' | 'reset_password';
    userId: string;
    email: string;
    ttlMs: number;
    now: number;
  }): { rawToken: string; expiresAt: number } {
    this.assertOpen();
    const rawToken = randomToken(32);
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = input.now + input.ttlMs;

    this.tx(() => {
      // Invalidate any older unused token of the same kind for this user.
      this.db
        .prepare(
          'UPDATE hub_email_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL',
        )
        .run(input.now, input.userId, input.kind);
      this.db
        .prepare(
          `INSERT INTO hub_email_tokens (
             token_hash, kind, user_id, email, expires_at, used_at, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(tokenHash, input.kind, input.userId, input.email, expiresAt, input.now);
    });
    return { rawToken, expiresAt };
  }

  consumeEmailToken(
    kind: 'verify_email' | 'reset_password',
    rawToken: string,
    now: number,
  ): { userId: string; email: string } | null {
    this.assertOpen();
    const tokenHash = sha256Hex(rawToken);
    const row = this.db
      .prepare('SELECT * FROM hub_email_tokens WHERE token_hash = ? AND kind = ?')
      .get(tokenHash, kind);
    if (!row) return null;
    if (row.used_at !== null && row.used_at !== undefined) return null;
    if (Number(row.expires_at) <= now) return null;

    const updated = this.db
      .prepare(
        'UPDATE hub_email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
      )
      .run(now, tokenHash) as { changes?: number };
    if (typeof updated?.changes === 'number' && updated.changes === 0) {
      return null;
    }
    return {
      userId: String(row.user_id),
      email: String(row.email),
    };
  }

  markEmailVerified(userId: string, now: number): HubUserRecord {
    this.assertOpen();
    this.tx(() => {
      this.db
        .prepare('UPDATE hub_users SET email_verified = 1, updated_at = ? WHERE user_id = ?')
        .run(now, userId);
      this.db
        .prepare("UPDATE hub_identities SET verified = 1 WHERE user_id = ? AND provider = 'email'")
        .run(userId);
    });
    return this.findUserById(userId)!;
  }

  updatePassword(userId: string, passwordHash: string, now: number): HubUserRecord {
    this.assertOpen();
    this.db
      .prepare('UPDATE hub_users SET password_hash = ?, updated_at = ? WHERE user_id = ?')
      .run(passwordHash, now, userId);
    return this.findUserById(userId)!;
  }

  saveOAuthFlow(flow: PendingOAuthFlow) {
    this.assertOpen();
    this.db
      .prepare('DELETE FROM hub_oauth_flows WHERE expires_at <= ?')
      .run(flow.createdAt);
    this.db
      .prepare(
        `INSERT INTO hub_oauth_flows (
           state, provider, mode, link_user_id, client_id, redirect_uri,
           code_challenge, code_challenge_method, provider_verifier,
           terms_version, privacy_version, terms_accepted_at, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flow.state,
        flow.provider,
        flow.mode,
        flow.linkUserId,
        flow.clientId,
        flow.redirectUri,
        flow.codeChallenge,
        flow.codeChallengeMethod,
        flow.providerVerifier,
        flow.termsVersion,
        flow.privacyVersion,
        flow.termsAcceptedAt,
        flow.createdAt,
        flow.expiresAt,
      );
  }

  peekOAuthFlow(state: string, provider: HubOAuthProvider, now: number): PendingOAuthFlow | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_oauth_flows WHERE state = ? AND provider = ?')
      .get(state, provider);
    if (!row) return null;
    if (Number(row.expires_at) <= now) {
      this.db.prepare('DELETE FROM hub_oauth_flows WHERE state = ?').run(state);
      return null;
    }
    return {
      state: String(row.state),
      provider: String(row.provider) as HubOAuthProvider,
      mode: String(row.mode) as 'login' | 'link',
      linkUserId: row.link_user_id ? String(row.link_user_id) : null,
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      codeChallengeMethod: 'S256',
      providerVerifier: String(row.provider_verifier),
      termsVersion: row.terms_version ? String(row.terms_version) : null,
      privacyVersion: row.privacy_version ? String(row.privacy_version) : null,
      termsAcceptedAt:
        typeof row.terms_accepted_at === 'number' ? row.terms_accepted_at : null,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  consumeOAuthFlow(state: string, provider: HubOAuthProvider, now: number): PendingOAuthFlow | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_oauth_flows WHERE state = ? AND provider = ?')
      .get(state, provider);
    if (!row) return null;
    this.db.prepare('DELETE FROM hub_oauth_flows WHERE state = ?').run(state);
    if (Number(row.expires_at) <= now) return null;
    return {
      state: String(row.state),
      provider: String(row.provider) as HubOAuthProvider,
      mode: String(row.mode) as 'login' | 'link',
      linkUserId: row.link_user_id ? String(row.link_user_id) : null,
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      codeChallengeMethod: 'S256',
      providerVerifier: String(row.provider_verifier),
      termsVersion: row.terms_version ? String(row.terms_version) : null,
      privacyVersion: row.privacy_version ? String(row.privacy_version) : null,
      termsAcceptedAt:
        typeof row.terms_accepted_at === 'number' ? row.terms_accepted_at : null,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  saveRefreshToken(record: RefreshTokenRecord, now: number) {
    this.assertOpen();
    this.db.prepare('DELETE FROM hub_refresh_tokens WHERE expires_at <= ?').run(now);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO hub_refresh_tokens (
           token_hash, user_id, family_id, client_id, scope, expires_at, consumed
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.tokenHash,
        record.userId,
        record.familyId,
        record.clientId,
        record.scope,
        record.expiresAt,
        record.consumed ? 1 : 0,
      );
  }

  findRefreshToken(tokenHash: string): RefreshTokenRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_refresh_tokens WHERE token_hash = ?')
      .get(tokenHash);
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash),
      userId: String(row.user_id),
      familyId: String(row.family_id),
      clientId: String(row.client_id),
      scope: String(row.scope),
      expiresAt: Number(row.expires_at),
      consumed: Number(row.consumed) === 1,
    };
  }

  markRefreshTokenConsumed(tokenHash: string) {
    this.assertOpen();
    this.db
      .prepare('UPDATE hub_refresh_tokens SET consumed = 1 WHERE token_hash = ?')
      .run(tokenHash);
  }

  deleteRefreshToken(tokenHash: string) {
    this.assertOpen();
    this.db.prepare('DELETE FROM hub_refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  isFamilyRevoked(familyId: string): boolean {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT family_id FROM hub_revoked_families WHERE family_id = ?')
      .get(familyId);
    return Boolean(row);
  }

  revokeFamily(familyId: string, now: number) {
    this.assertOpen();
    this.tx(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO hub_revoked_families (family_id, revoked_at) VALUES (?, ?)',
        )
        .run(familyId, now);
      this.db
        .prepare('DELETE FROM hub_refresh_tokens WHERE family_id = ?')
        .run(familyId);
    });
  }

  revokeAllUserFamilies(userId: string, now: number) {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT DISTINCT family_id FROM hub_refresh_tokens WHERE user_id = ?')
      .all(userId);
    for (const row of rows) {
      this.revokeFamily(String(row.family_id), now);
    }
  }

  pruneExpiredTokens(now: number) {
    this.assertOpen();
    this.db.prepare('DELETE FROM hub_refresh_tokens WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM hub_oauth_flows WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM hub_email_tokens WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM hub_auth_codes WHERE expires_at <= ?').run(now);
  }
}

export function resolveOAuthProviders(
  env: NodeJS.ProcessEnv,
  discordOverride?: OAuthProviderConfig,
  githubOverride?: OAuthProviderConfig,
): {
  discord: Required<OAuthProviderConfig>;
  github: Required<OAuthProviderConfig>;
} {
  return {
    discord: {
      clientId: discordOverride?.clientId ?? env.DISCORD_CLIENT_ID ?? '',
      clientSecret: discordOverride?.clientSecret ?? env.DISCORD_CLIENT_SECRET ?? '',
      authorizeUrl:
        discordOverride?.authorizeUrl ??
        env.DISCORD_AUTH_URL ??
        'https://discord.com/oauth2/authorize',
      tokenUrl:
        discordOverride?.tokenUrl ??
        env.DISCORD_TOKEN_URL ??
        'https://discord.com/api/oauth2/token',
      userInfoUrl:
        discordOverride?.userInfoUrl ??
        env.DISCORD_USER_URL ??
        'https://discord.com/api/users/@me',
      emailsUrl: '',
    },
    github: {
      clientId: githubOverride?.clientId ?? env.GITHUB_CLIENT_ID ?? '',
      clientSecret: githubOverride?.clientSecret ?? env.GITHUB_CLIENT_SECRET ?? '',
      authorizeUrl:
        githubOverride?.authorizeUrl ??
        env.GITHUB_AUTH_URL ??
        'https://github.com/login/oauth/authorize',
      tokenUrl:
        githubOverride?.tokenUrl ??
        env.GITHUB_TOKEN_URL ??
        'https://github.com/login/oauth/access_token',
      userInfoUrl:
        githubOverride?.userInfoUrl ??
        env.GITHUB_USER_URL ??
        'https://api.github.com/user',
      emailsUrl:
        githubOverride?.emailsUrl ??
        env.GITHUB_EMAILS_URL ??
        'https://api.github.com/user/emails',
    },
  };
}

export function describeProviderAvailability(
  brokerUrl: string,
  providers: ReturnType<typeof resolveOAuthProviders>,
): HubProvidersAvailability {
  return {
    brokerUrl,
    email: {
      enabled: true,
      requiresVerification: true,
    },
    discord: {
      configured: Boolean(providers.discord.clientId && providers.discord.clientSecret),
      label: 'Discord',
      scopes: ['identify', 'email'],
    },
    github: {
      configured: Boolean(providers.github.clientId && providers.github.clientSecret),
      label: 'GitHub',
      scopes: ['read:user', 'user:email'],
    },
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
  };
}

export function buildProviderAuthorizeUrl(input: {
  provider: HubOAuthProvider;
  config: Required<OAuthProviderConfig>;
  callbackUrl: string;
  state: string;
  codeVerifier?: string;
}): string {
  const url = new URL(input.config.authorizeUrl);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', input.state);
  if (input.provider === 'discord') {
    url.searchParams.set('scope', 'identify email');
    if (input.codeVerifier) {
      url.searchParams.set('code_challenge', sha256Base64Url(input.codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
  } else {
    url.searchParams.set('scope', 'read:user user:email');
  }
  return url.toString();
}

export async function exchangeExternalOAuthProfile(input: {
  provider: HubOAuthProvider;
  config: Required<OAuthProviderConfig>;
  code: string;
  callbackUrl: string;
  codeVerifier?: string;
}): Promise<ExternalProfile> {
  const tokenBody = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    redirect_uri: input.callbackUrl,
    grant_type: 'authorization_code',
  });
  if (input.provider === 'discord' && input.codeVerifier) {
    tokenBody.set('code_verifier', input.codeVerifier);
  }

  const tokenRes = await fetch(input.config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LiquidHub-Broker/1.0',
    },
    body: tokenBody.toString(),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
  const accessToken =
    typeof tokenJson.access_token === 'string' ? tokenJson.access_token : '';
  if (!tokenRes.ok || !accessToken) {
    const errCode =
      typeof tokenJson.error === 'string' ? tokenJson.error : 'oauth_token_exchange_failed';
    const desc =
      typeof tokenJson.error_description === 'string'
        ? tokenJson.error_description
        : 'Falha ao trocar o código OAuth no provedor.';
    const error = new Error(desc) as Error & { oauthCode?: string };
    error.oauthCode = errCode;
    throw error;
  }

  if (input.provider === 'discord') {
    const userRes = await fetch(input.config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!userRes.ok) {
      const error = new Error('Não foi possível obter o perfil do Discord.') as Error & {
        oauthCode?: string;
      };
      error.oauthCode = 'provider_profile_failed';
      throw error;
    }
    const raw = (await userRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
      email?: string | null;
      verified?: boolean;
    };
    const id = raw.id ? String(raw.id) : '';
    if (!id) {
      const error = new Error('ID do Discord ausente na resposta.') as Error & {
        oauthCode?: string;
      };
      error.oauthCode = 'provider_profile_invalid';
      throw error;
    }
    const username = raw.username || `discord_${id}`;
    const displayName = raw.global_name || username;
    const avatarUrl = raw.avatar
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(id)}/${encodeURIComponent(raw.avatar)}.${raw.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`
      : null;
    const email =
      typeof raw.email === 'string' && raw.email.includes('@') && raw.verified === true
        ? raw.email.trim().toLowerCase()
        : null;
    return {
      provider: 'discord',
      providerSubject: id,
      username,
      displayName,
      email,
      emailVerified: Boolean(email),
      avatarUrl,
    };
  }

  // GitHub
  const userRes = await fetch(input.config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LiquidHub-Broker/1.0',
    },
  });
  if (!userRes.ok) {
    const error = new Error('Não foi possível obter o perfil do GitHub.') as Error & {
      oauthCode?: string;
    };
    error.oauthCode = 'provider_profile_failed';
    throw error;
  }
  const gh = (await userRes.json()) as {
    id?: number | string;
    login?: string;
    name?: string | null;
    avatar_url?: string | null;
    email?: string | null;
  };
  const id = gh.id !== undefined && gh.id !== null ? String(gh.id) : '';
  if (!id) {
    const error = new Error('ID do GitHub ausente na resposta.') as Error & {
      oauthCode?: string;
    };
    error.oauthCode = 'provider_profile_invalid';
    throw error;
  }
  const username = gh.login || `github_${id}`;
  const displayName = gh.name || username;
  const avatarUrl = typeof gh.avatar_url === 'string' && gh.avatar_url ? gh.avatar_url : null;

  let email: string | null = null;
  let emailVerified = false;
  if (typeof gh.email === 'string' && gh.email.includes('@')) {
    email = gh.email.trim().toLowerCase();
  }
  if (input.config.emailsUrl) {
    try {
      const emailsRes = await fetch(input.config.emailsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
          const primaryVerified = list.find(e => e.primary && e.verified && e.email);
          const anyVerified = list.find(e => e.verified && e.email);
          const chosen = primaryVerified || anyVerified;
          if (chosen?.email) {
            email = chosen.email.trim().toLowerCase();
            emailVerified = true;
          }
        }
      }
    } catch {
      // GitHub private email or blocked emails endpoint is non-fatal
    }
  }

  return {
    provider: 'github',
    providerSubject: id,
    username,
    displayName,
    email,
    emailVerified,
    avatarUrl,
  };
}
