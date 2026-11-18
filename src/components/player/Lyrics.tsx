import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, LoaderCircle, X } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { activeLyric, parseLRC } from '../../lib/lyrics';
import type { LyricsResult } from '../../../shared/types';
import { GlassMaterial } from '../glass/materials';
import { IconButton } from '../glass/controls';
import { transport } from './engine';

const cache = new Map<string, LyricsResult | null>();

export default function Lyrics({
  detached = false,
  onSeek,
  onClose,
}: {
  detached?: boolean;
  onSeek?: (position: number) => void;
  onClose?: () => void;
} = {}) {
  const open = useApp(s => s.lyricsOpen),
    track = useApp(s => s.queue[s.index]),
    position = useApp(s => s.position);
  const allowed = useApp(
      s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone,
    ),
    reduced = useApp(
      s => s.data.preferences.reducedMotion || (s.data.preferences.uiStyle ?? 'matte') === 'matte',
    );
  const [result, setResult] = useState<LyricsResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [offset, setOffset] = useState(0),
    [follow, setFollow] = useState(true);
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setResult(null);
    setError('');
    setOffset(0);
    setFollow(true);
    if (!track || !allowed) {
      setBusy(false);
      return;
    }
    const key = [track.title, track.artist, track.duration].join('|');
    if (cache.has(key)) {
      setResult(cache.get(key)!);
      setBusy(false);
      return;
    }
    let active = true;
    setBusy(true);
    void window.glass
      .lyrics(track)
      .then(value => {
        cache.set(key, value);
        if (cache.size > 100) cache.delete(cache.keys().next().value!);
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
  }, [track?.id, track?.title, track?.artist, track?.duration, allowed]);

  const lines = useMemo(() => parseLRC(result?.syncedLyrics || ''), [result]);
  const index = activeLyric(lines, position + offset);

  useEffect(() => {
    if (open && follow)
      current.current?.scrollIntoView({
        block: 'center',
        behavior: reduced ? 'instant' : 'smooth',
      });
  }, [index, open, follow, reduced]);

  if (!open) return null;

  return (
    <GlassMaterial
      as="section"
      method="css"
      className="lyrics-panel"
      aria-label="Letras da música"
    >
      <header data-tauri-drag-region={detached ? true : undefined}>
        <h2>Letra</h2>
        <div>
          {!follow && (
            <IconButton label="Acompanhar letra" onClick={() => setFollow(true)}>
              <AlignCenter size={16} />
            </IconButton>
          )}
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
      <div className="lyrics-scroll" onWheel={() => setFollow(false)}>
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
