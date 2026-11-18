import { invoke } from '@tauri-apps/api/core';
import type {
  JamPingResponse,
  JamRequest,
  JamRoom,
  JamSession,
  LanJamAnnouncement,
} from '../../shared/jam';
import { discoverLanJamRooms } from './discovery';

export type JamSend = <T>(request: JamRequest | { action: 'status' }) => Promise<T>;
export const sendJam: JamSend = request => invoke('call', { action: 'jam', payload: request });

export function generateJamNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function computeBackoffMs(
  attempt: number,
  baseMs = 600,
  maxMs = 12000,
  jitterRatio = 0.15,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(8, attempt)));
  const jitter = exp * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.min(maxMs, Math.round(exp + jitter)));
}

export function parseJamInvite(value: string, defaultEndpoint = '') {
  const clean = value.trim().replace(/\s/g, '');
  if (/^[A-F0-9]{10}$/i.test(clean)) return { code: clean.toUpperCase(), endpoint: defaultEndpoint };
  try {
    const url = new URL(clean),
      code = new URLSearchParams(url.hash.slice(1)).get('jam') || '';
    if (/^[A-F0-9]{10}$/i.test(code) && !url.username && !url.password && url.pathname === '/') {
      return { code: code.toUpperCase(), endpoint: url.origin };
    }
  } catch {}
  return { code: '', endpoint: '' };
}

/**
 * Clock sample uses the request midpoint; prefers low-RTT samples to reject queueing bias
 * and maintains millisecond RTT & jitter telemetry for Clock Drift Compensation.
 */
export class JamClock {
  offset = 0;
  rttMs = 0;
  jitterMs = 0;
  private best = Number.POSITIVE_INFINITY;

  sample(start: number, end: number, serverTime: number) {
    const roundTrip = Math.max(0, end - start),
      offset = serverTime - (start + end) / 2;
    if (!Number.isFinite(offset)) return;
    if (this.rttMs > 0) {
      this.jitterMs = this.jitterMs * 0.75 + Math.abs(roundTrip - this.rttMs) * 0.25;
    }
    this.rttMs = roundTrip;
    if (roundTrip <= this.best * 1.5) {
      this.offset = Number.isFinite(this.best) ? this.offset * 0.3 + offset * 0.7 : offset;
      this.best = Math.min(this.best, roundTrip);
    } else {
      this.best = Math.min(this.best * 1.1, roundTrip);
    }
  }

  now() {
    return Date.now() + this.offset;
  }

  reset() {
    this.offset = 0;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.best = Number.POSITIVE_INFINITY;
  }
}

export function isLocalJamEndpoint(endpoint?: string): boolean {
  if (!endpoint) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'http:';
  } catch {
    return false;
  }
}

export class JamClient {
  session: JamSession | null = null;
  readonly clock = new JamClock();
  private lastKnownName = 'Ouvinte';
  private lastSequence = -1;
  private cachedRoom: JamRoom | null = null;

  constructor(
    private send: JamSend = sendJam,
    private lanDiscovery: (code?: string) => Promise<LanJamAnnouncement[]> = discoverLanJamRooms,
  ) {}

  private stamp(request: JamRequest): JamRequest {
    const now = Date.now();
    return {
      ...request,
      nonce: request.nonce || generateJamNonce(),
      timestamp: request.timestamp ?? Math.round(this.clock.now()),
      clientTime: now,
    };
  }

  private async request<T extends { serverTime: number }>(request: JamRequest) {
    const stamped = this.stamp(request);
    const start = Date.now(),
      value = await this.send<T>(stamped);
    this.clock.sample(start, Date.now(), value.serverTime);
    return value;
  }

  async ping(endpoint?: string): Promise<number> {
    const targetEndpoint = endpoint ?? this.session?.endpoint;
    const start = Date.now();
    const res = await this.send<JamPingResponse>(
      this.stamp({ action: 'ping', endpoint: targetEndpoint }),
    );
    const end = Date.now();
    this.clock.sample(start, end, res.serverTime);
    return Math.max(0, end - start);
  }

  async enter(
    action: 'create' | 'createLocal' | 'join',
    name: string,
    code?: string,
    endpoint?: string,
  ) {
    this.clock.reset();
    this.lastSequence = -1;
    this.cachedRoom = null;
    this.lastKnownName = name || 'Ouvinte';
    const session = await this.request<JamSession>({ action, name, code, endpoint });
    session.mode =
      action === 'createLocal' || isLocalJamEndpoint(session.endpoint || endpoint)
        ? 'lan'
        : 'cloud';
    this.session = session;
    this.cachedRoom = session;
    this.lastSequence = session.playback.sequence;
    return session;
  }

  async update(playback?: JamRequest['playback']) {
    const s = this.session;
    if (!s) throw new Error('Entre em uma JAM.');
    const t = playback?.track,
      clean = t
        ? {
            id: t.id,
            source: t.source,
            sourceId: t.sourceId,
            kind: t.kind,
            title: t.title,
            artist: t.artist,
            duration: t.duration,
            url: t.url,
            artwork: t.artwork,
            playbackId: t.playbackId,
            addedAt: 0,
          }
        : null;
    const room = await this.request<JamRoom>({
      action: s.host ? 'sync' : 'poll',
      code: s.code,
      token: s.token,
      endpoint: s.endpoint,
      ...(!s.host && this.lastSequence >= 0 ? { sinceSequence: this.lastSequence } : {}),
      ...(s.host ? { playback: playback ? { ...playback, track: clean } : undefined } : {}),
    });
    if (room.unchanged && this.cachedRoom) {
      const merged: JamRoom = {
        ...room,
        playback: {
          ...room.playback,
          track: room.playback.track ?? this.cachedRoom.playback.track,
        },
      };
      this.cachedRoom = merged;
      return merged;
    }
    this.cachedRoom = room;
    this.lastSequence = room.playback.sequence;
    return room;
  }

  /**
   * Hybrid Cloud -> LAN Fallback:
   * - Host: automatically spins up the native LAN coordinator (`createLocal`) preserving room code & playback.
   * - Guest: scans LAN via UDP discovery for the matching room code and seamlessly rejoins on LAN.
   */
  async fallbackToLan(playback?: JamRequest['playback']): Promise<JamSession | null> {
    const current = this.session;
    if (!current || current.mode === 'lan' || current.mode === 'lan-fallback') return null;

    if (current.host) {
      const migrated = await this.request<JamSession>({
        action: 'createLocal',
        name: this.lastKnownName,
        preferredCode: current.code,
      });
      migrated.mode = 'lan-fallback';
      this.session = migrated;
      this.cachedRoom = migrated;
      this.lastSequence = migrated.playback.sequence;
      if (playback) {
        const synced = await this.update(playback);
        this.session = { ...migrated, playback: synced.playback, members: synced.members };
      }
      return this.session;
    }

    const matches = await this.lanDiscovery(current.code);
    const target = matches[0];
    if (!target?.endpoint) return null;
    const rejoined = await this.request<JamSession>({
      action: 'join',
      name: this.lastKnownName,
      code: target.code,
      endpoint: target.endpoint,
    });
    rejoined.mode = 'lan-fallback';
    this.session = rejoined;
    this.cachedRoom = rejoined;
    this.lastSequence = rejoined.playback.sequence;
    return rejoined;
  }

  async leave() {
    const s = this.session;
    this.session = null;
    this.cachedRoom = null;
    this.lastSequence = -1;
    if (s) {
      await this.request<{ serverTime: number }>({
        action: 'leave',
        code: s.code,
        token: s.token,
        endpoint: s.endpoint,
      });
    }
  }
}
