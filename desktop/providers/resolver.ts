import { createHash } from 'node:crypto';
import {
  inferCatalogSource,
  trackDurationMs,
  type MusicProvider,
  type StreamCandidate,
  type StreamProvider,
  type StreamResolution,
  type Track,
} from '../../shared/types.ts';
import { artworkUrl } from '../../shared/validation.ts';

export type ResolvedStreamProvider = Exclude<StreamProvider, 'local'>;

export interface CachedStreamMapping {
  sourceTrackId: string;
  catalogSource: string;
  resolvedProvider: ResolvedStreamProvider;
  resolvedId: string;
  resolvedUrl?: string;
  durationDeltaMs: number;
  score: number;
  updatedAt: number;
}

export interface StreamMappingStore {
  get(key: string): CachedStreamMapping | undefined | Promise<CachedStreamMapping | undefined>;
  set(entry: CachedStreamMapping): void | Promise<void>;
  invalidate(key: string): void | Promise<void>;
}

export class MemoryStreamMappingStore implements StreamMappingStore {
  private readonly entries = new Map<string, CachedStreamMapping>();
  constructor(private readonly ttlMs = 14 * 24 * 60 * 60 * 1000) {}

  get(key: string): CachedStreamMapping | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    if (Date.now() - found.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return found;
  }

  set(entry: CachedStreamMapping) {
    if (this.entries.size >= 4096) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(entry.sourceTrackId, entry);
  }

  invalidate(key: string) {
    this.entries.delete(key);
  }
}

const NOISE_WORDS = new Set([
  'official',
  'audio',
  'video',
  'music',
  'lyrics',
  'lyric',
  'hd',
  '4k',
  'hq',
  'remastered',
  'remaster',
  'oficial',
  'clipe',
  'topic',
  'vevo',
  'visualizer',
  'feat',
  'ft',
  'explicit',
  'clean',
]);

const FORBIDDEN_SINGLE_WORDS = [
  'live',
  'cover',
  'tribute',
  'remix',
  'slowed',
  'reverb',
  'karaoke',
  'instrumental',
  'nightcore',
  'acoustic',
  'acustico',
  'parody',
  'parodia',
] as const;

const FORBIDDEN_PHRASES = [
  'ao vivo',
  'sped up',
  'bass boosted',
  '8d audio',
  'karaoke version',
] as const;

export function normalizeAsciiLower(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function stripEditionSuffix(raw: string): string {
  let out = raw;
  for (const sep of [' - ', ' (', ' [']) {
    const idx = out.indexOf(sep);
    if (idx > 0) {
      const right = out.slice(idx + sep.length).toLowerCase();
      if (
        [
          'deluxe',
          'remaster',
          'bonus',
          'radio edit',
          'version',
          'versao',
          'versão',
          'explicit',
          'clean',
          'mono',
          'stereo',
          'feat.',
          'ft.',
        ].some(tag => right.includes(tag))
      ) {
        out = out.slice(0, idx);
      }
    }
  }
  return out.trim();
}

export function extractMatchTokens(raw: string): string[] {
  const withoutFeat = raw.split(/\s*(?:\(|\[)?(?:feat\.|ft\.)/i)[0] || raw;
  return normalizeAsciiLower(withoutFeat)
    .split(/\s+/)
    .filter(w => w.length > 0 && !NOISE_WORDS.has(w));
}

export function primaryArtistName(artist: string): string {
  const first = artist.split(/[,&;/]/)[0]?.trim();
  return first || artist.trim();
}

export function buildResolverQuery(
  track: Pick<Track, 'title' | 'artist' | 'isrc'>,
): string {
  const cleanTitle = stripEditionSuffix(track.title);
  const artist = ['Spotify', 'Deezer', 'Apple Music', 'Tidal', 'Bandcamp'].includes(track.artist)
    ? ''
    : primaryArtistName(track.artist);
  return artist ? `${artist} - ${cleanTitle} Audio` : `${cleanTitle} Audio`;
}

export function canonicalMappingKey(track: Pick<Track, 'id' | 'url'>): string {
  if (track.url) {
    try {
      const u = new URL(track.url);
      if (u.hostname === 'open.spotify.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('track');
        const spId = idx >= 0 ? parts[idx + 1] : undefined;
        if (spId && /^[A-Za-z0-9]{22}$/.test(spId)) {
          return `spotify:track:${spId}`;
        }
      }
    } catch {}
  }
  return track.id;
}

function tokenCoverage(wanted: string[], available: string[]): number {
  if (!wanted.length) return 0;
  let hits = 0;
  for (const w of wanted) {
    if (available.includes(w)) hits++;
  }
  return hits / wanted.length;
}

function hasUnrequestedModifier(referenceRaw: string, candidateRaw: string): boolean {
  const refNorm = ` ${normalizeAsciiLower(referenceRaw)} `;
  const candNorm = ` ${normalizeAsciiLower(candidateRaw)} `;
  for (const phrase of FORBIDDEN_PHRASES) {
    if (candNorm.includes(` ${phrase} `) && !refNorm.includes(` ${phrase} `)) {
      return true;
    }
  }
  const refWords = new Set(refNorm.trim().split(/\s+/).filter(Boolean));
  const candWords = candNorm.trim().split(/\s+/).filter(Boolean);
  for (const word of FORBIDDEN_SINGLE_WORDS) {
    if (candWords.includes(word) && !refWords.has(word)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates a candidate stream against the reference catalog track on a 0–100 scale:
 * 1. Critical Duration Delta (up to 40 pts; <= 2s = 40 pts, > 10s heavily penalized, > 18s or 30s preview = 0).
 * 2. Title & Artist Fidelity (up to 45 pts; rejects unrequested Live/Ao Vivo/Cover/Remix/Slowed/Reverb/Karaoke/Instrumental).
 * 3. Official Channel / Topic / ISRC Bonus (up to 15 pts).
 */
export function scoreStreamCandidate(
  reference: Pick<Track, 'title' | 'artist' | 'duration' | 'durationMs' | 'isrc'>,
  candidate: {
    provider: ResolvedStreamProvider;
    id: string;
    title: string;
    artist: string;
    duration: number;
    durationMs?: number;
    isrc?: string;
    url?: string;
    isOfficialTopic?: boolean;
  },
): number {
  const refMs = trackDurationMs(reference);
  const candMs =
    typeof candidate.durationMs === 'number' && candidate.durationMs > 0
      ? Math.round(candidate.durationMs)
      : Math.max(0, Math.round((candidate.duration || 0) * 1000));

  const refSec = refMs / 1000;
  const candSec = candMs / 1000;

  // Reject 30s DRM previews, broken 0s streams (when reference has known duration), or huge delta (>18s)
  if (refSec > 45 && candSec > 0 && candSec <= 35) return 0;
  if (refSec > 0 && candSec <= 0) return 0;

  let durationScore = 22;
  if (refSec > 0 && candSec > 0) {
    const deltaSec = Math.abs(refSec - candSec);
    if (deltaSec > Math.max(18, refSec * 0.12)) return 0;
    if (deltaSec <= 2) {
      durationScore = 40;
    } else if (deltaSec <= 5) {
      durationScore = 40 - ((deltaSec - 2) / 3) * 10; // 40 -> 30
    } else if (deltaSec <= 10) {
      durationScore = 30 - ((deltaSec - 5) / 5) * 15; // 30 -> 15
    } else {
      // > 10s difference: heavy penalty!
      durationScore = Math.max(-25, 5 - (deltaSec - 10) * 3.5);
    }
  }

  // Unrequested version check (Live, Ao Vivo, Cover, Remix, Slowed, Reverb, Karaoke, Instrumental...)
  const refCombined = `${reference.title} ${reference.artist}`;
  const candCombined = `${candidate.title} ${candidate.artist}`;
  if (hasUnrequestedModifier(refCombined, candCombined)) {
    return 0;
  }

  const refTitleTokens = extractMatchTokens(stripEditionSuffix(reference.title));
  const candTitleTokens = extractMatchTokens(candidate.title);
  const candArtistTokens = extractMatchTokens(candidate.artist.replace(/ - Topic$/i, ''));
  const candAllTokens = [...candTitleTokens, ...candArtistTokens];

  const titleCov = tokenCoverage(refTitleTokens, candAllTokens);
  if (titleCov < 0.55) return 0;

  let artistCov = 0.6;
  if (!['Spotify', 'Deezer', 'Apple Music', 'Tidal', 'Bandcamp'].includes(reference.artist)) {
    const fullTokens = extractMatchTokens(reference.artist);
    const primTokens = extractMatchTokens(primaryArtistName(reference.artist));
    artistCov = Math.max(
      tokenCoverage(fullTokens, candAllTokens),
      tokenCoverage(primTokens, candAllTokens) * 0.95,
    );
    if (artistCov < 0.45 && titleCov < 0.9) return 0;
  }

  const fidelityScore = titleCov * 27 + artistCov * 18;

  // Official / Topic / ISRC / Provider priority bonus (up to 15 pts)
  const rawArtistLower = candidate.artist.toLowerCase();
  const rawTitleLower = candidate.title.toLowerCase();
  const isTopic =
    Boolean(candidate.isOfficialTopic) ||
    rawArtistLower.endsWith(' - topic') ||
    candidate.provider === 'ytmusic';
  const isOfficialAudio =
    rawTitleLower.includes('official audio') ||
    rawTitleLower.includes('audio oficial') ||
    rawTitleLower.includes('áudio oficial');
  const isMusicVideo =
    rawTitleLower.includes('official video') ||
    rawTitleLower.includes('music video') ||
    rawTitleLower.includes('clipe oficial');

  const isrcMatch =
    Boolean(reference.isrc && candidate.isrc) &&
    reference.isrc!.replace(/-/g, '').toUpperCase() ===
      candidate.isrc!.replace(/-/g, '').toUpperCase();

  let bonus = 0;
  if (isrcMatch) bonus += 15;
  else if (isTopic) bonus += 12;
  else if (isOfficialAudio) bonus += 9;

  bonus +=
    candidate.provider === 'ytmusic'
      ? 3
      : candidate.provider === 'deezer'
        ? 2.5
        : candidate.provider === 'soundcloud'
          ? 2
          : 1;

  if (isMusicVideo && !isTopic && !isOfficialAudio) {
    bonus -= 4;
  }

  const total = Math.round((durationScore + fidelityScore + Math.min(15, bonus)) * 10) / 10;
  return Math.max(0, Math.min(100, total));
}

function parseSpotifyEntityJson(html: string, expectedKind: string, expectedId: string): any {
  const marker = '<script id="__NEXT_DATA__"';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('Metadados do Spotify indisponíveis.');
  const openEnd = html.indexOf('>', start);
  const closeStart = html.indexOf('</script>', openEnd);
  if (openEnd < 0 || closeStart < 0) throw new Error('Metadados do Spotify inválidos.');
  const parsed = JSON.parse(html.slice(openEnd + 1, closeStart));
  const entity = parsed?.props?.pageProps?.state?.data?.entity;
  if (!entity || entity.id !== expectedId || entity.type !== expectedKind) {
    throw new Error('Entidade do Spotify inválida.');
  }
  return entity;
}

function buildSpotifyTrack(entity: any, fallbackAlbum?: string, fallbackArtwork?: string): Track | null {
  const spId =
    typeof entity?.id === 'string'
      ? entity.id
      : typeof entity?.uri === 'string' && entity.uri.startsWith('spotify:track:')
        ? entity.uri.slice('spotify:track:'.length)
        : '';
  if (!/^[A-Za-z0-9]{22}$/.test(spId)) return null;
  const title = String(entity.name || entity.title || '').trim();
  if (!title) return null;
  const artistList = Array.isArray(entity.artists)
    ? entity.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
    : '';
  const artist = artistList || String(entity.subtitle || 'Spotify').trim() || 'Spotify';
  const durationMs = Math.max(0, Math.round(Number(entity.duration_ms ?? entity.duration ?? 0)));
  const duration = durationMs / 1000;
  const canonicalUrl = `https://open.spotify.com/track/${spId}`;
  const hash = createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 32);
  const rawArt =
    entity.album?.images?.[0]?.url ||
    entity.albumOfTrack?.coverArt?.sources?.[0]?.url ||
    entity.coverArt?.sources?.[0]?.url ||
    entity.visualIdentity?.image?.[0]?.url ||
    fallbackArtwork ||
    '';
  const album = String(entity.album?.name || entity.albumOfTrack?.name || fallbackAlbum || '').trim();
  const isrc = entity.external_ids?.isrc || entity.externalIds?.isrc;

  const track: Track = {
    id: `link:${hash}`,
    source: 'link',
    sourceId: hash,
    kind: 'track',
    title,
    artist,
    duration,
    durationMs,
    catalogSource: 'spotify',
    url: canonicalUrl,
    addedAt: Date.now(),
    ...(album ? { album } : {}),
    ...(rawArt && artworkUrl(rawArt) ? { artwork: rawArt } : {}),
    ...(typeof isrc === 'string' && /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i.test(isrc)
      ? { isrc: isrc.toUpperCase() }
      : {}),
  };
  return track;
}

/**
 * Imports rich metadata from Spotify (`track`, `playlist`, `album`) WITHOUT ever attempting
 * direct DRM audio extraction from Spotify. Audio is resolved strictly via CrossPlatformResolver.
 */
export async function importSpotifyMetadata(
  rawUrl: string,
  request: typeof fetch = fetch,
): Promise<{ kind: 'track' | 'playlist' | 'album'; name: string; artwork?: string; tracks: Track[] }> {
  const u = new URL(rawUrl);
  if (u.protocol !== 'https:' || u.hostname !== 'open.spotify.com') {
    throw new Error('Use um link HTTPS válido de open.spotify.com.');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const kindIdx = parts.findIndex(p => ['track', 'playlist', 'album'].includes(p));
  if (kindIdx < 0) throw new Error('Use um link de faixa, playlist ou álbum do Spotify.');
  const kind = parts[kindIdx] as 'track' | 'playlist' | 'album';
  const spId = parts[kindIdx + 1] || '';
  if (!/^[A-Za-z0-9]{22}$/.test(spId)) throw new Error('Identificador do Spotify inválido.');

  const embedRes = await request(`https://open.spotify.com/embed/${kind}/${spId}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!embedRes.ok) throw new Error('Não foi possível consultar os metadados públicos do Spotify.');
  const html = await embedRes.text();
  const entity = parseSpotifyEntityJson(html, kind, spId);

  const coverCandidate =
    entity.coverArt?.sources?.[0]?.url ||
    entity.visualIdentity?.image?.[0]?.url ||
    entity.images?.[0]?.url ||
    '';
  const artwork = coverCandidate && artworkUrl(coverCandidate) ? coverCandidate : undefined;

  if (kind === 'track') {
    const single = buildSpotifyTrack(entity, undefined, artwork);
    if (!single) throw new Error('Faixa do Spotify inválida.');
    return { kind: 'track', name: single.title, artwork: single.artwork, tracks: [single] };
  }

  const name = String(entity.name || entity.title || 'Spotify').trim();
  const rows: any[] = Array.isArray(entity.trackList) ? entity.trackList : [];
  const tracks = rows
    .slice(0, 1000)
    .map(row =>
      buildSpotifyTrack(
        row,
        kind === 'album' ? name : undefined,
        kind === 'album' ? artwork : undefined,
      ),
    )
    .filter((t): t is Track => t !== null);

  if (!tracks.length) {
    throw new Error('Nenhuma faixa pública disponível nesta coleção do Spotify.');
  }
  return { kind, name, artwork, tracks };
}

export interface StreamCandidateSource {
  id: ResolvedStreamProvider;
  searchTracks(
    query: string,
    reference: Track,
    signal: AbortSignal,
  ): Promise<
    Array<{
      id: string;
      title: string;
      artist: string;
      duration: number;
      durationMs?: number;
      url?: string;
      artwork?: string;
      isrc?: string;
      isOfficialTopic?: boolean;
    }>
  >;
  resolveStreamUrl(
    candidate: StreamCandidate,
    signal: AbortSignal,
  ): Promise<{ streamUrl: string; duration: number }>;
}

const PROVIDER_ORDER: Record<ResolvedStreamProvider, number> = {
  ytmusic: 0,
  deezer: 1,
  soundcloud: 2,
  youtube: 3,
};

export function adaptMusicProviderToStreamSource(
  provider: MusicProvider,
  extractStream?: (
    providerId: ResolvedStreamProvider,
    candidate: StreamCandidate,
    signal: AbortSignal,
  ) => Promise<{ streamUrl: string; duration: number }>,
): StreamCandidateSource {
  const providerId = (provider.id === 'local' ? 'youtube' : provider.id) as ResolvedStreamProvider;
  return {
    id: providerId,
    async searchTracks(query, _reference, signal) {
      const res = await provider.search(
        {
          query,
          kind: 'track',
          source: provider.id as any,
          requestId: `resolve-${Date.now()}`,
        },
        signal,
      );
      return res.items
        .filter(item => item.kind === 'track' && item.available !== false)
        .map(item => ({
          id: item.sourceId,
          title: item.title,
          artist: item.artist,
          duration: item.duration,
          durationMs: item.durationMs,
          url: item.url,
          artwork: item.artwork,
          isrc: item.isrc,
          isOfficialTopic:
            providerId === 'ytmusic' || item.artist.toLowerCase().endsWith(' - topic'),
        }));
    },
    async resolveStreamUrl(candidate, signal) {
      if (extractStream) {
        return extractStream(providerId, candidate, signal);
      }
      if (!candidate.url) {
        throw new Error(`Stream URL ausente para ${providerId}:${candidate.id}`);
      }
      return { streamUrl: candidate.url, duration: candidate.duration };
    },
  };
}

export class CrossPlatformResolver {
  private readonly store: StreamMappingStore;

  constructor(
    private readonly sources: StreamCandidateSource[],
    store?: StreamMappingStore,
    private readonly minScore = 55,
  ) {
    this.store = store ?? new MemoryStreamMappingStore();
  }

  async searchCandidates(track: Track, signal = new AbortController().signal): Promise<StreamCandidate[]> {
    // Never query Spotify for audio streams — strictly query active stream providers in parallel.
    const query = buildResolverQuery(track);
    const refMs = trackDurationMs(track);

    const settled = await Promise.allSettled(
      this.sources.map(async src => {
        const items = await src.searchTracks(query, track, signal);
        return items.map(raw => {
          const isTopic =
            Boolean(raw.isOfficialTopic) || raw.artist.toLowerCase().endsWith(' - topic');
          const effectiveProvider: ResolvedStreamProvider =
            src.id === 'youtube' && isTopic ? 'ytmusic' : src.id;
          const candMs =
            typeof raw.durationMs === 'number' && raw.durationMs > 0
              ? Math.round(raw.durationMs)
              : Math.round((raw.duration || 0) * 1000);
          const score = scoreStreamCandidate(track, {
            provider: effectiveProvider,
            id: raw.id,
            title: raw.title,
            artist: raw.artist,
            duration: raw.duration,
            durationMs: candMs,
            isrc: raw.isrc,
            url: raw.url,
            isOfficialTopic: isTopic,
          });
          const candidate: StreamCandidate = {
            provider: effectiveProvider,
            id: raw.id,
            title: raw.title,
            artist: raw.artist,
            duration: raw.duration,
            durationMs: candMs,
            durationDeltaMs: refMs > 0 ? Math.abs(refMs - candMs) : 0,
            score,
            url: raw.url,
            artwork: raw.artwork,
            isrc: raw.isrc,
            isOfficialTopic: isTopic,
          };
          return candidate;
        });
      }),
    );

    const allCandidates: StreamCandidate[] = [];
    const seen = new Set<string>();
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const c of r.value) {
        if (c.score < this.minScore) continue;
        const dedup = `${c.provider}:${c.id}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        allCandidates.push(c);
      }
    }

    allCandidates.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.5) return b.score - a.score;
      return PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider];
    });
    return allCandidates;
  }

  async resolveStream(
    track: Track,
    options: {
      forceRefresh?: boolean;
      excludeIds?: string[];
      preferredProvider?: ResolvedStreamProvider;
      signal?: AbortSignal;
    } = {},
  ): Promise<StreamResolution> {
    const signal = options.signal ?? new AbortController().signal;
    const excluded = new Set(options.excludeIds || []);
    const key = canonicalMappingKey(track);
    const catalogSource = inferCatalogSource(track);

    // 1. Fast path: check persistent mapping cache first (never touches Spotify or search APIs!)
    if (!options.forceRefresh && !options.preferredProvider) {
      const cached = await this.store.get(key);
      if (cached && !excluded.has(cached.resolvedId)) {
        const providerAdapter = this.findSourceForProvider(cached.resolvedProvider);
        if (providerAdapter) {
          try {
            const stream = await providerAdapter.resolveStreamUrl(
              {
                provider: cached.resolvedProvider,
                id: cached.resolvedId,
                title: track.title,
                artist: track.artist,
                duration: track.duration,
                durationMs: trackDurationMs(track),
                durationDeltaMs: cached.durationDeltaMs,
                score: cached.score,
                url: cached.resolvedUrl,
              },
              signal,
            );
            const enriched: Track = {
              ...track,
              catalogSource,
              durationMs: trackDurationMs(track),
              streamProvider: cached.resolvedProvider,
              resolvedExternalId: cached.resolvedId,
              resolvedStreamUrl: stream.streamUrl,
              ...(
                ['ytmusic', 'youtube'].includes(cached.resolvedProvider) &&
                /^[\w-]{11}$/.test(cached.resolvedId) &&
                track.source === 'link'
                  ? { playbackId: cached.resolvedId }
                  : {}
              ),
            };
            return {
              track: enriched,
              provider: cached.resolvedProvider,
              externalId: cached.resolvedId,
              streamUrl: stream.streamUrl,
              duration: stream.duration || track.duration,
              durationDeltaMs: cached.durationDeltaMs,
              score: cached.score,
              fromCache: true,
            };
          } catch {
            // Cached stream expired or became unavailable -> invalidate and re-resolve transparently!
            await this.store.invalidate(key);
          }
        }
      }
    }

    // 2. Parallel Multi-Provider Search + Cascade Stream Fallback (#1 -> #2 -> #3...)
    const candidates = (await this.searchCandidates(track, signal)).filter(
      c => !excluded.has(c.id),
    );
    if (options.preferredProvider) {
      candidates.sort((a, b) => {
        const aPref = a.provider === options.preferredProvider ? 0 : 1;
        const bPref = b.provider === options.preferredProvider ? 0 : 1;
        return aPref - bPref || b.score - a.score;
      });
    }

    if (!candidates.length) {
      throw new Error('Não foi encontrada uma fonte de áudio compatível para esta faixa.');
    }

    const errors: string[] = [];
    for (const candidate of candidates) {
      const adapter = this.findSourceForProvider(candidate.provider);
      if (!adapter) continue;
      try {
        const resolved = await adapter.resolveStreamUrl(candidate, signal);
        await this.store.set({
          sourceTrackId: key,
          catalogSource,
          resolvedProvider: candidate.provider,
          resolvedId: candidate.id,
          resolvedUrl: candidate.url || resolved.streamUrl,
          durationDeltaMs: candidate.durationDeltaMs,
          score: candidate.score,
          updatedAt: Date.now(),
        });
        const enriched: Track = {
          ...track,
          catalogSource,
          durationMs: trackDurationMs(track),
          streamProvider: candidate.provider,
          resolvedExternalId: candidate.id,
          resolvedStreamUrl: resolved.streamUrl,
          ...(
            ['ytmusic', 'youtube'].includes(candidate.provider) &&
            /^[\w-]{11}$/.test(candidate.id) &&
            track.source === 'link'
              ? { playbackId: candidate.id }
              : {}
          ),
        };
        return {
          track: enriched,
          provider: candidate.provider,
          externalId: candidate.id,
          streamUrl: resolved.streamUrl,
          duration: resolved.duration || candidate.duration || track.duration,
          durationDeltaMs: candidate.durationDeltaMs,
          score: candidate.score,
          fromCache: false,
        };
      } catch (err) {
        errors.push(`${candidate.provider}: ${(err as Error).message}`);
      }
    }

    throw new Error(
      `Todas as fontes de áudio candidatas falharam (${errors.join('; ') || 'indisponível'}).`,
    );
  }

  private findSourceForProvider(provider: ResolvedStreamProvider): StreamCandidateSource | undefined {
    return (
      this.sources.find(s => s.id === provider) ||
      (provider === 'ytmusic' ? this.sources.find(s => s.id === 'youtube') : undefined)
    );
  }
}
