import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeLyric,
  clearLyricsCache,
  hasValidLyrics,
  parseLRC,
  resolveTrackLyrics,
} from '../../src/lib/lyrics';
import { shouldRenderLyricsButton } from '../../src/components/player/GlassPlayer';
import { useApp } from '../../src/stores/app';
import { defaults, type LyricsResult, type Track } from '../../shared/types';

const sampleTrack: Track = {
  id: 'youtube:M7lc1UVf-VE',
  source: 'youtube',
  sourceId: 'M7lc1UVf-VE',
  kind: 'track',
  title: 'Validação Sincronizada',
  artist: 'Liquid Hub',
  duration: 180,
  addedAt: 0,
};

afterEach(() => {
  clearLyricsCache();
  vi.unstubAllGlobals();
});

describe('lyric timing', () => {
  it('reads repeated timestamps, fractions and metadata offsets in order', () => {
    expect(parseLRC('[ar:Example]\n[offset:500]\n[00:03.25][00:08.000]Second\n[00:01]First')).toEqual(
      [
        { time: 0.5, text: 'First' },
        { time: 2.75, text: 'Second' },
        { time: 7.5, text: 'Second' },
      ],
    );
  });

  it('handles intros, exact timestamps and seeking backwards', () => {
    const lines = parseLRC('[00:05]First\n[00:12.5]Second\n[00:20]Third');
    expect([0, 5, 19, 12.49, 25].map(t => activeLyric(lines, t))).toEqual([-1, 0, 1, 0, 2]);
  });

  it('removes enhanced word timestamps while preserving the line timestamp', () => {
    expect(parseLRC('[00:12.40]<00:12.40>Hello <00:12.80>world')).toEqual([
      { time: 12.4, text: 'Hello world' },
    ]);
  });

  it('does not invent synchronization for plain text', () => {
    expect(parseLRC('A line without timing')).toEqual([]);
  });
});

describe('conditional lyrics availability & player button visibility', () => {
  it('accepts only non-instrumental tracks with non-empty synced or plain lyrics', () => {
    expect(hasValidLyrics(null)).toBe(false);
    expect(hasValidLyrics(undefined)).toBe(false);
    expect(
      hasValidLyrics({
        id: 1,
        title: 'Inst',
        artist: 'A',
        instrumental: true,
        plainLyrics: 'Instrumental',
        provider: 'LRCLIB',
      }),
    ).toBe(false);
    expect(
      hasValidLyrics({
        id: 2,
        title: 'Blank',
        artist: 'A',
        instrumental: false,
        plainLyrics: '   ',
        syncedLyrics: '',
        provider: 'LRCLIB',
      }),
    ).toBe(false);
    expect(
      hasValidLyrics({
        id: 3,
        title: 'Synced',
        artist: 'A',
        instrumental: false,
        syncedLyrics: '[00:01.00]Primeira linha',
        provider: 'LRCLIB',
      }),
    ).toBe(true);
    expect(
      hasValidLyrics({
        id: 4,
        title: 'Plain',
        artist: 'A',
        instrumental: false,
        plainLyrics: 'Letra simples disponível',
        provider: 'LRCLIB',
      }),
    ).toBe(true);
  });

  it('renders the player Lyrics icon strictly when active track has verified lyrics and hides/closes otherwise', async () => {
    const lyricsMock = vi.fn<(t: Track) => Promise<LyricsResult | null>>();
    vi.stubGlobal('window', { glass: { lyrics: lyricsMock } });

    useApp.setState({
      queue: [sampleTrack],
      index: 0,
      lyricsOpen: true,
      lyricsAvailable: false,
      lyricsChecking: false,
      currentLyrics: null,
      data: {
        tracks: [sampleTrack],
        playlists: [],
        likes: [],
        history: [],
        preferences: { ...defaults, onlineConsent: true, onboardingDone: true },
      },
    });

    // 1. Track without lyrics -> button stays hidden and open lyrics drawer closes gracefully
    lyricsMock.mockResolvedValueOnce(null);
    await useApp.getState().probeLyrics(sampleTrack);
    expect(useApp.getState().lyricsAvailable).toBe(false);
    expect(useApp.getState().lyricsOpen).toBe(false);
    expect(
      shouldRenderLyricsButton({
        hasActive: true,
        lyricsAvailable: useApp.getState().lyricsAvailable,
      }),
    ).toBe(false);

    // 2. Track with valid synced lyrics -> button becomes visible
    const trackWithLyrics: Track = {
      ...sampleTrack,
      id: 'youtube:dQw4w9WgXcQ',
      sourceId: 'dQw4w9WgXcQ',
      title: 'Com Letra',
    };
    lyricsMock.mockResolvedValueOnce({
      id: 99,
      title: 'Com Letra',
      artist: 'Liquid Hub',
      instrumental: false,
      syncedLyrics: '[00:00.50]Linha sincronizada',
      provider: 'LRCLIB',
    });
    useApp.setState({ queue: [trackWithLyrics], index: 0 });
    await useApp.getState().probeLyrics(trackWithLyrics);
    expect(useApp.getState().lyricsAvailable).toBe(true);
    expect(
      shouldRenderLyricsButton({
        hasActive: true,
        lyricsAvailable: useApp.getState().lyricsAvailable,
      }),
    ).toBe(true);

    // 3. Offline mode (onlineConsent=false) -> resolveTrackLyrics returns null & hides button
    useApp.setState({
      data: {
        ...useApp.getState().data,
        preferences: { ...defaults, onlineConsent: false, onboardingDone: true },
      },
    });
    await useApp.getState().probeLyrics(trackWithLyrics);
    expect(await resolveTrackLyrics(trackWithLyrics, false)).toBeNull();
    expect(useApp.getState().lyricsAvailable).toBe(false);
    expect(
      shouldRenderLyricsButton({
        hasActive: true,
        lyricsAvailable: useApp.getState().lyricsAvailable,
      }),
    ).toBe(false);
  });
});
