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

export interface Playlist {
  artwork?: string;
  description?: string;
  id: string;
  name: string;
  createdAt: number;
  trackIds: string[];
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
  uiStyle?: 'matte' | 'glass';
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
}

export const defaults: Preferences = {
  uiStyle: 'matte',
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

export type SearchKind = 'all' | 'track' | 'artist' | 'playlist' | 'album' | 'lyrics';
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

export interface HubSessionStatus {
  authenticated: boolean;
  subject: string;
  expiresAt: number;
  brokerUrl: string;
  tokenActive?: boolean;
}

export interface CatalogResult {
  sections: { id: string; source: 'youtube' | 'soundcloud' | 'deezer'; title: string; items: Track[] }[];
  notices: string[];
}

export type LibraryCommand =
  | { action: 'like'; track: Track }
  | { action: 'save'; track: Track }
  | { action: 'history'; track: Track }
  | { action: 'create'; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'add'; id: string; track: Track }
  | { action: 'remove'; id: string; trackId: string }
  | { action: 'move'; id: string; targetId: string; trackId: string }
  | { action: 'reorder'; id: string; trackIds: string[] }
  | { action: 'removeTrack'; id: string }
  | { action: 'clearHistory' };

export type MediaCommand = 'playPause' | 'next' | 'previous' | 'pauseVideo';

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
  playlistMeta(id: string, meta: { artwork?: string; description?: string }): Promise<Snapshot>;
  accounts(): Promise<AccountStatus[]>;
  configureAccounts(): Promise<AccountStatus[]>;
  connectAccount(provider: string): Promise<AccountStatus[]>;
  disconnectAccount(provider: string): Promise<AccountStatus[]>;
  cancelAccount(): Promise<void>;
  syncAccount(
    provider: string,
  ): Promise<{ snapshot: Snapshot; playlists: number; tracks: number; accounts: AccountStatus[] }>;
  hubStatus(): Promise<HubSessionStatus>;
  hubLogin(payload: {
    brokerUrl: string;
    username: string;
    password: string;
    register?: boolean;
  }): Promise<HubSessionStatus>;
  hubLogout(): Promise<HubSessionStatus>;
  offlineSource(id: string): Promise<{ url: string; duration: number } | null>;
  downloadOffline(track: Track): Promise<Snapshot>;
  removeOffline(id: string): Promise<Snapshot>;
  openLyrics(): Promise<void>;
  closeLyrics(): Promise<void>;
  pinLyrics(pinned: boolean): Promise<{ pinned: boolean }>;
  updateStatus(
    install?: boolean,
  ): Promise<{ configured: boolean; available: boolean; version: string; message: string }>;
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
    fallback?: { title?: string; artist?: string; duration?: number; isrc?: string; trackId?: string },
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
