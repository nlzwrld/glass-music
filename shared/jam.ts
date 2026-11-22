import type { Track } from './types';

/** Only public metadata and playback state leave the device; never audio or local paths. */
export type JamTransportMode = 'cloud' | 'lan' | 'lan-fallback';

export type JamRoomStatus = 'active' | 'full' | 'locked' | 'ended' | 'expired';

export type JamErrorCode =
  | 'INVITE_INVALID'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'ROOM_ENDED'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED'
  | 'AUTH_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'KICKED'
  | 'UNAVAILABLE';

export interface JamPlayback {
  track: Track | null;
  playing: boolean;
  position: number;
  updatedAt: number;
  sequence: number;
}

export interface JamMember {
  id: string;
  name: string;
  host: boolean;
  avatar?: string;
  online?: boolean;
  joinedAt?: number;
}

export interface JamQueueItem {
  id: string;
  track: Track;
  addedById: string;
  addedByName: string;
  addedAt: number;
}

export interface JamPlaylistRecommendation {
  id: string;
  name: string;
  trackCount: number;
  tracks: Track[];
  recommendedById: string;
  recommendedByName: string;
  recommendedAt: number;
}

export interface JamChatMessage {
  id: string;
  memberId: string;
  name: string;
  avatar?: string;
  text: string;
  sentAt: number;
}

export interface JamInvitePreview {
  roomId: string;
  code: string;
  roomName: string;
  hostName: string;
  hostAvatar?: string;
  participantCount: number;
  maxParticipants: number;
  status: JamRoomStatus;
  canJoin: boolean;
  reason?: string;
  requireAuth?: boolean;
  currentTrack?: Pick<Track, 'id' | 'title' | 'artist' | 'artwork' | 'source'> | null;
  playing?: boolean;
  inviteExpiresAt: number;
  createdAt: number;
  serverTime: number;
  endpoint?: string;
  mode?: JamTransportMode;
}

export interface JamInviteLookupResult {
  found: boolean;
  preview?: JamInvitePreview | null;
  error?: string;
  errorCode?: JamErrorCode;
}

export interface JamRoom {
  roomId: string;
  code: string;
  roomName: string;
  status: JamRoomStatus;
  locked?: boolean;
  requireAuth?: boolean;
  maxParticipants: number;
  inviteExpiresAt: number;
  createdAt: number;
  members: JamMember[];
  playback: JamPlayback;
  skipVotes?: string[];
  skipThreshold?: number;
  skipTriggeredAt?: number;
  jamQueue?: JamQueueItem[];
  recommendations?: JamPlaylistRecommendation[];
  messages?: JamChatMessage[];
  serverTime: number;
  unchanged?: boolean;
  echoClientTime?: number;
}

export interface JamSession extends JamRoom {
  token: string;
  memberId: string;
  host: boolean;
  clientId?: string;
  endpoint?: string;
  mode?: JamTransportMode;
  inviteUrl?: string;
  deepLinkUrl?: string;
}

export interface LanJamAnnouncement {
  roomId?: string;
  code: string;
  roomName?: string;
  endpoint: string;
  hostName: string;
  members: number;
  maxParticipants?: number;
  status?: JamRoomStatus;
  currentTrackTitle?: string;
  currentTrackArtist?: string;
  updatedAt: number;
}

export interface JamRealtimeEvent {
  event: 'state' | 'playback' | 'closed' | 'kicked' | 'stream_open' | 'stream_closed';
  room?: JamRoom;
  reason?: string;
  errorCode?: JamErrorCode;
  serverTime?: number;
}

export type JamAction =
  | 'create'
  | 'createLocal'
  | 'lookup'
  | 'join'
  | 'resume'
  | 'poll'
  | 'sync'
  | 'ping'
  | 'discoverLan'
  | 'rotateInvite'
  | 'updateRoom'
  | 'kick'
  | 'voteSkip'
  | 'queueAdd'
  | 'queueRemove'
  | 'recommendPlaylist'
  | 'chat'
  | 'subscribe'
  | 'unsubscribe'
  | 'leave';

export interface JamRequest {
  action: JamAction;
  code?: string;
  preferredCode?: string;
  token?: string;
  resumeToken?: string;
  name?: string;
  roomName?: string;
  avatar?: string;
  clientId?: string;
  memberId?: string;
  locked?: boolean;
  requireAuth?: boolean;
  inviteTtlMs?: number;
  endpoint?: string;
  nonce?: string;
  timestamp?: number;
  clientTime?: number;
  sinceSequence?: number;
  playback?: Pick<JamPlayback, 'track' | 'playing' | 'position'>;
  track?: Track;
  queueItemId?: string;
  message?: string;
  playlistName?: string;
  playlistTracks?: Track[];
}

export interface JamPingResponse {
  pong: true;
  serverTime: number;
  echoClientTime?: number;
}

export function normalizeJamCode(raw: string): string {
  const cleaned = raw.trim().replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z0-9]{6,16}$/.test(cleaned) ? cleaned : '';
}

export function jamPosition(playback: JamPlayback, serverTime: number) {
  const elapsed = playback.playing ? Math.max(0, (serverTime - playback.updatedAt) / 1000) : 0;
  const duration = playback.track?.duration || Number.POSITIVE_INFINITY;
  return Math.min(duration, Math.max(0, playback.position + elapsed));
}

/** Positive value means target room position is ahead of local audio element (in milliseconds). */
export function jamDriftMs(
  localPositionSeconds: number,
  playback: JamPlayback,
  calibratedServerNowMs: number,
): number {
  const expected = jamPosition(playback, calibratedServerNowMs);
  return (expected - localPositionSeconds) * 1000;
}

export function canJam(track?: Track | null): track is Track {
  return (
    !!track &&
    track.kind === 'track' &&
    ['youtube', 'link', 'soundcloud'].includes(track.source) &&
    track.available !== false
  );
}
