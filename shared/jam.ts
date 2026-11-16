import type { Track } from './types';

/** Only public metadata and playback state leave the device; never audio or local paths. */
export interface JamPlayback { track: Track | null; playing: boolean; position: number; updatedAt: number; sequence: number }
export interface JamMember { id: string; name: string; host: boolean }
export interface JamRoom { code: string; members: JamMember[]; playback: JamPlayback; serverTime: number }
export interface JamSession extends JamRoom { token: string; memberId: string; host: boolean; endpoint?:string }
export type JamAction = 'create' | 'createLocal' | 'join' | 'poll' | 'sync' | 'leave';
export interface JamRequest { action: JamAction; code?: string; token?: string; name?: string; endpoint?:string; playback?: Pick<JamPlayback,'track'|'playing'|'position'> }
export function jamPosition(playback: JamPlayback, serverTime: number) {
  const elapsed = playback.playing ? Math.max(0, (serverTime - playback.updatedAt) / 1000) : 0;
  const duration = playback.track?.duration || Number.POSITIVE_INFINITY;
  return Math.min(duration, Math.max(0, playback.position + elapsed));
}
export function canJam(track?: Track | null): track is Track {
  return !!track && track.kind === 'track' && ['youtube','link','soundcloud'].includes(track.source) && track.available !== false;
}
