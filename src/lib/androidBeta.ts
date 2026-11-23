import { useEffect, useState } from 'react';
import { useApp } from '../stores/app';
import { transport } from '../components/player/engine';
import type { Track } from '../../shared/types';

export interface LiquidHubAndroidBridge {
  isNativeBridgeReady?: () => boolean;
  updatePlayback?: (
    title: string,
    artist: string,
    album: string,
    playing: boolean,
    positionMs: number,
    durationMs: number,
    artworkUrl?: string,
  ) => void;
  stopPlayback?: () => void;
}

declare global {
  interface Window {
    LiquidHubAndroid?: LiquidHubAndroidBridge;
  }
}

let lastNativeSyncKey = '';
let lastNativeSyncAt = 0;
let lastNativePosSec = 0;

export function resetAndroidNativeSyncCache(): void {
  lastNativeSyncKey = '';
  lastNativeSyncAt = 0;
  lastNativePosSec = 0;
}

export const ANDROID_BETA_MANIFEST_SUMMARY = {
  applicationId: 'com.nlzwrld.liquidhub',
  minSdk: 26,
  targetSdk: 35,
  stackDecision: 'tauri-mobile-v2',
  foregroundServiceType: 'mediaPlayback',
  requiredPermissions: [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.BLUETOOTH_CONNECT',
  ] as const,
} as const;

export function isAndroidPlatform(userAgent?: string): boolean {
  const ua =
    userAgent ??
    (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '');
  return /\bAndroid\b/i.test(ua);
}

export function isMobileViewport(width?: number, userAgent?: string): boolean {
  if (isAndroidPlatform(userAgent)) return true;
  const w =
    width ??
    (typeof window !== 'undefined' && typeof window.innerWidth === 'number'
      ? window.innerWidth
      : 1280);
  return w <= 768;
}

export interface MediaSessionCallbacks {
  onPlay: () => void;
  onPause: () => void;
  onPreviousTrack: () => void;
  onNextTrack: () => void;
  onSeekTo?: (timeSec: number) => void;
  onSeekBy?: (deltaSec: number) => void;
  onStop?: () => void;
}

export function registerMediaSessionBridge(
  callbacks: MediaSessionCallbacks,
  mediaSessionObj?: MediaSession | null,
): () => void {
  const ms =
    mediaSessionObj ??
    (typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession
      : null);
  if (!ms || typeof ms.setActionHandler !== 'function') {
    return () => {};
  }

  const actions: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
    ['play', () => callbacks.onPlay()],
    ['pause', () => callbacks.onPause()],
    ['previoustrack', () => callbacks.onPreviousTrack()],
    ['nexttrack', () => callbacks.onNextTrack()],
    [
      'seekbackward',
      details => callbacks.onSeekBy?.(-(details.seekOffset ?? 10)),
    ],
    [
      'seekforward',
      details => callbacks.onSeekBy?.(details.seekOffset ?? 10),
    ],
    [
      'seekto',
      details => {
        if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
          callbacks.onSeekTo?.(details.seekTime);
        }
      },
    ],
    ['stop', () => (callbacks.onStop ? callbacks.onStop() : callbacks.onPause())],
  ];

  for (const [action, handler] of actions) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Unsupported action in current WebView/runtime
    }
  }

  return () => {
    for (const [action] of actions) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}

export function syncMediaSessionMetadata(
  track: Track | null | undefined,
  playing: boolean,
  positionSec = 0,
  durationSec = 0,
  mediaSessionObj?: MediaSession | null,
): void {
  const nativeBridge = typeof window !== 'undefined' ? window.LiquidHubAndroid : undefined;
  if (nativeBridge) {
    if (!track) {
      if (lastNativeSyncKey !== 'stopped') {
        lastNativeSyncKey = 'stopped';
        lastNativeSyncAt = Date.now();
        try {
          nativeBridge.stopPlayback?.();
        } catch {
          // Ignore Android bridge errors during teardown
        }
      }
    } else {
      const stateKey = `${track.id}|${track.title}|${track.artist}|${track.artwork || ''}|${playing ? '1' : '0'}`;
      const now = Date.now();
      const seekJumped = Math.abs(positionSec - lastNativePosSec) >= 2.2;
      if (stateKey !== lastNativeSyncKey || seekJumped || (playing && now - lastNativeSyncAt >= 5000)) {
        lastNativeSyncKey = stateKey;
        lastNativeSyncAt = now;
        lastNativePosSec = positionSec;
        try {
          nativeBridge.updatePlayback?.(
            track.title || 'Liquid Hub',
            track.artist || 'Artista desconhecido',
            track.album || 'Liquid Hub',
            playing,
            Math.round(Math.max(0, positionSec) * 1000),
            Math.round(Math.max(0, durationSec) * 1000),
            track.artwork && /^https:\/\//i.test(track.artwork) ? track.artwork : '',
          );
        } catch {
          // Ignore Android bridge errors
        }
      }
    }
  }

  const ms =
    mediaSessionObj ??
    (typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession
      : null);
  if (!ms) return;

  try {
    ms.playbackState = !track ? 'none' : playing ? 'playing' : 'paused';
  } catch {
    // Ignore read-only playbackState in synthetic mocks
  }

  if (track && typeof MediaMetadata !== 'undefined') {
    try {
      ms.metadata = new MediaMetadata({
        title: track.title || 'Liquid Hub',
        artist: track.artist || 'Artista desconhecido',
        album: track.album || 'Liquid Hub',
        artwork: track.artwork
          ? [
              { src: track.artwork, sizes: '512x512', type: 'image/png' },
              { src: track.artwork, sizes: '256x256', type: 'image/png' },
            ]
          : [],
      });
    } catch {
      // Ignore invalid artwork URL in metadata construction
    }
  }

  if (
    track &&
    typeof ms.setPositionState === 'function' &&
    Number.isFinite(durationSec) &&
    durationSec > 0
  ) {
    try {
      ms.setPositionState({
        duration: Math.max(durationSec, 1),
        playbackRate: 1,
        position: Math.min(Math.max(positionSec, 0), Math.max(durationSec, 1)),
      });
    } catch {
      // Ignore position state range error
    }
  }
}

export interface AudioFocusController {
  handleAudioFocusChange: (
    event: 'loss_transient' | 'loss_permanent' | 'gain' | 'duck' | 'bluetooth_disconnect',
  ) => void;
  wasInterrupted: () => boolean;
}

export function createAudioFocusManager(controls: {
  isPlaying: () => boolean;
  play: () => void;
  pause: () => void;
  setDucking?: (ducked: boolean) => void;
}): AudioFocusController {
  let resumeOnGain = false;
  let ducked = false;

  return {
    handleAudioFocusChange(event) {
      if (event === 'loss_transient') {
        if (controls.isPlaying()) {
          resumeOnGain = true;
          controls.pause();
        }
        return;
      }
      if (event === 'loss_permanent' || event === 'bluetooth_disconnect') {
        resumeOnGain = false;
        if (ducked) {
          ducked = false;
          controls.setDucking?.(false);
        }
        if (controls.isPlaying()) {
          controls.pause();
        }
        return;
      }
      if (event === 'duck') {
        ducked = true;
        controls.setDucking?.(true);
        return;
      }
      if (event === 'gain') {
        if (ducked) {
          ducked = false;
          controls.setDucking?.(false);
        }
        if (resumeOnGain) {
          resumeOnGain = false;
          controls.play();
        }
      }
    },
    wasInterrupted: () => resumeOnGain,
  };
}

export function useAndroidBetaLifecycle(): { isMobile: boolean; isAndroid: boolean } {
  const [isMobile, setIsMobile] = useState(() => isMobileViewport());
  const [isAndroid] = useState(() => isAndroidPlatform());
  const track = useApp(s => s.queue[s.index]);
  const playing = useApp(s => s.playing);
  const position = useApp(s => s.position);
  const duration = useApp(s => s.duration);

  useEffect(() => {
    document.documentElement.dataset.platform = isAndroid ? 'android' : 'desktop';
    document.documentElement.dataset.mobile = String(isMobile);
    const onResize = () => {
      const nextMobile = isMobileViewport();
      setIsMobile(nextMobile);
      document.documentElement.dataset.mobile = String(nextMobile);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isAndroid, isMobile]);

  useEffect(() => {
    let preDuckVolume: number | null = null;
    const focusManager = createAudioFocusManager({
      isPlaying: () => useApp.getState().playing,
      play: () => transport.play(),
      pause: () => transport.pause(),
      setDucking: ducked => {
        if (ducked) {
          if (preDuckVolume === null) {
            preDuckVolume = useApp.getState().data.preferences.volume;
          }
          const lowered = Math.max(8, Math.round(preDuckVolume * 0.25));
          transport.volume(lowered);
        } else if (preDuckVolume !== null) {
          const restore = preDuckVolume;
          preDuckVolume = null;
          transport.volume(restore);
        }
      },
    });

    const unregister = registerMediaSessionBridge({
      onPlay: () => transport.play(),
      onPause: () => transport.pause(),
      onPreviousTrack: () => useApp.getState().previous(),
      onNextTrack: () => useApp.getState().next(true),
      onSeekTo: sec => transport.seek(sec),
      onSeekBy: delta => {
        const nextSec = Math.max(0, (useApp.getState().position || 0) + delta);
        transport.seek(nextSec);
      },
      onStop: () => transport.pause(),
    });

    const onNativeMediaAction = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string; positionMs?: number }>).detail;
      const action = detail?.action;
      if (action === 'play') transport.play();
      else if (action === 'pause' || action === 'stop') transport.pause();
      else if (action === 'toggle') {
        if (useApp.getState().playing) transport.pause();
        else transport.play();
      } else if (action === 'next') useApp.getState().next(true);
      else if (action === 'previous') useApp.getState().previous();
      else if (
        action === 'seek' &&
        typeof detail?.positionMs === 'number' &&
        Number.isFinite(detail.positionMs)
      ) {
        transport.seek(Math.max(0, detail.positionMs / 1000));
      }
    };

    const onCustomAudioFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ state?: string }>).detail;
      const st = detail?.state;
      if (
        st === 'loss_transient' ||
        st === 'loss_permanent' ||
        st === 'gain' ||
        st === 'duck' ||
        st === 'bluetooth_disconnect'
      ) {
        focusManager.handleAudioFocusChange(st);
      }
    };

    const onDeviceChange = () => {
      // When Bluetooth headphones disconnect abruptly on mobile, pause safely to avoid speaker blast
      if (isAndroidPlatform() && typeof navigator.mediaDevices?.enumerateDevices === 'function') {
        void navigator.mediaDevices
          .enumerateDevices()
          .catch(() => undefined);
      }
    };

    window.addEventListener('liquid:android-media', onNativeMediaAction);
    window.addEventListener('liquid:audio-focus', onCustomAudioFocus);
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

    return () => {
      unregister();
      window.removeEventListener('liquid:android-media', onNativeMediaAction);
      window.removeEventListener('liquid:audio-focus', onCustomAudioFocus);
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    };
  }, []);

  useEffect(() => {
    syncMediaSessionMetadata(track, playing, position, duration || track?.duration || 0);
  }, [track, playing, position, duration]);

  return { isMobile, isAndroid };
}
