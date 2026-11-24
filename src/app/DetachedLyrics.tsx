import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useApp } from '../stores/app';
import type { LyricsResult, Track, Preferences } from '../../shared/types';
import Lyrics from '../components/player/Lyrics';
import { OpticalEngine } from '../components/glass/v3/OpticalEngine';

interface LyricsSyncPayload {
  track: Track | null;
  position: number;
  playing: boolean;
  lyricsAvailable?: boolean;
  lyricsChecking?: boolean;
  currentLyrics?: LyricsResult | null;
  preferences: Preferences;
}

function applyDetachedTheme(prefs: Preferences) {
  const isSystemLight =
    typeof window !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
  const resolvedTheme =
    prefs.theme === 'system' ? (isSystemLight ? 'light' : 'dark') : prefs.theme;
  const rawStyle = prefs.uiStyle ?? 'matte';
  document.documentElement.dataset.uiStyle = rawStyle === 'glass' ? 'glass' : 'matte';
  document.documentElement.dataset.beatPulse = String(
    Boolean((prefs.beatPulse ?? rawStyle === 'beat') && !prefs.performance),
  );
  document.documentElement.dataset.theme = resolvedTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.motion = prefs.reducedMotion ? 'reduced' : 'full';
  document.documentElement.dataset.performance = String(Boolean(prefs.performance));
  document.documentElement.style.setProperty('--user-accent', prefs.accent || '#52b79a');
}

export default function DetachedLyrics() {
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    void window.glass.bootstrap().then(data => {
      applyDetachedTheme(data.preferences);
      useApp.setState({ data, ready: true, lyricsOpen: true });
    });

    let disposed = false,
      hadValidTrack = false,
      off: (() => void) | undefined;

    void listen<LyricsSyncPayload>('lyrics-state', e => {
      const p = e.payload;
      if (p.track && p.lyricsAvailable) hadValidTrack = true;
      // Gracefully close detached lyrics if playback moves to a track with no lyrics
      if (hadValidTrack && (!p.track || (p.lyricsAvailable === false && !p.lyricsChecking))) {
        useApp.setState({ lyricsOpen: false, lyricsAvailable: false, currentLyrics: null });
        void invoke('call', { action: 'closeLyrics' }).catch(() => {});
        return;
      }
      useApp.setState(s => ({
        queue: p.track ? [p.track] : [],
        index: p.track ? 0 : -1,
        position: p.position,
        playing: p.playing,
        lyricsAvailable: p.lyricsAvailable ?? s.lyricsAvailable,
        lyricsChecking: p.lyricsChecking ?? false,
        ...(p.currentLyrics !== undefined ? { currentLyrics: p.currentLyrics } : {}),
        data: { ...s.data, preferences: p.preferences },
        lyricsOpen: true,
      }));
      applyDetachedTheme(p.preferences);
    }).then(fn => {
      if (disposed) fn();
      else off = fn;
    });

    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void invoke('call', { action: 'pinLyrics', payload: { pinned: next } }).catch(() => {
      setPinned(!next);
    });
  };

  return (
    <div className="app detached-lyrics">
      <OpticalEngine>
        <Lyrics
          detached
          pinned={pinned}
          onTogglePin={togglePin}
          onSeek={position => {
            void invoke('call', { action: 'lyricsControl', payload: { action: 'seek', position } });
          }}
          onClose={() => {
            void invoke('call', { action: 'closeLyrics' });
          }}
        />
      </OpticalEngine>
    </div>
  );
}
