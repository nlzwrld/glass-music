import { describe, expect, it, vi } from 'vitest';
import { createCatalog } from '../../server/catalog';
import { soundcloudCursor } from '../../server/catalog-platforms';

const secrets = {
  YOUTUBE_API_KEY: 'owner-youtube-secret',
  SOUNDCLOUD_CLIENT_ID: 'owner-client',
  SOUNDCLOUD_CLIENT_SECRET: 'owner-client-secret',
};

const ytVideo = {
  id: 'M7lc1UVf-VE',
  snippet: {
    title: 'Faixa de teste YouTube',
    channelTitle: 'Canal de teste',
    thumbnails: { high: { url: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg' } },
  },
  contentDetails: { duration: 'PT2M3S' },
  status: { embeddable: true },
};

const scTrack = {
  id: 123,
  urn: 'soundcloud:tracks:123',
  title: 'Faixa de teste SoundCloud',
  user: { username: 'Artista de teste' },
  duration: 90000,
  permalink_url: 'https://soundcloud.com/forss/flickermood',
  access: 'playable',
};

function mockApi() {
  return vi.fn(async (raw: string | URL | Request, _init?: RequestInit) => {
    const u = new URL(String(raw));
    if (u.pathname === '/oauth/token') {
      return Response.json({
        access_token: 'upstream-oauth-secret',
        refresh_token: 'upstream-refresh-secret',
        expires_in: 3600,
      });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.endsWith('/search')) {
      return Response.json({
        items: [{ ...ytVideo, id: { videoId: ytVideo.id } }],
        nextPageToken: u.searchParams.has('pageToken') ? undefined : 'youtube-page-2',
      });
    }
    if (u.hostname === 'www.googleapis.com') {
      return Response.json({ items: [ytVideo] });
    }
    if (u.hostname === 'api.soundcloud.com') {
      return Response.json({
        collection: [scTrack],
        next_href: u.searchParams.has('offset')
          ? undefined
          : 'https://api.soundcloud.com/tracks?q=ambient&offset=20',
      });
    }
    throw new Error(`Unexpected test request ${u.origin}`);
  });
}

async function withServer(
  fn: (url: string, api: ReturnType<typeof mockApi>) => Promise<void>,
  env: NodeJS.ProcessEnv = secrets,
  api = mockApi(),
) {
  const server = createCatalog(env, api as typeof fetch);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(url, api);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('shared catalog, public access with owner-only credentials & cross-platform resolver', () => {
  it('serves real-shaped results without a client API key, deduplicates and caches queries', async () => {
    await withServer(async (base, api) => {
      const url = `${base}/v1/search?source=youtube&kind=track&q=ambient`;
      const replies = await Promise.all([fetch(url), fetch(url)]);
      const first = await replies[0].json();
      const second = await replies[1].json();
      expect(first).toEqual(second);
      expect(first.items[0].duration).toBe(123);
      expect(first.items[0].durationMs).toBe(123000);
      expect(first.items[0].catalogSource).toBe('youtube');
      expect(first.next).toMatch(/^[\w-]{32}$/);
      await fetch(url);
      expect(api.mock.calls.filter(([u]) => String(u).includes('/search?'))).toHaveLength(1);
      const serialized = JSON.stringify(first);
      for (const secret of [...Object.values(secrets), 'upstream-oauth-secret']) {
        expect(serialized).not.toContain(secret);
      }
      expect(new URL(String(api.mock.calls[0][0])).searchParams.get('key')).toBe(
        secrets.YOUTUBE_API_KEY,
      );
    });
  });

  it('binds opaque pages to source, query and kind and never accepts arbitrary cursors', async () => {
    await withServer(async (base, api) => {
      const path = `${base}/v1/search?source=youtube&kind=track&q=ambient`;
      const first = await (await fetch(path)).json();
      expect((await fetch(`${path}&cursor=${first.next}`)).status).toBe(200);
      expect(
        (await fetch(`${base}/v1/search?source=youtube&kind=track&q=other&cursor=${first.next}`))
          .status,
      ).toBe(400);
      expect((await fetch(`${path}&cursor=https://127.0.0.1/private`)).status).toBe(400);
      expect(api.mock.calls.some(([u]) => String(u).includes('pageToken=youtube-page-2'))).toBe(
        true,
      );
    });
    expect(() => soundcloudCursor('https://api.soundcloud.com.evil.test/tracks', 'tracks')).toThrow();
    expect(() => soundcloudCursor('https://user:pass@api.soundcloud.com/tracks', 'tracks')).toThrow();
  });

  it('shares a SoundCloud OAuth token across concurrent requests and keeps it off responses', async () => {
    await withServer(async (base, api) => {
      const responses = await Promise.all(
        ['one', 'two'].map(q =>
          fetch(`${base}/v1/search?source=soundcloud&kind=track&q=${q}`).then(r => r.json()),
        ),
      );
      expect(responses[0].items[0].source).toBe('soundcloud');
      expect(responses[0].items[0].catalogSource).toBe('soundcloud');
      expect(api.mock.calls.filter(([u]) => String(u).includes('/oauth/token'))).toHaveLength(1);
      const oauth = api.mock.calls.find(([u]) => String(u).includes('/oauth/token'))!;
      expect((oauth[1]?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('owner-client:owner-client-secret').toString('base64')}`,
      );
      expect(JSON.stringify(responses)).not.toContain('upstream-oauth-secret');
    });
  });

  it('does not invent catalog items when credentials are absent', async () => {
    await withServer(
      async (base, api) => {
        const health = await (await fetch(`${base}/health`)).json();
        expect(health.providers).toEqual({ youtube: false, soundcloud: false });
        const discovery = await (await fetch(`${base}/v1/discover`)).json();
        expect(discovery.sections).toEqual([]);
        expect(discovery.notices).toHaveLength(2);
        expect((await fetch(`${base}/v1/search?source=youtube&q=x`)).status).toBe(503);
        expect(api).not.toHaveBeenCalled();
      },
      {},
    );
  });

  it('keeps one platform usable when the other fails and retries partial discovery', async () => {
    const api = mockApi();
    const delegate = api.getMockImplementation()!;
    let broken = true;
    api.mockImplementation(async (url, init) =>
      String(url).includes('soundcloud.com') && broken
        ? new Response('{}', { status: 503 })
        : delegate(url, init),
    );
    await withServer(
      async base => {
        const partial = await (await fetch(`${base}/v1/discover`)).json();
        expect(partial.sections.map((s: any) => s.source)).toEqual(['youtube']);
        expect(partial.notices).toHaveLength(1);
        broken = false;
        const complete = await (await fetch(`${base}/v1/discover`)).json();
        expect(complete.sections).toHaveLength(2);
        expect(complete.notices).toEqual([]);
      },
      secrets,
      api,
    );
  });

  it('enforces request limits and ignores forwarded addresses from untrusted clients', async () => {
    await withServer(
      async base => {
        const url = `${base}/v1/search?source=youtube&q=x`;
        expect((await fetch(url)).status).toBe(200);
        expect((await fetch(url, { headers: { 'X-Glass-Client-IP': '1.2.3.4' } })).status).toBe(
          200,
        );
        const blocked = await fetch(url, { headers: { 'X-Glass-Client-IP': '4.3.2.1' } });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('retry-after')).toBe('60');
      },
      { ...secrets, CATALOG_REQUESTS_PER_MINUTE: '2' },
    );
  });

  it('caps uncached YouTube searches independently of end-user credentials', async () => {
    await withServer(
      async (base, api) => {
        expect((await fetch(`${base}/v1/search?source=youtube&q=one`)).status).toBe(200);
        expect((await fetch(`${base}/v1/search?source=youtube&q=one`)).status).toBe(200);
        expect((await fetch(`${base}/v1/search?source=youtube&q=two`)).status).toBe(503);
        expect(api.mock.calls.filter(([u]) => String(u).includes('/search?'))).toHaveLength(1);
      },
      { ...secrets, YOUTUBE_DAILY_SEARCH_LIMIT: '1' },
    );
  });

  it('resolves Spotify-imported track metadata via /v1/resolve in parallel, ranking Topic first, filtering Live/Cover/30s previews, and surviving primary provider outage', async () => {
    let youtubeDown = false;
    const resolverApi = vi.fn(async (raw: string | URL | Request) => {
      const u = new URL(String(raw));
      if (u.pathname === '/oauth/token') {
        return Response.json({ access_token: 'sc-token', expires_in: 3600 });
      }
      if (u.hostname === 'www.googleapis.com') {
        if (youtubeDown) return new Response('{}', { status: 503 });
        if (u.pathname.endsWith('/search')) {
          return Response.json({
            items: [
              {
                id: { videoId: 'topicVid123' },
                snippet: {
                  title: 'One More Time',
                  channelTitle: 'Daft Punk - Topic',
                  thumbnails: { high: { url: 'https://i.ytimg.com/vi/topicVid123/hqdefault.jpg' } },
                },
              },
              {
                id: { videoId: 'liveVid9999' },
                snippet: {
                  title: 'Daft Punk - One More Time (Live Alive 2007)',
                  channelTitle: 'Daft Punk',
                  thumbnails: { high: { url: 'https://i.ytimg.com/vi/liveVid9999/hqdefault.jpg' } },
                },
              },
              {
                id: { videoId: 'longStory00' },
                snippet: {
                  title: 'Daft Punk - One More Time (Extended Story Video)',
                  channelTitle: 'Daft Punk',
                  thumbnails: { high: { url: 'https://i.ytimg.com/vi/longStory00/hqdefault.jpg' } },
                },
              },
            ],
          });
        }
        return Response.json({
          items: [
            { id: 'topicVid123', contentDetails: { duration: 'PT5M20S' }, status: { embeddable: true } },
            { id: 'liveVid9999', contentDetails: { duration: 'PT5M21S' }, status: { embeddable: true } },
            { id: 'longStory00', contentDetails: { duration: 'PT6M15S' }, status: { embeddable: true } },
          ],
        });
      }
      if (u.hostname === 'api.soundcloud.com') {
        return Response.json({
          collection: [
            {
              id: 555,
              urn: 'soundcloud:tracks:555',
              title: 'One More Time',
              user: { username: 'Daft Punk' },
              duration: 320500,
              permalink_url: 'https://soundcloud.com/daftpunk/one-more-time',
              access: 'playable',
            },
            {
              id: 556,
              urn: 'soundcloud:tracks:556',
              title: 'One More Time',
              user: { username: 'Daft Punk' },
              duration: 30000,
              permalink_url: 'https://soundcloud.com/daftpunk/one-more-time-preview',
              access: 'preview',
            },
          ],
        });
      }
      if (u.hostname === 'api.deezer.com') {
        return Response.json({
          data: [
            {
              id: 3135556,
              title: 'One More Time',
              artist: { name: 'Daft Punk' },
              album: { title: 'Discovery', cover_big: 'https://cdn-images.dzcdn.net/images/cover/a/500x500.jpg' },
              duration: 320,
              isrc: 'GBDUW0000053',
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${u.href}`);
    });

    await withServer(
      async base => {
        // 1. All providers healthy -> YT Music Topic wins (#1), Live, Extended Video (+55s), and 30s SoundCloud preview are all rejected!
        const res1 = await fetch(
          `${base}/v1/resolve?title=${encodeURIComponent('One More Time')}&artist=${encodeURIComponent('Daft Punk')}&durationMs=320400&isrc=GBDUW0000053`,
        );
        expect(res1.status).toBe(200);
        const body1 = await res1.json();
        expect(body1.best).toMatchObject({
          provider: 'ytmusic',
          id: 'topicVid123',
          isOfficialTopic: true,
        });
        const ids1 = body1.candidates.map((c: any) => c.id);
        expect(ids1).not.toContain('liveVid9999');
        expect(ids1).not.toContain('longStory00');
        expect(ids1).not.toContain('soundcloud:tracks:556');
        expect(ids1).toContain('3135556');
        expect(ids1).toContain('soundcloud:tracks:555');

        // 2. Exclude primary or simulate YouTube outage -> automatically falls back to Deezer / SoundCloud!
        youtubeDown = true;
        const res2 = await fetch(
          `${base}/v1/resolve?title=${encodeURIComponent('One More Time')}&artist=${encodeURIComponent('Daft Punk')}&durationMs=320400&exclude=topicVid123`,
        );
        expect(res2.status).toBe(200);
        const body2 = await res2.json();
        expect(['deezer', 'soundcloud']).toContain(body2.best.provider);
      },
      { ...secrets, CATALOG_ENABLE_DEEZER: '1' },
      resolverApi as any,
    );
  });
});
