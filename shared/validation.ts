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
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    const exact = [
      'img.youtube.com',
      'api.deezer.com',
      'f4.bcbits.com',
      'resources.tidal.com',
      'akamai.sscdn.co',
      'cdn.discordapp.com',
      'avatars.githubusercontent.com',
    ];
    const suffixes = [
      '.scdn.co',
      '.spotifycdn.com',
      '.ytimg.com',
      '.ggpht.com',
      '.googleusercontent.com',
      '.sndcdn.com',
      '.dzcdn.net',
      '.mzstatic.com',
    ];
    return (
      exact.includes(host) ||
      suffixes.some(suffix => host.length > suffix.length && host.endsWith(suffix))
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
    uiStyle: z.enum(['matte', 'glass', 'beat']).optional(),
    beatPulse: z.boolean().optional(),
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
    shuffleMode: z.enum(['standard', 'smart']).optional(),
    smartShuffleDiscoveries: z.boolean().optional(),
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
    termsVersion: z.string().min(1).max(32).optional(),
    privacyVersion: z.string().min(1).max(32).optional(),
    termsAcceptedAt: z.number().int().nonnegative().optional(),
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
    kind: z.enum(['all', 'track', 'artist', 'playlist', 'album', 'user', 'lyrics']),
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
export const emailSchema = z.string().trim().toLowerCase().email().max(160);
export const displayNameSchema = z.string().trim().min(1).max(80);
export const legalVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const passwordSchema = z.string().min(12).max(256);
export const hubOAuthProviderSchema = z.enum(['discord', 'github', 'google']);
export const hubAuthProviderSchema = z.enum(['email', 'discord', 'github', 'google']);

const brokerClientIdSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const pkceAuthorizeSchema = z
  .object({
    response_type: z.literal('code'),
    client_id: brokerClientIdSchema,
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri, 'Redirect URI deve ser loopback'),
    state: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    scope: z.string().max(256).optional(),
  })
  .strict();

export const credentialRegisterSchema = z
  .object({
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    displayName: displayNameSchema.optional(),
    password: passwordSchema,
    client_id: brokerClientIdSchema,
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri).optional(),
    termsVersion: legalVersionSchema.optional(),
    privacyVersion: legalVersionSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.username && !data.email) {
      ctx.addIssue({
        code: 'custom',
        message: 'Informe um e-mail ou nome de usuário.',
        path: ['email'],
      });
    }
  });

export const credentialLoginSchema = z
  .object({
    identifier: usernameSchema.optional(),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema,
    client_id: brokerClientIdSchema,
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri).optional(),
    termsVersion: legalVersionSchema.optional(),
    privacyVersion: legalVersionSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.identifier && !data.username && !data.email) {
      ctx.addIssue({
        code: 'custom',
        message: 'Informe seu e-mail ou nome de usuário.',
        path: ['identifier'],
      });
    }
  });

export const oauthStartSchema = z
  .object({
    provider: hubOAuthProviderSchema,
    client_id: brokerClientIdSchema,
    redirect_uri: z.string().max(512).refine(loopbackRedirectUri, 'Redirect URI deve ser loopback'),
    code_challenge: pkceChallengeSchema,
    code_challenge_method: z.literal('S256'),
    state: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
    mode: z.enum(['login', 'link']).optional(),
    termsVersion: legalVersionSchema.optional(),
    privacyVersion: legalVersionSchema.optional(),
    oauthClientId: z.string().trim().min(1).max(200).optional(),
    oauthClientSecret: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const verifyEmailSchema = z
  .object({
    token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const resendVerificationSchema = z
  .object({
    email: emailSchema.optional(),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
    newPassword: passwordSchema,
  })
  .strict();

export const linkEmailSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
  })
  .strict();

export const acceptTermsSchema = z
  .object({
    termsVersion: legalVersionSchema,
    privacyVersion: legalVersionSchema,
  })
  .strict();

export const publicHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/);

export const bioSchema = z.string().trim().max(240);
export const profileVisibilitySchema = z.enum(['public', 'restricted', 'private']);
export const playlistVisibilitySchema = z.enum(['public', 'unlisted', 'private']);

const optionalSocialUrl = z.union([
  z.literal(''),
  z.string().trim().max(2048).refine(publicMusicUrl),
]);

export const socialLinksSchema = z
  .object({
    website: optionalSocialUrl.optional(),
    instagram: optionalSocialUrl.optional(),
    twitter: optionalSocialUrl.optional(),
    youtube: optionalSocialUrl.optional(),
    spotify: optionalSocialUrl.optional(),
    github: optionalSocialUrl.optional(),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    publicHandle: publicHandleSchema.optional(),
    bio: bioSchema.optional(),
    profileVisibility: profileVisibilitySchema.optional(),
    socialLinks: socialLinksSchema.optional(),
    showPublicTracks: z.boolean().optional(),
  })
  .strict()
  .refine(
    v =>
      v.displayName !== undefined ||
      v.publicHandle !== undefined ||
      v.bio !== undefined ||
      v.profileVisibility !== undefined ||
      v.socialLinks !== undefined ||
      v.showPublicTracks !== undefined,
    { message: 'Informe ao menos um campo do perfil para atualizar.' },
  );

export const sharedTrackSchema = z
  .object({
    id: idSchema,
    source: z.enum(['youtube', 'soundcloud', 'link']),
    kind: z.enum(['track', 'artist', 'playlist', 'album']),
    sourceId: idSchema,
    title: text,
    artist: text,
    album: z.string().max(500).optional(),
    artwork: z.string().max(2048).refine(artworkUrl).optional(),
    duration: z.number().finite().min(0).max(604800),
    durationMs: z.number().finite().min(0).max(604_800_000).optional(),
    isrc: isrcSchema.optional(),
    catalogSource: catalogSourceSchema.optional(),
    streamProvider: streamProviderSchema.optional(),
    resolvedExternalId: z.string().min(1).max(200).regex(/^[\w:.\-/]+$/).optional(),
    url: z.string().max(2048).refine(publicMusicUrl).optional(),
    addedAt: z.number().finite().min(0).optional(),
    available: z.boolean().optional(),
    playbackId: z.string().regex(/^[\w-]{11}$/).optional(),
  })
  .strip();

export const publishPlaylistSchema = z
  .object({
    shareId: idSchema.optional(),
    localPlaylistId: idSchema.optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).optional(),
    artwork: z.union([z.literal(''), z.string().max(2048).refine(artworkUrl)]).optional(),
    visibility: playlistVisibilitySchema.default('private'),
    collaborative: z.boolean().default(false),
    tracks: z.array(z.unknown()).max(1000),
  })
  .strict();

export const mutateSharedPlaylistSchema = z
  .object({
    op: z.enum(['meta', 'addTracks', 'removeTrack', 'reorder']),
    expectedVersion: z.number().int().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(300).optional(),
    artwork: z.union([z.literal(''), z.string().max(2048).refine(artworkUrl)]).optional(),
    visibility: playlistVisibilitySchema.optional(),
    collaborative: z.boolean().optional(),
    tracks: z.array(z.unknown()).max(100).optional(),
    trackId: idSchema.optional(),
    trackIds: z.array(idSchema).max(1000).optional(),
  })
  .strict();

export const inviteCollaboratorSchema = z
  .object({
    handle: publicHandleSchema,
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
      'lookup',
      'join',
      'resume',
      'poll',
      'sync',
      'ping',
      'discoverLan',
      'rotateInvite',
      'updateRoom',
      'kick',
      'voteSkip',
      'queueAdd',
      'queueRemove',
      'recommendPlaylist',
      'chat',
      'subscribe',
      'unsubscribe',
      'leave',
    ]),
    code: z.string().regex(/^[A-Z0-9]{6,16}$/i).optional(),
    preferredCode: z.string().regex(/^[A-Z0-9]{6,16}$/i).optional(),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
    resumeToken: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
    name: z.string().max(80).optional(),
    roomName: z.string().max(60).optional(),
    avatar: z.string().max(2048).optional(),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
    memberId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
    locked: z.boolean().optional(),
    requireAuth: z.boolean().optional(),
    inviteTtlMs: z.number().int().min(60_000).max(86_400_000).optional(),
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
  'glass:recommendations:v1',
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
