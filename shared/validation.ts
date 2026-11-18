import { z } from 'zod';

export const idSchema = z.string().min(1).max(200).regex(/^[\w:.\-]+$/);
const text = z.string().trim().min(1).max(500);
export const nonceSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const timestampSchema = z.number().int().min(1_000_000_000_000).max(9_999_999_999_999);
export const pkceVerifierSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/);
export const pkceChallengeSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function officialUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      [
        'youtube.com',
        'www.youtube.com',
        'music.youtube.com',
        'youtu.be',
        'soundcloud.com',
        'www.soundcloud.com',
        'policies.google.com',
        'developers.google.com',
        'developers.soundcloud.com',
      ].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

export function publicMusicUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.hostname.includes('.') &&
      !u.hostname.includes(':') &&
      !/^([0-9.]+|localhost)$/.test(u.hostname) &&
      !['.local', '.localhost', '.internal'].some(s => u.hostname.endsWith(s))
    );
  } catch {
    return false;
  }
}

export function artworkUrl(raw: string): boolean {
  if (
    /^\/covers\/[\w-]+\.svg$/.test(raw) ||
    /^glass:\/\/app\/covers\/[a-f0-9]+\.(jpg|png|webp)$/.test(raw)
  ) {
    return true;
  }
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      [
        'i.ytimg.com',
        'i9.ytimg.com',
        'lh3.googleusercontent.com',
        'i1.sndcdn.com',
        'i2.sndcdn.com',
        'i.scdn.co',
        'mosaic.scdn.co',
        'image-cdn-fa.spotifycdn.com',
        'image-cdn-ak.spotifycdn.com',
        'cdn-images.dzcdn.net',
        'e-cdns-images.dzcdn.net',
        'cdns-images.dzcdn.net',
        'is1-ssl.mzstatic.com',
        'is2-ssl.mzstatic.com',
        'is3-ssl.mzstatic.com',
        'is4-ssl.mzstatic.com',
        'is5-ssl.mzstatic.com',
        'f4.bcbits.com',
        'resources.tidal.com',
        'akamai.sscdn.co',
      ].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

export const catalogSourceSchema = z.enum([
  'spotify',
  'deezer',
  'ytmusic',
  'youtube',
  'soundcloud',
  'local',
]);

export const streamProviderSchema = z.enum([
  'ytmusic',
  'youtube',
  'soundcloud',
  'deezer',
  'local',
]);

export const isrcSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i);

export function streamReferenceUrl(raw: string): boolean {
  if (publicMusicUrl(raw)) return true;
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'http:' &&
      u.hostname === '127.0.0.1' &&
      !u.username &&
      !u.password &&
      /^\/(audio|offline|media)\/[\w%.-]+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export const trackSchema = z
  .object({
    id: idSchema,
    source: z.enum(['local', 'youtube', 'soundcloud', 'link']),
    kind: z.enum(['track', 'artist', 'playlist', 'album']),
    sourceId: idSchema,
    title: text,
    artist: text,
    offline: z.boolean().optional(),
    album: z.string().max(500).optional(),
    artwork: z.string().max(2048).refine(artworkUrl).optional(),
    duration: z.number().finite().min(0).max(604800),
    durationMs: z.number().finite().min(0).max(604_800_000).optional(),
    isrc: isrcSchema.optional(),
    catalogSource: catalogSourceSchema.optional(),
    streamProvider: streamProviderSchema.optional(),
    resolvedStreamUrl: z.string().max(2048).refine(streamReferenceUrl).optional(),
    resolvedExternalId: z.string().min(1).max(200).regex(/^[\w:.\-/]+$/).optional(),
    url: z.string().max(2048).refine(publicMusicUrl).optional(),
    addedAt: z.number().finite().min(0),
    available: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    playbackId: z.string().regex(/^[\w-]{11}$/).optional(),
    lyricSnippet: z.string().max(500).optional(),
    recommended: z.boolean().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.source !== 'link' && t.url && !officialUrl(t.url)) {
      ctx.addIssue({ code: 'custom', message: 'Link da plataforma inválido' });
    }
    if (t.id !== `${t.source}:${t.sourceId}`) {
      ctx.addIssue({ code: 'custom', message: 'Identificador inconsistente' });
    }
    if (t.source === 'youtube' && t.kind === 'track' && !/^[\w-]{11}$/.test(t.sourceId)) {
      ctx.addIssue({ code: 'custom', message: 'ID de vídeo inválido' });
    }
    if (
      t.source === 'soundcloud' &&
      t.url &&
      !['soundcloud.com', 'www.soundcloud.com'].includes(new URL(t.url).hostname)
    ) {
      ctx.addIssue({ code: 'custom', message: 'URL SoundCloud inválida' });
    }
  });

export const preferencesSchema = z
  .object({
    uiStyle: z.enum(['matte', 'glass']).optional(),
    transition: z.enum(['off', 'fade', 'crossfade']).optional(),
    transitionSeconds: z.number().min(0.5).max(10).optional(),
    volumeBoost: z.number().min(0).max(12).optional(),
    limiter: z.boolean().optional(),
    outputDevice: z.string().max(300).optional(),
    jamEndpoint: z.string().max(2048).optional(),
    autoUpdate: z.boolean().optional(),
    autoplay: z.boolean().optional(),
    appearance: z.record(z.string(), z.unknown()).optional(),
    theme: z.enum(['dark', 'light', 'system']),
    glass: z.number().min(0).max(100),
    blur: z.number().min(0).max(48),
    accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    autoAccent: z.boolean(),
    reducedMotion: z.boolean(),
    performance: z.boolean(),
    volume: z.number().min(0).max(100),
    repeat: z.enum(['off', 'all', 'one']),
    shuffle: z.boolean(),
    tray: z.boolean(),
    startup: z.boolean(),
    notifications: z.boolean(),
    notificationMode: z.enum(['off', 'background', 'always']).optional(),
    globalShortcuts: z.boolean(),
    coverCacheMB: z.number().int().min(16).max(512),
    eq: z.array(z.number().min(-12).max(12)).length(5),
    onlineConsent: z.boolean(),
    catalogConsent: z.boolean(),
    onboardingDone: z.boolean(),
  })
  .strict();

export const librarySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('like'), track: trackSchema }).strict(),
  z.object({ action: z.literal('save'), track: trackSchema }).strict(),
  z.object({ action: z.literal('history'), track: trackSchema }).strict(),
  z.object({ action: z.literal('create'), name: z.string().trim().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal('rename'),
      id: idSchema,
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
  z.object({ action: z.literal('delete'), id: idSchema }).strict(),
  z.object({ action: z.literal('add'), id: idSchema, track: trackSchema }).strict(),
  z.object({ action: z.literal('remove'), id: idSchema, trackId: idSchema }).strict(),
  z
    .object({
      action: z.literal('move'),
      id: idSchema,
      targetId: idSchema,
      trackId: idSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('reorder'),
      id: idSchema,
      trackIds: z.array(idSchema).max(10000),
    })
    .strict(),
  z.object({ action: z.literal('removeTrack'), id: idSchema }).strict(),
  z.object({ action: z.literal('clearHistory') }).strict(),
]);

export const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    kind: z.enum(['all', 'track', 'artist', 'playlist', 'album', 'lyrics']),
    source: z.enum([
      'all',
      'local',
      'youtube',
      'ytmusic',
      'soundcloud',
      'deezer',
      'apple',
      'spotify',
    ]),
    cursor: z.record(z.string(), z.string().max(2048)).optional(),
    requestId: idSchema,
  })
  .strict();

export function brokerUrl(raw: string): boolean {
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'))
    );
  } catch {
    return false;
  }
}

export function loopbackRedirectUri(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.protocol === 'http:' &&
      u.hostname === '127.0.0.1' &&
      u.pathname === '/callback'
    );
  } catch {
    return false;
  }
}

export const credentialSchema = z
  .object({
    youtubeKey: z.string().trim().max(200).optional(),
    brokerUrl: z.string().trim().max(2048).refine(brokerUrl).optional(),
    brokerToken: z.string().trim().max(1000).optional(),
  })
  .strict();

export const portableSchema = z
  .object({
    format: z.enum(['liquid-hub', 'glass-music']),
    version: z.literal(1),
    tracks: z.array(trackSchema).max(20000),
    playlists: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().min(1).max(100),
            createdAt: z.number(),
            artwork: z.string().max(1_800_000).optional(),
            description: z.string().max(300).optional(),
            trackIds: z.array(idSchema).max(10000),
          })
          .strict(),
      )
      .max(1000),
    likes: z.array(idSchema).max(20000),
  })
  .strict();

/** Zero-Trust Auth Contracts: OAuth2 + Mandatory PKCE (S256), Argon2id Credentials & Refresh Rotation */
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-zA-Z0-9._@-]+$/);
export const passwordSchema = z.string().min(12).max(256);

export const pkceAuthorizeSchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().min(3).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri, 'Redirect URI deve ser loopback'),
    state: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    scope: z.string().max(256).optional(),
  })
  .strict();

export const credentialRegisterSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    client_id: z.string().min(3).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri).optional(),
  })
  .strict();

export const credentialLoginSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    client_id: z.string().min(3).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri).optional(),
  })
  .strict();

export const pkceTokenExchangeSchema = z
  .object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(24).max(256).regex(/^[A-Za-z0-9_-]+$/),
    client_id: z.string().min(3).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
    code_verifier: pkceVerifierSchema,
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri).optional(),
  })
  .strict();

export const refreshTokenGrantSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
    client_id: z.string().min(3).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  })
  .strict();

export const tokenGrantSchema = z.discriminatedUnion('grant_type', [
  pkceTokenExchangeSchema,
  refreshTokenGrantSchema,
]);

/** Strict JAM Request Schema with Nonce + Timestamp Replay Protection */
export const jamPlaybackSchema = z
  .object({
    track: trackSchema.nullable(),
    playing: z.boolean(),
    position: z.number().finite().min(0).max(86400),
  })
  .strict();

export const jamRequestSchema = z
  .object({
    action: z.enum([
      'create',
      'createLocal',
      'join',
      'poll',
      'sync',
      'ping',
      'discoverLan',
      'leave',
    ]),
    code: z.string().regex(/^[A-F0-9]{10}$/).optional(),
    preferredCode: z.string().regex(/^[A-F0-9]{10}$/).optional(),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
    name: z.string().max(80).optional(),
    endpoint: z.string().max(2048).optional(),
    nonce: nonceSchema.optional(),
    timestamp: timestampSchema.optional(),
    clientTime: z.number().finite().optional(),
    sinceSequence: z.number().int().min(0).optional(),
    playback: jamPlaybackSchema.optional(),
  })
  .strict();

const FORBIDDEN_WEB_STORAGE_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /jwt/i,
  /oauth/i,
  /credential/i,
  /auth/i,
  /refresh/i,
  /session/i,
];

const ALLOWED_WEB_STORAGE_KEYS = new Set([
  'glass-optics-v3',
  'liquid-optics-v3',
  'glass:discover:v2',
  'liquid:discover:v2',
]);

/**
 * Zero-Trust Desktop Policy: Sensitive tokens/credentials are strictly prohibited in Web Storage.
 * Scans and purges any unauthorized or token-bearing keys from localStorage / sessionStorage.
 */
export function purgeSensitiveWebStorage(
  storages: Array<Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'> | undefined> = typeof window !==
  'undefined'
    ? [window.localStorage, window.sessionStorage]
    : [],
): string[] {
  const purged: string[] = [];
  for (const store of storages) {
    if (!store) continue;
    const keys: string[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k !== null) keys.push(k);
      }
      for (const k of keys) {
        if (ALLOWED_WEB_STORAGE_KEYS.has(k)) continue;
        const val = store.getItem(k) || '';
        const looksLikeJwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(val);
        if (FORBIDDEN_WEB_STORAGE_PATTERNS.some(rx => rx.test(k)) || looksLikeJwt) {
          store.removeItem(k);
          purged.push(k);
        }
      }
    } catch {
      // Storage may be disabled by sandbox/CSP; memory-only state remains safe.
    }
  }
  return purged;
}
