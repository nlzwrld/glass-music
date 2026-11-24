import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults, type CollectionPreview, type Track } from '../../shared/types';
import {
  describePlaybackStatus,
  getUpcomingQueueItems,
} from '../../src/components/player/GlassPlayer';
import { transport } from '../../src/components/player/engine';
import { isMobileViewport } from '../../src/lib/androidBeta';
import { useApp } from '../../src/stores/app';

function makeTrack(id: string, available = true): Track {
  return {
    id: `local:${id}`,
    source: 'local',
    sourceId: id,
    kind: 'track',
    title: `Faixa ${id}`,
    artist: 'Artista Teste',
    duration: 180,
    addedAt: 1,
    available,
  };
}

describe('UI/UX, Continuity, Queue, Scrub & Responsive Regressions', () => {
  beforeEach(() => {
    transport.setScrubbing(false);
    useApp.setState({
      ready: true,
      page: 'home',
      settingsTab: 'account',
      filter: '',
      navigation: ['home'],
      navigationIndex: 0,
      navigationMotion: 'push',
      scrollPositions: {},
      collectionSnapshots: {},
      searchSession: {
        query: '',
        kind: 'all',
        source: 'all',
        result: { items: [], next: {}, notices: [] },
        users: [],
      },
      lastVolume: 65,
      mini: false,
      queue: [],
      index: -1,
      queueShuffled: false,
      shufflePlayed: [],
      shuffleNext: null,
      playing: false,
      playbackIntent: false,
      status: '',
      preview: null,
      previewBusy: false,
      data: {
        tracks: [],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, onlineConsent: true, onboardingDone: true },
      },
    });
  });

  it('excludes already-played tracks from sequential upcoming queue and orders shuffle upcoming deterministically', () => {
    const q = [makeTrack('0'), makeTrack('1'), makeTrack('2'), makeTrack('3'), makeTrack('4')];

    // Sequential at index 2 -> only indices 3 and 4 are upcoming
    const seqUpcoming = getUpcomingQueueItems({
      queue: q,
      index: 2,
      queueShuffled: false,
      shufflePlayed: [],
      shuffleNext: null,
      shuffle: false,
    });
    expect(seqUpcoming.map(x => x.idx)).toEqual([3, 4]);

    // Active shuffle at index 2 with index 0 already played and shuffleNext = 4 -> 4 first, then unplayed 1, 3
    const shufUpcoming = getUpcomingQueueItems({
      queue: q,
      index: 2,
      queueShuffled: false,
      shufflePlayed: [0, 2],
      shuffleNext: 4,
      shuffle: true,
    });
    expect(shufUpcoming.map(x => x.idx)).toEqual([4, 1, 3]);
  });

  it('prevents Desktop Mini-Player (440x680) from triggering mobile layout while keeping 390px viewports mobile', () => {
    const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    const androidUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8)';

    useApp.setState({ mini: false });
    expect(isMobileViewport(390, desktopUA)).toBe(true);
    expect(isMobileViewport(440, desktopUA)).toBe(true);
    expect(isMobileViewport(920, desktopUA)).toBe(false);

    // Entering Desktop Mini-Player at 440px width must NOT activate mobile mode
    useApp.setState({ mini: true });
    expect(isMobileViewport(440, desktopUA)).toBe(false);
    // Real Android always stays mobile
    expect(isMobileViewport(440, androidUA)).toBe(true);
  });

  it('preserves search filter, searchSession, and multi-collection snapshots across Back/Forward navigation', async () => {
    const colA: CollectionPreview = {
      name: 'Álbum Aurora',
      artwork: '',
      url: 'https://open.spotify.com/album/aurora',
      tracks: [makeTrack('a1')],
      warning: '',
      skipped: 0,
    };
    const colB: CollectionPreview = {
      name: 'Álbum Nebulosa',
      artwork: '',
      url: 'https://open.spotify.com/album/nebulosa',
      tracks: [makeTrack('b1')],
      warning: '',
      skipped: 0,
    };
    vi.stubGlobal('window', {
      glass: {
        previewCollection: vi
          .fn()
          .mockResolvedValueOnce(colA)
          .mockResolvedValueOnce(colB),
      },
    });

    useApp.getState().setPage('search');
    useApp.setState({ filter: 'Aurora' });
    useApp.getState().setSearchSession({
      query: 'Aurora',
      kind: 'album',
      result: { items: [makeTrack('a1')], next: {}, notices: [] },
    });

    await useApp.getState().openCollection(colA.url, colA.name);
    expect(useApp.getState().page).toBe('collection');
    expect(useApp.getState().preview?.name).toBe('Álbum Aurora');
    // Search query must survive leaving the search page
    expect(useApp.getState().filter).toBe('Aurora');

    // Opening a second collection from within collection pushes a distinct history entry
    await useApp.getState().openCollection(colB.url, colB.name);
    expect(useApp.getState().preview?.name).toBe('Álbum Nebulosa');

    // Back -> restores Álbum Aurora
    useApp.getState().navigate(-1);
    expect(useApp.getState().page).toBe('collection');
    expect(useApp.getState().preview?.name).toBe('Álbum Aurora');
    expect(useApp.getState().navigationMotion).toBe('traverse');

    // Back again -> returns to Search with query & session intact
    useApp.getState().navigate(-1);
    expect(useApp.getState().page).toBe('search');
    expect(useApp.getState().filter).toBe('Aurora');
    expect(useApp.getState().searchSession.result.items).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('tracks last non-zero volume for mute/unmute, resets status on previous(), and exposes readable status pills', async () => {
    vi.stubGlobal('window', {
      glass: {
        preferences: vi.fn(async () => undefined),
        lyrics: vi.fn(async () => null),
      },
    });

    await useApp.getState().setPreferences({ volume: 42 });
    expect(useApp.getState().lastVolume).toBe(42);
    await useApp.getState().setPreferences({ volume: 0 });
    expect(useApp.getState().data.preferences.volume).toBe(0);
    expect(useApp.getState().lastVolume).toBe(42);

    const a = makeTrack('a');
    const b = makeTrack('b');
    useApp.setState({
      queue: [a, b],
      index: 1,
      position: 1,
      playing: false,
      playbackIntent: false,
      status: 'Fim da fila',
    });
    useApp.getState().previous();
    expect(useApp.getState().index).toBe(0);
    expect(useApp.getState().status).toBe('Carregando');

    expect(describePlaybackStatus('Sincronizando fonte de áudio...', true, false)).toBe(
      'Sincronizando áudio…',
    );
    expect(describePlaybackStatus('Carregando', true, false)).toBe('Carregando…');
    expect(describePlaybackStatus('Reproduzindo', true, true)).toBe('Sincronizado na JAM');
    expect(describePlaybackStatus('Reproduzindo', true, false)).toBe('');

    transport.setScrubbing(true);
    expect(transport.isScrubbing()).toBe(true);
    transport.setScrubbing(false);
    expect(transport.isScrubbing()).toBe(false);

    await Promise.resolve();
    vi.unstubAllGlobals();
  });
});
