import { inferCatalogSource, type SearchKind, type Track } from '../../shared/types';

export type SearchRankTier = 1 | 2 | 3 | 4;

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

const COVER_REUPLOAD_WORDS = [
  'cover',
  'covers',
  'tribute',
  'karaoke',
  'instrumental',
  'slowed',
  'reverb',
  'nightcore',
  'daycore',
  'parody',
  'parodia',
  'reupload',
  'bootleg',
];

const COVER_REUPLOAD_PHRASES = [
  'sped up',
  'speed up',
  'bass boosted',
  '8d audio',
  'karaoke version',
  'type beat',
  'slowed reverb',
  'slowed and reverb',
];

const UNOFFICIAL_CHANNEL_WORDS = new Set([
  'lyrics',
  'letra',
  'letras',
  'traducao',
  'legendado',
  'karaoke',
  'covers',
  'nightcore',
  '8d',
  'fan',
  'fanclub',
  'reupload',
  'edits',
]);

const REMIX_WORDS = ['remix', 'remixed', 'mashup'];
const REMIX_PHRASES = ['vip mix', 'club mix', 'dub mix', 'extended remix'];

const ALTERNATIVE_WORDS = [
  'live',
  'acoustic',
  'acustico',
  'acustica',
  'unplugged',
  'deluxe',
  'remaster',
  'remastered',
  'session',
  'sessions',
  'extended',
  'orchestral',
];

const ALTERNATIVE_PHRASES = [
  'ao vivo',
  'radio edit',
  'piano version',
  'acoustic version',
  'versao acustica',
  'tiny desk',
];

function normalizeAsciiLower(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractTokens(raw: string): string[] {
  const withoutFeat = raw.split(/\s*(?:\(|\[)?(?:feat\.|ft\.)/i)[0] || raw;
  return normalizeAsciiLower(withoutFeat)
    .split(/\s+/)
    .filter(w => w.length > 0 && !NOISE_WORDS.has(w));
}

function primaryArtist(raw: string): string {
  return raw.split(/[,&;/]/)[0]?.trim() || raw.trim();
}

function looksLikeFanReupload(track: Track, queryWords: Set<string>): boolean {
  if (track.source !== 'youtube' && track.source !== 'soundcloud') return false;
  const rawArtistLow = (track.artist || '').toLowerCase();
  if (rawArtistLow.endsWith(' - topic') || rawArtistLow.includes('vevo')) return false;

  const artistWords = normalizeAsciiLower(track.artist || '')
    .split(/\s+/)
    .filter(Boolean);
  if (artistWords.some(w => UNOFFICIAL_CHANNEL_WORDS.has(w) && !queryWords.has(w))) {
    return true;
  }

  if (track.source === 'youtube' && track.title.includes(' - ')) {
    const [lead] = track.title.split(' - ');
    const leadTokens = extractTokens(primaryArtist(lead || '')).filter(t => t.length >= 2);
    const channelTokens = new Set(extractTokens(track.artist || ''));
    if (
      leadTokens.length > 0 &&
      channelTokens.size > 0 &&
      !leadTokens.some(t => channelTokens.has(t))
    ) {
      const low = track.title.toLowerCase();
      if (
        low.includes('letra') ||
        low.includes('lyric') ||
        low.includes('tradu') ||
        (!channelTokens.has('records') && !channelTokens.has('music'))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function classifySearchTier(track: Track, query: string): SearchRankTier {
  const queryNorm = ` ${normalizeAsciiLower(query)} `;
  const queryWords = new Set(queryNorm.trim().split(/\s+/).filter(Boolean));
  const combinedNorm = ` ${normalizeAsciiLower(track.title || '')} ${normalizeAsciiLower(track.artist || '')} `;
  const combinedWords = new Set(combinedNorm.trim().split(/\s+/).filter(Boolean));

  const hasWord = (words: string[]) => words.some(w => combinedWords.has(w) && !queryWords.has(w));
  const hasPhrase = (phrases: string[]) =>
    phrases.some(p => combinedNorm.includes(` ${p} `) && !queryNorm.includes(` ${p} `));

  if (
    hasPhrase(COVER_REUPLOAD_PHRASES) ||
    hasWord(COVER_REUPLOAD_WORDS) ||
    looksLikeFanReupload(track, queryWords)
  ) {
    return 1;
  }

  const hasPlainEdit =
    combinedWords.has('edit') &&
    !combinedNorm.includes(' radio edit ') &&
    !queryWords.has('edit');
  if (hasPhrase(REMIX_PHRASES) || hasWord(REMIX_WORDS) || hasPlainEdit) {
    return 2;
  }

  if (hasPhrase(ALTERNATIVE_PHRASES) || hasWord(ALTERNATIVE_WORDS)) {
    return 3;
  }

  return 4;
}

function tokenCoverage(wanted: string[], found: string[]): number {
  if (!wanted.length) return 0;
  let hits = 0;
  for (const w of wanted) {
    if (found.includes(w)) hits++;
  }
  return hits / wanted.length;
}

function sourceAuthorityScore(track: Track): number {
  const cat = inferCatalogSource(track);
  const rawArtistLow = (track.artist || '').toLowerCase();
  const isTopic = rawArtistLow.endsWith(' - topic');
  const isVevo = rawArtistLow.includes('vevo');
  if (cat === 'spotify') return 10;
  if (cat === 'ytmusic' || isTopic) return 9;
  if (cat === 'deezer') return 8.5;
  if (cat === 'local') return 7;
  if (track.url?.includes('music.apple.com')) return 8;
  if (cat === 'youtube' && isVevo) return 6.5;
  if (cat === 'soundcloud') return 5;
  if (cat === 'youtube') return 3.5;
  return 5;
}

export function rankSearchTracks(
  items: readonly Track[],
  query: string,
  requestedKind: SearchKind = 'all',
): Track[] {
  const deduped: Track[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  const qNorm = normalizeAsciiLower(query);
  const qTokens = extractTokens(query);

  const scored = deduped.map((track, idx) => {
    const tier = classifySearchTier(track, query);
    const titleNorm = normalizeAsciiLower(track.title || '');
    const artistClean = (track.artist || '').replace(/ - Topic$/i, '');
    const artistNorm = normalizeAsciiLower(artistClean);

    const titleTokens = extractTokens(titleNorm);
    const artistTokens = extractTokens(artistNorm);
    const combinedTokens = [...titleTokens, ...artistTokens];

    let score = tokenCoverage(qTokens, combinedTokens) * 40 + tokenCoverage(titleTokens, qTokens) * 12;
    if (qNorm) {
      if (titleNorm === qNorm) score += 20;
      else if (titleNorm.startsWith(qNorm) || qNorm.startsWith(titleNorm)) score += 9;
      else if (titleNorm.includes(qNorm)) score += 6;

      if (artistNorm === qNorm) score += 22;
      else if (
        artistTokens.length > 0 &&
        qTokens.length >= artistTokens.length &&
        artistTokens.every(t => qTokens.includes(t))
      ) {
        score += 14;
      }
    }
    score += sourceAuthorityScore(track);
    if (requestedKind !== 'all' && track.kind === requestedKind) score += 4;
    return { track, tier, score, idx };
  });

  scored.sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    const diff = Math.round(b.score * 1000) - Math.round(a.score * 1000);
    if (diff !== 0) return diff;
    return a.idx - b.idx;
  });

  return scored.map(entry => entry.track);
}
