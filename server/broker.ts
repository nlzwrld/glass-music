/** Optional personal API broker. Deploy separately; never bundle client_secret in the desktop app. */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Track } from '../shared/types.ts';
type Token = { access_token: string; refresh_token?: string; expires: number };
export function validNext(raw: string, kind: string) {
  const u = new URL(raw); if (u.origin !== 'https://api.soundcloud.com' || u.pathname !== `/${kind}`) throw new Error('Cursor inválido');
  return u;
}
export function createBroker(env = process.env, request = fetch) {
  const secret = env.BROKER_ACCESS_TOKEN || '';
  if (secret.length < 24 || !env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) throw new Error('Configure SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET e BROKER_ACCESS_TOKEN (24+ caracteres) no servidor.');
  let token: Token | undefined; let pendingToken: Promise<string> | undefined;
  async function access(): Promise<string> {
    if (token && token.expires > Date.now() + 60000) return token.access_token;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const body = new URLSearchParams(token?.refresh_token ? { grant_type: 'refresh_token', refresh_token: token.refresh_token } : { grant_type: 'client_credentials' });
      const r = await request('https://secure.soundcloud.com/oauth/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!r.ok) throw new Error('A autorização do servidor SoundCloud falhou.');
      const value = await r.json() as any; if (typeof value.access_token !== 'string') throw new Error('Resposta de autorização inválida.');
      token = { ...value, expires: Date.now() + Number(value.expires_in || 3600) * 1000 }; return token!.access_token;
    })();
    try { return await pendingToken; } finally { pendingToken = undefined; }
  }
  let requests = 0; let windowStart = Date.now();
  return createServer(async (req, res) => {
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    const provided = Buffer.from((req.headers.authorization || '').replace(/^Bearer /,'')); const expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401).end('{"error":"Não autorizado"}'); return; }
    if (Date.now() - windowStart > 60000) { requests = 0; windowStart = Date.now(); }
    if (++requests > 40) { res.writeHead(429, { 'Retry-After': '60' }).end('{"error":"Aguarde"}'); return; }
    try {
      const u = new URL(req.url || '/', 'http://localhost'); if (req.method !== 'GET' || u.pathname !== '/search') { res.writeHead(404).end('{}'); return; }
      const q = (u.searchParams.get('q') || '').trim(); const kind = u.searchParams.get('kind') || 'track';
      if (!q || q.length > 200 || !['all','track','artist','playlist'].includes(kind)) { res.writeHead(400).end('{}'); return; }
      const rawCursor = u.searchParams.get('cursor'); if (rawCursor && rawCursor.length > 2000) throw new Error('Cursor muito grande');
      const cursors: Record<string,string> | undefined = rawCursor ? JSON.parse(Buffer.from(rawCursor,'base64url').toString('utf8')) : undefined;
      const kinds = kind === 'all' ? ['tracks','users','playlists'] : [kind === 'track' ? 'tracks' : kind === 'artist' ? 'users' : 'playlists'];
      const auth = await access(); const next: Record<string,string> = {}; const items: Track[] = [];
      await Promise.all(kinds.map(async endpoint => {
        if (cursors && !cursors[endpoint]) return;
        const target = cursors?.[endpoint] ? validNext(cursors[endpoint], endpoint) : new URL(`https://api.soundcloud.com/${endpoint}?${new URLSearchParams({ q, limit: '20', linked_partitioning: 'true' })}`);
        const r = await request(target, { headers: { Authorization: `OAuth ${auth}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!r.ok) { if (r.status === 401) token = undefined; res.statusCode = [401,403,429].includes(r.status) ? r.status : 502; throw new Error('SoundCloud indisponível'); }
        const data = await r.json() as any; const collection = Array.isArray(data) ? data : data.collection || [];
        if (data.next_href) next[endpoint] = validNext(data.next_href, endpoint).toString();
        collection.forEach((v: any) => {
          const sourceId = String(v.urn || v.id).replace(/[^\w:.-]/g,''); const trackKind = endpoint === 'users' ? 'artist' : endpoint === 'playlists' ? 'playlist' : 'track';
          items.push({ id: `soundcloud:${sourceId}`, sourceId, source: 'soundcloud', kind: trackKind, title: v.title || v.username || 'SoundCloud', artist: v.user?.username || v.username || 'SoundCloud', artwork: v.artwork_url || v.avatar_url || v.user?.avatar_url, duration: (v.duration || 0) / 1000, url: v.permalink_url, addedAt: Date.now(), available: v.access === 'blocked' || v.embeddable_by === 'none' ? false : undefined, reason: v.access === 'blocked' ? 'Reprodução restrita pela plataforma.' : v.access === 'preview' ? 'A plataforma pode disponibilizar apenas uma prévia.' : undefined });
        });
      }));
      res.end(JSON.stringify({ items, next: Object.keys(next).length ? Buffer.from(JSON.stringify(next)).toString('base64url') : undefined }));
    } catch { if (!res.headersSent) { res.statusCode = res.statusCode >= 400 ? res.statusCode : 502; res.end('{"error":"Não foi possível consultar o SoundCloud."}'); } }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BROKER_PORT || 8787); createBroker().listen(port, '127.0.0.1', () => console.log(`Servidor pessoal ativo em 127.0.0.1:${port}. Credenciais nunca são retornadas ao cliente.`));
}
