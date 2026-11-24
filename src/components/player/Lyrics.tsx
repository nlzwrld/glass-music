import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, ExternalLink, LoaderCircle, Pin, PinOff, X } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { activeLyric, parseLRC, resolveTrackLyrics } from '../../lib/lyrics';
import type { LyricsResult } from '../../../shared/types';
import { GlassMaterial } from '../glass/materials';
import { IconButton } from '../glass/controls';
import { isAndroidPlatform } from '../../lib/androidBeta';
import { transport } from './engine';

export default function Lyrics(props: {
  detached?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onSeek?: (position: number) => void;
  onClose?: () => void;
} = {}) {
  const open = useApp(s => s.lyricsOpen);
  if (!open && !props.detached) return null;
  return <LyricsPanel {...props} />;
}

function LyricsPanel({
  detached = false,
  pinned = true,
  onTogglePin,
  onSeek,
  onClose,
}: {
  detached?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onSeek?: (position: number) => void;
  onClose?: () => void;
}) {
  const track = useApp(s => s.queue[s.index]),
    cachedCurrent = useApp(s => s.currentLyrics),
    position = useApp(s => s.position);
  const allowed = useApp(
      s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone,
    ),
    reduced = useApp(
      s => s.data.preferences.reducedMotion || (s.data.preferences.uiStyle ?? 'matte') === 'matte',
    );
  const [result, setResult] = useState<LyricsResult | null>(cachedCurrent),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [offset, setOffset] = useState(0),
    [follow, setFollow] = useState(true);
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (detached) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    return () => {
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) {
        prevFocus.focus();
      }
    };
  }, [detached]);

  useEffect(() => {
    setError('');
    setOffset(0);
    setFollow(true);
    if (!track || !allowed) {
      setResult(null);
      setBusy(false);
      return;
    }
    if (cachedCurrent && cachedCurrent.title) {
      setResult(cachedCurrent);
      setBusy(false);
      return;
    }
    let active = true;
    setBusy(true);
    void resolveTrackLyrics(track, true)
      .then(value => {
        if (active) setResult(value);
      })
      .catch(e => {
        if (active) setError(cleanError(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [track?.id, track?.title, track?.artist, track?.duration, allowed, cachedCurrent]);

  const lines = useMemo(() => parseLRC(result?.syncedLyrics || ''), [result]);
  const index = activeLyric(lines, position + offset);

  useEffect(() => {
    if (follow)
      current.current?.scrollIntoView({
        block: 'center',
        behavior: reduced ? 'instant' : 'smooth',
      });
  }, [index, follow, reduced]);

  return (
    <GlassMaterial
      as="section"
      method="css"
      className="lyrics-panel"
      aria-label="Letras da música"
    >
      <header data-tauri-drag-region={detached ? true : undefined}>
        <div className="lyrics-header-title" data-tauri-drag-region={detached ? true : undefined}>
          <h2>Letra</h2>
          {track && (
            <small className="lyrics-track-context" title={`${track.title} · ${track.artist}`}>
              {track.title} · {track.artist}
            </small>
          )}
        </div>
        <div className="lyrics-header-actions">
          {!follow && (
            <IconButton label="Acompanhar letra" onClick={() => setFollow(true)}>
              <AlignCenter size={16} />
            </IconButton>
          )}
          {detached ? (
            <IconButton
              label={pinned ? 'Desafixar do topo' : 'Fixar no topo'}
              active={pinned}
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              {pinned ? <Pin size={15} /> : <PinOff size={15} />}
            </IconButton>
          ) : !isAndroidPlatform() ? (
            <IconButton
              label="Destacar janela de letras"
              onClick={() => {
                useApp.setState({ lyricsOpen: false });
                void window.glass
                  .openLyrics()
                  .catch(e => useApp.getState().message(cleanError(e)));
              }}
            >
              <ExternalLink size={15} />
            </IconButton>
          ) : null}
          <IconButton
            label="Fechar letras"
            onClick={() => {
              if (onClose) onClose();
              else useApp.setState({ lyricsOpen: false });
            }}
          >
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div
        className="lyrics-scroll"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        {busy ? (
          <div className="lyrics-state" role="status">
            <LoaderCircle size={18} className="spinner" />
          </div>
        ) : !allowed ? (
          <p className="lyrics-state">Ative o acesso online para carregar letras.</p>
        ) : error ? (
          <p className="lyrics-state" role="status">
            {error}
          </p>
        ) : result?.instrumental ? (
          <p className="lyrics-state">Instrumental</p>
        ) : lines.length ? (
          <div className="lyrics-lines">
            {lines.map((line, i) => (
              <button
                ref={i === index ? current : undefined}
                key={`${line.time}-${i}`}
                className={i === index ? 'active' : i < index ? 'past' : ''}
                aria-current={i === index ? 'true' : undefined}
                aria-label={`Ir para ${line.text || 'pausa'}`}
                onClick={() => {
                  const target = Math.max(0, line.time - offset);
                  if (onSeek) onSeek(target);
                  else transport.seek(target);
                  useApp.setState({ position: target });
                  setFollow(true);
                }}
              >
                {line.text || '· · ·'}
              </button>
            ))}
          </div>
        ) : result?.plainLyrics ? (
          <div className="lyrics-plain">
            <p>{result.plainLyrics}</p>
          </div>
        ) : (
          <p className="lyrics-state">Letra indisponível</p>
        )}
      </div>
      {lines.length > 0 && (
        <label className="lyrics-offset">
          <span>Sincronização</span>
          <input
            aria-label="Ajuste da sincronização"
            type="range"
            min={-15}
            max={15}
            step={0.25}
            value={offset}
            onChange={e => setOffset(Number(e.target.value))}
          />
          <output>
            {offset > 0 ? '+' : ''}
            {offset.toFixed(2)}s
          </output>
        </label>
      )}
      {result && (
        <button
          className="lyrics-credit"
          onClick={() => void window.glass.external('https://lrclib.net')}
        >
          LRCLIB
        </button>
      )}
    </GlassMaterial>
  );
}
