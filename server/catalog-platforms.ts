import type { Track } from '../shared/types.ts';

export type CatalogSource = 'youtube' | 'soundcloud';
export type CatalogKind = 'all' | 'track' | 'artist' | 'playlist';
export interface CatalogPage { items: Track[]; next?: string }
export class CatalogError extends Error {
  status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}
const text = (v: unknown, fallback: string) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : fallback;
const decode = (v: unknown) => text(v, 'YouTube').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const duration = (v: string) => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v); return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0; };
function artwork(raw: unknown): string | undefined {
  try { const u = new URL(String(raw)); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['i.ytimg.com', 'i1.sndcdn.com', 'i2.sndcdn.com'].includes(u.hostname) ? u.href : undefined; } catch { return undefined; }
}
export function soundcloudCursor(raw: string, endpoint: string) {
  const u = new URL(raw);
  if (u.origin !== 'https://api.soundcloud.com' || u.username || u.password || u.pathname !== `/${endpoint}` || u.hash || raw.length > 2000) throw new CatalogError('Página inválida.', 400);
  return u;
}

/** Server-only platform credentials. No user password or streaming media is handled here. */
export function createPlatforms(env: NodeJS.ProcessEnv, request: typeof fetch = fetch) {
  const configured = { youtube: !!env.YOUTUBE_API_KEY, soundcloud: !!env.SOUNDCLOUD_CLIENT_ID && !!env.SOUNDCLOUD_CLIENT_SECRET };
  let token: { access: string; refresh?: string; expires: number } | undefined;
  let pendingToken: Promise<string> | undefined;
  let youtubeDay = '', youtubeCalls = 0;
  const searchBudget = Math.max(1, Math.min(100000, Number(env.YOUTUBE_DAILY_SEARCH_LIMIT) || 90));
  const region = /^[A-Z]{2}$/.test(env.CATALOG_REGION || '') ? env.CATALOG_REGION! : 'BR';
  async function json(url: URL | string, init: RequestInit = {}) {
    let response: Response;
    try { response = await request(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new CatalogError('A plataforma está temporariamente indisponível. Tente novamente em instantes.'); }
    if (!response.ok) {
      if (String(url).startsWith('https://api.soundcloud.com') && response.status === 401) token = undefined;
      throw new CatalogError(response.status === 429 || response.status === 403 ? 'O catálogo atingiu um limite temporário. Tente novamente mais tarde.' : 'Não foi possível consultar esta plataforma agora.');
    }
    if (Number(response.headers.get('content-length')) > 2_000_000) throw new CatalogError('Resposta inválida da plataforma.');
    const reader = response.body?.getReader(); if (!reader) throw new CatalogError('Resposta inválida da plataforma.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new CatalogError('Resposta inválida da plataforma.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CatalogError('Resposta inválida da plataforma.'); }
  }
  async function youtube(path: string, params: Record<string, string>) {
    if (!configured.youtube) throw new CatalogError('O catálogo do YouTube ainda não foi ativado pelo Glass Music.');
    if (path === 'search') {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
      if (today !== youtubeDay) { youtubeDay = today; youtubeCalls = 0; }
      if (youtubeCalls >= searchBudget) throw new CatalogError('As buscas do YouTube atingiram o limite diário do aplicativo. Tente novamente amanhã.');
      youtubeCalls++;
    }
    return json(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY! })}`);
  }
  function youtubeTrack(row: any, detail: any, isVideoList = false): Track | undefined {
    const kind = isVideoList || row.id?.videoId ? 'track' : row.id?.channelId ? 'artist' : 'playlist';
    const id = isVideoList ? row.id : row.id?.videoId || row.id?.channelId || row.id?.playlistId;
    if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id) || (kind === 'track' && id.length !== 11)) return;
    const snippet = row.snippet || {};
    return { id: `youtube:${id}`, source: 'youtube', sourceId: id, kind, title: decode(snippet.title), artist: decode(snippet.channelTitle),
      artwork: artwork(snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url), duration: Math.min(604800, duration(detail?.contentDetails?.duration || '')),
      available: kind === 'track' ? !!detail && detail.status?.embeddable !== false : undefined,
      url: kind === 'track' ? `https://www.youtube.com/watch?v=${id}` : kind === 'artist' ? `https://www.youtube.com/channel/${id}` : `https://www.youtube.com/playlist?list=${id}`, addedAt: Date.now() };
  }
  async function access() {
    if (token && token.expires > Date.now() + 60000) return token.access;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const body = new URLSearchParams(token?.refresh ? { grant_type: 'refresh_token', refresh_token: token.refresh } : { grant_type: 'client_credentials' });
      const data = await json('https://secure.soundcloud.com/oauth/token', { method: 'POST', headers: {
        Authorization: `Basic ${Buffer.from(`${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      }, body });
      if (typeof data.access_token !== 'string') throw new CatalogError('A autorização do catálogo está indisponível.');
      token = { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
      return token.access;
    })();
    try { return await pendingToken; } catch (e) { token = undefined; throw e; } finally { pendingToken = undefined; }
  }
  async function search(source: CatalogSource, query: string, kind: CatalogKind, cursor?: string): Promise<CatalogPage> {
    if (source === 'youtube') {
      const type = kind === 'artist' ? 'channel' : kind === 'playlist' ? 'playlist' : kind === 'all' ? 'video,channel,playlist' : 'video';
      const data = await youtube('search', { part: 'snippet', q: query, type, maxResults: '20', relevanceLanguage: 'pt', ...(type === 'video' ? { videoEmbeddable: 'true' } : {}), ...(cursor ? { pageToken: cursor } : {}) });
      const rows: any[] = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
      const ids = rows.map(r => r.id?.videoId).filter(Boolean);
      const details = ids.length ? await youtube('videos', { part: 'contentDetails,status', id: ids.join(',') }) : { items: [] };
      return { items: rows.map(r => youtubeTrack(r, details.items?.find((d: any) => d.id === r.id?.videoId))).filter((t): t is Track => !!t), next: typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined };
    }
    if (!configured.soundcloud) throw new CatalogError('O catálogo do SoundCloud ainda não foi ativado pelo Glass Music.');
    const endpoints = kind === 'all' ? ['tracks', 'users', 'playlists'] : [kind === 'artist' ? 'users' : kind === 'playlist' ? 'playlists' : 'tracks'];
    let cursors: Record<string, string> | undefined;
    try { cursors = cursor ? JSON.parse(cursor) : undefined; } catch { throw new CatalogError('Página inválida.', 400); }
    const next: Record<string, string> = {}; const auth = await access();
    const pages = await Promise.all(endpoints.map(async endpoint => {
      if (cursors && !cursors[endpoint]) return [];
      const target = cursors?.[endpoint] ? soundcloudCursor(cursors[endpoint], endpoint) : new URL(`https://api.soundcloud.com/${endpoint}?${new URLSearchParams({ q: query, limit: '20', linked_partitioning: 'true' })}`);
      const data = await json(target, { headers: { Authorization: `OAuth ${auth}`, Accept: 'application/json' } });
      if (data.next_href) next[endpoint] = soundcloudCursor(data.next_href, endpoint).href;
      const collection: any[] = Array.isArray(data) ? data : Array.isArray(data.collection) ? data.collection : [];
      const items: Track[] = [];
      for (const row of collection.slice(0, 20)) {
        const sourceId = String(row.urn || row.id || '');
        let url: URL; try { url = new URL(row.permalink_url); } catch { continue; }
        if (!/^[\w:.-]{1,180}$/.test(sourceId) || url.protocol !== 'https:' || url.username || url.password || url.port || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)) continue;
        const seconds = Number(row.duration || 0) / 1000;
        items.push({ id: `soundcloud:${sourceId}`, source: 'soundcloud', sourceId, kind: endpoint === 'users' ? 'artist' : endpoint === 'playlists' ? 'playlist' : 'track',
          title: text(row.title || row.username, 'SoundCloud'), artist: text(row.user?.username || row.username, 'SoundCloud'),
          artwork: artwork(row.artwork_url || row.avatar_url || row.user?.avatar_url), duration: Number.isFinite(seconds) ? Math.max(0, Math.min(604800, seconds)) : 0,
          url: url.href, addedAt: Date.now(), available: row.access === 'blocked' || row.embeddable_by === 'none' ? false : undefined,
          reason: row.access === 'preview' ? 'A plataforma pode disponibilizar apenas uma prévia.' : undefined });
      }
      return items;
    }));
    return { items: pages.flat(), next: Object.keys(next).length ? JSON.stringify(next) : undefined };
  }
  async function discover(source: CatalogSource): Promise<Track[]> {
    if (source === 'soundcloud') return (await search(source, 'electronic', 'track')).items.filter(t => t.available !== false).slice(0, 10);
    const data = await youtube('videos', { part: 'snippet,contentDetails,status', chart: 'mostPopular', videoCategoryId: '10', regionCode: region, maxResults: '20' });
    return (Array.isArray(data.items) ? data.items : []).map((r: any) => youtubeTrack(r, r, true)).filter((t: Track | undefined): t is Track => !!t && t.available !== false).slice(0, 10);
  }
  return { configured, search, discover, region };
}
