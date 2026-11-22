import { createHash } from 'node:crypto';
import type { StreamCandidate, Track } from '../shared/types.ts';
import { buildResolverQuery, scoreStreamCandidate } from '../desktop/providers/resolver.ts';

export type CatalogSource = 'youtube' | 'soundcloud' | 'deezer' | 'spotify';
export type CatalogKind = 'all' | 'track' | 'artist' | 'playlist' | 'album';
export interface CatalogPage {
  items: Track[];
  next?: string;
}

export class CatalogError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.status = status;
  }
}

const text = (v: unknown, fallback: string) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : fallback;

const decode = (v: unknown) =>
  text(v, 'YouTube')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const duration = (v: string) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
};

function artwork(raw: unknown): string | undefined {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      [
        'i.ytimg.com',
        'i1.sndcdn.com',
        'i2.sndcdn.com',
        'i.scdn.co',
        'mosaic.scdn.co',
        'image-cdn-fa.spotifycdn.com',
        'image-cdn-ak.spotifycdn.com',
        'cdn-images.dzcdn.net',
        'e-cdns-images.dzcdn.net',
        'cdns-images.dzcdn.net',
      ].includes(u.hostname)
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function soundcloudCursor(raw: string, endpoint: string) {
  const u = new URL(raw);
  if (
    u.origin !== 'https://api.soundcloud.com' ||
    u.username ||
    u.password ||
    u.pathname !== `/${endpoint}` ||
    u.hash ||
    raw.length > 2000
  ) {
    throw new CatalogError('Página inválida.', 400);
  }
  return u;
}

/** Server-only platform credentials. No user password or streaming media is handled here. */
export function createPlatforms(env: NodeJS.ProcessEnv, request: typeof fetch = fetch) {
  const configured = {
    youtube: !!env.YOUTUBE_API_KEY,
    soundcloud: !!env.SOUNDCLOUD_CLIENT_ID && !!env.SOUNDCLOUD_CLIENT_SECRET,
    spotify: !!env.SPOTIFY_CLIENT_ID && !!env.SPOTIFY_CLIENT_SECRET,
  };
  const deezerEnabled = env.CATALOG_ENABLE_DEEZER === '1';
  let token: { access: string; refresh?: string; expires: number } | undefined;
  let pendingToken: Promise<string> | undefined;
  let spotifyToken: { access: string; expires: number } | undefined;
  let pendingSpotifyToken: Promise<string> | undefined;
  let youtubeDay = '',
    youtubeCalls = 0;
  const searchBudget = Math.max(1, Math.min(100000, Number(env.YOUTUBE_DAILY_SEARCH_LIMIT) || 90));
  const region = /^[A-Z]{2}$/.test(env.CATALOG_REGION || '') ? env.CATALOG_REGION! : 'BR';

  async function json(url: URL | string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await request(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new CatalogError(
        'A plataforma está temporariamente indisponível. Tente novamente em instantes.',
      );
    }
    if (!response.ok) {
      if (String(url).startsWith('https://api.soundcloud.com') && response.status === 401) {
        token = undefined;
      }
      throw new CatalogError(
        response.status === 429 || response.status === 403
          ? 'O catálogo atingiu um limite temporário. Tente novamente mais tarde.'
          : 'Não foi possível consultar esta plataforma agora.',
      );
    }
    if (Number(response.headers.get('content-length')) > 2_000_000) {
      throw new CatalogError('Resposta inválida da plataforma.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CatalogError('Resposta inválida da plataforma.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new CatalogError('Resposta inválida da plataforma.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new CatalogError('Resposta inválida da plataforma.');
    }
  }

  async function youtube(path: string, params: Record<string, string>) {
    if (!configured.youtube) {
      throw new CatalogError('O catálogo do YouTube ainda não foi ativado pelo Liquid Hub.');
    }
    if (path === 'search') {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
        new Date(),
      );
      if (today !== youtubeDay) {
        youtubeDay = today;
        youtubeCalls = 0;
      }
      if (youtubeCalls >= searchBudget) {
        throw new CatalogError(
          'As buscas do YouTube atingiram o limite diário do aplicativo. Tente novamente amanhã.',
        );
      }
      youtubeCalls++;
    }
    return json(
      `https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({
        ...params,
        key: env.YOUTUBE_API_KEY!,
      })}`,
    );
  }

  function youtubeTrack(row: any, detail: any, isVideoList = false): Track | undefined {
    const kind =
      isVideoList || row.id?.videoId ? 'track' : row.id?.channelId ? 'artist' : 'playlist';
    const id = isVideoList ? row.id : row.id?.videoId || row.id?.channelId || row.id?.playlistId;
    if (
      typeof id !== 'string' ||
      !/^[\w-]{1,200}$/.test(id) ||
      (kind === 'track' && id.length !== 11)
    ) {
      return;
    }
    const snippet = row.snippet || {};
    const artist = decode(snippet.channelTitle);
    const dur = Math.min(604800, duration(detail?.contentDetails?.duration || ''));
    const isTopic = artist.toLowerCase().endsWith(' - topic');
    return {
      id: `youtube:${id}`,
      source: 'youtube',
      sourceId: id,
      kind,
      title: decode(snippet.title),
      artist,
      artwork: artwork(snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url),
      duration: dur,
      durationMs: Math.round(dur * 1000),
      catalogSource: isTopic ? 'ytmusic' : 'youtube',
      streamProvider: kind === 'track' ? (isTopic ? 'ytmusic' : 'youtube') : undefined,
      available: kind === 'track' ? !!detail && detail.status?.embeddable !== false : undefined,
      url:
        kind === 'track'
          ? `https://www.youtube.com/watch?v=${id}`
          : kind === 'artist'
            ? `https://www.youtube.com/channel/${id}`
            : `https://www.youtube.com/playlist?list=${id}`,
      addedAt: Date.now(),
    };
  }

  async function access() {
    if (token && token.expires > Date.now() + 60000) return token.access;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const body = new URLSearchParams(
        token?.refresh
          ? { grant_type: 'refresh_token', refresh_token: token.refresh }
          : { grant_type: 'client_credentials' },
      );
      const data = await json('https://secure.soundcloud.com/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
      if (typeof data.access_token !== 'string') {
        throw new CatalogError('A autorização do catálogo está indisponível.');
      }
      token = {
        access: data.access_token,
        refresh: data.refresh_token,
        expires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      return token.access;
    })();
    try {
      return await pendingToken;
    } catch (e) {
      token = undefined;
      throw e;
    } finally {
      pendingToken = undefined;
    }
  }

  async function searchDeezerTracks(query: string, cursor?: string): Promise<CatalogPage> {
    const offset = cursor && /^\d{1,3}$/.test(cursor) ? Math.min(180, Number(cursor)) : 0;
    const data = await json(
      `https://api.deezer.com/search/track?${new URLSearchParams({
        q: query,
        index: String(offset),
        limit: '20',
      })}`,
    );
    const rows: any[] = Array.isArray(data?.data) ? data.data.slice(0, 20) : [];
    const items: Track[] = [];
    for (const row of rows) {
      const dzId = String(row.id || '');
      if (!/^\d{1,25}$/.test(dzId)) continue;
      const canonical = `https://www.deezer.com/track/${dzId}`;
      const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
      const sec = Math.max(0, Math.min(604800, Number(row.duration || 0)));
      const isrc = typeof row.isrc === 'string' && /^[A-Z0-9-]{12,15}$/i.test(row.isrc) ? row.isrc : undefined;
      items.push({
        id: `link:${hash}`,
        source: 'link',
        sourceId: hash,
        kind: 'track',
        title: text(row.title, 'Deezer'),
        artist: text(row.artist?.name, 'Deezer'),
        album: row.album?.title ? text(row.album.title, '') : undefined,
        artwork: artwork(row.album?.cover_big || row.album?.cover_medium),
        duration: sec,
        durationMs: Math.round(sec * 1000),
        isrc,
        catalogSource: 'deezer',
        resolvedExternalId: dzId,
        url: canonical,
        addedAt: Date.now(),
      });
    }
    return {
      items,
      next: data?.next && offset < 180 ? String(offset + 20) : undefined,
    };
  }

  async function spotifyAccess() {
    if (!configured.spotify) {
      throw new CatalogError('O catálogo do Spotify ainda não foi ativado pelo Liquid Hub.');
    }
    if (spotifyToken && spotifyToken.expires > Date.now() + 60000) return spotifyToken.access;
    if (pendingSpotifyToken) return pendingSpotifyToken;
    pendingSpotifyToken = (async () => {
      const data = await json('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
      if (typeof data.access_token !== 'string') {
        throw new CatalogError('A autorização do Spotify está indisponível.');
      }
      spotifyToken = {
        access: data.access_token,
        expires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      return spotifyToken.access;
    })();
    try {
      return await pendingSpotifyToken;
    } catch (e) {
      spotifyToken = undefined;
      throw e;
    } finally {
      pendingSpotifyToken = undefined;
    }
  }

  function mapSpotifyItem(row: any, kind: 'track' | 'album' | 'artist' | 'playlist'): Track | undefined {
    if (!row || typeof row !== 'object') return undefined;
    const spId = String(row.id || '');
    if (!/^[A-Za-z0-9]{22}$/.test(spId)) return undefined;
    const canonical = `https://open.spotify.com/${kind}/${spId}`;
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    const art = artwork(
      row.album?.images?.[0]?.url || row.images?.[0]?.url,
    );
    if (kind === 'track') {
      const durMs = Math.max(0, Math.round(Number(row.duration_ms || 0)));
      const sec = Math.min(604800, durMs / 1000);
      const artists = Array.isArray(row.artists)
        ? row.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
        : '';
      const isrc =
        typeof row.external_ids?.isrc === 'string' && /^[A-Z0-9-]{12,15}$/i.test(row.external_ids.isrc)
          ? row.external_ids.isrc.toUpperCase()
          : undefined;
      return {
        id: `link:${hash}`,
        source: 'link',
        sourceId: hash,
        kind: 'track',
        title: text(row.name, 'Spotify'),
        artist: text(artists, 'Spotify'),
        album: row.album?.name ? text(row.album.name, '') : undefined,
        artwork: art,
        duration: sec,
        durationMs: Math.round(sec * 1000),
        isrc,
        catalogSource: 'spotify',
        url: canonical,
        addedAt: Date.now(),
      };
    }
    const artist =
      kind === 'album'
        ? text(
            Array.isArray(row.artists)
              ? row.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
              : '',
            'Spotify',
          )
        : kind === 'playlist'
          ? text(row.owner?.display_name, 'Spotify')
          : text(row.name, 'Spotify');
    return {
      id: `link:${hash}`,
      source: 'link',
      sourceId: hash,
      kind,
      title: text(row.name, 'Spotify'),
      artist,
      ...(kind === 'album' ? { album: text(row.name, 'Spotify') } : {}),
      artwork: art,
      duration: 0,
      catalogSource: 'spotify',
      url: canonical,
      addedAt: Date.now(),
    };
  }

  async function searchSpotify(
    query: string,
    kind: CatalogKind,
    cursor?: string,
  ): Promise<CatalogPage> {
    if (cursor && !/^\d{1,3}$/.test(cursor)) {
      throw new CatalogError('Página inválida.', 400);
    }
    const offset = cursor ? Number(cursor) : 0;
    if (offset > 190 || offset % 10 !== 0) {
      throw new CatalogError('Página inválida.', 400);
    }
    const auth = await spotifyAccess();
    const searchType =
      kind === 'all' ? 'track,album,artist,playlist' : kind;
    const url = `https://api.spotify.com/v1/search?${new URLSearchParams({
      q: query,
      type: searchType,
      limit: '10',
      offset: String(offset),
      market: region,
    })}`;
    let response: Response;
    try {
      response = await request(url, {
        headers: { Authorization: `Bearer ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new CatalogError('O Spotify está temporariamente indisponível.', 503);
    }
    if (response.status === 401) {
      spotifyToken = undefined;
      throw new CatalogError('A autorização do Spotify expirou.', 503);
    }
    if (!response.ok) {
      if (response.status === 429) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {}
        if (bodyText.includes('QUOTA_EXCEEDED')) {
          throw new CatalogError(
            'A cota da Spotify Web API foi excedida temporariamente.',
            429,
          );
        }
        throw new CatalogError(
          'O catálogo atingiu um limite temporário. Tente novamente mais tarde.',
          429,
        );
      }
      throw new CatalogError('Não foi possível consultar o Spotify agora.', 503);
    }
    const data = await response.json();
    const items: Track[] = [];
    let hasNext = false;
    const sections: Array<['tracks' | 'albums' | 'artists' | 'playlists', 'track' | 'album' | 'artist' | 'playlist']> = [
      ['tracks', 'track'],
      ['albums', 'album'],
      ['artists', 'artist'],
      ['playlists', 'playlist'],
    ];
    for (const [secKey, itemKind] of sections) {
      const sec = data?.[secKey];
      if (!sec) continue;
      if (Array.isArray(sec.items)) {
        for (const row of sec.items) {
          const mapped = mapSpotifyItem(row, itemKind);
          if (mapped) items.push(mapped);
        }
      }
      if (typeof sec.next === 'string' && offset + 10 <= 190) {
        hasNext = true;
      }
    }
    return { items, next: hasNext ? String(offset + 10) : undefined };
  }

  async function search(
    source: CatalogSource,
    query: string,
    kind: CatalogKind,
    cursor?: string,
  ): Promise<CatalogPage> {
    if (source === 'spotify') {
      return searchSpotify(query, kind, cursor);
    }
    if (kind === 'album' && (source === 'youtube' || source === 'soundcloud')) {
      return { items: [] };
    }
    if (source === 'deezer') {
      if (!deezerEnabled) {
        throw new CatalogError('O catálogo do Deezer não está habilitado neste servidor.');
      }
      return searchDeezerTracks(query, cursor);
    }
    if (source === 'youtube') {
      const type =
        kind === 'artist'
          ? 'channel'
          : kind === 'playlist'
            ? 'playlist'
            : kind === 'all'
              ? 'video,channel,playlist'
              : 'video';
      const data = await youtube('search', {
        part: 'snippet',
        q: query,
        type,
        maxResults: '20',
        relevanceLanguage: 'pt',
        ...(type === 'video' ? { videoEmbeddable: 'true' } : {}),
        ...(cursor ? { pageToken: cursor } : {}),
      });
      const rows: any[] = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
      const ids = rows.map(r => r.id?.videoId).filter(Boolean);
      const details = ids.length
        ? await youtube('videos', { part: 'contentDetails,status', id: ids.join(',') })
        : { items: [] };
      return {
        items: rows
          .map(r => youtubeTrack(r, details.items?.find((d: any) => d.id === r.id?.videoId)))
          .filter((t): t is Track => !!t),
        next: typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined,
      };
    }
    if (!configured.soundcloud) {
      throw new CatalogError('O catálogo do SoundCloud ainda não foi ativado pelo Liquid Hub.');
    }
    const endpoints =
      kind === 'all'
        ? ['tracks', 'users', 'playlists']
        : [kind === 'artist' ? 'users' : kind === 'playlist' ? 'playlists' : 'tracks'];
    let cursors: Record<string, string> | undefined;
    try {
      cursors = cursor ? JSON.parse(cursor) : undefined;
    } catch {
      throw new CatalogError('Página inválida.', 400);
    }
    const next: Record<string, string> = {};
    const auth = await access();
    const pages = await Promise.all(
      endpoints.map(async endpoint => {
        if (cursors && !cursors[endpoint]) return [];
        const target = cursors?.[endpoint]
          ? soundcloudCursor(cursors[endpoint], endpoint)
          : new URL(
              `https://api.soundcloud.com/${endpoint}?${new URLSearchParams({
                q: query,
                limit: '20',
                linked_partitioning: 'true',
              })}`,
            );
        const data = await json(target, {
          headers: { Authorization: `OAuth ${auth}`, Accept: 'application/json' },
        });
        if (data.next_href) next[endpoint] = soundcloudCursor(data.next_href, endpoint).href;
        const collection: any[] = Array.isArray(data)
          ? data
          : Array.isArray(data.collection)
            ? data.collection
            : [];
        const items: Track[] = [];
        for (const row of collection.slice(0, 20)) {
          const sourceId = String(row.urn || row.id || '');
          let url: URL;
          try {
            url = new URL(row.permalink_url);
          } catch {
            continue;
          }
          if (
            !/^[\w:.-]{1,180}$/.test(sourceId) ||
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.port ||
            !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)
          ) {
            continue;
          }
          const seconds = Number(row.duration || 0) / 1000;
          const dur = Number.isFinite(seconds) ? Math.max(0, Math.min(604800, seconds)) : 0;
          const itemKind =
            endpoint === 'users' ? 'artist' : endpoint === 'playlists' ? 'playlist' : 'track';
          items.push({
            id: `soundcloud:${sourceId}`,
            source: 'soundcloud',
            sourceId,
            kind: itemKind,
            title: text(row.title || row.username, 'SoundCloud'),
            artist: text(row.user?.username || row.username, 'SoundCloud'),
            artwork: artwork(row.artwork_url || row.avatar_url || row.user?.avatar_url),
            duration: dur,
            durationMs: Math.round(dur * 1000),
            catalogSource: 'soundcloud',
            streamProvider: itemKind === 'track' && row.access !== 'preview' ? 'soundcloud' : undefined,
            url: url.href,
            addedAt: Date.now(),
            available: row.access === 'blocked' || row.embeddable_by === 'none' ? false : undefined,
            reason:
              row.access === 'preview'
                ? 'A plataforma pode disponibilizar apenas uma prévia.'
                : undefined,
          });
        }
        return items;
      }),
    );
    return { items: pages.flat(), next: Object.keys(next).length ? JSON.stringify(next) : undefined };
  }

  async function resolveCrossPlatform(input: {
    title: string;
    artist: string;
    durationMs: number;
    isrc?: string;
    excludeIds?: string[];
  }): Promise<StreamCandidate[]> {
    const activeSources: Array<'youtube' | 'soundcloud' | 'deezer'> = [];
    if (configured.youtube) activeSources.push('youtube');
    if (configured.soundcloud) activeSources.push('soundcloud');
    if (deezerEnabled) activeSources.push('deezer');
    if (!activeSources.length) {
      throw new CatalogError('Nenhum provedor de stream ativo no catálogo.', 503);
    }

    const ref = {
      title: input.title,
      artist: input.artist,
      duration: input.durationMs / 1000,
      durationMs: input.durationMs,
      isrc: input.isrc,
    };
    const query = buildResolverQuery(ref);
    const excluded = new Set(input.excludeIds || []);

    const settled = await Promise.allSettled(
      activeSources.map(src => search(src, query, 'track')),
    );

    const candidates: StreamCandidate[] = [];
    const seen = new Set<string>();

    settled.forEach((res, idx) => {
      if (res.status !== 'fulfilled') return;
      const src = activeSources[idx]!;
      for (const item of res.value.items) {
        if (item.available === false) continue;
        // Skip SoundCloud 30s preview-only tracks
        if (item.reason?.includes('prévia')) continue;
        const extId = item.resolvedExternalId || item.sourceId;
        if (excluded.has(extId)) continue;
        const isTopic = item.artist.toLowerCase().endsWith(' - topic');
        const provider =
          src === 'youtube' ? (isTopic ? 'ytmusic' : 'youtube') : src;
        const candMs = item.durationMs ?? Math.round(item.duration * 1000);
        const score = scoreStreamCandidate(ref, {
          provider,
          id: extId,
          title: item.title,
          artist: item.artist,
          duration: item.duration,
          durationMs: candMs,
          isrc: item.isrc,
          url: item.url,
          isOfficialTopic: isTopic,
        });
        if (score < 55) continue;
        const dedup = `${provider}:${extId}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        candidates.push({
          provider,
          id: extId,
          title: item.title,
          artist: item.artist,
          duration: item.duration,
          durationMs: candMs,
          durationDeltaMs: input.durationMs > 0 ? Math.abs(input.durationMs - candMs) : 0,
          score,
          url: item.url,
          artwork: item.artwork,
          isrc: item.isrc,
          isOfficialTopic: isTopic,
        });
      }
    });

    const order: Record<string, number> = { ytmusic: 0, deezer: 1, soundcloud: 2, youtube: 3 };
    candidates.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.5) return b.score - a.score;
      return (order[a.provider] ?? 9) - (order[b.provider] ?? 9);
    });
    return candidates;
  }

  async function discover(source: CatalogSource): Promise<Track[]> {
    if (source === 'soundcloud') {
      return (await search(source, 'electronic', 'track')).items
        .filter(t => t.available !== false)
        .slice(0, 10);
    }
    if (source === 'deezer') {
      return (await searchDeezerTracks('brasil')).items.slice(0, 10);
    }
    const data = await youtube('videos', {
      part: 'snippet,contentDetails,status',
      chart: 'mostPopular',
      videoCategoryId: '10',
      regionCode: region,
      maxResults: '20',
    });
    return (Array.isArray(data.items) ? data.items : [])
      .map((r: any) => youtubeTrack(r, r, true))
      .filter((t: Track | undefined): t is Track => !!t && t.available !== false)
      .slice(0, 10);
  }

  return { configured, search, discover, resolveCrossPlatform, region };
}
