import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useApp } from '../stores/app';
import { transport } from '../components/player/engine';

export function LyricsWindowBridge() {
  useEffect(() => {
    let offControl: (() => void) | undefined;
    let offOpen: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const send = () => {
      const s = useApp.getState();
      if (!s.ready) return;
      void invoke('call', {
        action: 'lyricsState',
        payload: {
          track: s.queue[s.index] || null,
          position: s.position,
          playing: s.playing,
          lyricsAvailable: s.lyricsAvailable,
          lyricsChecking: s.lyricsChecking,
          preferences: {
            ...s.data.preferences,
            appearance: { ...s.data.preferences.appearance, customImage: '' },
          },
        },
      }).catch(() => {});
    };

    const setWindowOpen = (open: boolean) => {
      if (disposed) return;
      if (open) {
        send();
        if (!timer) {
          timer = setInterval(send, 200);
        }
      } else if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    void listen<{ action: string; position?: number }>('lyrics-control', e => {
      if (e.payload.action === 'seek' && Number.isFinite(e.payload.position)) {
        transport.seek(e.payload.position!);
        useApp.setState({ position: e.payload.position! });
      }
      if (e.payload.action === 'toggle') transport.toggle();
    }).then(fn => {
      if (disposed) fn();
      else offControl = fn;
    });

    void listen<boolean>('lyrics-window-open', e => {
      setWindowOpen(Boolean(e.payload));
    }).then(fn => {
      if (disposed) fn();
      else offOpen = fn;
    });

    void invoke<boolean>('call', { action: 'lyricsWindowOpen', payload: null })
      .then(open => {
        if (!disposed) setWindowOpen(Boolean(open));
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      offControl?.();
      offOpen?.();
    };
  }, []);
  return null;
}
