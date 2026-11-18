import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { CatalogError, createPlatforms, type CatalogKind, type CatalogSource } from './catalog-platforms.ts';

const discoverySources: CatalogSource[] = ['youtube', 'soundcloud'];
const searchSources: CatalogSource[] = ['youtube', 'soundcloud', 'deezer'];
const kinds: CatalogKind[] = ['all', 'track', 'artist', 'playlist'];
const bounded = (raw: string | undefined, fallback: number, maximum: number) =>
  Math.max(1, Math.min(maximum, Number(raw) || fallback));

/** Public, read-only Liquid Hub catalog with Zero-Trust IP + User-ID rate limiting & strict query contracts. */
export function createCatalog(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  const platforms = createPlatforms(env, request);
  const cache = new Map<string, { until: number; value: unknown }>();
  const pending = new Map<string, Promise<any>>();
  const cursors = new Map<
    string,
    { until: number; source: string; query: string; kind: string; upstream: string }
  >();
  const clients = new Map<string, { until: number; count: number }>();
  const limit = bounded(env.CATALOG_REQUESTS_PER_MINUTE, 40, 600);
  const upstreamLimit = bounded(env.CATALOG_UPSTREAM_REQUESTS_PER_MINUTE, 30, 300);
  const trusted = new Set(
    (env.CATALOG_TRUSTED_PROXY_IPS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
  let upstreamWindow = 0,
    upstreamCount = 0;

  function address(req: IncomingMessage) {
    const direct = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const forwarded =
      req.headers['x-liquid-client-ip'] ?? req.headers['x-glass-client-ip'];
    return trusted.has(direct) && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded
      : direct;
  }

  function userBucketKey(req: IncomingMessage): string | null {
    const direct = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const trustedUser = req.headers['x-liquid-user-id'];
    if (trusted.has(direct) && typeof trustedUser === 'string' && /^[\w:.-]{3,120}$/.test(trustedUser)) {
      return `usr:${trustedUser}`;
    }
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length <= 4096) {
      return `tok:${createHash('sha256').update(auth.slice(7)).digest('base64url').slice(0, 22)}`;
    }
    return null;
  }

  function consumeBucket(key: string, maxRequests: number, now: number): boolean {
    if (clients.size >= 4096) {
      for (const [id, v] of clients) if (v.until <= now) clients.delete(id);
    }
    let state = clients.get(key);
    if (!state || state.until <= now) {
      if (clients.size >= 4096 && !state) return false;
      state = { until: now + 60000, count: 0 };
      clients.set(key, state);
    }
    return ++state.count <= maxRequests;
  }

  function allowed(req: IncomingMessage, routeMultiplier = 1) {
    const now = Date.now();
    const ipOk = consumeBucket(`ip:${address(req)}`, limit * routeMultiplier, now);
    if (!ipOk) return false;
    const usrKey = userBucketKey(req);
    if (usrKey && !consumeBucket(usrKey, limit * routeMultiplier, now)) return false;
    return true;
  }

  async function cached(key: string, ttl: number, load: () => Promise<any>) {
    const previous = cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 20)
      throw new CatalogError('O catálogo está ocupado. Tente novamente em instantes.', 429);
    if (upstreamWindow <= Date.now()) {
      upstreamWindow = Date.now() + 60000;
      upstreamCount = 0;
    }
    if (++upstreamCount > upstreamLimit)
      throw new CatalogError('Limite temporário de consultas. Tente novamente em um minuto.', 429);
    const promise = load()
      .then(value => {
        if (!value.notices?.length) {
          if (cache.size >= 256) cache.delete(cache.keys().next().value!);
          cache.set(key, { until: Date.now() + ttl, value });
        }
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  function cursorFor(source: string, query: string, kind: string, upstream: string | undefined) {
    if (!upstream) return undefined;
    const now = Date.now();
    for (const [id, v] of cursors) if (v.until <= now) cursors.delete(id);
    if (cursors.size >= 1024) cursors.delete(cursors.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    cursors.set(id, { source, query, kind, upstream, until: now + 30 * 60000 });
    return id;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Service', 'liquid-hub-catalog');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status: number, body: unknown) => {
      if (!res.destroyed) res.writeHead(status).end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        send(405, { error: 'Método não permitido.' });
        return;
      }
      if ((req.url?.length || 0) > 4096) {
        send(414, { error: 'Consulta muito longa.' });
        return;
      }
      const url = new URL(req.url || '/', 'http://catalog.internal');
      if (url.pathname === '/health') {
        if (!allowed(req, 3)) {
          res.setHeader('Retry-After', '60');
          send(429, { error: 'Aguarde um minuto antes de continuar.' });
          return;
        }
        send(200, { service: 'liquid-hub-catalog', version: 2, providers: platforms.configured });
        return;
      }
      if (!['/v1/search', '/v1/discover', '/v1/resolve'].includes(url.pathname)) {
        send(404, { error: 'Não encontrado.' });
        return;
      }
      if (!allowed(req)) {
        res.setHeader('Retry-After', '60');
        send(429, { error: 'Aguarde um minuto antes de continuar.' });
        return;
      }

      if (url.pathname === '/v1/resolve') {
        for (const key of url.searchParams.keys()) {
          if (!['title', 'artist', 'durationMs', 'isrc', 'exclude'].includes(key)) {
            send(400, { error: 'Parâmetro de consulta não permitido.' });
            return;
          }
        }
        const title = (url.searchParams.get('title') || '').trim();
        const artist = (url.searchParams.get('artist') || '').trim();
        const durationMs = Math.max(0, Math.min(604_800_000, Number(url.searchParams.get('durationMs') || 0)));
        const isrc = (url.searchParams.get('isrc') || '').trim() || undefined;
        const excludeIds = (url.searchParams.get('exclude') || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 20);
        if (!title || title.length > 200 || artist.length > 200) {
          send(400, { error: 'Parâmetros de resolução inválidos.' });
          return;
        }
        const value = await cached(
          JSON.stringify(['resolve', title.toLowerCase(), artist.toLowerCase(), durationMs, isrc, excludeIds]),
          300000,
          async () => {
            const candidates = await platforms.resolveCrossPlatform({
              title,
              artist: artist || 'Spotify',
              durationMs,
              isrc,
              excludeIds,
            });
            return { best: candidates[0] || null, candidates };
          },
        );
        send(200, value);
        return;
      }

      if (url.pathname === '/v1/discover') {
        if ([...url.searchParams.keys()].length > 0) {
          send(400, { error: 'Parâmetros de consulta não permitidos.' });
          return;
        }
        const value = await cached('discover', 600000, async () => {
          const sections: unknown[] = [],
            notices: string[] = [];
          const results = await Promise.allSettled(
            discoverySources.map(source => platforms.discover(source)),
          );
          results.forEach((result, index) => {
            if (result.status === 'fulfilled')
              sections.push({
                id: `${discoverySources[index]}-public`,
                source: discoverySources[index],
                title:
                  index === 0
                    ? `Música em alta no YouTube · ${platforms.region}`
                    : 'Eletrônica no SoundCloud',
                items: result.value,
              });
            else
              notices.push(
                result.reason instanceof CatalogError
                  ? result.reason.message
                  : 'Um dos catálogos está indisponível.',
              );
          });
          return { sections, notices, providers: platforms.configured };
        });
        send(200, value);
        return;
      }

      // Strict parameter contract for /v1/search
      for (const key of url.searchParams.keys()) {
        if (!['source', 'kind', 'q', 'cursor'].includes(key)) {
          send(400, { error: 'Parâmetro de consulta não permitido.' });
          return;
        }
      }
      const source = url.searchParams.get('source') as CatalogSource;
      const kind = (url.searchParams.get('kind') || 'track') as CatalogKind;
      const query = (url.searchParams.get('q') || '').trim();
      const cursor = url.searchParams.get('cursor') || '';
      if (
        !searchSources.includes(source) ||
        !kinds.includes(kind) ||
        !query ||
        [...query].length > 200 ||
        cursor.length > 100
      ) {
        send(400, { error: 'Pesquisa inválida.' });
        return;
      }
      let upstream: string | undefined;
      if (cursor) {
        const stored = cursors.get(cursor);
        if (
          !stored ||
          stored.until <= Date.now() ||
          stored.source !== source ||
          stored.query !== query ||
          stored.kind !== kind
        ) {
          send(400, { error: 'Esta página expirou. Faça a busca novamente.' });
          return;
        }
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
      send(status, {
        error:
          error instanceof CatalogError
            ? error.message
            : 'O catálogo está temporariamente indisponível.',
      });
    }
  });

  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache) if (value.until <= now) cache.delete(key);
    for (const [key, value] of cursors) if (value.until <= now) cursors.delete(key);
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
  }, 30000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || process.env.CATALOG_PORT || 8788);
  const host = process.env.CATALOG_HOST || '127.0.0.1';
  createCatalog().listen(port, host, () =>
    console.log(`Liquid Hub Catalog em ${host}:${port}. Credenciais somente no servidor.`),
  );
}
