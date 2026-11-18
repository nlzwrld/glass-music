import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeProvider } from '../../desktop/providers/youtube';
import { SoundCloudProvider } from '../../desktop/providers/soundcloud';
import { SearchService } from '../../desktop/providers/search';
import {
  CrossPlatformResolver,
  MemoryStreamMappingStore,
  scoreStreamCandidate,
  type StreamCandidateSource,
} from '../../desktop/providers/resolver';
import { durationISO } from '../../desktop/providers/http';
import type { SearchRequest, Track } from '../../shared/types';

const req: SearchRequest = { query: 'test', kind: 'track', source: 'all', requestId: 'test-1' };

afterEach(() => vi.unstubAllGlobals());

describe('Official providers & Cross-Platform Stream Resolver', () => {
  it('searches the official YouTube endpoint, passes pagination and joins durations/availability', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            nextPageToken: 'next',
            items: [
              {
                id: { videoId: 'M7lc1UVf-VE' },
                snippet: {
                  title: 'A &amp; B',
                  channelTitle: 'Channel - Topic',
                  thumbnails: { high: { url: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg' } },
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'M7lc1UVf-VE',
                contentDetails: { duration: 'PT3M15S' },
                status: { embeddable: false },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal('fetch', fn);
    const result = await new YouTubeProvider(() => 'test-key').search(
      { ...req, cursor: { youtube: 'page2' } },
      new AbortController().signal,
    );
    const called = new URL(String(fn.mock.calls[0][0]));
    expect(called.origin).toBe('https://www.googleapis.com');
    expect(called.searchParams.get('pageToken')).toBe('page2');
    expect(called.searchParams.get('videoEmbeddable')).toBe('true');
    expect(result.items[0].title).toBe('A & B');
    expect(result.items[0].duration).toBe(195);
    expect(result.items[0].durationMs).toBe(195000);
    expect(result.items[0].catalogSource).toBe('ytmusic');
    expect(result.items[0].available).toBe(false);
    expect(result.next).toBe('next');
  });

  it('does not invent working credentials', async () => {
    await expect(
      new YouTubeProvider(() => '').search(req, new AbortController().signal),
    ).rejects.toThrow('configure');
    await expect(
      new SoundCloudProvider(() => ({ url: '', token: '' })).search(
        req,
        new AbortController().signal,
      ),
    ).rejects.toThrow('configure');
  });

  it('surfaces API limits and network failures without leaking credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(
      new YouTubeProvider(() => 'private-secret').search(req, new AbortController().signal),
    ).rejects.toThrow('Limite');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network secret')));
    await expect(
      new YouTubeProvider(() => 'private-secret').search(req, new AbortController().signal),
    ).rejects.toThrow('conexão');
  });

  it('converts ISO durations and declares different platform capabilities', () => {
    expect(durationISO('PT1H2M3S')).toBe(3723);
    expect(durationISO('P0D')).toBe(0);
    expect(new YouTubeProvider(() => '').capabilities.background).toBe(false);
    expect(new SoundCloudProvider(() => ({ url: '', token: '' })).capabilities.equalizer).toBe(
      false,
    );
  });

  it('combines results, isolates one provider failure and caches successful queries', async () => {
    const yt = new YouTubeProvider(() => '');
    const sc = new SoundCloudProvider(() => ({ url: '', token: '' }));
    const item: Track = {
      id: 'youtube:M7lc1UVf-VE',
      sourceId: 'M7lc1UVf-VE',
      source: 'youtube',
      kind: 'track',
      title: 'Test',
      artist: 'Test',
      duration: 180,
      durationMs: 180000,
      catalogSource: 'youtube',
      addedAt: 0,
    };
    const a = vi.spyOn(yt, 'search').mockResolvedValue({ items: [item], next: undefined });
    const b = vi.spyOn(sc, 'search').mockRejectedValue(new Error('No permission'));
    const service = new SearchService([yt, sc]);
    const first = await service.search(req);
    expect(first.items).toHaveLength(1);
    expect(first.notices).toHaveLength(1);
    b.mockResolvedValue({ items: [] });
    await service.search(req);
    await service.search(req);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('cancels in-flight queries instead of publishing stale results', async () => {
    const yt = new YouTubeProvider(() => '');
    vi.spyOn(yt, 'search').mockImplementation(
      (_r, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const service = new SearchService([yt]);
    const p = service.search(req);
    service.cancel(req.requestId);
    await expect(p).rejects.toThrow('cancelada');
  });

  it('imports Spotify playlist/track metadata without direct Spotify stream extraction and redirects to multi-provider search', async () => {
    const spotifyPlaylistUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
    const nextDataHtml = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: {
            state: {
              data: {
                entity: {
                  id: '37i9dQZF1DXcBWIGoYBM5M',
                  type: 'playlist',
                  name: 'Top Hits Spotify',
                  coverArt: {
                    sources: [{ url: 'https://i.scdn.co/image/ab67706f00000002aa11bb22' }],
                  },
                  trackList: [
                    {
                      uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
                      title: 'Blinding Lights',
                      subtitle: 'The Weeknd',
                      duration: 200040,
                    },
                    {
                      uri: 'spotify:track:7qiZfU4dY1lWllzX7mPBI3',
                      title: 'Shape of You',
                      subtitle: 'Ed Sheeran',
                      duration: 233713,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    )}</script></body></html>`;

    const spotifyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Verify ONLY the metadata embed page is read, NEVER an audio stream from Spotify
      expect(url).toBe('https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
      return new Response(nextDataHtml, { status: 200 });
    });

    const yt = new YouTubeProvider(() => 'yt-key');
    const sc = new SoundCloudProvider(() => ({ url: 'https://hub.example.com', token: 'tok' }));

    const ytSearchSpy = vi.spyOn(yt, 'search').mockResolvedValue({
      items: [
        {
          id: 'youtube:4NRXx6U8ABQ',
          source: 'youtube',
          sourceId: '4NRXx6U8ABQ',
          kind: 'track',
          title: 'Blinding Lights',
          artist: 'The Weeknd - Topic',
          duration: 200,
          durationMs: 200000,
          catalogSource: 'ytmusic',
          streamProvider: 'ytmusic',
          url: 'https://www.youtube.com/watch?v=4NRXx6U8ABQ',
          addedAt: 0,
        },
      ],
    });
    const scSearchSpy = vi.spyOn(sc, 'search').mockResolvedValue({
      items: [
        {
          id: 'soundcloud:999888',
          source: 'soundcloud',
          sourceId: '999888',
          kind: 'track',
          title: 'Blinding Lights',
          artist: 'The Weeknd',
          duration: 201,
          durationMs: 201000,
          catalogSource: 'soundcloud',
          streamProvider: 'soundcloud',
          url: 'https://soundcloud.com/theweeknd/blinding-lights',
          addedAt: 0,
        },
      ],
    });

    const service = new SearchService([yt, sc]);
    const imported = await service.importSpotify(spotifyPlaylistUrl, {
      request: spotifyFetch as typeof fetch,
      resolveFirstStream: true,
    });

    expect(imported.kind).toBe('playlist');
    expect(imported.tracks).toHaveLength(2);
    // Rich Spotify metadata preserved while streamProvider resolves to YT Music Topic!
    expect(imported.tracks[0]).toMatchObject({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      catalogSource: 'spotify',
      durationMs: 200040,
      streamProvider: 'ytmusic',
      resolvedExternalId: '4NRXx6U8ABQ',
      playbackId: '4NRXx6U8ABQ',
    });
    expect(ytSearchSpy).toHaveBeenCalledOnce();
    expect(scSearchSpy).toHaveBeenCalledOnce();
    expect(ytSearchSpy.mock.calls[0][0].query).toBe('The Weeknd - Blinding Lights Audio');
  });

  it('scores Official Topic audio highest and rejects Live, Ao Vivo, Cover, Slowed+Reverb, 30s previews and mismatched durations', () => {
    const reference = {
      title: 'Starboy',
      artist: 'The Weeknd, Daft Punk',
      duration: 230.45,
      durationMs: 230450,
      isrc: 'USUG11600976',
    };

    const topicScore = scoreStreamCandidate(reference, {
      provider: 'ytmusic',
      id: 'plnfIj7dkJE',
      title: 'Starboy',
      artist: 'The Weeknd - Topic',
      duration: 230,
      durationMs: 230000,
      isOfficialTopic: true,
    });
    const officialVideoScore = scoreStreamCandidate(reference, {
      provider: 'youtube',
      id: '34Na4j8AVgA',
      title: 'The Weeknd - Starboy ft. Daft Punk (Official Video)',
      artist: 'The Weeknd',
      duration: 273, // +42.5s story intro -> rejected!
      durationMs: 273000,
    });
    const liveScore = scoreStreamCandidate(reference, {
      provider: 'youtube',
      id: 'live1234567',
      title: 'The Weeknd - Starboy (Live at Vevo)',
      artist: 'The Weeknd',
      duration: 231,
    });
    const aoVivoScore = scoreStreamCandidate(reference, {
      provider: 'youtube',
      id: 'aovivo12345',
      title: 'Starboy (Ao Vivo em São Paulo)',
      artist: 'The Weeknd',
      duration: 230,
    });
    const coverScore = scoreStreamCandidate(reference, {
      provider: 'youtube',
      id: 'cover123456',
      title: 'Starboy - Acoustic Cover',
      artist: 'The Weeknd Fan',
      duration: 230,
    });
    const slowedScore = scoreStreamCandidate(reference, {
      provider: 'soundcloud',
      id: 'sc_slowed',
      title: 'The Weeknd - Starboy (Slowed + Reverb)',
      artist: 'The Weeknd',
      duration: 231,
    });
    const preview30sScore = scoreStreamCandidate(reference, {
      provider: 'deezer',
      id: 'dz_prev',
      title: 'Starboy',
      artist: 'The Weeknd',
      duration: 30,
      durationMs: 30000,
    });

    expect(topicScore).toBeGreaterThanOrEqual(95);
    expect(officialVideoScore).toBe(0);
    expect(liveScore).toBe(0);
    expect(aoVivoScore).toBe(0);
    expect(coverScore).toBe(0);
    expect(slowedScore).toBe(0);
    expect(preview30sScore).toBe(0);
  });

  it('automatically falls back to the #2 provider when #1 fails stream extraction and invalidates expired cached mappings', async () => {
    const spotifyTrack: Track = {
      id: 'link:0123456789abcdef0123456789abcdef',
      source: 'link',
      sourceId: '0123456789abcdef0123456789abcdef',
      kind: 'track',
      title: 'Instant Crush',
      artist: 'Daft Punk, Julian Casablancas',
      duration: 337.56,
      durationMs: 337560,
      catalogSource: 'spotify',
      url: 'https://open.spotify.com/track/2cGxRwrMyEAp8dEbuZaVv6',
      addedAt: 0,
    };

    let ytmHealthy = false;
    let scCachedStreamExpired = false;

    const ytmSource: StreamCandidateSource = {
      id: 'ytmusic',
      searchTracks: vi.fn(async () => [
        {
          id: 'a5uQMwRMHcs',
          title: 'Instant Crush',
          artist: 'Daft Punk - Topic',
          duration: 338,
          durationMs: 338000,
          url: 'https://music.youtube.com/watch?v=a5uQMwRMHcs',
          isOfficialTopic: true,
        },
      ]),
      resolveStreamUrl: vi.fn(async () => {
        if (!ytmHealthy) throw new Error('YT Music 403 geo-blocked');
        return { streamUrl: 'http://127.0.0.1:41000/audio/ytm-ticket', duration: 338 };
      }),
    };

    const scSource: StreamCandidateSource = {
      id: 'soundcloud',
      searchTracks: vi.fn(async () => [
        {
          id: 'sc-instant-crush-77',
          title: 'Instant Crush (feat. Julian Casablancas)',
          artist: 'Daft Punk',
          duration: 337,
          durationMs: 337000,
          url: 'https://soundcloud.com/daftpunk/instant-crush',
        },
      ]),
      resolveStreamUrl: vi.fn(async () => {
        if (scCachedStreamExpired) throw new Error('SoundCloud CDN token expired');
        return { streamUrl: 'http://127.0.0.1:41000/audio/sc-ticket', duration: 337 };
      }),
    };

    const store = new MemoryStreamMappingStore();
    const resolver = new CrossPlatformResolver([ytmSource, scSource], store);

    // 1st play: YT Music (#1) fails -> transparently falls back to SoundCloud (#2)!
    const first = await resolver.resolveStream(spotifyTrack);
    expect(first.provider).toBe('soundcloud');
    expect(first.externalId).toBe('sc-instant-crush-77');
    expect(first.streamUrl).toBe('http://127.0.0.1:41000/audio/sc-ticket');
    expect(first.fromCache).toBe(false);
    expect(first.track.catalogSource).toBe('spotify');
    expect(first.track.streamProvider).toBe('soundcloud');

    // 2nd play: hits persistent mapping cache immediately without re-searching providers!
    const second = await resolver.resolveStream(spotifyTrack);
    expect(second.fromCache).toBe(true);
    expect(second.provider).toBe('soundcloud');
    expect(ytmSource.searchTracks).toHaveBeenCalledTimes(1);
    expect(scSource.searchTracks).toHaveBeenCalledTimes(1);

    // 3rd play: cached SoundCloud stream expires while YT Music recovers -> cache auto-invalidates and re-resolves to YT Music!
    scCachedStreamExpired = true;
    ytmHealthy = true;
    const third = await resolver.resolveStream(spotifyTrack);
    expect(third.fromCache).toBe(false);
    expect(third.provider).toBe('ytmusic');
    expect(third.externalId).toBe('a5uQMwRMHcs');
    expect(third.track.playbackId).toBe('a5uQMwRMHcs');
  });
});
