import type { CatalogResult, DiscoveryCacheEntry, Snapshot, Track } from '../../shared/types';
import { inferStyleTags, normalizePrimaryArtist } from './smartShuffle';

export interface TasteProfile {
  seeds: Track[];
  artistWeights: Map<string, number>;
  styleWeights: Map<string, number>;
  recentTrackIds: Set<string>;
  topArtists: string[];
  topStyles: string[];
  signature: string;
}

export interface CachedPersonalResult {
  items: Track[];
  signature: string;
  at: number;
  fresh: boolean;
}

export interface FetchPersonalizedOptions {
  force?: boolean;
  onRevalidated?: (items: Track[]) => void;
}

const PERSONAL_CACHE_KEY = 'personal-recommendations-v1';
const PERSONAL_LOCAL_KEY = 'glass:recommendations:v1';
const PERSONAL_TTL_MS = 10 * 60_000;
const PERSONAL_STALE_MAX_MS = 3 * 24 * 60 * 60_000;

function normalizeArtistKey(raw?: string): string {
  return normalizePrimaryArtist(raw);
}

/**
 * Builds a multi-horizon weighted listening taste profile balancing recent plays,
 * older listening history, liked tracks, and musical style diversity.
 */
export function buildTasteProfile(
  data: Pick<Snapshot, 'tracks' | 'history' | 'likes'>,
  maxSeeds = 6,
): TasteProfile {
  const byId = new Map<string, Track>();
  for (const t of data.tracks) byId.set(t.id, t);

  const likeSet = new Set(data.likes);
  const recentScores = new Map<string, number>();
  const olderScores = new Map<string, number>();
  const totalTrackScores = new Map<string, number>();
  const artistWeights = new Map<string, number>();
  const artistLabels = new Map<string, string>();
  const styleWeights = new Map<string, number>();
  const recentTrackIds = new Set<string>(data.history.slice(0, 15).map(h => h.id));

  const recentHistory = data.history.slice(0, 30);
  const olderHistory = data.history.slice(30, 250);

  recentHistory.forEach((entry, index) => {
    const track = byId.get(entry.id);
    if (!track || track.kind !== 'track') return;
    const recencyWeight = 1 / (1 + index * 0.32);
    const likeBonus = likeSet.has(track.id) ? 0.5 : 0;
    const weight = recencyWeight + likeBonus;
    recentScores.set(track.id, (recentScores.get(track.id) || 0) + weight);
    totalTrackScores.set(track.id, (totalTrackScores.get(track.id) || 0) + weight);

    const artistKey = normalizeArtistKey(track.artist);
    if (artistKey) {
      artistWeights.set(artistKey, (artistWeights.get(artistKey) || 0) + weight);
      if (!artistLabels.has(artistKey)) {
        artistLabels.set(artistKey, track.artist.replace(/\s*-\s*Topic$/i, '').trim());
      }
    }
    for (const style of inferStyleTags(track)) {
      styleWeights.set(style, (styleWeights.get(style) || 0) + weight);
    }
  });

  olderHistory.forEach((entry, offset) => {
    const track = byId.get(entry.id);
    if (!track || track.kind !== 'track') return;
    const weight = 0.55 / (1 + offset * 0.04);
    olderScores.set(track.id, (olderScores.get(track.id) || 0) + weight);
    totalTrackScores.set(track.id, (totalTrackScores.get(track.id) || 0) + weight * 0.75);

    const artistKey = normalizeArtistKey(track.artist);
    if (artistKey) {
      artistWeights.set(artistKey, (artistWeights.get(artistKey) || 0) + weight * 0.65);
      if (!artistLabels.has(artistKey)) {
        artistLabels.set(artistKey, track.artist.replace(/\s*-\s*Topic$/i, '').trim());
      }
    }
    for (const style of inferStyleTags(track)) {
      styleWeights.set(style, (styleWeights.get(style) || 0) + weight * 0.65);
    }
  });

  // Ensure likes contribute both as fallback seeds and as style/artist diversification
  data.likes.slice(0, 24).forEach((id, index) => {
    const track = byId.get(id);
    if (!track || track.kind !== 'track') return;
    const weight = 0.85 / (1 + index * 0.18);
    if (!recentScores.has(track.id)) {
      olderScores.set(track.id, (olderScores.get(track.id) || 0) + weight);
    }
    totalTrackScores.set(track.id, (totalTrackScores.get(track.id) || 0) + weight * 0.9);
    const artistKey = normalizeArtistKey(track.artist);
    if (artistKey) {
      artistWeights.set(artistKey, (artistWeights.get(artistKey) || 0) + weight * 0.7);
      if (!artistLabels.has(artistKey)) {
        artistLabels.set(artistKey, track.artist.replace(/\s*-\s*Topic$/i, '').trim());
      }
    }
    for (const style of inferStyleTags(track)) {
      styleWeights.set(style, (styleWeights.get(style) || 0) + weight * 0.7);
    }
  });

  const sortIds = (scoreMap: Map<string, number>) =>
    [...scoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => byId.get(id)!)
      .filter(Boolean);

  const rankedRecent = sortIds(recentScores);
  const rankedOlder = sortIds(olderScores);
  const rankedAll = sortIds(totalTrackScores);

  const seeds: Track[] = [];
  const usedIds = new Set<string>();
  const usedArtists = new Set<string>();
  const usedStyles = new Set<string>();

  const tryAddSeed = (t: Track, preferNewStyle: boolean): boolean => {
    if (seeds.length >= maxSeeds || usedIds.has(t.id)) return false;
    const artist = normalizeArtistKey(t.artist);
    const primaryStyle = inferStyleTags(t)[0] || '';
    if (artist && usedArtists.has(artist)) return false;
    if (preferNewStyle && primaryStyle && usedStyles.has(primaryStyle)) return false;
    seeds.push(t);
    usedIds.add(t.id);
    if (artist) usedArtists.add(artist);
    if (primaryStyle) usedStyles.add(primaryStyle);
    return true;
  };

  // 1. Up to 3 distinct recent artists (favoring distinct musical styles)
  const recentCap = Math.min(maxSeeds, Math.max(1, Math.ceil(maxSeeds / 2)));
  for (const t of rankedRecent) {
    if (seeds.length >= recentCap) break;
    tryAddSeed(t, true);
  }
  for (const t of rankedRecent) {
    if (seeds.length >= recentCap) break;
    tryAddSeed(t, false);
  }

  // 2. Up to 2 distinct artists/styles from older history & likes to avoid 1-style monotony
  for (const t of rankedOlder) {
    if (seeds.length >= Math.min(maxSeeds, recentCap + 2)) break;
    tryAddSeed(t, true);
  }
  for (const t of rankedOlder) {
    if (seeds.length >= Math.min(maxSeeds, recentCap + 2)) break;
    tryAddSeed(t, false);
  }

  // 3. Fill remaining capacity by overall weighted taste
  for (const t of rankedAll) {
    if (seeds.length >= maxSeeds) break;
    if (!tryAddSeed(t, false) && !usedIds.has(t.id)) {
      seeds.push(t);
      usedIds.add(t.id);
    }
  }

  const topArtists = [...artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key]) => artistLabels.get(key) || key);

  const topStyles = [...styleWeights.entries()]
    .filter(([k]) => !k.startsWith('album:') && !k.startsWith('artist:') && !k.startsWith('source:'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key]) => key);

  const historyBucket =
    data.history.length < 500
      ? Math.floor(data.history.length / 3)
      : Math.floor((data.history[0]?.playedAt || 0) / (15 * 60_000));
  const signature = `${seeds.map(s => s.id).join(',')}::h${historyBucket}:l${data.likes.length}`;
  return {
    seeds,
    artistWeights,
    styleWeights,
    recentTrackIds,
    topArtists,
    topStyles,
    signature,
  };
}

function diversifySectionOrder(tracks: Track[]): Track[] {
  if (tracks.length <= 2) return tracks;
  const remaining = [...tracks];
  const ordered: Track[] = [];
  while (remaining.length > 0) {
    const prev1 = ordered[ordered.length - 1]
      ? normalizeArtistKey(ordered[ordered.length - 1]!.artist)
      : '';
    const prev2 = ordered[ordered.length - 2]
      ? normalizeArtistKey(ordered[ordered.length - 2]!.artist)
      : '';
    let pickIdx = remaining.findIndex(t => {
      const a = normalizeArtistKey(t.artist);
      return !a || (a !== prev1 && a !== prev2);
    });
    if (pickIdx < 0) pickIdx = 0;
    ordered.push(remaining.splice(pickIdx, 1)[0]!);
  }
  return ordered;
}

/**
 * Re-ranks catalog items within each section by affinity to recent + historical taste,
 * style diversity, and recency cooldown so the same track/artist doesn't dominate every row.
 */
export function rankCatalogByTaste(catalog: CatalogResult, profile: TasteProfile): CatalogResult {
  if (!profile.artistWeights.size && !profile.styleWeights.size) return catalog;
  return {
    ...catalog,
    sections: catalog.sections.map(section => {
      const scored = [...section.items].sort((a, b) => {
        const scoreItem = (t: Track) => {
          const aw = profile.artistWeights.get(normalizeArtistKey(t.artist)) || 0;
          const sw = inferStyleTags(t).reduce(
            (best, tag) => Math.max(best, profile.styleWeights.get(tag) || 0),
            0,
          );
          const recentPenalty = profile.recentTrackIds.has(t.id) ? 0.25 : 1;
          return (aw + sw * 0.35) * recentPenalty;
        };
        return scoreItem(b) - scoreItem(a);
      });
      return {
        ...section,
        items: diversifySectionOrder(scored),
      };
    }),
  };
}

let cachedPersonal: { signature: string; at: number; expiresAt: number; items: Track[] } | null =
  null;
const inFlightPersonal = new Map<string, Promise<Track[]>>();
let personalSeq = 0;
let activeTargetSignature = '';

function readLocalPersonalCache():
  | { signature: string; at: number; expiresAt: number; items: Track[] }
  | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PERSONAL_LOCAL_KEY);
    if (!raw || raw.length > 500_000) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.signature === 'string' &&
      typeof parsed?.at === 'number' &&
      Array.isArray(parsed?.items) &&
      Date.now() - parsed.at <= PERSONAL_STALE_MAX_MS
    ) {
      return {
        signature: parsed.signature,
        at: parsed.at,
        expiresAt:
          typeof parsed.expiresAt === 'number' ? parsed.expiresAt : parsed.at + PERSONAL_TTL_MS,
        items: parsed.items,
      };
    }
  } catch {
    // Ignore storage quota / sandbox failures
  }
  return null;
}

function writeLocalPersonalCache(entry: {
  signature: string;
  at: number;
  expiresAt: number;
  items: Track[];
}) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PERSONAL_LOCAL_KEY, JSON.stringify(entry));
    }
  } catch {
    // Storage may be disabled; memory + SQLite caching still active
  }
}

export async function loadCachedPersonalRecommendations(
  expectedSignature?: string,
): Promise<CachedPersonalResult | null> {
  const now = Date.now();
  const evaluate = (entry: {
    signature: string;
    at: number;
    expiresAt: number;
    items: Track[];
  }): CachedPersonalResult | null => {
    if (!entry.items.length || now - entry.at > PERSONAL_STALE_MAX_MS) return null;
    const sameSig = expectedSignature ? entry.signature === expectedSignature : true;
    const withinTtl = now < entry.expiresAt && now - entry.at < PERSONAL_TTL_MS;
    return {
      items: entry.items,
      signature: entry.signature,
      at: entry.at,
      fresh: sameSig && withinTtl,
    };
  };

  if (cachedPersonal) {
    const res = evaluate(cachedPersonal);
    if (res) return res;
  }

  if (typeof window !== 'undefined' && typeof window.glass?.cacheGet === 'function') {
    try {
      const dbEntry = (await window.glass.cacheGet<Track[]>(
        PERSONAL_CACHE_KEY,
      )) as DiscoveryCacheEntry<Track[]> | null;
      if (dbEntry && Array.isArray(dbEntry.payload) && dbEntry.payload.length) {
        cachedPersonal = {
          signature: dbEntry.signature,
          at: dbEntry.updatedAt,
          expiresAt: dbEntry.expiresAt,
          items: dbEntry.payload,
        };
        const res = evaluate(cachedPersonal);
        if (res) return res;
      }
    } catch {
      // Fallback to localStorage below
    }
  }

  const localEntry = readLocalPersonalCache();
  if (localEntry) {
    cachedPersonal = localEntry;
    return evaluate(localEntry);
  }
  return null;
}

export function clearRecommendationsCache(): void {
  personalSeq++;
  cachedPersonal = null;
  activeTargetSignature = '';
  inFlightPersonal.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PERSONAL_LOCAL_KEY);
  } catch {}
}

export async function fetchPersonalizedTracks(
  profile: TasteProfile,
  excludeIds: string[],
  forceOrOptions: boolean | FetchPersonalizedOptions = false,
): Promise<Track[]> {
  if (!profile.seeds.length || typeof window === 'undefined' || !window.glass?.recommendations) {
    return [];
  }
  const opts: FetchPersonalizedOptions =
    typeof forceOrOptions === 'boolean' ? { force: forceOrOptions } : forceOrOptions;
  const force = !!opts.force;

  activeTargetSignature = profile.signature;
  const existing = !force ? await loadCachedPersonalRecommendations(profile.signature) : null;
  if (existing?.fresh) {
    return existing.items;
  }

  const startFetch = (): Promise<Track[]> => {
    const flightKey = `${profile.signature}${force ? ':force' : ''}`;
    const existingFlight = inFlightPersonal.get(flightKey);
    if (existingFlight) return existingFlight;

    const seq = ++personalSeq;
    const requestedSignature = profile.signature;
    const promise = (async () => {
      try {
        const recs = await window.glass.recommendations(profile.seeds, excludeIds.slice(0, 40));
        // Protect against stale responses resolved after a newer request or profile change
        if (seq !== personalSeq || activeTargetSignature !== requestedSignature) {
          return cachedPersonal?.items || [];
        }
        const unique: Track[] = [];
        const seen = new Set<string>();
        for (const item of recs || []) {
          if (!item?.id || seen.has(item.id)) continue;
          seen.add(item.id);
          unique.push({ ...item, recommended: true });
        }
        if (unique.length) {
          const now = Date.now();
          const entry = {
            signature: requestedSignature,
            at: now,
            expiresAt: now + PERSONAL_TTL_MS,
            items: unique,
          };
          cachedPersonal = entry;
          writeLocalPersonalCache(entry);
          if (typeof window.glass?.cacheSet === 'function') {
            void window.glass
              .cacheSet({
                key: PERSONAL_CACHE_KEY,
                signature: requestedSignature,
                payload: unique,
                ttlMs: PERSONAL_TTL_MS,
              })
              .catch(() => {});
          }
          opts.onRevalidated?.(unique);
        }
        return unique;
      } catch {
        return existing?.items || cachedPersonal?.items || [];
      }
    })();
    promise.finally(() => {
      if (inFlightPersonal.get(flightKey) === promise) {
        inFlightPersonal.delete(flightKey);
      }
    });
    inFlightPersonal.set(flightKey, promise);
    return promise;
  };

  if (existing && existing.items.length > 0 && opts.onRevalidated) {
    // Stale-while-revalidate: deliver cached results immediately, refresh in background
    void startFetch();
    return existing.items;
  }

  return startFetch();
}
