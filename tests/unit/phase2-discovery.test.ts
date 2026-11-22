import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults, type CatalogResult, type Snapshot, type Track } from '../../shared/types';
import {
  buildSmartShuffleProfile,
  orderSmartShuffleTracks,
  pickSmartShuffleIndex,
  scoreSmartShuffleCandidate,
} from '../../src/lib/smartShuffle';
import { shufflePlay } from '../../src/lib/playback';
import { classifySearchTier, rankSearchTracks } from '../../src/lib/searchRanking';
import {
  buildTasteProfile,
  clearRecommendationsCache,
  fetchPersonalizedTracks,
  rankCatalogByTaste,
} from '../../src/lib/recommendations';
import {
  clearDiscoveryCache,
  discoverMusic,
  hydrateDiscoveries,
} from '../../src/lib/discovery';
import {
  inspectMusicLink,
  registerLinkProvider,
} from '../../src/lib/playlist';
import { formatBytes } from '../../src/pages/Downloads';
import { looksLikeMusicLink, useApp } from '../../src/stores/app';

function makeTrack(
  id: string,
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    source: 'youtube',
    sourceId: id.replace(/^[^:]+:/, ''),
    kind: 'track',
    title: `Faixa ${id}`,
    artist: `Artista ${id}`,
    duration: 210,
    addedAt: 1000,
    ...overrides,
  };
}

function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };
}

function makeSnapshot(tracks: Track[], extras: Partial<Snapshot> = {}): Snapshot {
  return {
    tracks,
    playlists: [
      {
        id: 'pl-main',
        name: 'Mix Principal',
        trackIds: tracks.map(t => t.id),
        createdAt: 1000,
      },
    ],
    likes: [],
    history: [],
    preferences: { ...defaults },
    ...extras,
  };
}

afterEach(() => {
  clearRecommendationsCache();
  clearDiscoveryCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useApp.setState({
    queue: [],
    index: -1,
    shufflePlayed: [],
    shuffleNext: null,
    smartShuffleSteps: 0,
    downloadItems: {},
    downloadingIds: [],
    downloadsPaused: false,
    playing: false,
    data: makeSnapshot([]),
  });
});

describe('Phase 2: Smart Shuffle engine and playlist fidelity', () => {
  it('penalizes recent & overplayed tracks while favoring likes, older favorites, and artist diversity', () => {
    const rockFav = makeTrack('yt:rock1', {
      title: 'Everlong Rock Anthem',
      artist: 'Foo Fighters',
      album: 'The Colour and the Shape',
    });
    const sameArtist = makeTrack('yt:rock2', {
      title: 'Best of You Rock',
      artist: 'Foo Fighters',
      album: 'In Your Honor',
    });
    const overplayed = makeTrack('yt:pop1', {
      title: 'Overplayed Pop Hit',
      artist: 'Neon Singer',
    });
    const olderGem = makeTrack('yt:mpb1', {
      title: 'Construção MPB Clássica',
      artist: 'Chico Buarque',
      album: 'Construção',
    });
    const elecPick = makeTrack('yt:elec1', {
      title: 'Midnight House Synthwave',
      artist: 'Kavinsky',
    });

    const recentHistory = [
      { id: overplayed.id, playedAt: 9900 },
      { id: overplayed.id, playedAt: 9800 },
      { id: overplayed.id, playedAt: 9700 },
      { id: overplayed.id, playedAt: 9600 },
    ];
    const olderHistory = Array.from({ length: 40 }, (_, i) => ({
      id: i === 36 ? olderGem.id : `yt:filler-${i}`,
      playedAt: 5000 - i * 10,
    }));

    const ctx = {
      history: [...recentHistory, ...olderHistory],
      likes: [olderGem.id, rockFav.id],
      libraryTracks: [rockFav, sameArtist, overplayed, olderGem, elecPick],
      currentTrack: sameArtist,
    };
    const profile = buildSmartShuffleProfile(ctx);

    const sameArtistScore = scoreSmartShuffleCandidate(rockFav, 0, ctx, profile, {
      applyArtistDiversity: true,
    });
    const overplayedScore = scoreSmartShuffleCandidate(overplayed, 2, ctx, profile, {
      applyArtistDiversity: true,
    });
    const olderGemScore = scoreSmartShuffleCandidate(olderGem, 3, ctx, profile, {
      applyArtistDiversity: true,
    });

    expect(sameArtistScore.diversityFactor).toBeLessThan(0.3);
    expect(sameArtistScore.reasons).toContain('evitar-mesmo-artista');
    expect(overplayedScore.recencyFactor).toBeLessThan(0.25);
    expect(overplayedScore.overplayFactor).toBeLessThan(0.5);
    expect(olderGemScore.olderPreferenceBonus).toBeGreaterThan(0);
    expect(olderGemScore.reasons).toContain('preferencia-antiga');
    expect(olderGemScore.score).toBeGreaterThan(overplayedScore.score);
  });

  it('avoids consecutive same-artist clustering when ordering and stepping through diverse queues', () => {
    const queue = [
      makeTrack('t1', { artist: 'Daft Punk', title: 'Track 1 Electronic' }),
      makeTrack('t2', { artist: 'Daft Punk', title: 'Track 2 Electronic' }),
      makeTrack('t3', { artist: 'Radiohead', title: 'Track 3 Rock' }),
      makeTrack('t4', { artist: 'Radiohead', title: 'Track 4 Rock' }),
      makeTrack('t5', { artist: 'Miles Davis', title: 'Track 5 Jazz' }),
    ];

    const ordered = orderSmartShuffleTracks(
      queue,
      {
        history: [{ id: 't1', playedAt: 5000 }],
        likes: ['t5'],
        libraryTracks: queue,
      },
      () => 0.05,
    );
    expect(ordered).toHaveLength(5);
    expect(new Set(ordered.map(t => t.id)).size).toBe(5);

    const picked = pickSmartShuffleIndex(
      queue,
      0,
      [0],
      false,
      {
        history: [{ id: 't1', playedAt: 5000 }],
        likes: ['t5'],
        libraryTracks: queue,
      },
      () => 0.05,
    );
    expect(picked.next).not.toBeNull();
    expect(picked.next).not.toBe(0);
    expect(queue[picked.next!]!.artist).not.toBe('Daft Punk');
  });

  it('distinguishes smart vs standard shuffle and inserts discoveries only when opted in without mutating playlists', async () => {
    const playlistTracks = [
      makeTrack('p1', { artist: 'Artist A', title: 'One Rock' }),
      makeTrack('p2', { artist: 'Artist B', title: 'Two Pop' }),
      makeTrack('p3', { artist: 'Artist C', title: 'Three Indie' }),
      makeTrack('p4', { artist: 'Artist D', title: 'Four Jazz' }),
      makeTrack('p5', { artist: 'Artist E', title: 'Five MPB' }),
    ];
    const discoveryTrack = makeTrack('rec1', {
      artist: 'Discovery Artist',
      title: 'Fresh Discovery',
    });
    const recommendations = vi.fn(async () => [discoveryTrack]);
    vi.stubGlobal('window', {
      glass: {
        recommendations,
        preferences: vi.fn(async (p: any) => makeSnapshot(playlistTracks, { preferences: p })),
        history: vi.fn(async () => makeSnapshot(playlistTracks)),
      },
    });

    // Standard shuffle leaves playlist trackIds untouched and never pulls discoveries
    const standardSnap = makeSnapshot(playlistTracks, {
      preferences: {
        ...defaults,
        onlineConsent: true,
        onboardingDone: true,
        shuffle: true,
        shuffleMode: 'standard',
        smartShuffleDiscoveries: false,
      },
    });
    useApp.setState({ data: standardSnap });
    shufflePlay(playlistTracks, undefined, { mode: 'standard' });
    expect(useApp.getState().queue).toHaveLength(5);
    useApp.getState().next(true);
    useApp.getState().next(true);
    useApp.getState().next(true);
    useApp.getState().next(true);
    expect(recommendations).not.toHaveBeenCalled();

    // Smart shuffle with smartShuffleDiscoveries: true injects a discovery after 4 steps,
    // without adding it to the saved playlist's trackIds
    const smartSnap = makeSnapshot(playlistTracks, {
      preferences: {
        ...defaults,
        onlineConsent: true,
        onboardingDone: true,
        shuffle: true,
        shuffleMode: 'smart',
        smartShuffleDiscoveries: true,
      },
    });
    useApp.setState({ data: smartSnap });
    shufflePlay(playlistTracks, undefined, { mode: 'smart' });
    for (let i = 0; i < 4; i++) {
      useApp.getState().next(true);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(recommendations).toHaveBeenCalledTimes(1);
    const state = useApp.getState();
    expect(state.queue.some(t => t.id === discoveryTrack.id && t.recommended === true)).toBe(true);
    expect(state.data.playlists[0]!.trackIds).toEqual(playlistTracks.map(t => t.id));
  });
});

describe('Phase 2: Search ranking prioritizes original artist releases', () => {
  it('ranks Studio/Topic/Spotify tracks above Acoustic, Remix, and Covers/Reuploads', () => {
    const coverTrack = makeTrack('yt:cover', {
      title: 'Blinding Lights (Slowed & Reverb Cover)',
      artist: 'Nightcore Edits',
    });
    const remixTrack = makeTrack('yt:remix', {
      title: 'Blinding Lights (Club Remix)',
      artist: 'The Weeknd, Ariana Grande',
    });
    const liveTrack = makeTrack('yt:live', {
      title: 'Blinding Lights (Live Acoustic Session)',
      artist: 'The Weeknd',
    });
    const topicTrack = makeTrack('yt:topic', {
      title: 'Blinding Lights',
      artist: 'The Weeknd - Topic',
    });
    const spotifyTrack = makeTrack('link:sp1', {
      source: 'link',
      catalogSource: 'spotify',
      url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
    });

    expect(classifySearchTier(coverTrack, 'Blinding Lights')).toBe(1);
    expect(classifySearchTier(remixTrack, 'Blinding Lights')).toBe(2);
    expect(classifySearchTier(liveTrack, 'Blinding Lights')).toBe(3);
    expect(classifySearchTier(topicTrack, 'Blinding Lights')).toBe(4);
    expect(classifySearchTier(spotifyTrack, 'Blinding Lights')).toBe(4);

    const ranked = rankSearchTracks(
      [coverTrack, liveTrack, remixTrack, topicTrack, spotifyTrack],
      'The Weeknd Blinding Lights',
      'track',
    );
    expect(ranked[0]!.id).toBe('link:sp1');
    expect(ranked[1]!.id).toBe('yt:topic');
    expect(ranked[2]!.id).toBe('yt:live');
    expect(ranked[3]!.id).toBe('yt:remix');
    expect(ranked[4]!.id).toBe('yt:cover');
  });

  it('promotes matching explicit variants when query asks for remix or acoustic', () => {
    const original = makeTrack('link:sp_orig', {
      source: 'link',
      catalogSource: 'spotify',
      url: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV',
      title: 'One More Time',
      artist: 'Daft Punk',
    });
    const remix = makeTrack('link:sp_rmx', {
      source: 'link',
      catalogSource: 'spotify',
      url: 'https://open.spotify.com/track/1111111111111111111111',
      title: 'One More Time (Remix)',
      artist: 'Daft Punk',
    });
    expect(classifySearchTier(remix, 'One More Time remix')).toBe(4);
    const ranked = rankSearchTracks([original, remix], 'One More Time remix', 'track');
    expect(ranked[0]!.id).toBe('link:sp_rmx');
  });
});

describe('Phase 2: Multi-style recommendations, SWR persistent cache & race guard', () => {
  it('builds balanced multi-style taste seeds and diversifies catalog sections', () => {
    const tracks = [
      makeTrack('r1', { artist: 'Muse', title: 'Rock Starlight' }),
      makeTrack('r2', { artist: 'Muse', title: 'Rock Hysteria' }),
      makeTrack('e1', { artist: 'Disclosure', title: 'Electronic House Latch' }),
      makeTrack('m1', { artist: 'Tim Maia', title: 'MPB Samba Funk' }),
      makeTrack('j1', { artist: 'Bill Evans', title: 'Jazz Waltz Acoustic' }),
    ];
    const history = [
      { id: 'r1', playedAt: 9000 },
      { id: 'r1', playedAt: 8900 },
      { id: 'r1', playedAt: 8800 },
      { id: 'r2', playedAt: 8700 },
      { id: 'e1', playedAt: 8600 },
      { id: 'm1', playedAt: 8500 },
    ];
    const profile = buildTasteProfile({ tracks, history, likes: ['j1'] }, 4);
    expect(profile.seeds.length).toBeGreaterThanOrEqual(3);
    expect(profile.seeds.length).toBeLessThanOrEqual(4);
    expect(new Set(profile.seeds.map(s => s.artist)).size).toBeGreaterThanOrEqual(3);
    expect(profile.topStyles.length).toBeGreaterThanOrEqual(2);

    const catalog: CatalogResult = {
      sections: [
        {
          id: 'mix',
          source: 'youtube',
          title: 'Mix',
          items: [
            makeTrack('c1', { artist: 'Muse', title: 'Muse 1' }),
            makeTrack('c2', { artist: 'Muse', title: 'Muse 2' }),
            makeTrack('c3', { artist: 'Muse', title: 'Muse 3' }),
            makeTrack('c4', { artist: 'Disclosure', title: 'House 1' }),
          ],
        },
      ],
      notices: [],
    };
    const ranked = rankCatalogByTaste(catalog, profile);
    const artists = ranked.sections[0]!.items.map(i => i.artist);
    // Diverse interleaving prevents 3 consecutive Muse entries when Disclosure exists
    expect(artists.slice(0, 3)).toContain('Disclosure');
  });

  it('deduplicates in-flight recommendations, hydrates SQLite SWR caches, and rejects stale race responses', async () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const seedA = makeTrack('sA', { artist: 'Artist Alpha', title: 'Alpha Rock' });
    const seedB = makeTrack('sB', { artist: 'Artist Beta', title: 'Beta Jazz' });
    const freshItem = makeTrack('rec-new', { artist: 'Beta Companion', title: 'New Hit' });
    const staleItem = makeTrack('rec-old', { artist: 'Stale Artist', title: 'Old Hit' });

    let resolveSlow!: (v: Track[]) => void;
    let callCount = 0;
    const cacheSet = vi.fn(async () => {});
    const recommendations = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Promise<Track[]>(r => {
          resolveSlow = r;
        });
      }
      return [freshItem];
    });
    const cachedSections: CatalogResult = {
      sections: [
        { id: 'yt-public', source: 'youtube', title: 'Em alta', items: [seedA] },
      ],
      notices: [],
    };
    const discover = vi.fn(async () => cachedSections);

    vi.stubGlobal('window', {
      glass: {
        recommendations,
        discover,
        cancelSearch: vi.fn(async () => {}),
        cacheGet: vi.fn(async (key: string) => {
          if (key === 'catalog-discover-v2') {
            return {
              key,
              signature: 'catalog-discover-v2',
              payload: cachedSections,
              updatedAt: Date.now() - 1000,
              expiresAt: Date.now() + 60_000,
            };
          }
          return null;
        }),
        cacheSet,
      },
    });

    const p1 = buildTasteProfile({ tracks: [seedA], history: [{ id: seedA.id, playedAt: 100 }], likes: [] });
    const p2 = buildTasteProfile({ tracks: [seedB], history: [{ id: seedB.id, playedAt: 200 }], likes: [] });

    // Launch req1 (slow), then req2 (fast) -> req1 resolving later must NOT poison req2 or write stale cache
    const slowReq = fetchPersonalizedTracks(p1, []);
    const fastItems = await fetchPersonalizedTracks(p2, []);
    expect(fastItems.map(t => t.id)).toEqual([freshItem.id]);

    resolveSlow([staleItem]);
    await slowReq;
    // cacheSet only persisted freshItem from p2
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect((cacheSet.mock.calls[0] as any[])[0].payload[0].id).toBe(freshItem.id);

    // Concurrent calls for the same p2 signature reuse fresh cache (0 new network calls)
    const [r1, r2] = await Promise.all([
      fetchPersonalizedTracks(p2, []),
      fetchPersonalizedTracks(p2, []),
    ]);
    expect(r1.map(t => t.id)).toEqual([freshItem.id]);
    expect(r2.map(t => t.id)).toEqual([freshItem.id]);
    expect(recommendations).toHaveBeenCalledTimes(2);

    // Discover hydration & deduplication
    const hydrated = await hydrateDiscoveries();
    expect(hydrated?.fresh).toBe(true);
    expect(hydrated?.value.sections).toHaveLength(1);

    clearDiscoveryCache();
    const [d1, d2] = await Promise.all([discoverMusic(false), discoverMusic(false)]);
    expect(d1.sections).toHaveLength(1);
    expect(d2.sections).toHaveLength(1);
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 2: Standalone Downloads tab, progress controls & Settings removal', () => {
  it('formats sizes cleanly and manages queue progress, pause/resume, cancel & non-destructive file removal', async () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB');

    const dlTrack = makeTrack('yt:dl1', { title: 'Offline Song', artist: 'Artist', offline: true });
    const afterRemoveSnap = makeSnapshot([{ ...dlTrack, offline: false }]);
    const cancelDownload = vi.fn(async () => {});
    const removeOffline = vi.fn(async () => afterRemoveSnap);

    vi.stubGlobal('window', {
      glass: {
        cancelDownload,
        removeOffline,
        offline: vi.fn(async () => makeSnapshot([dlTrack])),
      },
    });

    useApp.setState({
      data: makeSnapshot([dlTrack]),
      queue: [dlTrack],
      downloadItems: {
        [dlTrack.id]: {
          track: dlTrack,
          status: 'downloading',
          downloadedBytes: 512,
          totalBytes: 1024,
          percent: 50,
          updatedAt: 1000,
        },
      },
      downloadingIds: [dlTrack.id],
    });

    useApp.getState().applyDownloadProgress({
      trackId: dlTrack.id,
      status: 'downloading',
      downloadedBytes: 768,
      totalBytes: 1024,
      percent: 75,
    });
    expect(useApp.getState().downloadItems[dlTrack.id]?.percent).toBe(75);

    await useApp.getState().pauseDownload(dlTrack.id);
    expect(useApp.getState().downloadItems[dlTrack.id]?.status).toBe('paused');
    expect(cancelDownload).toHaveBeenCalledWith(dlTrack.id);

    // A late native cancelled event must preserve explicit 'paused' UI state
    useApp.getState().applyDownloadProgress({
      trackId: dlTrack.id,
      status: 'cancelled',
      downloadedBytes: 768,
      totalBytes: 1024,
      percent: 75,
    });
    expect(useApp.getState().downloadItems[dlTrack.id]?.status).toBe('paused');

    await useApp.getState().removeOfflineFile(dlTrack.id);
    expect(removeOffline).toHaveBeenCalledWith(dlTrack.id);
    // Track stays in library and playlists, only offline flag flips false
    expect(useApp.getState().data.tracks).toHaveLength(1);
    expect(useApp.getState().data.tracks[0]!.offline).toBe(false);
    expect(useApp.getState().data.playlists[0]!.trackIds).toEqual([dlTrack.id]);
    expect(useApp.getState().queue[0]!.offline).toBe(false);
  });

  it('moves Downloads controls into dedicated view and removes OfflineSettings from Settings', () => {
    const root = process.cwd();
    const downloadsSrc = readFileSync(join(root, 'src/pages/Downloads.tsx'), 'utf8');
    const sidebarSrc = readFileSync(join(root, 'src/components/sidebar/Sidebar.tsx'), 'utf8');
    const settingsSrc = readFileSync(join(root, 'src/pages/Settings.tsx'), 'utf8');

    expect(downloadsSrc).toContain('Armazenamento local');
    expect(downloadsSrc).toContain('Limpar arquivos locais');
    expect(downloadsSrc).toContain('Remover arquivo');
    expect(downloadsSrc).toContain('Pausar fila');
    expect(downloadsSrc).toContain('Retomar fila');
    expect(sidebarSrc).toContain("'downloads'");
    expect(settingsSrc).not.toContain('OfflineSettings');
    expect(settingsSrc).not.toContain('Armazenamento offline');
    expect(settingsSrc).not.toContain('Limpar downloads');
  });
});

describe('Phase 2: Extensible Universal Link Import & SSRF hardening', () => {
  it('recognizes all 8 music platforms, URIs, mobile domains, and custom registered providers', () => {
    const cases: Array<[string, string, string, boolean?]> = [
      ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'track', false],
      ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'track', false],
      ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'playlist', true],
      ['https://open.spotify.com/intl-pt/album/6akEvsycLGftJxYudPjmqK', 'spotify', 'album', true],
      ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'ytmusic', 'track', false],
      ['https://music.youtube.com/playlist?list=PLabc12345', 'ytmusic', 'playlist', true],
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'track', false],
      ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'track', false],
      ['https://m.soundcloud.com/forss/flickermood', 'soundcloud', 'track', false],
      ['https://soundcloud.com/forss/sets/soulhack', 'soundcloud', 'playlist', true],
      ['https://m.deezer.com/br/track/3135556', 'deezer', 'track', false],
      ['https://music.apple.com/br/album/discovery/697194953?i=697195787', 'apple', 'track', false],
      ['https://music.apple.com/us/album/discovery/697194953', 'apple', 'album', true],
      ['https://c418.bandcamp.com/track/sweden', 'bandcamp', 'track', false],
      ['https://c418.bandcamp.com/album/minecraft-volume-alpha', 'bandcamp', 'album', true],
      ['https://listen.tidal.com/browse/track/12345678', 'tidal', 'track', false],
    ];

    for (const [url, providerId, kind, preferCollection = false] of cases) {
      const res = inspectMusicLink(url, preferCollection);
      expect(res.valid, url).toBe(true);
      expect(res.supported, url).toBe(true);
      expect(res.provider?.id, url).toBe(providerId);
      expect(res.kind, url).toBe(kind);
    }

    expect(looksLikeMusicLink('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe(true);

    // Custom runtime extension via dedicated registry host (uses an unused Tidal ID namespace check via new host only)
    registerLinkProvider({
      id: 'bandcamp',
      label: 'Bandcamp Custom',
      supportsCollections: false,
      match: u => u.hostname === 'audio.indie-mirror.example',
      detectKind: () => 'track',
    });
    const custom = inspectMusicLink('https://audio.indie-mirror.example/song/42');
    expect(custom.supported).toBe(true);
    expect(custom.provider?.label).toBe('Bandcamp Custom');
  });

  it('rejects SSRF/local/invalid URLs while keeping unknown public HTTPS fallback for playback validation', () => {
    for (const bad of [
      'file:///C:/music/song.mp3',
      'http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://127.0.0.1/track/1',
      'https://[::1]/track/1',
      'https://localhost/track/1',
      'https://internal.local/track/1',
      'https://user:pass@open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://open.spotify.com:8443/track/4uLU6hMCjMI75M1A2tKUQC',
      'spotify:track:short',
      'javascript:alert(1)',
    ]) {
      expect(inspectMusicLink(bad).valid, bad).toBe(false);
      expect(looksLikeMusicLink(bad), bad).toBe(false);
    }

    const spoofedBandcamp = inspectMusicLink('https://evil.bandcamp.com.attacker.test/album/fake', true);
    expect(spoofedBandcamp.supported).toBe(false);
    expect(spoofedBandcamp.provider).toBeNull();

    // Preserves generic public HTTPS acceptance for track link dialog & playback error assertion
    const generic = inspectMusicLink('https://example.com/music/not-a-supported-provider', false);
    expect(generic.valid).toBe(true);
    expect(generic.supported).toBe(false);
    expect(generic.provider).toBeNull();
  });
});
