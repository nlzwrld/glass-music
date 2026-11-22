import type { CatalogResult, Snapshot, Track } from '../../shared/types';

export interface TasteProfile {
  seeds: Track[];
  artistWeights: Map<string, number>;
  topArtists: string[];
  signature: string;
}

function normalizeArtistKey(raw?: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*(feat\.|ft\.|&|,|x)\s.*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Builds a weighted listening taste profile from the user's most recently played tracks
 * (recency decay + repeat frequency + likes affinity).
 */
export function buildTasteProfile(
  data: Pick<Snapshot, 'tracks' | 'history' | 'likes'>,
  maxSeeds = 5,
): TasteProfile {
  const byId = new Map<string, Track>();
  for (const t of data.tracks) byId.set(t.id, t);

  const likeSet = new Set(data.likes);
  const trackScores = new Map<string, number>();
  const artistWeights = new Map<string, number>();
  const artistLabels = new Map<string, string>();

  const recentHistory = data.history.slice(0, 40);
  recentHistory.forEach((entry, index) => {
    const track = byId.get(entry.id);
    if (!track || track.kind !== 'track') return;
    const recencyWeight = 1 / (1 + index * 0.35);
    const likeBonus = likeSet.has(track.id) ? 0.5 : 0;
    const weight = recencyWeight + likeBonus;
    trackScores.set(track.id, (trackScores.get(track.id) || 0) + weight);

    const artistKey = normalizeArtistKey(track.artist);
    if (artistKey) {
      artistWeights.set(artistKey, (artistWeights.get(artistKey) || 0) + weight);
      if (!artistLabels.has(artistKey)) {
        artistLabels.set(artistKey, track.artist.replace(/\s*-\s*Topic$/i, '').trim());
      }
    }
  });

  // Fallback to liked tracks when history is empty
  if (trackScores.size === 0 && data.likes.length > 0) {
    data.likes.slice(0, 12).forEach((id, index) => {
      const track = byId.get(id);
      if (!track || track.kind !== 'track') return;
      const weight = 0.8 / (1 + index * 0.25);
      trackScores.set(track.id, weight);
      const artistKey = normalizeArtistKey(track.artist);
      if (artistKey) {
        artistWeights.set(artistKey, (artistWeights.get(artistKey) || 0) + weight);
        if (!artistLabels.has(artistKey)) {
          artistLabels.set(artistKey, track.artist.replace(/\s*-\s*Topic$/i, '').trim());
        }
      }
    });
  }

  const ranked = [...trackScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)!)
    .filter(Boolean);

  // Pick diverse top seeds (prefer distinct artists first, then fill up to maxSeeds)
  const seeds: Track[] = [];
  const usedArtists = new Set<string>();
  for (const t of ranked) {
    if (seeds.length >= maxSeeds) break;
    const key = normalizeArtistKey(t.artist);
    if (!key || !usedArtists.has(key)) {
      seeds.push(t);
      if (key) usedArtists.add(key);
    }
  }
  for (const t of ranked) {
    if (seeds.length >= maxSeeds) break;
    if (!seeds.some(s => s.id === t.id)) seeds.push(t);
  }

  const topArtists = [...artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key]) => artistLabels.get(key) || key);

  const signature = seeds.map(s => s.id).join(',');
  return { seeds, artistWeights, topArtists, signature };
}

/**
 * Re-ranks catalog items within each section by affinity to the user's recent listening history.
 */
export function rankCatalogByTaste(catalog: CatalogResult, profile: TasteProfile): CatalogResult {
  if (!profile.artistWeights.size) return catalog;
  return {
    ...catalog,
    sections: catalog.sections.map(section => ({
      ...section,
      items: [...section.items].sort((a, b) => {
        const wa = profile.artistWeights.get(normalizeArtistKey(a.artist)) || 0;
        const wb = profile.artistWeights.get(normalizeArtistKey(b.artist)) || 0;
        return wb - wa;
      }),
    })),
  };
}

let cachedPersonal: { signature: string; at: number; items: Track[] } | null = null;
const PERSONAL_TTL_MS = 10 * 60_000;

export async function fetchPersonalizedTracks(
  profile: TasteProfile,
  excludeIds: string[],
  force = false,
): Promise<Track[]> {
  if (!profile.seeds.length || !window.glass?.recommendations) return [];
  if (
    !force &&
    cachedPersonal &&
    cachedPersonal.signature === profile.signature &&
    Date.now() - cachedPersonal.at < PERSONAL_TTL_MS
  ) {
    return cachedPersonal.items;
  }
  try {
    const recs = await window.glass.recommendations(profile.seeds, excludeIds.slice(0, 40));
    const unique: Track[] = [];
    const seen = new Set<string>();
    for (const item of recs || []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push({ ...item, recommended: true });
    }
    if (unique.length) {
      cachedPersonal = { signature: profile.signature, at: Date.now(), items: unique };
    }
    return unique;
  } catch {
    return cachedPersonal?.items || [];
  }
}
