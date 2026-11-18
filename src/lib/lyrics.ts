import type { LyricsResult, Track } from '../../shared/types';

export interface LyricLine {
  time: number;
  text: string;
}

export function parseLRC(raw: string): LyricLine[] {
  const offset = Number(raw.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const lines: LyricLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const text = row
      .replace(/\[[^\]]*\]/g, '')
      .replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '')
      .trim();
    for (const stamp of stamps) {
      const seconds = Number(stamp[2]);
      if (seconds < 60) {
        lines.push({
          time: Math.max(0, Number(stamp[1]) * 60 + seconds - offset),
          text,
        });
      }
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function activeLyric(lines: LyricLine[], position: number): number {
  let low = 0,
    high = lines.length - 1,
    result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= position) {
      result = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return result;
}

export function hasValidLyrics(result: LyricsResult | null | undefined): boolean {
  if (!result || result.instrumental) return false;
  if (typeof result.syncedLyrics === 'string' && parseLRC(result.syncedLyrics).length > 0) {
    return true;
  }
  if (typeof result.plainLyrics === 'string' && result.plainLyrics.trim().length > 0) {
    return true;
  }
  return false;
}

const lyricsCache = new Map<string, LyricsResult | null>();
const inflightLyrics = new Map<string, Promise<LyricsResult | null>>();
let lastLyricsProviderFn: unknown = undefined;

export function clearLyricsCache() {
  lyricsCache.clear();
  inflightLyrics.clear();
}

export function trackLyricsKey(track: Pick<Track, 'id' | 'title' | 'artist' | 'duration'>): string {
  return `${track.id}|${track.title}|${track.artist}|${Math.round(track.duration || 0)}`;
}

export async function resolveTrackLyrics(
  track: Track | null | undefined,
  onlineAllowed: boolean,
): Promise<LyricsResult | null> {
  if (!track || !onlineAllowed || typeof window === 'undefined' || !window.glass?.lyrics) {
    return null;
  }
  // Automatically reset cache if window.glass.lyrics was replaced (e.g. E2E/unit test mocks)
  if (lastLyricsProviderFn !== window.glass.lyrics) {
    lastLyricsProviderFn = window.glass.lyrics;
    lyricsCache.clear();
    inflightLyrics.clear();
  }
  const key = trackLyricsKey(track);
  if (lyricsCache.has(key)) {
    return lyricsCache.get(key) ?? null;
  }
  const existing = inflightLyrics.get(key);
  if (existing) return existing;

  const request = window.glass
    .lyrics(track)
    .then(value => {
      const normalized = value ?? null;
      lyricsCache.set(key, normalized);
      if (lyricsCache.size > 120) {
        const oldest = lyricsCache.keys().next().value;
        if (oldest) lyricsCache.delete(oldest);
      }
      return normalized;
    })
    .finally(() => {
      inflightLyrics.delete(key);
    });

  inflightLyrics.set(key, request);
  return request;
}
