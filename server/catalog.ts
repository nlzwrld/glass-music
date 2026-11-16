import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { CatalogError, createPlatforms, type CatalogKind, type CatalogSource } from './catalog-platforms.ts';

const sources: CatalogSource[] = ['youtube', 'soundcloud'];
const kinds: CatalogKind[] = ['all', 'track', 'artist', 'playlist'];
const bounded = (raw: string | undefined, fallback: number, maximum: number) => Math.max(1, Math.min(maximum, Number(raw) || fallback));

/** Public, read-only catalog. Desktop users need no account, API key or shared secret. */
export function createCatalog(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  const platforms = createPlatforms(env, request);
  const cache = new Map<string, { until: number; value: unknown }>();
  const pending = new Map<string, Promise<any>>();
  const cursors = new Map<string, { until: number; source: string; query: string; kind: string; upstream: string }>();
  const clients = new Map<string, { until: number; count: number }>();
  const limit = bounded(env.CATALOG_REQUESTS_PER_MINUTE, 40, 600);
  const upstreamLimit = bounded(env.CATALOG_UPSTREAM_REQUESTS_PER_MINUTE, 30, 300);
  const trusted = new Set((env.CATALOG_TRUSTED_PROXY_IPS || '').split(',').map(s => s.trim()).filter(Boolean));
  let upstreamWindow = 0, upstreamCount = 0;
  function address(req: IncomingMessage) {
    const direct = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const forwarded = req.headers['x-glass-client-ip'];
    return trusted.has(direct) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : direct;
  }
  function allowed(req: IncomingMessage) {
    const now = Date.now(), key = address(req);
    if (clients.size >= 4096) { for (const [id, v] of clients) if (v.until <= now) clients.delete(id); }
    let state = clients.get(key);
    if (!state || state.until <= now) {
      if (clients.size >= 4096 && !state) return false;
      state = { until: now + 60000, count: 0 }; clients.set(key, state);
    }
    return ++state.count <= limit;
  }
  async function cached(key: string, ttl: number, load: () => Promise<any>) {
    const previous = cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 20) throw new CatalogError('O catálogo está ocupado. Tente novamente em instantes.', 429);
    if (upstreamWindow <= Date.now()) { upstreamWindow = Date.now() + 60000; upstreamCount = 0; }
    if (++upstreamCount > upstreamLimit) throw new CatalogError('Limite temporário de consultas. Tente novamente em um minuto.', 429);
    const promise = load().then(value => {
      // Failed/partial discovery responses must recover on the next request, not linger in cache.
      if (!value.notices?.length) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, { until: Date.now() + ttl, value });
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  }
  function cursorFor(source: string, query: string, kind: string, upstream: string | undefined) {
    if (!upstream) return undefined;
    const now = Date.now(); for (const [id, v] of cursors) if (v.until <= now) cursors.delete(id);
    if (cursors.size >= 1024) cursors.delete(cursors.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    cursors.set(id, { source, query, kind, upstream, until: now + 30 * 60000 }); return id;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { if (!res.destroyed) res.writeHead(status).end(JSON.stringify(body)); };
    try {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: 'Método não permitido.' }); return; }
      if ((req.url?.length || 0) > 4096) { send(414, { error: 'Consulta muito longa.' }); return; }
      const url = new URL(req.url || '/', 'http://catalog.internal');
      if (url.pathname === '/health') { send(200, { service: 'glass-music-catalog', version: 1, providers: platforms.configured }); return; }
      if (!['/v1/search', '/v1/discover'].includes(url.pathname)) { send(404, { error: 'Não encontrado.' }); return; }
      if (!allowed(req)) { res.setHeader('Retry-After', '60'); send(429, { error: 'Aguarde um minuto antes de continuar.' }); return; }
      if (url.pathname === '/v1/discover') {
        const value = await cached('discover', 600000, async () => {
          const sections: unknown[] = [], notices: string[] = [];
          const results = await Promise.allSettled(sources.map(source => platforms.discover(source)));
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') sections.push({ id: `${sources[index]}-public`, source: sources[index], title: index === 0 ? `Música em alta no YouTube · ${platforms.region}` : 'Eletrônica no SoundCloud', items: result.value });
            else notices.push(result.reason instanceof CatalogError ? result.reason.message : 'Um dos catálogos está indisponível.');
          });
          return { sections, notices, providers: platforms.configured };
        });
        send(200, value); return;
      }
      const source = url.searchParams.get('source') as CatalogSource;
      const kind = (url.searchParams.get('kind') || 'track') as CatalogKind;
      const query = (url.searchParams.get('q') || '').trim();
      const cursor = url.searchParams.get('cursor') || '';
      if (!sources.includes(source) || !kinds.includes(kind) || !query || [...query].length > 200 || cursor.length > 100) { send(400, { error: 'Pesquisa inválida.' }); return; }
      let upstream: string | undefined;
      if (cursor) {
        const stored = cursors.get(cursor);
        if (!stored || stored.until <= Date.now() || stored.source !== source || stored.query !== query || stored.kind !== kind) { send(400, { error: 'Esta página expirou. Faça a busca novamente.' }); return; }
        upstream = stored.upstream;
      }
      const value = await cached(JSON.stringify([source, query, kind, cursor]), 300000, async () => {
        const page = await platforms.search(source, query, kind, upstream);
        return { items: page.items, next: cursorFor(source, query, kind, page.next) };
      });
      send(200, value);
    } catch (error) {
      const status = error instanceof CatalogError ? error.status : 502;
      if (status === 429) res.setHeader('Retry-After', '60');
      send(status, { error: error instanceof CatalogError ? error.message : 'O catálogo está temporariamente indisponível.' });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 256;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache) if (value.until <= now) cache.delete(key);
    for (const [key, value] of cursors) if (value.until <= now) cursors.delete(key);
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
  }, 30000);
  cleanup.unref(); server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || process.env.CATALOG_PORT || 8788);
  const host = process.env.CATALOG_HOST || '127.0.0.1';
  createCatalog().listen(port, host, () => console.log(`Glass Music Catalog em ${host}:${port}. Credenciais somente no servidor.`));
}
