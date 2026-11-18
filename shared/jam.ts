import type { Track } from './types';

/** Only public metadata and playback state leave the device; never audio or local paths. */
export type JamTransportMode = 'cloud' | 'lan' | 'lan-fallback';

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
}

export interface JamRoom {
  code: string;
  members: JamMember[];
  playback: JamPlayback;
  serverTime: number;
  unchanged?: boolean;
  echoClientTime?: number;
}

export interface JamSession extends JamRoom {
  token: string;
  memberId: string;
  host: boolean;
  endpoint?: string;
  mode?: JamTransportMode;
}

export interface LanJamAnnouncement {
  code: string;
  endpoint: string;
  hostName: string;
  members: number;
  updatedAt: number;
}

export type JamAction =
  | 'create'
  | 'createLocal'
  | 'join'
  | 'poll'
  | 'sync'
  | 'ping'
  | 'discoverLan'
  | 'leave';

export interface JamRequest {
  action: JamAction;
  code?: string;
  preferredCode?: string;
  token?: string;
  name?: string;
  endpoint?: string;
  nonce?: string;
  timestamp?: number;
  clientTime?: number;
  sinceSequence?: number;
  playback?: Pick<JamPlayback, 'track' | 'playing' | 'position'>;
}

export interface JamPingResponse {
  pong: true;
  serverTime: number;
  echoClientTime?: number;
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
