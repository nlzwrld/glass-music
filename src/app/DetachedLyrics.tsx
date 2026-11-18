import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useApp } from '../stores/app';
import type { Track, Preferences } from '../../shared/types';
import Lyrics from '../components/player/Lyrics';
import { OpticalEngine } from '../components/glass/v3/OpticalEngine';

interface LyricsSyncPayload {
  track: Track | null;
  position: number;
  playing: boolean;
  lyricsAvailable?: boolean;
  lyricsChecking?: boolean;
  preferences: Preferences;
}

export default function DetachedLyrics() {
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    void window.glass.bootstrap().then(data => {
      document.documentElement.dataset.uiStyle = data.preferences.uiStyle ?? 'matte';
      document.documentElement.dataset.theme =
        data.preferences.theme === 'light' ? 'light' : 'dark';
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
        useApp.setState({ lyricsOpen: false, lyricsAvailable: false });
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
        data: { ...s.data, preferences: p.preferences },
        lyricsOpen: true,
      }));
      document.documentElement.dataset.uiStyle = p.preferences.uiStyle ?? 'matte';
      document.documentElement.dataset.theme =
        p.preferences.theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.motion = p.preferences.reducedMotion ? 'reduced' : 'full';
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
