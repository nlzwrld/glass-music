import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../shared/auth.ts';
import {
  AUDIO_ADS_POLICY,
  defaultFreePlusStatus,
  resolvePlusEntitlements,
  type LiquidPlusStatus,
  type PlusPlanId,
  type SubscriptionSource,
  type SubscriptionStatus,
} from '../shared/plus.ts';
import type {
  HubAuthProvider,
  HubIdentityPublic,
  HubOAuthProvider,
  HubProvidersAvailability,
  MySharedPlaylistsResponse,
  PlaylistActivityEntry,
  PlaylistCollaborator,
  PlaylistVisibility,
  ProfileVisibility,
  PublicUserProfile,
  SharedPlaylistDetail,
  SharedPlaylistSummary,
  SocialLinks,
  Track,
  UserSearchItem,
} from '../shared/types.ts';
import { sharedTrackSchema } from '../shared/validation.ts';

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
  publicHandle: string;
  displayName: string;
  email: string | null;
  normalizedEmail: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  avatarUrl: string | null;
  bio: string;
  profileVisibility: ProfileVisibility;
  socialLinks: SocialLinks;
  showPublicTracks: boolean;
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
  publicHandle: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  bio: string;
  profileVisibility: ProfileVisibility;
  socialLinks: SocialLinks;
  showPublicTracks: boolean;
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
      const sanitize = (params: unknown[]) => params.map(p => (p === undefined ? null : p));
      return {
        run(...params: unknown[]) {
          sql.exec(query, ...sanitize(params));
          return {};
        },
        get(...params: unknown[]) {
          const rows = sql.exec(query, ...sanitize(params)).toArray();
          return rows[0];
        },
        all(...params: unknown[]) {
          return sql.exec(query, ...sanitize(params)).toArray();
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

function sanitizeHandleSeed(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 28)
    .replace(/[._-]+$/g, '');
  if (/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(cleaned)) {
    return cleaned;
  }
  return `lh-${randomBytes(3).toString('hex')}`;
}

const SOCIAL_KEYS: Array<keyof SocialLinks> = [
  'website',
  'instagram',
  'twitter',
  'youtube',
  'spotify',
  'github',
];

function sanitizeSocialLinks(raw: unknown): SocialLinks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: SocialLinks = {};
  for (const key of SOCIAL_KEYS) {
    const val = typeof obj[key] === 'string' ? obj[key]!.trim() : '';
    if (val) out[key] = val;
  }
  return out;
}

function parseSocialLinks(jsonStr: unknown): SocialLinks {
  if (typeof jsonStr !== 'string' || !jsonStr) return {};
  try {
    return sanitizeSocialLinks(JSON.parse(jsonStr));
  } catch {
    return {};
  }
}

function normalizeVisibility<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const val = String(raw || '').trim() as T;
  return allowed.includes(val) ? val : fallback;
}

function sanitizeTrackList(rawTracks: unknown[], now: number): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const cand of rawTracks) {
    if (!cand || typeof cand !== 'object' || Array.isArray(cand)) continue;
    if ((cand as Record<string, unknown>).source === 'local') continue;
    const parsed = sharedTrackSchema.safeParse(cand);
    if (!parsed.success) continue;
    const clean: Track = {
      ...parsed.data,
      addedAt: typeof parsed.data.addedAt === 'number' ? parsed.data.addedAt : now,
    };
    if (seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.push(clean);
    if (out.length >= 1000) break;
  }
  return out;
}

function parseTracksJson(raw: unknown): Track[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeTrackList(parsed, 0);
  } catch {
    return [];
  }
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
    provider TEXT NOT NULL CHECK (provider IN ('email', 'discord', 'github', 'google')),
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
    provider TEXT NOT NULL CHECK (provider IN ('discord', 'github', 'google')),
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
  `CREATE TABLE IF NOT EXISTS hub_user_library (
    user_id TEXT PRIMARY KEY REFERENCES hub_users(user_id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hub_shared_playlists (
    playlist_id TEXT PRIMARY KEY,
    local_playlist_id TEXT,
    owner_user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    artwork TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'unlisted', 'private')),
    collaborative INTEGER NOT NULL DEFAULT 0,
    tracks_json TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hub_shared_playlists_owner ON hub_shared_playlists(owner_user_id)',
  `CREATE TABLE IF NOT EXISTS hub_playlist_collaborators (
    playlist_id TEXT NOT NULL REFERENCES hub_shared_playlists(playlist_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    invited_by TEXT NOT NULL,
    invited_at INTEGER NOT NULL,
    accepted_at INTEGER,
    PRIMARY KEY (playlist_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hub_playlist_collab_user ON hub_playlist_collaborators(user_id)',
  `CREATE TABLE IF NOT EXISTS hub_playlist_activity (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL REFERENCES hub_shared_playlists(playlist_id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL,
    actor_handle TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hub_playlist_activity_pl ON hub_playlist_activity(playlist_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS hub_subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES hub_users(user_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'none',
    source TEXT NOT NULL DEFAULT 'system',
    current_period_end INTEGER,
    updated_at INTEGER NOT NULL
  )`,
];

export function initAuthSchema(db: SqliteDatabaseLike) {
  for (const stmt of AUTH_SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
  const profileMigrations = [
    'ALTER TABLE hub_users ADD COLUMN public_handle TEXT',
    "ALTER TABLE hub_users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE hub_users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'public'",
    'ALTER TABLE hub_users ADD COLUMN social_links_json TEXT',
    'ALTER TABLE hub_users ADD COLUMN show_public_tracks INTEGER NOT NULL DEFAULT 0',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_users_public_handle ON hub_users(public_handle)',
  ];
  for (const ddl of profileMigrations) {
    try {
      db.exec(ddl);
    } catch {
      // Column or index already exists on migrated databases
    }
  }
  try {
    const flowsTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hub_oauth_flows'")
      .get();
    if (
      flowsTable &&
      typeof flowsTable.sql === 'string' &&
      !flowsTable.sql.includes("'google'")
    ) {
      db.exec(`
        ALTER TABLE hub_oauth_flows RENAME TO hub_oauth_flows_legacy;
        CREATE TABLE hub_oauth_flows (
          state TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('discord', 'github', 'google')),
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
        );
        INSERT INTO hub_oauth_flows SELECT * FROM hub_oauth_flows_legacy;
        DROP TABLE hub_oauth_flows_legacy;
      `);
    }
    const identitiesTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hub_identities'")
      .get();
    if (
      identitiesTable &&
      typeof identitiesTable.sql === 'string' &&
      !identitiesTable.sql.includes("'google'")
    ) {
      db.exec(`
        ALTER TABLE hub_identities RENAME TO hub_identities_legacy;
        CREATE TABLE hub_identities (
          provider TEXT NOT NULL CHECK (provider IN ('email', 'discord', 'github', 'google')),
          provider_subject TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES hub_users(user_id) ON DELETE CASCADE,
          username TEXT,
          display_name TEXT,
          email TEXT,
          avatar_url TEXT,
          verified INTEGER NOT NULL DEFAULT 0,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (provider, provider_subject)
        );
        INSERT INTO hub_identities SELECT * FROM hub_identities_legacy;
        DROP TABLE hub_identities_legacy;
        CREATE INDEX IF NOT EXISTS idx_hub_identities_user ON hub_identities(user_id);
      `);
    }
  } catch {
    // Ignore if sqlite_master introspection is unavailable
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
  const vis = normalizeVisibility(
    row.profile_visibility,
    ['public', 'restricted', 'private'] as const,
    'public',
  );
  return {
    userId: String(row.user_id),
    username: String(row.username),
    normalizedUsername: String(row.normalized_username),
    publicHandle: row.public_handle ? String(row.public_handle).trim().toLowerCase() : '',
    displayName: String(row.display_name),
    email: row.email ? String(row.email) : null,
    normalizedEmail: row.normalized_email ? String(row.normalized_email) : null,
    emailVerified: Number(row.email_verified) === 1,
    passwordHash: row.password_hash ? String(row.password_hash) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    bio: row.bio ? String(row.bio) : '',
    profileVisibility: vis,
    socialLinks: parseSocialLinks(row.social_links_json),
    showPublicTracks: Number(row.show_public_tracks) === 1,
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

  findUserByPublicHandle(handle: string): HubUserRecord | null {
    this.assertOpen();
    const norm = handle.trim().toLowerCase();
    if (!norm) return null;
    return rowToUser(
      this.db.prepare('SELECT * FROM hub_users WHERE LOWER(public_handle) = ?').get(norm),
    );
  }

  allocateUniqueHandle(seed: string): string {
    this.assertOpen();
    const base = sanitizeHandleSeed(seed);
    if (!this.findUserByPublicHandle(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base.slice(0, 24)}-${i}`;
      if (!this.findUserByPublicHandle(candidate)) return candidate;
    }
    return `lh-${randomBytes(5).toString('hex')}`;
  }

  private ensurePublicHandle(user: HubUserRecord): HubUserRecord {
    if (user.publicHandle) return user;
    const allocated = this.allocateUniqueHandle(user.username || 'user');
    this.db
      .prepare('UPDATE hub_users SET public_handle = ? WHERE user_id = ?')
      .run(allocated, user.userId);
    return { ...user, publicHandle: allocated };
  }

  toPublicUser(user: HubUserRecord): HubUserPublic {
    const withHandle = this.ensurePublicHandle(user);
    const identities = this.listIdentities(withHandle.userId);
    const legalOk = isCurrentLegalAcceptance(withHandle.termsVersion, withHandle.privacyVersion);
    return {
      userId: withHandle.userId,
      subject: withHandle.username || withHandle.userId,
      username: withHandle.username,
      publicHandle: withHandle.publicHandle,
      displayName: withHandle.displayName,
      email: withHandle.email,
      emailVerified: withHandle.emailVerified,
      avatarUrl: withHandle.avatarUrl,
      bio: withHandle.bio,
      profileVisibility: withHandle.profileVisibility,
      socialLinks: withHandle.socialLinks,
      showPublicTracks: withHandle.showPublicTracks,
      hasPassword: Boolean(withHandle.passwordHash),
      identities,
      termsVersion: withHandle.termsVersion,
      privacyVersion: withHandle.privacyVersion,
      termsAcceptedAt: withHandle.termsAcceptedAt,
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
    const publicHandle = this.allocateUniqueHandle(trimmedUsername);
    const rawEmail = input.email ? input.email.trim() : null;
    const normEmail = rawEmail ? normalizeEmail(rawEmail) : null;
    const displayName = input.displayName?.trim() || trimmedUsername;
    const acceptLegal = isCurrentLegalAcceptance(input.termsVersion, input.privacyVersion);

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO hub_users (
             user_id, username, normalized_username, public_handle, display_name, email, normalized_email,
             email_verified, password_hash, avatar_url, bio, profile_visibility, social_links_json,
             show_public_tracks, terms_version, privacy_version, terms_accepted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'public', '{}', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          trimmedUsername,
          normUsername,
          publicHandle,
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
    const publicHandle = this.allocateUniqueHandle(username);
    const rawEmail = input.profile.email ? input.profile.email.trim() : null;
    const normEmail = rawEmail && input.profile.emailVerified ? normalizeEmail(rawEmail) : null;
    const acceptLegal = isCurrentLegalAcceptance(input.termsVersion, input.privacyVersion);

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO hub_users (
             user_id, username, normalized_username, public_handle, display_name, email, normalized_email,
             email_verified, password_hash, avatar_url, bio, profile_visibility, social_links_json,
             show_public_tracks, terms_version, privacy_version, terms_accepted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '', 'public', '{}', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          username,
          normUsername,
          publicHandle,
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.profile.provider,
          input.profile.providerSubject,
          userId,
          input.profile.username,
          input.profile.displayName,
          input.profile.email,
          input.profile.avatarUrl,
          input.profile.email && !input.profile.emailVerified ? 0 : 1,
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
         SET username = ?, display_name = ?, email = ?, avatar_url = ?, verified = ?
         WHERE provider = ? AND provider_subject = ? AND user_id = ?`,
      )
      .run(
        input.profile.username,
        input.profile.displayName,
        input.profile.email,
        input.profile.avatarUrl,
        input.profile.email && !input.profile.emailVerified ? 0 : 1,
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.profile.provider,
          input.profile.providerSubject,
          input.userId,
          input.profile.username,
          input.profile.displayName,
          input.profile.email,
          input.profile.avatarUrl,
          input.profile.email && !input.profile.emailVerified ? 0 : 1,
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

  updateDisplayName(userId: string, displayName: string, now: number): HubUserRecord {
    this.assertOpen();
    const cleaned = displayName.trim().slice(0, 80);
    this.db
      .prepare('UPDATE hub_users SET display_name = ?, updated_at = ? WHERE user_id = ?')
      .run(cleaned, now, userId);
    return this.findUserById(userId)!;
  }

  updateUserProfile(
    userId: string,
    patch: {
      displayName?: string;
      publicHandle?: string;
      bio?: string;
      profileVisibility?: ProfileVisibility;
      socialLinks?: SocialLinks;
      showPublicTracks?: boolean;
    },
    now: number,
  ): { status: 'ok'; user: HubUserRecord } | { status: 'not_found' } | { status: 'handle_taken' } {
    this.assertOpen();
    const existingRaw = this.findUserById(userId);
    if (!existingRaw) return { status: 'not_found' };
    const existing = this.ensurePublicHandle(existingRaw);

    let nextHandle = existing.publicHandle;
    if (patch.publicHandle !== undefined) {
      const candidate = patch.publicHandle.trim().toLowerCase();
      const collision = this.findUserByPublicHandle(candidate);
      if (collision && collision.userId !== userId) {
        return { status: 'handle_taken' };
      }
      nextHandle = candidate;
    }

    const nextDisplayName =
      patch.displayName !== undefined ? patch.displayName.trim().slice(0, 80) : existing.displayName;
    const nextBio = patch.bio !== undefined ? patch.bio.trim().slice(0, 240) : existing.bio;
    const nextVisibility =
      patch.profileVisibility !== undefined ? patch.profileVisibility : existing.profileVisibility;
    const nextSocial =
      patch.socialLinks !== undefined
        ? sanitizeSocialLinks(patch.socialLinks)
        : existing.socialLinks;
    const nextShowTracks =
      patch.showPublicTracks !== undefined ? patch.showPublicTracks : existing.showPublicTracks;

    this.db
      .prepare(
        `UPDATE hub_users
         SET display_name = ?, public_handle = ?, bio = ?, profile_visibility = ?,
             social_links_json = ?, show_public_tracks = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        nextDisplayName,
        nextHandle,
        nextBio,
        nextVisibility,
        JSON.stringify(nextSocial),
        nextShowTracks ? 1 : 0,
        now,
        userId,
      );
    return { status: 'ok', user: this.findUserById(userId)! };
  }

  searchDiscoverableUsers(
    query: string,
    includeRestricted: boolean,
    limit = 20,
  ): UserSearchItem[] {
    this.assertOpen();
    const trimmed = query.trim().toLowerCase();
    const maxRows = Math.max(1, Math.min(25, Math.floor(limit) || 20));
    if (!trimmed) return [];
    const like = `%${trimmed}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM hub_users
         WHERE profile_visibility IN ('public'${includeRestricted ? ", 'restricted'" : ''})
           AND (LOWER(display_name) LIKE ? OR LOWER(COALESCE(public_handle, '')) LIKE ? OR normalized_username LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(like, like, like, maxRows);

    const out: UserSearchItem[] = [];
    for (const row of rows) {
      const parsed = rowToUser(row);
      if (!parsed) continue;
      const user = this.ensurePublicHandle(parsed);
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM hub_shared_playlists WHERE owner_user_id = ? AND visibility = 'public'",
        )
        .get(user.userId);
      out.push({
        handle: user.publicHandle,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        visibility: user.profileVisibility,
        publicPlaylistCount: Number(countRow?.cnt) || 0,
        accountType: 'user',
      });
    }
    return out;
  }

  getPublicProfile(
    handle: string,
    viewerUserId: string | null,
  ):
    | { status: 'ok'; profile: PublicUserProfile }
    | { status: 'not_found' }
    | { status: 'auth_required' }
    | { status: 'private' } {
    this.assertOpen();
    const userRaw = this.findUserByPublicHandle(handle);
    if (!userRaw) return { status: 'not_found' };
    const user = this.ensurePublicHandle(userRaw);
    const isOwner = Boolean(viewerUserId && viewerUserId === user.userId);
    if (user.profileVisibility === 'private' && !isOwner) {
      return { status: 'private' };
    }
    if (user.profileVisibility === 'restricted' && !viewerUserId) {
      return { status: 'auth_required' };
    }

    const playlistRows = this.db
      .prepare(
        `SELECT * FROM hub_shared_playlists
         WHERE owner_user_id = ? AND visibility = 'public'
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all(user.userId);

    const publicPlaylists: SharedPlaylistSummary[] = [];
    const trackMap = new Map<string, Track>();
    for (const row of playlistRows) {
      const tracks = parseTracksJson(row.tracks_json);
      publicPlaylists.push({
        id: String(row.playlist_id),
        name: String(row.name),
        description: String(row.description || ''),
        ...(row.artwork ? { artwork: String(row.artwork) } : {}),
        visibility: 'public',
        collaborative: Number(row.collaborative) === 1,
        trackCount: tracks.length,
        ownerHandle: user.publicHandle,
        ownerDisplayName: user.displayName,
        ownerAvatarUrl: user.avatarUrl,
        version: Number(row.version) || 1,
        updatedAt: Number(row.updated_at) || 0,
      });
      if (user.showPublicTracks && trackMap.size < 25) {
        for (const t of tracks) {
          if (t.source !== 'local' && !trackMap.has(t.id)) {
            trackMap.set(t.id, t);
            if (trackMap.size >= 25) break;
          }
        }
      }
    }

    return {
      status: 'ok',
      profile: {
        handle: user.publicHandle,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        visibility: user.profileVisibility,
        socialLinks: user.socialLinks,
        showPublicTracks: user.showPublicTracks,
        publicPlaylists,
        publicTracks: user.showPublicTracks ? [...trackMap.values()] : [],
        createdAt: user.createdAt,
        accountType: 'user',
      },
    };
  }

  private buildSharedPlaylistDetail(
    row: Record<string, unknown>,
    viewerUserId: string | null,
  ): SharedPlaylistDetail {
    const playlistId = String(row.playlist_id);
    const ownerId = String(row.owner_user_id);
    const ownerRaw = this.findUserById(ownerId);
    const owner = ownerRaw ? this.ensurePublicHandle(ownerRaw) : null;
    const ownerHandle = owner?.publicHandle || 'owner';
    const ownerDisplayName = owner?.displayName || 'Ouvinte';
    const ownerAvatarUrl = owner?.avatarUrl || null;
    const tracks = parseTracksJson(row.tracks_json);

    let role: 'owner' | 'editor' | 'viewer' = 'viewer';
    if (viewerUserId && viewerUserId === ownerId) {
      role = 'owner';
    } else if (viewerUserId) {
      const collabRow = this.db
        .prepare(
          'SELECT role, status FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?',
        )
        .get(playlistId, viewerUserId);
      if (collabRow && collabRow.status === 'accepted' && collabRow.role === 'editor') {
        role = 'editor';
      }
    }

    const canSeePrivateMeta = role === 'owner' || role === 'editor';
    const collabRows = this.db
      .prepare(
        `SELECT c.role, c.status, c.invited_at, c.accepted_at, u.*
         FROM hub_playlist_collaborators c
         JOIN hub_users u ON u.user_id = c.user_id
         WHERE c.playlist_id = ?
         ${canSeePrivateMeta ? '' : "AND c.status = 'accepted'"}
         ORDER BY CASE WHEN c.role = 'owner' THEN 0 ELSE 1 END, c.invited_at ASC`,
      )
      .all(playlistId);

    const collaborators: PlaylistCollaborator[] = [];
    for (const cr of collabRows) {
      const cuRaw = rowToUser(cr);
      if (!cuRaw) continue;
      const cu = this.ensurePublicHandle(cuRaw);
      collaborators.push({
        handle: cu.publicHandle,
        displayName: cu.displayName,
        avatarUrl: cu.avatarUrl,
        role: cr.role === 'owner' ? 'owner' : 'editor',
        status: cr.status === 'accepted' ? 'accepted' : 'pending',
        invitedAt: Number(cr.invited_at) || 0,
        acceptedAt: typeof cr.accepted_at === 'number' ? cr.accepted_at : null,
      });
    }

    const activity: PlaylistActivityEntry[] = canSeePrivateMeta
      ? this.db
          .prepare(
            `SELECT * FROM hub_playlist_activity
             WHERE playlist_id = ?
             ORDER BY created_at DESC
             LIMIT 30`,
          )
          .all(playlistId)
          .map(ar => ({
            id: String(ar.id),
            actorHandle: String(ar.actor_handle),
            actorName: String(ar.actor_name),
            action: String(ar.action),
            summary: String(ar.summary),
            version: Number(ar.version) || 1,
            createdAt: Number(ar.created_at) || 0,
          }))
      : [];

    const visibility = normalizeVisibility(
      row.visibility,
      ['public', 'unlisted', 'private'] as const,
      'private',
    );
    return {
      id: playlistId,
      localPlaylistId: row.local_playlist_id ? String(row.local_playlist_id) : null,
      name: String(row.name),
      description: String(row.description || ''),
      ...(row.artwork ? { artwork: String(row.artwork) } : {}),
      visibility,
      collaborative: Number(row.collaborative) === 1,
      trackCount: tracks.length,
      ownerHandle,
      ownerDisplayName,
      ownerAvatarUrl,
      version: Number(row.version) || 1,
      updatedAt: Number(row.updated_at) || 0,
      tracks,
      role,
      collaborators,
      activity,
    };
  }

  private recordPlaylistActivity(
    playlistId: string,
    actor: HubUserRecord,
    action: string,
    summary: string,
    version: number,
    now: number,
  ) {
    const actorWithHandle = this.ensurePublicHandle(actor);
    const id = `pa_${randomBytes(6).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO hub_playlist_activity (
           id, playlist_id, actor_user_id, actor_handle, actor_name, action, summary, version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        playlistId,
        actorWithHandle.userId,
        actorWithHandle.publicHandle,
        actorWithHandle.displayName,
        action,
        summary.slice(0, 200),
        version,
        now,
      );
    this.db
      .prepare(
        `DELETE FROM hub_playlist_activity
         WHERE playlist_id = ?
           AND id NOT IN (
             SELECT id FROM hub_playlist_activity WHERE playlist_id = ? ORDER BY created_at DESC LIMIT 50
           )`,
      )
      .run(playlistId, playlistId);
  }

  upsertSharedPlaylist(
    ownerUserId: string,
    input: {
      shareId?: string;
      localPlaylistId?: string;
      name: string;
      description?: string;
      artwork?: string;
      visibility: PlaylistVisibility;
      collaborative: boolean;
      tracks: unknown[];
    },
    now: number,
  ): { status: 'ok'; detail: SharedPlaylistDetail } | { status: 'forbidden' } {
    this.assertOpen();
    const owner = this.findUserById(ownerUserId);
    if (!owner) return { status: 'forbidden' };
    const cleanTracks = sanitizeTrackList(input.tracks, now);
    const desc = (input.description || '').trim().slice(0, 300);
    const art = input.artwork ? input.artwork.trim() : null;

    return this.tx(() => {
      let existing: Record<string, unknown> | undefined;
      if (input.shareId) {
        existing = this.db
          .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
          .get(input.shareId);
        if (existing && String(existing.owner_user_id) !== ownerUserId) {
          return { status: 'forbidden' as const };
        }
      } else if (input.localPlaylistId) {
        existing = this.db
          .prepare(
            'SELECT * FROM hub_shared_playlists WHERE owner_user_id = ? AND local_playlist_id = ?',
          )
          .get(ownerUserId, input.localPlaylistId);
      }

      if (existing) {
        const playlistId = String(existing.playlist_id);
        const nextVersion = (Number(existing.version) || 1) + 1;
        this.db
          .prepare(
            `UPDATE hub_shared_playlists
             SET name = ?, description = ?, artwork = ?, visibility = ?, collaborative = ?,
                 tracks_json = ?, version = ?, updated_at = ?
             WHERE playlist_id = ?`,
          )
          .run(
            input.name.trim().slice(0, 100),
            desc,
            art || (existing.artwork ? String(existing.artwork) : null),
            input.visibility,
            input.collaborative ? 1 : 0,
            JSON.stringify(cleanTracks),
            nextVersion,
            now,
            playlistId,
          );
        this.db
          .prepare(
            `INSERT OR IGNORE INTO hub_playlist_collaborators (
               playlist_id, user_id, role, status, invited_by, invited_at, accepted_at
             ) VALUES (?, ?, 'owner', 'accepted', ?, ?, ?)`,
          )
          .run(playlistId, ownerUserId, ownerUserId, now, now);
        this.recordPlaylistActivity(
          playlistId,
          owner,
          'publish',
          `Sincronizou "${input.name.trim()}" (${input.visibility})`,
          nextVersion,
          now,
        );
        const updatedRow = this.db
          .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
          .get(playlistId)!;
        return {
          status: 'ok' as const,
          detail: this.buildSharedPlaylistDetail(updatedRow, ownerUserId),
        };
      }

      const playlistId = `pl_${randomBytes(6).toString('hex')}`;
      this.db
        .prepare(
          `INSERT INTO hub_shared_playlists (
             playlist_id, local_playlist_id, owner_user_id, name, description, artwork,
             visibility, collaborative, tracks_json, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          playlistId,
          input.localPlaylistId || null,
          ownerUserId,
          input.name.trim().slice(0, 100),
          desc,
          art,
          input.visibility,
          input.collaborative ? 1 : 0,
          JSON.stringify(cleanTracks),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO hub_playlist_collaborators (
             playlist_id, user_id, role, status, invited_by, invited_at, accepted_at
           ) VALUES (?, ?, 'owner', 'accepted', ?, ?, ?)`,
        )
        .run(playlistId, ownerUserId, ownerUserId, now, now);
      this.recordPlaylistActivity(
        playlistId,
        owner,
        'create',
        `Publicou "${input.name.trim()}" (${input.visibility})`,
        1,
        now,
      );
      const inserted = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(playlistId)!;
      return {
        status: 'ok' as const,
        detail: this.buildSharedPlaylistDetail(inserted, ownerUserId),
      };
    });
  }

  getSharedPlaylist(
    shareId: string,
    viewerUserId: string | null,
    sinceVersion?: number,
  ):
    | { status: 'ok'; detail: SharedPlaylistDetail }
    | { status: 'not_found' }
    | { status: 'auth_required' }
    | { status: 'forbidden' } {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
      .get(shareId);
    if (!row) return { status: 'not_found' };

    const ownerId = String(row.owner_user_id);
    const isOwner = Boolean(viewerUserId && viewerUserId === ownerId);
    let hasCollabAccess = false;
    let role: 'owner' | 'editor' | 'viewer' = isOwner ? 'owner' : 'viewer';
    if (viewerUserId && !isOwner) {
      const collab = this.db
        .prepare(
          'SELECT role, status FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?',
        )
        .get(shareId, viewerUserId);
      if (collab && (collab.status === 'accepted' || collab.status === 'pending')) {
        hasCollabAccess = true;
        if (collab.status === 'accepted' && collab.role === 'editor') role = 'editor';
      }
    }

    const vis = normalizeVisibility(
      row.visibility,
      ['public', 'unlisted', 'private'] as const,
      'private',
    );
    if (vis === 'private' && !isOwner && !hasCollabAccess) {
      return { status: viewerUserId ? 'forbidden' : 'auth_required' };
    }

    const currentVersion = Number(row.version) || 1;
    if (typeof sinceVersion === 'number' && sinceVersion === currentVersion) {
      const ownerRaw = this.findUserById(ownerId);
      const owner = ownerRaw ? this.ensurePublicHandle(ownerRaw) : null;
      return {
        status: 'ok',
        detail: {
          id: String(row.playlist_id),
          name: String(row.name),
          description: String(row.description || ''),
          ...(row.artwork ? { artwork: String(row.artwork) } : {}),
          visibility: vis,
          collaborative: Number(row.collaborative) === 1,
          trackCount: parseTracksJson(row.tracks_json).length,
          ownerHandle: owner?.publicHandle || 'owner',
          ownerDisplayName: owner?.displayName || 'Ouvinte',
          ownerAvatarUrl: owner?.avatarUrl || null,
          version: currentVersion,
          updatedAt: Number(row.updated_at) || 0,
          tracks: [],
          role,
          collaborators: [],
          activity: [],
          unchanged: true,
        },
      };
    }

    return { status: 'ok', detail: this.buildSharedPlaylistDetail(row, viewerUserId) };
  }

  listMySharedPlaylists(userId: string): MySharedPlaylistsResponse {
    this.assertOpen();
    const toSummary = (row: Record<string, unknown>): SharedPlaylistSummary => {
      const ownerRaw = this.findUserById(String(row.owner_user_id));
      const owner = ownerRaw ? this.ensurePublicHandle(ownerRaw) : null;
      return {
        id: String(row.playlist_id),
        name: String(row.name),
        description: String(row.description || ''),
        ...(row.artwork ? { artwork: String(row.artwork) } : {}),
        visibility: normalizeVisibility(
          row.visibility,
          ['public', 'unlisted', 'private'] as const,
          'private',
        ),
        collaborative: Number(row.collaborative) === 1,
        trackCount: parseTracksJson(row.tracks_json).length,
        ownerHandle: owner?.publicHandle || 'owner',
        ownerDisplayName: owner?.displayName || 'Ouvinte',
        ownerAvatarUrl: owner?.avatarUrl || null,
        version: Number(row.version) || 1,
        updatedAt: Number(row.updated_at) || 0,
      };
    };

    const ownedRows = this.db
      .prepare('SELECT * FROM hub_shared_playlists WHERE owner_user_id = ? ORDER BY updated_at DESC')
      .all(userId);
    const acceptedRows = this.db
      .prepare(
        `SELECT p.* FROM hub_shared_playlists p
         JOIN hub_playlist_collaborators c ON c.playlist_id = p.playlist_id
         WHERE c.user_id = ? AND c.role = 'editor' AND c.status = 'accepted'
         ORDER BY p.updated_at DESC`,
      )
      .all(userId);
    const pendingRows = this.db
      .prepare(
        `SELECT p.*, c.invited_at AS invite_time FROM hub_shared_playlists p
         JOIN hub_playlist_collaborators c ON c.playlist_id = p.playlist_id
         WHERE c.user_id = ? AND c.status = 'pending'
         ORDER BY c.invited_at DESC`,
      )
      .all(userId);

    return {
      owned: ownedRows.map(toSummary),
      collaborating: acceptedRows.map(toSummary),
      pendingInvites: pendingRows.map(r => ({
        ...toSummary(r),
        invitedAt: Number(r.invite_time) || 0,
      })),
    };
  }

  mutateSharedPlaylist(
    shareId: string,
    actorUserId: string,
    mutation: {
      op: 'meta' | 'addTracks' | 'removeTrack' | 'reorder';
      expectedVersion: number;
      name?: string;
      description?: string;
      artwork?: string;
      visibility?: PlaylistVisibility;
      collaborative?: boolean;
      tracks?: unknown[];
      trackId?: string;
      trackIds?: string[];
    },
    now: number,
  ):
    | { status: 'ok'; detail: SharedPlaylistDetail }
    | { status: 'not_found' }
    | { status: 'forbidden' }
    | { status: 'invalid_order' }
    | { status: 'conflict'; latest: SharedPlaylistDetail } {
    this.assertOpen();
    const actor = this.findUserById(actorUserId);
    if (!actor) return { status: 'forbidden' };

    return this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(shareId);
      if (!row) return { status: 'not_found' as const };

      const ownerId = String(row.owner_user_id);
      const isOwner = actorUserId === ownerId;
      let isAcceptedEditor = false;
      if (!isOwner) {
        const collab = this.db
          .prepare(
            "SELECT role, status FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ? AND status = 'accepted'",
          )
          .get(shareId, actorUserId);
        isAcceptedEditor = collab?.role === 'editor' && Number(row.collaborative) === 1;
      }

      if (mutation.op === 'meta' && !isOwner) {
        return { status: 'forbidden' as const };
      }
      if (!isOwner && !isAcceptedEditor) {
        return { status: 'forbidden' as const };
      }

      const currentVersion = Number(row.version) || 1;
      if (mutation.expectedVersion !== currentVersion) {
        return {
          status: 'conflict' as const,
          latest: this.buildSharedPlaylistDetail(row, actorUserId),
        };
      }

      let nextName = String(row.name);
      let nextDesc = String(row.description || '');
      let nextArt = row.artwork ? String(row.artwork) : null;
      let nextVis = normalizeVisibility(
        row.visibility,
        ['public', 'unlisted', 'private'] as const,
        'private',
      );
      let nextCollab = Number(row.collaborative) === 1;
      let tracks = parseTracksJson(row.tracks_json);
      let summary = '';

      if (mutation.op === 'meta') {
        if (mutation.name !== undefined) nextName = mutation.name.trim().slice(0, 100);
        if (mutation.description !== undefined) nextDesc = mutation.description.trim().slice(0, 300);
        if (mutation.artwork !== undefined) nextArt = mutation.artwork.trim() || null;
        if (mutation.visibility !== undefined) nextVis = mutation.visibility;
        if (mutation.collaborative !== undefined) nextCollab = mutation.collaborative;
        summary = `Atualizou configurações (${nextVis}${nextCollab ? ', colaborativa' : ''})`;
      } else if (mutation.op === 'addTracks') {
        const incoming = sanitizeTrackList(mutation.tracks || [], now);
        const existingIds = new Set(tracks.map(t => t.id));
        const added: Track[] = [];
        for (const t of incoming) {
          if (!existingIds.has(t.id) && tracks.length + added.length < 1000) {
            existingIds.add(t.id);
            added.push(t);
          }
        }
        tracks = [...tracks, ...added];
        summary = added.length
          ? `Adicionou ${added.length} música(s)`
          : 'Músicas já presentes na playlist';
      } else if (mutation.op === 'removeTrack') {
        const targetId = String(mutation.trackId || '');
        const before = tracks.length;
        const removed = tracks.find(t => t.id === targetId);
        tracks = tracks.filter(t => t.id !== targetId);
        summary =
          tracks.length < before && removed
            ? `Removeu "${removed.title}"`
            : 'Removeu uma faixa da playlist';
      } else if (mutation.op === 'reorder') {
        const ids = mutation.trackIds || [];
        const unique = new Set(ids);
        const byId = new Map(tracks.map(t => [t.id, t]));
        if (
          ids.length !== tracks.length ||
          unique.size !== tracks.length ||
          ids.some(id => !byId.has(id))
        ) {
          return { status: 'invalid_order' as const };
        }
        tracks = ids.map(id => byId.get(id)!);
        summary = 'Reordenou a playlist';
      }

      const nextVersion = currentVersion + 1;
      this.db
        .prepare(
          `UPDATE hub_shared_playlists
           SET name = ?, description = ?, artwork = ?, visibility = ?, collaborative = ?,
               tracks_json = ?, version = ?, updated_at = ?
           WHERE playlist_id = ?`,
        )
        .run(
          nextName,
          nextDesc,
          nextArt,
          nextVis,
          nextCollab ? 1 : 0,
          JSON.stringify(tracks),
          nextVersion,
          now,
          shareId,
        );
      this.recordPlaylistActivity(shareId, actor, mutation.op, summary, nextVersion, now);
      const updated = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(shareId)!;
      return {
        status: 'ok' as const,
        detail: this.buildSharedPlaylistDetail(updated, actorUserId),
      };
    });
  }

  inviteCollaborator(
    shareId: string,
    ownerUserId: string,
    targetHandle: string,
    now: number,
  ):
    | { status: 'ok'; detail: SharedPlaylistDetail }
    | { status: 'not_found' }
    | { status: 'forbidden' }
    | { status: 'user_not_found' }
    | { status: 'invalid_target' }
    | { status: 'target_private' } {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
      .get(shareId);
    if (!row) return { status: 'not_found' };
    if (String(row.owner_user_id) !== ownerUserId) return { status: 'forbidden' };
    const owner = this.findUserById(ownerUserId);
    if (!owner) return { status: 'forbidden' };

    const targetRaw = this.findUserByPublicHandle(targetHandle);
    if (!targetRaw) return { status: 'user_not_found' };
    const target = this.ensurePublicHandle(targetRaw);
    if (target.userId === ownerUserId) return { status: 'invalid_target' };
    if (target.profileVisibility === 'private') return { status: 'target_private' };

    return this.tx(() => {
      const existing = this.db
        .prepare(
          'SELECT status FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?',
        )
        .get(shareId, target.userId);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO hub_playlist_collaborators (
               playlist_id, user_id, role, status, invited_by, invited_at, accepted_at
             ) VALUES (?, ?, 'editor', 'pending', ?, ?, NULL)`,
          )
          .run(shareId, target.userId, ownerUserId, now);
      } else if (existing.status !== 'accepted') {
        this.db
          .prepare(
            `UPDATE hub_playlist_collaborators
             SET status = 'pending', invited_by = ?, invited_at = ?, accepted_at = NULL
             WHERE playlist_id = ? AND user_id = ?`,
          )
          .run(ownerUserId, now, shareId, target.userId);
      }
      const nextVersion = (Number(row.version) || 1) + 1;
      this.db
        .prepare('UPDATE hub_shared_playlists SET version = ?, updated_at = ? WHERE playlist_id = ?')
        .run(nextVersion, now, shareId);
      this.recordPlaylistActivity(
        shareId,
        owner,
        'invite',
        `Convidou @${target.publicHandle} para colaborar`,
        nextVersion,
        now,
      );
      const updated = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(shareId)!;
      return {
        status: 'ok' as const,
        detail: this.buildSharedPlaylistDetail(updated, ownerUserId),
      };
    });
  }

  respondPlaylistInvite(
    shareId: string,
    userId: string,
    accept: boolean,
    now: number,
  ):
    | { status: 'ok'; detail?: SharedPlaylistDetail }
    | { status: 'not_found' } {
    this.assertOpen();
    const user = this.findUserById(userId);
    if (!user) return { status: 'not_found' };
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(shareId);
      if (!row) return { status: 'not_found' as const };
      const collab = this.db
        .prepare(
          'SELECT role, status FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?',
        )
        .get(shareId, userId);
      if (!collab || collab.role === 'owner') return { status: 'not_found' as const };

      const nextVersion = (Number(row.version) || 1) + 1;
      if (accept) {
        this.db
          .prepare(
            `UPDATE hub_playlist_collaborators
             SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?)
             WHERE playlist_id = ? AND user_id = ?`,
          )
          .run(now, shareId, userId);
        this.db
          .prepare('UPDATE hub_shared_playlists SET version = ?, updated_at = ? WHERE playlist_id = ?')
          .run(nextVersion, now, shareId);
        this.recordPlaylistActivity(
          shareId,
          user,
          'accept_invite',
          `@${this.ensurePublicHandle(user).publicHandle} entrou na colaboração`,
          nextVersion,
          now,
        );
        const updated = this.db
          .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
          .get(shareId)!;
        return {
          status: 'ok' as const,
          detail: this.buildSharedPlaylistDetail(updated, userId),
        };
      }

      this.db
        .prepare('DELETE FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?')
        .run(shareId, userId);
      this.db
        .prepare('UPDATE hub_shared_playlists SET version = ?, updated_at = ? WHERE playlist_id = ?')
        .run(nextVersion, now, shareId);
      this.recordPlaylistActivity(
        shareId,
        user,
        'decline_invite',
        `@${this.ensurePublicHandle(user).publicHandle} recusou o convite`,
        nextVersion,
        now,
      );
      return { status: 'ok' as const };
    });
  }

  removeCollaborator(
    shareId: string,
    actorUserId: string,
    targetHandle: string,
    now: number,
  ):
    | { status: 'ok'; detail?: SharedPlaylistDetail }
    | { status: 'not_found' }
    | { status: 'forbidden' } {
    this.assertOpen();
    const actor = this.findUserById(actorUserId);
    const targetRaw = this.findUserByPublicHandle(targetHandle);
    if (!actor || !targetRaw) return { status: 'not_found' };
    const target = this.ensurePublicHandle(targetRaw);

    return this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
        .get(shareId);
      if (!row) return { status: 'not_found' as const };
      const ownerId = String(row.owner_user_id);
      if (target.userId === ownerId) return { status: 'forbidden' as const };

      const isOwner = actorUserId === ownerId;
      const isSelfLeave = actorUserId === target.userId;
      if (!isOwner && !isSelfLeave) return { status: 'forbidden' as const };

      this.db
        .prepare('DELETE FROM hub_playlist_collaborators WHERE playlist_id = ? AND user_id = ?')
        .run(shareId, target.userId);
      const nextVersion = (Number(row.version) || 1) + 1;
      this.db
        .prepare('UPDATE hub_shared_playlists SET version = ?, updated_at = ? WHERE playlist_id = ?')
        .run(nextVersion, now, shareId);
      this.recordPlaylistActivity(
        shareId,
        actor,
        isSelfLeave ? 'leave_collab' : 'revoke_collab',
        isSelfLeave
          ? `@${target.publicHandle} saiu da colaboração`
          : `Revogou acesso de @${target.publicHandle}`,
        nextVersion,
        now,
      );
      if (isOwner) {
        const updated = this.db
          .prepare('SELECT * FROM hub_shared_playlists WHERE playlist_id = ?')
          .get(shareId)!;
        return {
          status: 'ok' as const,
          detail: this.buildSharedPlaylistDetail(updated, actorUserId),
        };
      }
      return { status: 'ok' as const };
    });
  }

  getUserLibrary(userId: string): {
    playlists: unknown[];
    tracks: unknown[];
    likes: string[];
    preferences?: Record<string, unknown>;
    updatedAt: number;
  } {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT payload_json, updated_at FROM hub_user_library WHERE user_id = ?')
      .get(userId);
    if (!row || typeof row.payload_json !== 'string') {
      return { playlists: [], tracks: [], likes: [], updatedAt: 0 };
    }
    try {
      const parsed = JSON.parse(row.payload_json) as {
        playlists?: unknown[];
        tracks?: unknown[];
        likes?: string[];
        preferences?: Record<string, unknown>;
      };
      return {
        playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
        tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [],
        likes: Array.isArray(parsed.likes)
          ? parsed.likes.filter((x): x is string => typeof x === 'string')
          : [],
        ...(parsed.preferences && typeof parsed.preferences === 'object' && !Array.isArray(parsed.preferences)
          ? { preferences: parsed.preferences }
          : {}),
        updatedAt: Number(row.updated_at) || 0,
      };
    } catch {
      return { playlists: [], tracks: [], likes: [], updatedAt: 0 };
    }
  }

  saveUserLibrary(
    userId: string,
    payload: {
      playlists: unknown[];
      tracks: unknown[];
      likes: string[];
      preferences?: Record<string, unknown>;
    },
    now: number,
  ): { ok: boolean; updatedAt: number } {
    this.assertOpen();
    const serialized = JSON.stringify({
      playlists: payload.playlists.slice(0, 200),
      tracks: payload.tracks.slice(0, 2000),
      likes: payload.likes.slice(0, 5000),
      ...(payload.preferences && Object.keys(payload.preferences).length > 0
        ? { preferences: payload.preferences }
        : {}),
    });
    this.db
      .prepare(
        `INSERT INTO hub_user_library (user_id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      )
      .run(userId, serialized, now);
    return { ok: true, updatedAt: now };
  }

  getUserSubscription(userId: string, now: number): LiquidPlusStatus {
    this.assertOpen();
    if (!userId || !this.findUserById(userId)) {
      return defaultFreePlusStatus(false);
    }
    const row = this.db
      .prepare(
        'SELECT plan_id, status, source, current_period_end FROM hub_subscriptions WHERE user_id = ?',
      )
      .get(userId);
    if (!row) {
      return defaultFreePlusStatus(true);
    }
    const rawPlan = String(row.plan_id);
    const planId: PlusPlanId =
      rawPlan === 'plus_monthly' || rawPlan === 'plus_annual' ? rawPlan : 'free';
    const rawStatus = String(row.status);
    const status: SubscriptionStatus =
      rawStatus === 'active' ||
      rawStatus === 'trialing' ||
      rawStatus === 'past_due' ||
      rawStatus === 'canceled' ||
      rawStatus === 'expired'
        ? rawStatus
        : 'none';
    const rawSource = String(row.source);
    const source: SubscriptionSource =
      rawSource === 'admin' ||
      rawSource === 'stripe' ||
      rawSource === 'google_play' ||
      rawSource === 'promo'
        ? rawSource
        : 'system';
    const currentPeriodEnd =
      typeof row.current_period_end === 'number' && Number.isFinite(row.current_period_end)
        ? row.current_period_end
        : null;
    const resolved = resolvePlusEntitlements(planId, status, now, currentPeriodEnd);
    return {
      authenticated: true,
      planId: resolved.effectivePlanId,
      status: resolved.effectiveStatus,
      active: resolved.active,
      currentPeriodEnd,
      checkoutEnabled: false,
      entitlements: resolved.entitlements,
      audioAdsPolicy: AUDIO_ADS_POLICY,
      source,
    };
  }

  setUserSubscription(
    userId: string,
    input: {
      planId: PlusPlanId;
      status: SubscriptionStatus;
      source?: SubscriptionSource;
      currentPeriodEnd?: number | null;
    },
    now: number,
  ): LiquidPlusStatus {
    this.assertOpen();
    if (!this.findUserById(userId)) {
      throw new Error('user_not_found');
    }
    this.db
      .prepare(
        `INSERT INTO hub_subscriptions (
           user_id, plan_id, status, source, current_period_end, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           plan_id = excluded.plan_id,
           status = excluded.status,
           source = excluded.source,
           current_period_end = excluded.current_period_end,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        input.planId,
        input.status,
        input.source ?? 'admin',
        input.currentPeriodEnd ?? null,
        now,
      );
    return this.getUserSubscription(userId, now);
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
  googleOverride?: OAuthProviderConfig,
): {
  discord: Required<OAuthProviderConfig>;
  github: Required<OAuthProviderConfig>;
  google: Required<OAuthProviderConfig>;
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
    google: {
      clientId: googleOverride?.clientId ?? env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: googleOverride?.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '',
      authorizeUrl:
        googleOverride?.authorizeUrl ??
        env.GOOGLE_AUTH_URL ??
        'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl:
        googleOverride?.tokenUrl ??
        env.GOOGLE_TOKEN_URL ??
        'https://oauth2.googleapis.com/token',
      userInfoUrl:
        googleOverride?.userInfoUrl ??
        env.GOOGLE_USER_URL ??
        'https://openidconnect.googleapis.com/v1/userinfo',
      emailsUrl: '',
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
    google: {
      configured: Boolean(providers.google.clientId && providers.google.clientSecret),
      label: 'Google',
      scopes: ['openid', 'email', 'profile'],
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
  } else if (input.provider === 'google') {
    url.searchParams.set('scope', 'openid email profile');
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
  if ((input.provider === 'discord' || input.provider === 'google') && input.codeVerifier) {
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

  if (input.provider === 'google') {
    const userRes = await fetch(input.config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'LiquidHub-Broker/1.0',
      },
    });
    if (!userRes.ok) {
      const error = new Error('Não foi possível obter o perfil do Google.') as Error & {
        oauthCode?: string;
      };
      error.oauthCode = 'provider_profile_failed';
      throw error;
    }
    const raw = (await userRes.json()) as {
      sub?: string | number;
      name?: string | null;
      given_name?: string | null;
      preferred_username?: string | null;
      email?: string | null;
      email_verified?: boolean | string;
      picture?: string | null;
    };
    const sub = raw.sub !== undefined && raw.sub !== null ? String(raw.sub).trim() : '';
    if (!sub) {
      const error = new Error('Identificador (sub) do Google ausente na resposta.') as Error & {
        oauthCode?: string;
      };
      error.oauthCode = 'provider_profile_invalid';
      throw error;
    }
    const rawEmail =
      typeof raw.email === 'string' && raw.email.includes('@')
        ? raw.email.trim().toLowerCase()
        : null;
    const emailVerified =
      Boolean(rawEmail) && (raw.email_verified === true || raw.email_verified === 'true');
    const emailLocalPart = rawEmail ? rawEmail.split('@')[0]?.trim() || '' : '';
    const fullName =
      (typeof raw.name === 'string' && raw.name.trim()) ||
      (typeof raw.given_name === 'string' && raw.given_name.trim()) ||
      '';
    const preferredUsername =
      (typeof raw.preferred_username === 'string' && raw.preferred_username.trim()) || '';
    const fallbackHandle = `google_${sub.slice(0, 16)}`;
    const username = preferredUsername || emailLocalPart || fullName || fallbackHandle;
    const displayName = fullName || preferredUsername || emailLocalPart || fallbackHandle;
    const avatarUrl =
      typeof raw.picture === 'string' && /^https:\/\//i.test(raw.picture.trim())
        ? raw.picture.trim()
        : null;

    return {
      provider: 'google',
      providerSubject: sub,
      username,
      displayName,
      email: rawEmail,
      emailVerified,
      avatarUrl,
    };
  }

  if (input.provider === 'discord') {
    const userRes = await fetch(input.config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'LiquidHub-Broker/1.0',
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
