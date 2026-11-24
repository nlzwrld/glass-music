import type { LiquidPlusStatus } from './plus';
import type { SupportedPlatform, VersionPolicyResponse } from './version';

export type {
  LiquidPlusStatus,
  PlusEntitlementKey,
  PlusEntitlements,
  PlusPlanDefinition,
  PlusPlanId,
  SubscriptionSource,
  SubscriptionStatus,
} from './plus';

export type { SupportedPlatform, VersionPolicyResponse } from './version';

export interface MaintenanceReport {
  ok: boolean;
  repaired: boolean;
  version: string;
  dbIntegrityOk: boolean;
  vaultReadable: boolean;
  orphanedTempFiles: number;
  removedOrphanedTempFiles: number;
  backupsCount: number;
  backupCreated?: string | null;
  checkedAt: number;
  message: string;
}

export type Source = 'local' | 'youtube' | 'soundcloud' | 'link';
export type Kind = 'track' | 'artist' | 'playlist' | 'album';

export type CatalogSource =
  | 'spotify'
  | 'deezer'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | 'local';

export type StreamProvider = 'ytmusic' | 'youtube' | 'soundcloud' | 'deezer' | 'local';

export interface Track {
  id: string;
  source: Source;
  kind: Kind;
  sourceId: string;
  title: string;
  artist: string;
  offline?: boolean;
  album?: string;
  artwork?: string;
  duration: number;
  durationMs?: number;
  isrc?: string;
  catalogSource?: CatalogSource;
  streamProvider?: StreamProvider;
  resolvedStreamUrl?: string;
  resolvedExternalId?: string;
  url?: string;
  addedAt: number;
  available?: boolean;
  reason?: string;
  playbackId?: string;
  lyricSnippet?: string;
  recommended?: boolean;
}

export interface StreamCandidate {
  provider: Exclude<StreamProvider, 'local'>;
  id: string;
  title: string;
  artist: string;
  duration: number;
  durationMs: number;
  durationDeltaMs: number;
  score: number;
  url?: string;
  artwork?: string;
  isrc?: string;
  isOfficialTopic?: boolean;
}

export interface StreamResolution {
  track: Track;
  provider: Exclude<StreamProvider, 'local'>;
  externalId: string;
  streamUrl: string;
  duration: number;
  durationDeltaMs: number;
  score: number;
  fromCache: boolean;
}

export function inferCatalogSource(
  track: Pick<Track, 'source' | 'url' | 'catalogSource' | 'artist'>,
): CatalogSource {
  if (track.catalogSource) return track.catalogSource;
  if (track.source === 'local') return 'local';
  if (track.url) {
    try {
      const host = new URL(track.url).hostname.toLowerCase();
      if (host === 'open.spotify.com') return 'spotify';
      if (host === 'deezer.com' || host === 'www.deezer.com') return 'deezer';
      if (host === 'music.youtube.com') return 'ytmusic';
      if (host === 'soundcloud.com' || host === 'www.soundcloud.com') return 'soundcloud';
      if (['youtube.com', 'www.youtube.com', 'youtu.be'].includes(host)) {
        return track.artist?.endsWith(' - Topic') ? 'ytmusic' : 'youtube';
      }
    } catch {}
  }
  if (track.source === 'soundcloud') return 'soundcloud';
  if (track.source === 'youtube') {
    return track.artist?.endsWith(' - Topic') ? 'ytmusic' : 'youtube';
  }
  return 'spotify';
}

export function trackDurationMs(track: Pick<Track, 'duration' | 'durationMs'>): number {
  if (typeof track.durationMs === 'number' && Number.isFinite(track.durationMs) && track.durationMs >= 0) {
    return Math.round(track.durationMs);
  }
  return Math.max(0, Math.round((Number(track.duration) || 0) * 1000));
}

export function isCatalogOnlyTrack(track: Pick<Track, 'source' | 'url' | 'catalogSource'>): boolean {
  if (track.source === 'local') return false;
  if (track.catalogSource === 'spotify' || track.catalogSource === 'deezer') return true;
  if (track.source === 'link') return true;
  if (track.url) {
    try {
      const host = new URL(track.url).hostname.toLowerCase();
      if (
        [
          'open.spotify.com',
          'deezer.com',
          'www.deezer.com',
          'music.apple.com',
          'itunes.apple.com',
          'tidal.com',
          'www.tidal.com',
          'listen.tidal.com',
        ].includes(host) ||
        host.endsWith('.bandcamp.com')
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function canPlay(track: Track) {
  return (
    (['local', 'youtube', 'link'].includes(track.source) && track.kind === 'track') ||
    (track.source === 'soundcloud' && ['track', 'playlist'].includes(track.kind))
  );
}

export type ProfileVisibility = 'public' | 'restricted' | 'private';
export type PlaylistVisibility = 'public' | 'unlisted' | 'private';

export interface SocialLinks {
  website?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
  spotify?: string;
  github?: string;
}

export interface Playlist {
  artwork?: string;
  description?: string;
  id: string;
  name: string;
  createdAt: number;
  trackIds: string[];
  shareId?: string;
  visibility?: PlaylistVisibility;
  collaborative?: boolean;
  remoteVersion?: number;
  ownerHandle?: string;
}

export interface PlaylistCollaborator {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'editor';
  status: 'pending' | 'accepted';
  invitedAt: number;
  acceptedAt?: number | null;
}

export interface PlaylistActivityEntry {
  id: string;
  actorHandle: string;
  actorName: string;
  action: string;
  summary: string;
  version: number;
  createdAt: number;
}

export interface SharedPlaylistSummary {
  id: string;
  name: string;
  description: string;
  artwork?: string;
  visibility: PlaylistVisibility;
  collaborative: boolean;
  trackCount: number;
  ownerHandle: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string | null;
  version: number;
  updatedAt: number;
}

export interface SharedPlaylistDetail extends SharedPlaylistSummary {
  localPlaylistId?: string | null;
  tracks: Track[];
  role: 'owner' | 'editor' | 'viewer';
  collaborators: PlaylistCollaborator[];
  activity: PlaylistActivityEntry[];
  shareUrl?: string;
  deepLinkUrl?: string;
  unchanged?: boolean;
}

export interface PublicUserProfile {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  visibility: ProfileVisibility;
  socialLinks: SocialLinks;
  showPublicTracks: boolean;
  publicPlaylists: SharedPlaylistSummary[];
  publicTracks: Track[];
  createdAt: number;
  accountType: 'user';
}

export interface UserSearchItem {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  visibility: ProfileVisibility;
  publicPlaylistCount: number;
  accountType: 'user';
}

export interface MySharedPlaylistsResponse {
  owned: SharedPlaylistSummary[];
  collaborating: SharedPlaylistSummary[];
  pendingInvites: (SharedPlaylistSummary & { invitedAt: number })[];
}

export type ShuffleMode = 'standard' | 'smart';

export interface OfflineTrackInfo {
  trackId: string;
  size: number;
  duration: number;
  createdAt: number;
  verified: boolean;
}

export interface OfflineSummary {
  tracks: OfflineTrackInfo[];
  totalTracks: number;
  totalBytes: number;
}

export interface DownloadProgressEvent {
  trackId: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  status: 'downloading' | 'completed' | 'cancelled' | 'error';
}

export interface DiscoveryCacheEntry<T = unknown> {
  signature: string;
  payload: T;
  updatedAt: number;
  expiresAt: number;
}

export type NotificationMode = 'off' | 'background' | 'always';

export function resolveNotificationMode(
  prefs: Pick<Preferences, 'notifications' | 'notificationMode'>,
): NotificationMode {
  if (
    prefs.notificationMode === 'off' ||
    prefs.notificationMode === 'background' ||
    prefs.notificationMode === 'always'
  ) {
    return prefs.notificationMode;
  }
  return prefs.notifications ? 'background' : 'off';
}

export interface Preferences {
  uiStyle?: 'matte' | 'glass' | 'beat';
  beatPulse?: boolean;
  transition: 'off' | 'fade' | 'crossfade';
  transitionSeconds: number;
  volumeBoost: number;
  limiter: boolean;
  outputDevice: string;
  jamEndpoint: string;
  autoUpdate: boolean;
  autoplay: boolean;
  appearance?: Record<string, unknown>;
  theme: 'dark' | 'light' | 'system';
  glass: number;
  blur: number;
  accent: string;
  autoAccent: boolean;
  reducedMotion: boolean;
  performance: boolean;
  volume: number;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  shuffleMode?: ShuffleMode;
  smartShuffleDiscoveries?: boolean;
  tray: boolean;
  startup: boolean;
  notifications: boolean;
  notificationMode?: NotificationMode;
  globalShortcuts: boolean;
  coverCacheMB: number;
  eq: number[];
  onlineConsent: boolean;
  catalogConsent: boolean;
  onboardingDone: boolean;
  termsVersion?: string;
  privacyVersion?: string;
  termsAcceptedAt?: number;
}

export const defaults: Preferences = {
  uiStyle: 'matte',
  beatPulse: false,
  transition: 'fade',
  transitionSeconds: 3,
  volumeBoost: 0,
  limiter: true,
  outputDevice: 'default',
  jamEndpoint: '',
  autoUpdate: true,
  autoplay: true,
  theme: 'dark',
  glass: 20,
  blur: 24,
  accent: '#52b79a',
  autoAccent: false,
  reducedMotion: false,
  performance: false,
  volume: 65,
  repeat: 'off',
  shuffle: false,
  shuffleMode: 'smart',
  smartShuffleDiscoveries: false,
  tray: true,
  startup: false,
  notifications: false,
  notificationMode: 'off',
  globalShortcuts: false,
  coverCacheMB: 128,
  eq: [0, 0, 0, 0, 0],
  onlineConsent: false,
  catalogConsent: false,
  onboardingDone: false,
};

export interface Snapshot {
  tracks: Track[];
  playlists: Playlist[];
  likes: string[];
  history: { id: string; playedAt: number }[];
  preferences: Preferences;
}

export type SearchKind = 'all' | 'track' | 'artist' | 'playlist' | 'album' | 'user' | 'lyrics';
export type SearchSource = 'all' | Source | 'deezer' | 'apple' | 'ytmusic' | 'spotify';

export interface SearchRequest {
  query: string;
  kind: SearchKind;
  source: SearchSource;
  cursor?: Record<string, string>;
  requestId: string;
}

export interface SearchResult {
  items: Track[];
  next: Record<string, string>;
  notices: string[];
}

export interface CollectionPreview {
  name: string;
  artwork: string;
  url: string;
  tracks: Track[];
  warning: string;
  skipped: number;
}

export interface ProviderCapabilities {
  search: Kind[];
  playback: 'official-embed' | 'local';
  equalizer: boolean;
  background: boolean;
  downloads: boolean;
}

export interface MusicProvider {
  id: Source | 'ytmusic' | 'deezer';
  capabilities: ProviderCapabilities;
  search(request: SearchRequest, signal: AbortSignal): Promise<{ items: Track[]; next?: string }>;
  metadata(id: string, signal: AbortSignal): Promise<Track>;
  availability(track: Track, signal: AbortSignal): Promise<{ available: boolean; reason?: string }>;
  playback(track: Track): { type: 'local' | 'youtube' | 'ytmusic' | 'soundcloud' | 'deezer' | 'link'; reference: string };
}

export interface IntegrationStatus {
  youtube: boolean;
  soundcloud: boolean;
  spotify?: boolean;
  catalogConfigured: boolean;
  catalogMode?: 'direct' | 'hosted' | 'unavailable';
  encrypted: boolean;
  brokerUrl: string;
  hubAuthenticated?: boolean;
  offlineTracks?: number;
  offlineBytes?: number;
  version: string;
  gpu: boolean;
  shortcuts: boolean;
}

export type HubAuthProvider = 'email' | 'discord' | 'github' | 'google';
export type HubOAuthProvider = 'discord' | 'github' | 'google';

export interface HubIdentityPublic {
  provider: HubAuthProvider;
  providerSubject: string;
  username?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  verified: boolean;
  linkedAt: number;
}

export interface HubProviderAvailability {
  configured: boolean;
  label: string;
  scopes: string[];
}

export interface HubProvidersAvailability {
  brokerUrl: string;
  email: {
    enabled: boolean;
    requiresVerification: boolean;
  };
  discord: HubProviderAvailability;
  github: HubProviderAvailability;
  google: HubProviderAvailability;
  termsVersion: string;
  privacyVersion: string;
}

export interface HubSessionStatus {
  authenticated: boolean;
  subject: string;
  expiresAt: number;
  brokerUrl: string;
  tokenActive?: boolean;
  userId?: string;
  username?: string;
  displayName?: string;
  email?: string | null;
  emailVerified?: boolean;
  avatarUrl?: string | null;
  hasPassword?: boolean;
  identities?: HubIdentityPublic[];
  termsVersion?: string | null;
  privacyVersion?: string | null;
  termsAcceptedAt?: number | null;
  needsTermsAcceptance?: boolean;
  publicHandle?: string;
  bio?: string;
  profileVisibility?: ProfileVisibility;
  socialLinks?: SocialLinks;
  showPublicTracks?: boolean;
}

export interface CatalogResult {
  sections: { id: string; source: 'youtube' | 'soundcloud' | 'deezer'; title: string; items: Track[] }[];
  notices: string[];
}

export type LibraryCommand =
  | { action: 'like'; track: Track }
  | { action: 'save'; track: Track }
  | { action: 'history'; track: Track }
  | { action: 'create'; name: string; artwork?: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'setArtwork'; id: string; artwork: string }
  | { action: 'delete'; id: string }
  | { action: 'add'; id: string; track: Track }
  | { action: 'remove'; id: string; trackId: string }
  | { action: 'move'; id: string; targetId: string; trackId: string }
  | { action: 'reorder'; id: string; trackIds: string[] }
  | { action: 'removeTrack'; id: string }
  | { action: 'clearHistory' };

export type MediaCommand = 'playPause' | 'next' | 'previous';

export interface AccountStatus {
  provider: 'youtube' | 'soundcloud' | 'spotify';
  configured: boolean;
  connected: boolean;
  name: string;
  lastSync: number;
  reason: string;
}

export interface LinkImport {
  snapshot: Snapshot;
  track?: Track;
  playlistId?: string;
  count?: number;
  warning: string;
  skipped?: number;
}

export interface LyricsResult {
  id: number;
  title: string;
  artist: string;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental: boolean;
  provider: string;
}

export interface GlassAPI {
  importLink(url: string, playlist?: boolean): Promise<LinkImport>;
  previewCollection(url: string): Promise<CollectionPreview>;
  recommendations(seeds: Track[], excludeIds: string[]): Promise<Track[]>;
  playlistMeta(
    id: string,
    meta: {
      artwork?: string;
      description?: string;
      shareId?: string;
      visibility?: PlaylistVisibility;
      collaborative?: boolean;
      remoteVersion?: number;
      ownerHandle?: string;
    },
  ): Promise<Snapshot>;
  accounts(): Promise<AccountStatus[]>;
  configureAccounts(): Promise<AccountStatus[]>;
  connectAccount(provider: string): Promise<AccountStatus[]>;
  disconnectAccount(provider: string): Promise<AccountStatus[]>;
  cancelAccount(): Promise<void>;
  syncAccount(
    provider: string,
  ): Promise<{ snapshot: Snapshot; playlists: number; tracks: number; accounts: AccountStatus[] }>;
  hubStatus(): Promise<HubSessionStatus>;
  hubProviders(brokerUrl?: string): Promise<HubProvidersAvailability>;
  hubLogin(payload: {
    brokerUrl: string;
    username?: string;
    email?: string;
    identifier?: string;
    displayName?: string;
    password: string;
    register?: boolean;
    termsVersion?: string;
    privacyVersion?: string;
  }): Promise<HubSessionStatus>;
  hubOAuthStart(payload: {
    brokerUrl?: string;
    provider: HubOAuthProvider;
    mode?: 'login' | 'link';
    termsVersion?: string;
    privacyVersion?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  }): Promise<HubSessionStatus>;
  hubCancelOAuth(): Promise<{ ok: boolean }>;
  hubRefresh(brokerUrl?: string): Promise<HubSessionStatus>;
  hubLogout(): Promise<HubSessionStatus>;
  hubUnlinkIdentity(payload: {
    brokerUrl?: string;
    provider: HubAuthProvider;
  }): Promise<HubSessionStatus>;
  hubLinkEmail(payload: {
    brokerUrl?: string;
    email: string;
    password: string;
    username?: string;
    displayName?: string;
  }): Promise<HubSessionStatus>;
  hubVerifyEmail(payload: {
    brokerUrl?: string;
    token: string;
  }): Promise<{ ok: boolean; status: HubSessionStatus }>;
  hubResendVerification(payload?: {
    brokerUrl?: string;
    email?: string;
  }): Promise<{ ok: boolean; sent: boolean }>;
  hubForgotPassword(payload: {
    brokerUrl?: string;
    email: string;
  }): Promise<{ ok: boolean }>;
  hubResetPassword(payload: {
    brokerUrl?: string;
    token: string;
    newPassword: string;
  }): Promise<{ ok: boolean }>;
  hubAcceptTerms(payload: {
    brokerUrl?: string;
    termsVersion: string;
    privacyVersion: string;
  }): Promise<HubSessionStatus>;
  hubUpdateProfile(payload: {
    brokerUrl?: string;
    displayName?: string;
    publicHandle?: string;
    bio?: string;
    profileVisibility?: ProfileVisibility;
    socialLinks?: SocialLinks;
    showPublicTracks?: boolean;
  }): Promise<HubSessionStatus>;
  hubGetProfile(payload: {
    brokerUrl?: string;
    handle: string;
  }): Promise<PublicUserProfile>;
  hubSearchUsers(payload: {
    brokerUrl?: string;
    query: string;
    limit?: number;
  }): Promise<{ users: UserSearchItem[] }>;
  hubPublishPlaylist(payload: {
    brokerUrl?: string;
    shareId?: string;
    localPlaylistId?: string;
    name: string;
    description?: string;
    artwork?: string;
    visibility: PlaylistVisibility;
    collaborative: boolean;
    tracks: Track[];
  }): Promise<SharedPlaylistDetail>;
  hubMyPlaylists(payload?: { brokerUrl?: string }): Promise<MySharedPlaylistsResponse>;
  hubGetSharedPlaylist(payload: {
    brokerUrl?: string;
    shareId: string;
    sinceVersion?: number;
  }): Promise<SharedPlaylistDetail>;
  hubMutateSharedPlaylist(payload: {
    brokerUrl?: string;
    shareId: string;
    op: 'meta' | 'addTracks' | 'removeTrack' | 'reorder';
    expectedVersion: number;
    name?: string;
    description?: string;
    artwork?: string;
    visibility?: PlaylistVisibility;
    collaborative?: boolean;
    tracks?: Track[];
    trackId?: string;
    trackIds?: string[];
  }): Promise<SharedPlaylistDetail>;
  hubInviteCollaborator(payload: {
    brokerUrl?: string;
    shareId: string;
    handle: string;
  }): Promise<SharedPlaylistDetail>;
  hubRespondPlaylistInvite(payload: {
    brokerUrl?: string;
    shareId: string;
    accept: boolean;
  }): Promise<SharedPlaylistDetail | { ok: boolean }>;
  hubRemoveCollaborator(payload: {
    brokerUrl?: string;
    shareId: string;
    handle: string;
  }): Promise<SharedPlaylistDetail | { ok: boolean }>;
  hubPlusStatus?(payload?: { brokerUrl?: string }): Promise<LiquidPlusStatus>;
  hubVersionPolicy?(payload?: {
    brokerUrl?: string;
    clientVersion?: string;
    platform?: SupportedPlatform;
  }): Promise<VersionPolicyResponse>;
  hubLibraryPull(payload?: {
    brokerUrl?: string;
  }): Promise<{
    playlists: Playlist[];
    tracks: Track[];
    likes: string[];
    preferences?: Partial<Preferences>;
    updatedAt: number;
  }>;
  hubLibraryPush(payload: {
    brokerUrl?: string;
    playlists: Playlist[];
    tracks: Track[];
    likes: string[];
    preferences?: Partial<Preferences>;
  }): Promise<{ ok: boolean; updatedAt: number }>;
  offlineSource(id: string): Promise<{ url: string; duration: number } | null>;
  downloadOffline(track: Track): Promise<Snapshot>;
  removeOffline(id: string): Promise<Snapshot>;
  cancelDownload?(id: string): Promise<void>;
  offlineSummary?(): Promise<OfflineSummary>;
  onDownloadProgress?(callback: (event: DownloadProgressEvent) => void): () => void;
  cacheGet?<T = unknown>(key: string): Promise<DiscoveryCacheEntry<T> | null>;
  cacheSet?(entry: { key: string; signature: string; payload: unknown; ttlMs: number }): Promise<void>;
  openLyrics(): Promise<void>;
  closeLyrics(): Promise<void>;
  pinLyrics(pinned: boolean): Promise<{ pinned: boolean }>;
  updateStatus(
    install?: boolean,
  ): Promise<{
    configured: boolean;
    available: boolean;
    version: string;
    message: string;
    notes?: string;
    pubDate?: string;
    channel?: string;
    integrity?: string;
    downloadUrl?: string;
  }>;
  onUpdateProgress?(
    listener: (ev: { downloaded: number; total: number; percent: number }) => void,
  ): () => void;
  maintenanceStatus?(repair?: boolean): Promise<MaintenanceReport>;
  lyrics(track: Track): Promise<LyricsResult | null>;
  playlistArtwork(id: string): Promise<string | null>;
  trackArtwork(id: string): Promise<string | null>;
  bootstrap(): Promise<Snapshot>;
  library(command: LibraryCommand): Promise<Snapshot>;
  preferences(value: Preferences): Promise<Preferences>;
  search(request: SearchRequest): Promise<SearchResult>;
  discover(requestId: string): Promise<CatalogResult>;
  cancelSearch(id: string): Promise<void>;
  importAudio(): Promise<Snapshot>;
  resolveLink(url: string): Promise<Track>;
  linkPlayback(track: Track, requestId: string): Promise<Track>;
  resolveStream(
    track: Track,
    requestId: string,
    options?: {
      forceRefresh?: boolean;
      excludeIds?: string[];
      preferredProvider?: Exclude<StreamProvider, 'local'>;
    },
  ): Promise<StreamResolution>;
  streamCandidates(track: Track, requestId: string): Promise<StreamCandidate[]>;
  selectStreamCandidate(track: Track, candidate: StreamCandidate | null): Promise<Track>;
  exportLibrary(playlistId?: string): Promise<boolean>;
  importLibrary(): Promise<Snapshot | null>;
  integrations(): Promise<IntegrationStatus>;
  credentials(value: {
    youtubeKey?: string;
    brokerUrl?: string;
    brokerToken?: string;
  }): Promise<IntegrationStatus>;
  external(url: string): Promise<void>;
  playerUrl(): Promise<string>;
  audioSource(
    videoId: string,
    requestId: string,
    fallback?: {
      title?: string;
      artist?: string;
      duration?: number;
      isrc?: string;
      trackId?: string;
      forceRefresh?: boolean;
    },
  ): Promise<{ url: string; duration: number; videoId?: string; provider?: StreamProvider }>;
  window(action: 'minimize' | 'maximize' | 'close' | 'mini' | 'restore'): Promise<void>;
  visualState(): Promise<boolean>;
  windowShape(): Promise<{
    clippedDesktopBackdrop: boolean;
    systemBackdrop: number;
    backdropReadResult: number;
    nativeRegion: boolean;
    width: number;
    height: number;
    clientInsets: number[];
    corners: boolean[];
    center: boolean;
    sideMidpoints: boolean[];
    maximized: boolean;
    clientCorners: boolean[];
    frame: {
      caption: boolean;
      resizeStyle: boolean;
      extendedEdge: boolean;
      dwmBorderSuppressed: boolean;
    };
  }>;
  onVisualVisibility(callback: (visible: boolean) => void): () => void;
  onWindowMaximized?(callback: (maximized: boolean) => void): () => void;
  clearCache(): Promise<void>;
  checkUpdates(): Promise<string>;
  updateMediaMetadata?(track: {
    id: string;
    title: string;
    artist: string;
    album?: string;
    playing: boolean;
  }): Promise<void>;
  notify(track: {
    id?: string;
    title: string;
    artist: string;
    tag?: string;
    renotify?: boolean;
    silent?: boolean;
  }): Promise<void>;
  onMedia(callback: (command: MediaCommand) => void): () => void;
  consumeDeepLink(): Promise<string | null>;
  dispatchDeepLink(url: string): Promise<boolean>;
  onDeepLink(callback: (url: string) => void): () => void;
  onJamEvent(callback: (event: import('./jam').JamRealtimeEvent) => void): () => void;
}

declare global {
  interface Window {
    glass: GlassAPI;
  }
}
