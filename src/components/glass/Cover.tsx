import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Music2 } from 'lucide-react';
import type { Track } from '../../../shared/types';
import { hasResourceBase, nativeResource, onResourceBaseReady } from '../../lib/native';

const loadedUrlCache = new Set<string>();

function rememberLoaded(url: string) {
  if (!url) return;
  if (loadedUrlCache.size > 600) {
    const first = loadedUrlCache.values().next().value;
    if (first) loadedUrlCache.delete(first);
  }
  loadedUrlCache.add(url);
}

function normalizeArtworkUrl(raw?: string): string {
  if (!raw) return '';
  return raw.replace(
    /^(https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/[^/]+)\/(?:hqdefault|sddefault|default)\.jpg(\?.*)?$/i,
    '$1/mqdefault.jpg$2',
  );
}

export function coverURL(t?: Pick<Track, 'artwork'>) {
  const normalized = normalizeArtworkUrl(t?.artwork);
  if (!normalized) return '';
  const inTauri =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (normalized.startsWith('https://')) {
    if (hasResourceBase()) return nativeResource(`cover?url=${encodeURIComponent(normalized)}`);
    return inTauri ? '' : normalized;
  }
  if (normalized.startsWith('glass://app/')) {
    return hasResourceBase() ? nativeResource(normalized.slice(12)) : '';
  }
  return normalized;
}

type CoverStatus = 'loading' | 'loaded' | 'failed';

export default function Cover({
  track,
  className = '',
}: {
  track?: Pick<Track, 'title' | 'artwork' | 'source'>;
  className?: string;
}) {
  const [, setBaseTick] = useState(0);
  useEffect(() => {
    if (hasResourceBase()) return;
    return onResourceBaseReady(() => setBaseTick(n => n + 1));
  }, []);

  const baseUrl = coverURL(track);
  const directHttpsUrl = normalizeArtworkUrl(track?.artwork);
  const canFallbackDirect =
    directHttpsUrl.startsWith('https://') && baseUrl.includes('/cover?');
  const [stage, setStage] = useState<{ url: string; step: 0 | 1 | 2 }>({ url: '', step: 0 });
  const step = stage.url === baseUrl ? stage.step : 0;
  const effectiveUrl =
    !baseUrl
      ? ''
      : step === 1 && canFallbackDirect
        ? directHttpsUrl
        : step === 2 && baseUrl.includes('/cover?')
          ? `${baseUrl}&r=1`
          : baseUrl;

  const [state, setState] = useState<{ url: string; status: CoverStatus }>(() => ({
    url: effectiveUrl,
    status: effectiveUrl && loadedUrlCache.has(effectiveUrl) ? 'loaded' : 'loading',
  }));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const isCached = Boolean(effectiveUrl && loadedUrlCache.has(effectiveUrl));
  const status: CoverStatus = !effectiveUrl
    ? 'failed'
    : isCached
      ? 'loaded'
      : state.url === effectiveUrl
        ? state.status
        : 'loading';

  // Synchronously reconcile already-cached images before paint so cached covers NEVER stay hidden at opacity: 0.
  useLayoutEffect(() => {
    if (!effectiveUrl) return;
    if (loadedUrlCache.has(effectiveUrl)) {
      setState(prev =>
        prev.url === effectiveUrl && prev.status === 'loaded'
          ? prev
          : { url: effectiveUrl, status: 'loaded' },
      );
      return;
    }
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      rememberLoaded(effectiveUrl);
      setState({ url: effectiveUrl, status: 'loaded' });
    }
  }, [effectiveUrl]);

  // Safety watchdog: never allow a cover to remain stuck in shimmer loading indefinitely.
  useEffect(() => {
    if (!effectiveUrl || status !== 'loading') return;
    const timer = window.setTimeout(() => {
      const img = imgRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        rememberLoaded(effectiveUrl);
        setState({ url: effectiveUrl, status: 'loaded' });
      } else {
        setState({ url: effectiveUrl, status: 'failed' });
      }
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [effectiveUrl, status]);

  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    },
    [],
  );

  const handleLoad = () => {
    if (!effectiveUrl) return;
    rememberLoaded(effectiveUrl);
    setState({ url: effectiveUrl, status: 'loaded' });
  };

  const handleError = () => {
    if (!effectiveUrl) return;
    // Stage 1 -> Stage 2: instant direct HTTPS CDN fallback if local proxy fails.
    if (step === 0 && canFallbackDirect) {
      setStage({ url: baseUrl, step: 1 });
      return;
    }
    // Stage 2 -> Stage 3: one delayed retry on the local proxy before falling back to Music2 icon.
    if (step === 1 && baseUrl.includes('/cover?')) {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setStage({ url: baseUrl, step: 2 });
      }, 1200);
      return;
    }
    setState({ url: effectiveUrl, status: 'failed' });
  };

  const showImg = Boolean(effectiveUrl) && status !== 'failed';
  const showLoading = showImg && status === 'loading';

  return (
    <div
      className={`cover ${showLoading ? 'cover-loading' : ''} ${className}`}
      data-source={track?.source}
    >
      {showImg ? (
        <img
          ref={imgRef}
          src={effectiveUrl}
          alt={`Capa de ${track?.title || 'faixa'}`}
          decoding="async"
          draggable={false}
          onLoad={handleLoad}
          onError={handleError}
        />
      ) : (
        <div className="cover-fallback">
          <Music2 size={36} strokeWidth={1.2} />
        </div>
      )}
    </div>
  );
}
