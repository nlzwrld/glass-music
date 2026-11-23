import type { Snapshot, Track } from '../../shared/types';

export interface SmartShuffleContext {
  history: Snapshot['history'];
  likes: string[];
  libraryTracks: Track[];
  /** When provided, taste, artist affinity, likes and history cooldown are strictly scoped to this active playlist/queue. */
  playlistTracks?: readonly Track[];
  currentTrack?: Track;
  recentQueueTracks?: Track[];
  now?: number;
}

export interface SmartShuffleProfile {
  lastPlayIndex: Map<string, number>;
  recentPlayCounts: Map<string, number>;
  recentTenIds: Set<string>;
  olderPlayIds: Set<string>;
  likeSet: Set<string>;
  recentArtistWeights: Map<string, number>;
  olderArtistWeights: Map<string, number>;
  likedArtistWeights: Map<string, number>;
  styleWeights: Map<string, number>;
}

export interface SmartShuffleBreakdown {
  trackId: string;
  index: number;
  score: number;
  baseRelevance: number;
  recencyFactor: number;
  overplayFactor: number;
  likeBoost: number;
  artistAffinity: number;
  styleAffinity: number;
  olderPreferenceBonus: number;
  diversityFactor: number;
  reasons: string[];
}

export interface SmartShufflePickResult {
  next: number | null;
  breakdown: SmartShuffleBreakdown | null;
  candidates: SmartShuffleBreakdown[];
}

const STYLE_RULES: ReadonlyArray<[string, RegExp]> = [
  ['rock', /\b(rock|punk|grunge|alternative|alt-rock|britpop|post-rock|hard rock)\b/i],
  ['metal', /\b(metal|heavy|thrash|deathcore|metalcore|djent|doom)\b/i],
  ['pop', /\b(pop|synthpop|electropop|teen pop|k-pop|kpop)\b/i],
  ['hiphop', /\b(hip hop|hip-hop|hiphop|rap|trap|boom bap|drill)\b/i],
  ['funk', /\b(funk|baile|mandelao|mandelão|proibidao|proibidão|montagem|mtgm|megafunk)\b/i],
  ['eletronica', /\b(electronic|eletronica|eletrônica|edm|house|techno|trance|dubstep|dnb|drum and bass|electro|synthwave|club)\b/i],
  ['mpb', /\b(mpb|bossa nova|bossa|samba|tropicalia|tropicália|choro)\b/i],
  ['sertanejo', /\b(sertanejo|modao|modão|universitario|universitário|caipira)\b/i],
  ['pagode', /\b(pagode|axé|axe|forro|forró|piseiro)\b/i],
  ['indie', /\b(indie|shoegaze|dream pop|bedroom pop|folk|singer-songwriter)\b/i],
  ['jazz', /\b(jazz|blues|bebop|swing|fusion)\b/i],
  ['classical', /\b(classical|classica|clássica|orchestra|symphony|sonata|concerto|piano solo)\b/i],
  ['rnb', /\b(r&b|rnb|soul|neo-soul|neosoul|motown)\b/i],
  ['lofi', /\b(lo-fi|lofi|chillhop|study beats|beats to relax)\b/i],
  ['ambient', /\b(ambient|meditation|soundscape|drone|atmospheric)\b/i],
  ['acoustic', /\b(acoustic|acustico|acústico|unplugged|voz e violao|voz e violão)\b/i],
  ['latin', /\b(reggaeton|latin|latina|salsa|bachata|cumbia)\b/i],
  ['soundtrack', /\b(soundtrack|ost|trilha sonora|score|cinema)\b/i],
];

function stripAccentsLower(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function normalizePrimaryArtist(raw?: string): string {
  if (!raw) return '';
  const cleaned = stripAccentsLower(raw)
    .replace(/\s*-\s*topic$/i, '')
    .split(/\s*(?:feat\.|ft\.|featuring|&|,|;|\/|\bx\b|\bwith\b)\s*/i)[0]
    ?.replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return cleaned || '';
}

export function inferStyleTags(
  track: Pick<Track, 'title' | 'artist' | 'album' | 'catalogSource'>,
): string[] {
  const haystack = `${track.title || ''} ${track.artist || ''} ${track.album || ''}`;
  const tags: string[] = [];
  for (const [style, rx] of STYLE_RULES) {
    if (rx.test(haystack)) tags.push(style);
  }
  if (!tags.length) {
    const albumKey = stripAccentsLower(track.album || '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const artistKey = normalizePrimaryArtist(track.artist);
    if (albumKey) tags.push(`album:${albumKey}`);
    else if (artistKey) tags.push(`artist:${artistKey}`);
    else if (track.catalogSource) tags.push(`source:${track.catalogSource}`);
  }
  return tags;
}

export function buildSmartShuffleProfile(ctx: SmartShuffleContext): SmartShuffleProfile {
  const now = ctx.now ?? Date.now();
  const scopedPlaylist =
    ctx.playlistTracks && ctx.playlistTracks.length > 0 ? ctx.playlistTracks : null;
  const playlistIdSet = scopedPlaylist
    ? new Set(scopedPlaylist.map(t => t.id).filter(Boolean))
    : null;

  const byId = new Map<string, Track>();
  for (const t of scopedPlaylist ?? ctx.libraryTracks) {
    if (t?.id) byId.set(t.id, t);
  }

  const rawLikes = ctx.likes || [];
  const likeSet = new Set(
    playlistIdSet ? rawLikes.filter(id => playlistIdSet.has(id)) : rawLikes,
  );
  const lastPlayIndex = new Map<string, number>();
  const recentPlayCounts = new Map<string, number>();
  const recentTenIds = new Set<string>();
  const olderPlayIds = new Set<string>();
  const recentArtistWeights = new Map<string, number>();
  const olderArtistWeights = new Map<string, number>();
  const likedArtistWeights = new Map<string, number>();
  const styleWeights = new Map<string, number>();

  // When scoped to an active playlist, ignore listening history from other playlists / previous taste
  const history = playlistIdSet
    ? (ctx.history || []).filter(entry => entry?.id && playlistIdSet.has(entry.id))
    : ctx.history || [];
  const sevenDaysMs = 7 * 86_400_000;

  if (scopedPlaylist) {
    // Anchor style & artist profile strictly to the currently playing playlist's own tracks
    for (const track of scopedPlaylist) {
      if (!track || track.kind !== 'track' || track.recommended) continue;
      for (const tag of inferStyleTags(track)) {
        styleWeights.set(tag, (styleWeights.get(tag) || 0) + 0.55);
      }
    }
  }

  history.forEach((entry, idx) => {
    if (!entry?.id) return;
    if (idx < 10) recentTenIds.add(entry.id);
    if (idx < 25 && !lastPlayIndex.has(entry.id)) {
      lastPlayIndex.set(entry.id, idx);
    }
    if (idx < 35) {
      recentPlayCounts.set(entry.id, (recentPlayCounts.get(entry.id) || 0) + 1);
    }
    const isOlderWindow =
      idx >= 25 || (entry.playedAt > 0 && now - entry.playedAt >= sevenDaysMs);
    if (isOlderWindow && idx < 500) {
      olderPlayIds.add(entry.id);
    }

    const track = byId.get(entry.id);
    if (!track || track.kind !== 'track') return;

    const artist = normalizePrimaryArtist(track.artist);
    const weight = 1 / (1 + idx * 0.28);
    if (idx < 25) {
      if (artist) {
        recentArtistWeights.set(artist, (recentArtistWeights.get(artist) || 0) + weight);
      }
    } else if (idx < 500) {
      if (artist) {
        olderArtistWeights.set(
          artist,
          (olderArtistWeights.get(artist) || 0) + 0.6 / (1 + (idx - 25) * 0.08),
        );
      }
    }

    if (!scopedPlaylist) {
      for (const tag of inferStyleTags(track)) {
        styleWeights.set(tag, (styleWeights.get(tag) || 0) + weight * (idx < 25 ? 1 : 0.45));
      }
    }
  });

  for (const id of likeSet) {
    const track = byId.get(id);
    if (!track || track.kind !== 'track') continue;
    const artist = normalizePrimaryArtist(track.artist);
    if (artist) {
      likedArtistWeights.set(artist, (likedArtistWeights.get(artist) || 0) + 0.8);
    }
    for (const tag of inferStyleTags(track)) {
      styleWeights.set(tag, (styleWeights.get(tag) || 0) + 0.4);
    }
  }

  return {
    lastPlayIndex,
    recentPlayCounts,
    recentTenIds,
    olderPlayIds,
    likeSet,
    recentArtistWeights,
    olderArtistWeights,
    likedArtistWeights,
    styleWeights,
  };
}

function normalizeMapScore(raw: number, cap = 3.0): number {
  if (raw <= 0) return 0;
  return Math.min(1, raw / cap);
}

export function scoreSmartShuffleCandidate(
  track: Track,
  index: number,
  ctx: SmartShuffleContext,
  profile: SmartShuffleProfile,
  options: { applyArtistDiversity?: boolean } = {},
): SmartShuffleBreakdown {
  const reasons: string[] = [];
  const artist = normalizePrimaryArtist(track.artist);
  const styles = inferStyleTags(track);
  const recentIdx = profile.lastPlayIndex.get(track.id);
  const recentCount = profile.recentPlayCounts.get(track.id) || 0;
  const isLiked = profile.likeSet.has(track.id);
  const applyArtistDiversity = options.applyArtistDiversity ?? true;

  // 1. Recency cooldown (recent tracks get penalized, strongest right after play)
  let recencyFactor = 1.0;
  if (recentIdx !== undefined && recentIdx < 25) {
    recencyFactor = Math.max(0.12, 1 - 0.88 * Math.exp(-recentIdx / 4.5));
    reasons.push('cooldown-recente');
  }

  // 2. Overplay penalty (excessive repetition inside last 35 plays)
  let overplayFactor = 1.0;
  if (recentCount >= 3) {
    overplayFactor = 1 / (1 + (recentCount - 2) * 0.7);
    reasons.push('evitar-repeticao-excessiva');
  }

  // 3. Liked boost (softened if track is overplayed so likes don't hijack queue)
  let likeBoost = 0;
  if (isLiked) {
    likeBoost = recentCount >= 3 ? 0.15 : 0.55;
    reasons.push('faixa-curtida');
  }

  // 4. Artist & style affinity from listening taste
  const recentArtistRaw = artist ? profile.recentArtistWeights.get(artist) || 0 : 0;
  const likedArtistRaw = artist ? profile.likedArtistWeights.get(artist) || 0 : 0;
  const olderArtistRaw = artist ? profile.olderArtistWeights.get(artist) || 0 : 0;
  const artistAffinity =
    normalizeMapScore(recentArtistRaw) * 0.45 + normalizeMapScore(likedArtistRaw) * 0.25;
  if (artistAffinity >= 0.18) {
    reasons.push('afinidade-artista');
  }

  const maxStyleRaw = styles.reduce(
    (max, tag) => Math.max(max, profile.styleWeights.get(tag) || 0),
    0,
  );
  const styleAffinity = normalizeMapScore(maxStyleRaw, 3.5) * 0.2;
  if (styleAffinity >= 0.08) {
    reasons.push('afinidade-estilo');
  }

  // 5. Resurface older favorites / older history tracks absent from last 10 plays
  let olderPreferenceBonus = 0;
  const isOlderPreference =
    !profile.recentTenIds.has(track.id) &&
    recentCount < 3 &&
    (profile.olderPlayIds.has(track.id) || olderArtistRaw >= 0.3 || (isLiked && recentIdx === undefined));
  if (isOlderPreference) {
    olderPreferenceBonus = 0.45;
    reasons.push('preferencia-antiga');
  }

  // 6. Musical diversity against active and recently queued tracks
  let diversityFactor = 1.0;
  const current = ctx.currentTrack;
  const currentArtist = normalizePrimaryArtist(current?.artist);
  const currentStyles = current ? new Set(inferStyleTags(current)) : new Set<string>();
  const recentQueue = ctx.recentQueueTracks || [];
  const prevArtist = recentQueue.length
    ? normalizePrimaryArtist(recentQueue[recentQueue.length - 1]?.artist)
    : '';
  const prevTwoArtist =
    recentQueue.length >= 2
      ? normalizePrimaryArtist(recentQueue[recentQueue.length - 2]?.artist)
      : '';

  if (applyArtistDiversity && artist) {
    if (currentArtist && artist === currentArtist) {
      diversityFactor *= 0.18;
      reasons.push('evitar-mesmo-artista');
    } else if ((prevArtist && artist === prevArtist) || (prevTwoArtist && artist === prevTwoArtist)) {
      diversityFactor *= 0.55;
      reasons.push('alternar-artistas');
    } else if (current) {
      const sharesStyle = styles.some(s => currentStyles.has(s));
      if (sharesStyle) {
        // Reward cohesive style continuity inside the active playlist while alternating artists
        diversityFactor *= 1.15;
        reasons.push('coesao-playlist');
      }
    }
  }

  if (
    current?.album &&
    track.album &&
    stripAccentsLower(current.album) === stripAccentsLower(track.album)
  ) {
    diversityFactor *= 0.75;
  }

  const baseRelevance = Math.max(
    0.25,
    1.0 + likeBoost + artistAffinity + styleAffinity + olderPreferenceBonus,
  );
  const score = Math.max(0.02, baseRelevance * recencyFactor * overplayFactor * diversityFactor);

  return {
    trackId: track.id,
    index,
    score: Math.round(score * 10000) / 10000,
    baseRelevance: Math.round(baseRelevance * 1000) / 1000,
    recencyFactor: Math.round(recencyFactor * 1000) / 1000,
    overplayFactor: Math.round(overplayFactor * 1000) / 1000,
    likeBoost,
    artistAffinity: Math.round(artistAffinity * 1000) / 1000,
    styleAffinity: Math.round(styleAffinity * 1000) / 1000,
    olderPreferenceBonus,
    diversityFactor: Math.round(diversityFactor * 1000) / 1000,
    reasons,
  };
}

function weightedPick(
  candidates: SmartShuffleBreakdown[],
  rng: () => number,
): SmartShuffleBreakdown | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0]!;
  const weights = candidates.map(c => Math.pow(Math.max(0.01, c.score), 1.85));
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    return candidates[0]!;
  }
  const r = Math.min(0.999999999, Math.max(0, rng()));
  let cursor = r * total;
  for (let i = 0; i < candidates.length; i++) {
    cursor -= weights[i]!;
    if (cursor <= 0) return candidates[i]!;
  }
  return candidates.reduce((best, item) => (item.score > best.score ? item : best), candidates[0]!);
}

export function pickSmartShuffleIndex(
  queue: readonly Track[],
  currentIndex: number,
  playedIndices: readonly number[],
  allowWrap: boolean,
  ctx: SmartShuffleContext,
  rng: () => number = Math.random,
): SmartShufflePickResult {
  const playable = queue.map((_, i) => i).filter(i => queue[i]?.available !== false);
  if (currentIndex < 0 || currentIndex >= queue.length || playable.length <= 1) {
    return { next: null, breakdown: null, candidates: [] };
  }

  const playedSet = new Set(playedIndices);
  let pool = playable.filter(i => !playedSet.has(i) && i !== currentIndex);
  if (!pool.length) {
    if (!allowWrap) {
      return { next: null, breakdown: null, candidates: [] };
    }
    pool = playable.filter(i => i !== currentIndex);
  }
  if (!pool.length) {
    return { next: null, breakdown: null, candidates: [] };
  }

  const effectiveCtx: SmartShuffleContext = {
    ...ctx,
    playlistTracks: ctx.playlistTracks ?? queue,
    currentTrack: ctx.currentTrack ?? queue[currentIndex],
  };
  const profile = buildSmartShuffleProfile(effectiveCtx);
  const distinctCandidateArtists = new Set(
    pool.map(i => normalizePrimaryArtist(queue[i]?.artist)).filter(Boolean),
  );
  const applyArtistDiversity = distinctCandidateArtists.size > 1;

  const candidates = pool
    .map(i =>
      scoreSmartShuffleCandidate(queue[i]!, i, effectiveCtx, profile, { applyArtistDiversity }),
    )
    .sort((a, b) => b.score - a.score);

  const chosen = weightedPick(candidates, rng);
  return {
    next: chosen ? chosen.index : null,
    breakdown: chosen,
    candidates,
  };
}

export function orderSmartShuffleTracks(
  tracks: readonly Track[],
  ctx: Omit<SmartShuffleContext, 'currentTrack' | 'recentQueueTracks'>,
  rng: () => number = Math.random,
): Track[] {
  const remaining = [...tracks];
  if (remaining.length <= 1) return remaining;

  const ordered: Track[] = [];
  const scopedCtx = {
    ...ctx,
    playlistTracks: ctx.playlistTracks ?? tracks,
  };
  const profile = buildSmartShuffleProfile(scopedCtx);

  while (remaining.length > 0) {
    const current = ordered[ordered.length - 1];
    const recentQueueTracks = ordered.slice(Math.max(0, ordered.length - 3), -1);
    const stepCtx: SmartShuffleContext = {
      ...scopedCtx,
      currentTrack: current,
      recentQueueTracks,
    };
    const distinctArtists = new Set(
      remaining.map(t => normalizePrimaryArtist(t.artist)).filter(Boolean),
    );
    const applyArtistDiversity = distinctArtists.size > 1;
    const scored = remaining
      .map((track, idx) =>
        scoreSmartShuffleCandidate(track, idx, stepCtx, profile, { applyArtistDiversity }),
      )
      .sort((a, b) => b.score - a.score);
    const picked = weightedPick(scored, rng);
    const chosenIdx = picked ? picked.index : 0;
    const [chosen] = remaining.splice(chosenIdx, 1);
    if (chosen) ordered.push(chosen);
  }

  return ordered;
}
