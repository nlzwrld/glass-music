import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import '../../lib/pulseEngine';
import {
  EMPTY_PULSE_FRAME,
  normalizeBackgroundVideoPreferences,
  subscribeMusicAnalysis,
  type BackgroundVideoInfo,
} from '../../lib/musicEvents';
import { onResourceBaseReady } from '../../lib/native';
import { useReducedUI } from '../../lib/motion';
import {
  computeBaseVideoSpeed,
  VideoSpeedController,
} from '../../lib/videoSpeedController';
import { useApp } from '../../stores/app';

let currentVideoInfo: BackgroundVideoInfo | null = null;
const videoInfoListeners = new Set<() => void>();

function notifyVideoInfoListeners(): void {
  videoInfoListeners.forEach(listener => {
    try {
      listener();
    } catch {
      // Isolate subscriber errors.
    }
  });
}

export function getBackgroundVideoInfo(): BackgroundVideoInfo | null {
  return currentVideoInfo;
}

export function setBackgroundVideoInfo(info: BackgroundVideoInfo | null): void {
  currentVideoInfo = info;
  notifyVideoInfoListeners();
}

export function subscribeBackgroundVideoInfo(listener: () => void): () => void {
  videoInfoListeners.add(listener);
  return () => {
    videoInfoListeners.delete(listener);
  };
}

export function useBackgroundVideoInfo(): BackgroundVideoInfo | null {
  return useSyncExternalStore(
    subscribeBackgroundVideoInfo,
    getBackgroundVideoInfo,
    getBackgroundVideoInfo,
  );
}

export async function refreshBackgroundVideoInfo(): Promise<BackgroundVideoInfo | null> {
  if (typeof window === 'undefined' || typeof window.glass?.backgroundVideoInfo !== 'function') {
    return currentVideoInfo;
  }
  try {
    const info = await window.glass.backgroundVideoInfo();
    setBackgroundVideoInfo(info ?? null);
    return info ?? null;
  } catch {
    return currentVideoInfo;
  }
}

function enforceSilentVideo(el: HTMLVideoElement, loop: boolean): void {
  el.muted = true;
  el.defaultMuted = true;
  el.volume = 0;
  el.loop = loop;
}

function releaseVideoResources(el: HTMLVideoElement): void {
  try {
    el.pause();
  } catch {}
  try {
    el.defaultPlaybackRate = 1;
    el.playbackRate = 1;
  } catch {}
  try {
    el.removeAttribute('src');
    el.load();
  } catch {}
}

export function BackgroundVideoLayer() {
  const ready = useApp(s => s.ready);
  const playing = useApp(s => s.playing);
  const trackId = useApp(s => s.queue[s.index]?.id ?? '');
  const performanceMode = useApp(s => s.data.preferences.performance);
  const rawBgVideo = useApp(s => s.data.preferences.backgroundVideo);
  const reducedMotion = useReducedUI();

  const cfg = useMemo(() => normalizeBackgroundVideoPreferences(rawBgVideo), [rawBgVideo]);
  const videoInfo = useBackgroundVideoInfo();
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const [windowVisible, setWindowVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<VideoSpeedController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new VideoSpeedController(computeBaseVideoSpeed(cfg));
  }

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const visibleRef = useRef(windowVisible);
  visibleRef.current = windowVisible;

  const videoUrl = videoInfo?.url ?? '';

  // Clear previous decode error whenever the user selects or reloads a different video URL.
  useEffect(() => {
    setErroredUrl(prev => (prev && prev !== videoUrl ? null : prev));
  }, [videoUrl]);

  // Load persisted background video info on mount / boot / resource-server ready.
  useEffect(() => {
    void refreshBackgroundVideoInfo();
    return onResourceBaseReady(() => {
      void refreshBackgroundVideoInfo();
    });
  }, [ready]);

  // Track both native window visibility (minimize/tray) and document visibility.
  useEffect(() => {
    let disposed = false;
    let nativeVisible = true;
    const syncVisibility = () => {
      if (!disposed) {
        setWindowVisible(nativeVisible && !document.hidden);
      }
    };
    void window.glass
      ?.visualState?.()
      .then(visible => {
        if (typeof visible === 'boolean') {
          nativeVisible = visible;
          syncVisibility();
        }
      })
      .catch(() => {});
    const offVisual = window.glass?.onVisualVisibility?.(visible => {
      nativeVisible = Boolean(visible);
      syncVisibility();
    });
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      disposed = true;
      offVisual?.();
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, []);

  const active = Boolean(
    cfg.enabled &&
      videoInfo?.exists &&
      videoUrl &&
      erroredUrl !== videoUrl &&
      !performanceMode &&
      !reducedMotion,
  );

  // Sync html[data-bg-video] attribute for Matte & Liquid Glass backdrop translucency.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.bgVideo = active ? 'true' : 'false';
    return () => {
      delete root.dataset.bgVideo;
    };
  }, [active]);

  // Clear transient impulses cleanly on track changes so prior peaks do not carry over.
  useEffect(() => {
    controllerRef.current?.onTrackChange(cfgRef.current);
  }, [trackId]);

  // Keep loop property synced dynamically without tearing down the video decoder.
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.loop = cfg.loop;
    }
  }, [active, cfg.loop]);

  // Core `<video>` element lifecycle: mute enforcement, error isolation, and decoder release.
  useEffect(() => {
    if (!active || !videoUrl) return;
    const el = videoRef.current;
    if (!el) return;

    const controller = controllerRef.current!;
    const baseSpeed = computeBaseVideoSpeed(cfgRef.current);
    controller.reset(baseSpeed);
    enforceSilentVideo(el, cfgRef.current.loop);
    try {
      el.defaultPlaybackRate = baseSpeed;
      el.playbackRate = baseSpeed;
    } catch {}

    let disposed = false;

    const tryPlay = () => {
      if (disposed || !visibleRef.current) return;
      enforceSilentVideo(el, cfgRef.current.loop);
      if (el.paused) {
        void el.play().catch(() => {});
      }
    };

    const onLoadedMetadata = () => {
      enforceSilentVideo(el, cfgRef.current.loop);
      tryPlay();
    };

    const onCanPlay = () => {
      tryPlay();
    };

    const onError = () => {
      if (disposed || !el.getAttribute('src')) return;
      const code = el.error?.code;
      const unsupported = code === 3 || code === 4;
      useApp
        .getState()
        .message(
          unsupported
            ? 'Não foi possível reproduzir o vídeo de fundo (formato ou codec não suportado). Use MP4 (H.264) ou WebM.'
            : 'Não foi possível carregar o vídeo de fundo. Verifique se o arquivo ainda existe.',
        );
      setErroredUrl(videoUrl);
    };

    const onBeforeUnload = () => {
      disposed = true;
      releaseVideoResources(el);
    };

    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('error', onError);
    window.addEventListener('beforeunload', onBeforeUnload);

    if (visibleRef.current) {
      tryPlay();
    }

    return () => {
      disposed = true;
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
      window.removeEventListener('beforeunload', onBeforeUnload);
      releaseVideoResources(el);
    };
  }, [active, videoUrl]);

  // Pause video decoding when window is hidden/minimized; resume cleanly when visible again.
  useEffect(() => {
    if (!active) return;
    const el = videoRef.current;
    if (!el) return;

    if (windowVisible) {
      enforceSilentVideo(el, cfgRef.current.loop);
      if (el.paused) {
        void el.play().catch(() => {});
      }
    } else {
      controllerRef.current?.onTrackChange(cfgRef.current);
      try {
        el.pause();
      } catch {}
    }
  }, [active, windowVisible, videoUrl]);

  // Drive smooth beat-synchronized playbackRate when active + visible + playing + beatSync;
  // otherwise unsubscribe from audio analysis and glide smoothly back to normal speed.
  useEffect(() => {
    if (!active || !windowVisible) return;
    const controller = controllerRef.current!;

    if (cfg.beatSync && playing) {
      let lastTs = performance.now();
      return subscribeMusicAnalysis('background-video', frame => {
        const el = videoRef.current;
        if (!el || !visibleRef.current) return;
        const now = performance.now();
        const dt = Math.max(1, Math.min(100, now - lastTs));
        lastTs = now;
        controller.step(frame, cfgRef.current, dt, true);
        controller.applyToVideo(el, cfgRef.current, now);
      });
    }

    // Idle / paused / beatSync disabled: smoothly decelerate back to baseSpeed, then stop rAF.
    let rafId = 0;
    let lastTs = performance.now();
    const settleStep = (now: number) => {
      rafId = 0;
      const el = videoRef.current;
      if (!el || !visibleRef.current) return;
      const dt = Math.max(1, Math.min(100, now - lastTs));
      lastTs = now;
      const currentCfg = cfgRef.current;
      const baseSpeed = computeBaseVideoSpeed(currentCfg);
      const speed = controller.step(EMPTY_PULSE_FRAME, currentCfg, dt, false);
      controller.applyToVideo(el, currentCfg, now);

      const settled =
        Math.abs(speed - baseSpeed) < 0.002 &&
        Math.abs(el.playbackRate - baseSpeed) < 0.003;
      if (!settled) {
        rafId = requestAnimationFrame(settleStep);
      } else if (el.playbackRate !== baseSpeed) {
        try {
          el.defaultPlaybackRate = baseSpeed;
          el.playbackRate = baseSpeed;
          controller.coalescer.lastCommittedRate = baseSpeed;
        } catch {}
      }
    };

    const el = videoRef.current;
    const baseSpeed = computeBaseVideoSpeed(cfgRef.current);
    if (
      el &&
      (Math.abs(controller.state.speed - baseSpeed) >= 0.002 ||
        Math.abs(el.playbackRate - baseSpeed) >= 0.003)
    ) {
      rafId = requestAnimationFrame(settleStep);
    } else if (el) {
      try {
        el.defaultPlaybackRate = baseSpeed;
        el.playbackRate = baseSpeed;
        controller.coalescer.lastCommittedRate = baseSpeed;
      } catch {}
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [active, windowVisible, cfg.beatSync, cfg.minSpeed, cfg.maxSpeed, playing, videoUrl]);

  if (!active || !videoUrl) return null;

  return (
    <div className="bg-video-layer" aria-hidden="true">
      <video
        key={videoUrl}
        ref={videoRef}
        className="bg-video-media"
        src={videoUrl}
        muted
        playsInline
        loop={cfg.loop}
        preload="auto"
        disablePictureInPicture
        disableRemotePlayback
      />
      <div className="bg-video-scrim" />
    </div>
  );
}
