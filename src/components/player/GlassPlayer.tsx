import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Heart,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  ListMusic,
  PictureInPicture2,
  Maximize2,
  X,
  ExternalLink,
  Plus,
  Music2,
  PanelRightOpen,
  MicVocal,
  LoaderCircle,
  Radio,
} from 'lucide-react';
import {
  useApp,
  formatTime,
  cleanError,
  setPreferencesFromUI,
  upcomingIndex,
} from '../../stores/app';
import { useJam } from '../jam/state';
import { openJamWindow } from '../../lib/jamWindow';
import { isMobileViewport } from '../../lib/androidBeta';
import { PlayerEngine, transport } from './engine';
import { coverMotion, useReducedUI } from '../../lib/motion';
import Cover from '../glass/Cover';
import { IconButton, OfflineIndicator, SmartShuffleIcon, SourceBadge } from '../glass/controls';
import {
  GlassContextMenu,
  GlassMaterial,
  GlassPanel,
  GlassSlider,
  LiquidLens,
} from '../glass/materials';
import type { Track } from '../../../shared/types';

export function shouldRenderLyricsButton(state: {
  hasActive: boolean;
  lyricsAvailable: boolean;
}): boolean {
  return Boolean(state.hasActive && state.lyricsAvailable);
}

export function getUpcomingQueueItems(state: {
  queue: Track[];
  index: number;
  queueShuffled: boolean;
  shufflePlayed: number[];
  shuffleNext: number | null;
  shuffle: boolean;
}): Array<{ t: Track; idx: number }> {
  const { queue, index, queueShuffled, shufflePlayed, shuffleNext, shuffle } = state;
  if (!queue.length) return [];
  if (index < 0) return queue.map((t, idx) => ({ t, idx }));
  if (!queueShuffled && shuffle) {
    const seen = new Set<number>([index]);
    const ordered: Array<{ t: Track; idx: number }> = [];
    if (
      shuffleNext !== null &&
      shuffleNext >= 0 &&
      shuffleNext < queue.length &&
      shuffleNext !== index &&
      queue[shuffleNext]?.available !== false
    ) {
      seen.add(shuffleNext);
      ordered.push({ t: queue[shuffleNext]!, idx: shuffleNext });
    }
    for (let idx = 0; idx < queue.length; idx++) {
      if (!seen.has(idx) && !shufflePlayed.includes(idx)) {
        seen.add(idx);
        ordered.push({ t: queue[idx]!, idx });
      }
    }
    return ordered;
  }
  const items: Array<{ t: Track; idx: number }> = [];
  for (let idx = index + 1; idx < queue.length; idx++) {
    items.push({ t: queue[idx]!, idx });
  }
  return items;
}

export function describePlaybackStatus(
  status: string,
  playbackIntent: boolean,
  isJamGuest: boolean,
): string {
  if (status === 'Sincronizando fonte de áudio...') return 'Sincronizando áudio…';
  if (status === 'Buscando recomendações no seu estilo…') return 'Buscando recomendações…';
  if (status === 'Carregando' && playbackIntent) return 'Carregando…';
  if (status === 'Fim da fila') return 'Fim da fila';
  if (isJamGuest) return 'Sincronizado na JAM';
  return '';
}

function formatAccessibleTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 segundos';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function useDisplayTrack() {
  return useApp(
    s =>
      s.queue[s.index] ||
      s.data.tracks.find(
        t =>
          t.kind === 'track' &&
          ['local', 'soundcloud', 'youtube', 'link'].includes(t.source) &&
          t.available !== false,
      ),
  );
}

export function PlaybackControls({
  large = false,
  localSurface = false,
}: {
  large?: boolean;
  localSurface?: boolean;
}) {
  const active = useApp(s => s.queue[s.index]),
    track = useDisplayTrack(),
    playing = useApp(s => s.playing),
    playbackIntent = useApp(s => s.playbackIntent),
    status = useApp(s => s.status),
    p = useApp(s => s.data.preferences);
  const isGlass = (p.uiStyle ?? 'matte') === 'glass';
  const wantsPlayback = playing || playbackIntent;
  const preparing =
    playbackIntent &&
    (status === 'Carregando' || status === 'Sincronizando fonte de áudio...');

  const shuffleMode = p.shuffleMode ?? 'smart';
  const shuffleLabel = !p.shuffle
    ? 'Aleatório'
    : shuffleMode === 'smart'
      ? 'Aleatório Inteligente'
      : 'Aleatório tradicional';

  return (
    <div className={`transport ${large ? 'large' : ''}`}>
      <IconButton
        label={shuffleLabel}
        active={p.shuffle}
        aria-pressed={p.shuffle}
        data-shuffle-mode={p.shuffle ? shuffleMode : 'off'}
        className={`shuffle-transport-btn ${p.shuffle && shuffleMode === 'smart' ? 'is-smart' : ''}`}
        onClick={() => {
          if (!p.shuffle) {
            setPreferencesFromUI({ shuffle: true, shuffleMode: 'smart' });
          } else if (shuffleMode === 'smart') {
            setPreferencesFromUI({ shuffle: true, shuffleMode: 'standard' });
          } else {
            setPreferencesFromUI({ shuffle: false });
          }
        }}
      >
        {p.shuffle && shuffleMode === 'smart' ? (
          <SmartShuffleIcon size={16} />
        ) : (
          <Shuffle size={15} />
        )}
        {p.shuffle && shuffleMode !== 'smart' && (
          <span className="transport-active-dot" aria-hidden="true" />
        )}
      </IconButton>
      <IconButton
        label="Faixa anterior"
        disabled={!active}
        onClick={() => useApp.getState().previous()}
      >
        <SkipBack size={17} fill="currentColor" />
      </IconButton>
      <button
        className="play-main"
        data-optic={!isGlass || localSurface ? 'css' : 'auto'}
        data-crystal="thin"
        data-material="clear"
        title={wantsPlayback ? 'Pausar' : 'Reproduzir'}
        aria-label={wantsPlayback ? 'Pausar' : 'Reproduzir'}
        disabled={!track}
        onClick={() => {
          if (active) transport.toggle();
          else if (track)
            useApp
              .getState()
              .play(track, useApp.getState().data.tracks.filter(t => t.kind === 'track'));
        }}
      >
        {isGlass && <LiquidLens />}
        {preparing ? (
          <LoaderCircle className="spinner" size={16} />
        ) : wantsPlayback ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
      </button>
      <IconButton
        label="Próxima faixa"
        disabled={!active}
        onClick={() => useApp.getState().next()}
      >
        <SkipForward size={17} fill="currentColor" />
      </IconButton>
      <IconButton
        label={`Repetir: ${p.repeat === 'off' ? 'desligado' : p.repeat === 'all' ? 'fila' : 'uma faixa'}`}
        active={p.repeat !== 'off'}
        aria-pressed={p.repeat !== 'off'}
        className="repeat-transport-btn"
        onClick={() =>
          setPreferencesFromUI({
            repeat: p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off',
          })
        }
      >
        {p.repeat === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
        {p.repeat !== 'off' && <span className="transport-active-dot" aria-hidden="true" />}
      </IconButton>
    </div>
  );
}

export function Seekbar({ compact = false }: { compact?: boolean }) {
  const position = useApp(s => s.position),
    measuredDuration = useApp(s => s.duration),
    track = useApp(s => s.queue[s.index]),
    preview = useDisplayTrack();
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const isDragging = useRef(false);
  const draftRef = useRef<number | null>(null);

  useEffect(() => {
    setDraftPosition(null);
    draftRef.current = null;
    if (isDragging.current) {
      isDragging.current = false;
      transport.setScrubbing(false);
    }
  }, [track?.id]);

  useEffect(() => {
    return () => {
      if (isDragging.current) {
        isDragging.current = false;
        transport.setScrubbing(false);
      }
    };
  }, []);

  const commitScrub = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    transport.setScrubbing(false);
    const target = draftRef.current;
    draftRef.current = null;
    setDraftPosition(null);
    if (target !== null) {
      transport.seek(target);
    }
  };

  useEffect(() => {
    if (draftPosition === null && !isDragging.current) return;
    const onGlobalRelease = () => commitScrub();
    window.addEventListener('pointerup', onGlobalRelease);
    window.addEventListener('pointercancel', onGlobalRelease);
    return () => {
      window.removeEventListener('pointerup', onGlobalRelease);
      window.removeEventListener('pointercancel', onGlobalRelease);
    };
  }, [draftPosition !== null]);

  const duration = track ? measuredDuration || track.duration || 0 : preview?.duration || 0;
  const knownDuration = Number.isFinite(duration) && duration > 0;
  const maxVal = knownDuration ? duration : 1;
  const baseElapsed = track ? position : 0;
  const shownElapsed = Math.max(
    0,
    Math.min(draftPosition !== null ? draftPosition : baseElapsed, maxVal),
  );
  const progressPct = knownDuration ? Math.max(0, Math.min(100, (shownElapsed / duration) * 100)) : 0;

  return (
    <div
      className={`seek ${compact ? 'compact-seek' : ''} ${draftPosition !== null ? 'is-scrubbing' : ''}`}
      onTouchStart={e => e.stopPropagation()}
      onTouchMove={e => e.stopPropagation()}
    >
      <time>
        {formatTime(shownElapsed)}
        {compact && (
          <>
            <span> / </span>
            {knownDuration ? formatTime(duration) : '—:—'}
          </>
        )}
      </time>
      <GlassSlider
        aria-label="Posição da música"
        aria-valuetext={`${formatAccessibleTime(shownElapsed)} de ${knownDuration ? formatAccessibleTime(duration) : 'duração desconhecida'}`}
        min={0}
        max={maxVal}
        step={0.5}
        value={shownElapsed}
        disabled={!track || !knownDuration}
        onPointerDown={() => {
          if (!track || !knownDuration) return;
          isDragging.current = true;
          draftRef.current = shownElapsed;
          transport.setScrubbing(true);
        }}
        onPointerUp={commitScrub}
        onPointerCancel={commitScrub}
        onLostPointerCapture={commitScrub}
        onBlur={commitScrub}
        onKeyDown={e => {
          if (!track || !knownDuration) return;
          let delta = 0;
          if (e.key === 'PageUp') delta = 15;
          else if (e.key === 'PageDown') delta = -15;
          else if (e.shiftKey && e.key === 'ArrowRight') delta = 10;
          else if (e.shiftKey && e.key === 'ArrowLeft') delta = -10;
          if (delta !== 0) {
            e.preventDefault();
            const target = Math.max(0, Math.min(duration, shownElapsed + delta));
            transport.seek(target);
          }
        }}
        onChange={e => {
          const n = Number(e.target.value);
          if (isDragging.current) {
            draftRef.current = n;
            setDraftPosition(n);
          } else {
            transport.seek(n);
          }
        }}
        style={{ '--progress': `${progressPct}%` } as React.CSSProperties}
      />
      {!compact && <time>{knownDuration ? formatTime(duration) : '—:—'}</time>}
    </div>
  );
}

export function VolumeControl() {
  const volume = useApp(s => s.data.preferences.volume);
  const lastVolume = useApp(s => s.lastVolume);
  return (
    <div className="volume-control">
      <IconButton
        label={volume ? 'Silenciar' : 'Ativar som'}
        aria-pressed={volume === 0}
        onClick={() => setPreferencesFromUI({ volume: volume ? 0 : lastVolume || 65 })}
      >
        {volume ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </IconButton>
      <GlassSlider
        aria-label="Volume"
        aria-valuetext={volume === 0 ? 'Silenciado (0%)' : `${volume}%`}
        min={0}
        max={100}
        value={volume}
        style={{ '--progress': `${volume}%` } as React.CSSProperties}
        onChange={e => setPreferencesFromUI({ volume: Number(e.target.value) })}
      />
    </div>
  );
}

export function TrackMenu({ track, label }: { track?: Track; label: string }) {
  return (
    <GlassContextMenu
      label={label}
      disabled={!track}
      getItems={() =>
        track
          ? [
              {
                label: 'Adicionar à playlist',
                icon: <Plus size={15} />,
                action: () => useApp.getState().setDialog({ type: 'add', track }),
              },
              {
                label: 'Adicionar à fila',
                icon: <ListMusic size={15} />,
                action: () => useApp.getState().enqueue(track),
              },
              {
                label: 'Salvar na biblioteca',
                icon: <Music2 size={15} />,
                action: () => {
                  void useApp
                    .getState()
                    .mutate({ action: 'save', track })
                    .then(() => useApp.getState().message('Salva na biblioteca.'))
                    .catch(() => {});
                },
              },
              ...(track.source !== 'local' && track.kind === 'track'
                ? [
                    {
                      label: 'Trocar fonte de áudio',
                      icon: <Radio size={15} />,
                      action: () =>
                        useApp.getState().setDialog({ type: 'streamSource', track }),
                    },
                  ]
                : []),
              ...(track.url
                ? [
                    {
                      label: 'Abrir na plataforma',
                      icon: <ExternalLink size={15} />,
                      action: () => {
                        void window.glass
                          .external(track.url!)
                          .catch(e => useApp.getState().message(cleanError(e)));
                      },
                    },
                  ]
                : []),
            ]
          : []
      }
    />
  );
}

function Favorite({ label, track }: { label: string; track?: Track }) {
  const likes = useApp(s => s.data.likes);
  const liked = !!track && likes.includes(track.id);
  return (
    <IconButton
      label={label}
      active={liked}
      aria-pressed={liked}
      disabled={!track}
      onClick={() =>
        track &&
        void useApp
          .getState()
          .mutate({ action: 'like', track })
          .catch(() => {})
      }
    >
      <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
    </IconButton>
  );
}

function AuxiliaryControls() {
  const queueOpen = useApp(s => s.queueOpen),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    queueShuffled = useApp(s => s.queueShuffled),
    shufflePlayed = useApp(s => s.shufflePlayed),
    shuffleNext = useApp(s => s.shuffleNext),
    shuffle = useApp(s => s.data.preferences.shuffle),
    lyricsOpen = useApp(s => s.lyricsOpen),
    lyricsAvailable = useApp(s => s.lyricsAvailable),
    hasActive = useApp(s => !!s.queue[s.index]),
    mini = useApp(s => s.mini),
    jamSession = useJam(s => s.session),
    jamConnected = useJam(s => s.connected),
    jamListeners = useJam(s => s.room?.members.length ?? (s.session ? 1 : 0)),
    jamPendingReqCount = useJam(s => (s.session?.host ? s.room?.pendingRequestCount ?? 0 : 0));

  const queueCount = useMemo(
    () =>
      getUpcomingQueueItems({
        queue,
        index,
        queueShuffled,
        shufflePlayed,
        shuffleNext,
        shuffle,
      }).length,
    [queue, index, queueShuffled, shufflePlayed, shuffleNext, shuffle],
  );
  const showLyrics = shouldRenderLyricsButton({ hasActive, lyricsAvailable });

  return (
    <>
      {jamSession && (
        <button
          type="button"
          className={`jam-player-badge ${jamConnected ? 'connected' : 'reconnecting'}`}
          aria-label={`JAM ativa com ${jamListeners} ouvinte(s)${jamPendingReqCount > 0 ? ` e ${jamPendingReqCount} pedido(s) pendente(s)` : ''}`}
          title={`JAM ao vivo · ${jamListeners} ouvinte(s)${jamPendingReqCount > 0 ? ` · ${jamPendingReqCount} pedido(s) pendente(s)` : ''}`}
          onClick={() => {
            if (mini) {
              void window.glass.window('restore').then(() => useApp.setState({ mini: false }));
            }
            void openJamWindow();
          }}
        >
          <span className="jam-pulse-dot" aria-hidden="true" />
          <Radio size={14} />
          <span>{jamListeners}</span>
          {jamPendingReqCount > 0 && (
            <span className="detached-jam-tab-badge" aria-hidden="true">
              +{jamPendingReqCount}
            </span>
          )}
        </button>
      )}
      <AnimatePresence initial={false}>
        {showLyrics && (
          <motion.span
            key="conditional-lyrics-btn"
            className="lyrics-btn-presence"
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <IconButton
              label="Letras"
              active={lyricsOpen}
              aria-expanded={lyricsOpen}
              onClick={() => {
                if (mini)
                  void window.glass
                    .openLyrics()
                    .catch(e => useApp.getState().message(cleanError(e)));
                else useApp.setState({ lyricsOpen: !useApp.getState().lyricsOpen });
              }}
            >
              <MicVocal size={16} />
            </IconButton>
          </motion.span>
        )}
      </AnimatePresence>
      <span className="queue-btn-wrap">
        <IconButton
          label="Fila de reprodução"
          active={queueOpen}
          aria-expanded={queueOpen}
          onClick={() => useApp.setState({ queueOpen: !queueOpen })}
        >
          <ListMusic size={16} />
        </IconButton>
        {queueCount > 0 && <span className="queue-count-dot" aria-hidden="true">{queueCount > 99 ? '99+' : queueCount}</span>}
      </span>
      <IconButton
        label={mini ? 'Sair do mini-player' : 'Mini-player'}
        active={mini}
        aria-pressed={mini}
        onClick={() => {
          void window.glass
            .window(mini ? 'restore' : 'mini')
            .then(() =>
              useApp.setState({
                mini: !mini,
                expanded: false,
                queueOpen: false,
                lyricsOpen: false,
              }),
            )
            .catch(e => useApp.getState().message(cleanError(e)));
        }}
      >
        <PictureInPicture2 size={16} />
      </IconButton>
    </>
  );
}

export function SidePlayer() {
  const track = useDisplayTrack(),
    active = useApp(s => s.queue[s.index]),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    queueShuffled = useApp(s => s.queueShuffled),
    shufflePlayed = useApp(s => s.shufflePlayed),
    shuffleNext = useApp(s => s.shuffleNext),
    data = useApp(s => s.data),
    downloadingIds = useApp(s => s.downloadingIds);
  const isDownloading = !!track && downloadingIds.includes(track.id);
  const nextIdx = useMemo(
    () =>
      upcomingIndex(
        {
          queue,
          index,
          queueShuffled,
          shufflePlayed,
          shuffleNext,
          data,
        },
        false,
      ),
    [queue, index, queueShuffled, shufflePlayed, shuffleNext, data],
  );
  const nextTrack = nextIdx >= 0 ? queue[nextIdx] : undefined;

  return (
    <GlassPanel
      className={`side-player ${active && active.source !== 'local' ? 'external-track' : ''}`}
      aria-label="Tocando agora"
    >
      <div className="side-player-header">
        <span className="side-panel-label">Tocando agora</span>
        <div>
          <IconButton
            label="Expandir música"
            disabled={!active}
            onClick={() => useApp.setState({ expanded: true })}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="Fechar painel lateral"
            className="side-close"
            onClick={() => useApp.setState({ sideOpen: false })}
          >
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="side-art">
        <div className="side-cover">
          <Cover track={track} />
        </div>
      </div>
      <div className="side-info">
        <div>
          <h2>{track?.title || 'Nada tocando'}</h2>
          <p>{track ? `${track.artist}${track.album ? ` · ${track.album}` : ''}` : ''}</p>
        </div>
        <Favorite label="Curtir no player lateral" track={track} />
        <TrackMenu label="Opções no player lateral" track={track} />
      </div>
      {track && (
        <div className="side-badges">
          <OfflineIndicator offline={track.offline} downloading={isDownloading} />
          <SourceBadge
            source={track.source}
            url={track.url}
            catalogSource={track.catalogSource}
            streamProvider={track.streamProvider}
          />
        </div>
      )}
      {nextTrack && (
        <div className="side-next-up">
          <span className="side-panel-label">A seguir</span>
          <button
            type="button"
            className="side-next-card"
            onClick={() => useApp.getState().jumpQueue(nextIdx)}
            aria-label={`Reproduzir a seguir: ${nextTrack.title}`}
          >
            <span className="side-next-cover">
              <Cover track={nextTrack} />
            </span>
            <span className="side-next-meta">
              <strong>{nextTrack.title}</strong>
              <small>{nextTrack.artist}</small>
            </span>
          </button>
        </div>
      )}
    </GlassPanel>
  );
}

function MobileMiniProgress({
  hasActive,
  fallbackDuration,
}: {
  hasActive: boolean;
  fallbackDuration: number;
}) {
  const position = useApp(s => s.position);
  const duration = useApp(s => s.duration);
  const totalDuration = hasActive ? duration || fallbackDuration : fallbackDuration;
  const progressPct =
    hasActive && Number.isFinite(totalDuration) && totalDuration > 0
      ? Math.max(0, Math.min(100, (position / totalDuration) * 100))
      : 0;
  return (
    <div className="mobile-mini-progress" aria-hidden="true">
      <span style={{ width: `${progressPct}%` }} />
    </div>
  );
}

export default function GlassPlayer() {
  const track = useDisplayTrack(),
    active = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing),
    playbackIntent = useApp(s => s.playbackIntent),
    status = useApp(s => s.status),
    mini = useApp(s => s.mini),
    downloadingIds = useApp(s => s.downloadingIds),
    sideOpen = useApp(s => s.sideOpen),
    error = useApp(s => s.error),
    jamSession = useJam(s => s.session),
    reduced = useReducedUI();
  const jamActive = Boolean(jamSession);
  const isJamGuest = Boolean(jamSession && !jamSession.host);
  const [mobile, setMobile] = useState(() => isMobileViewport(undefined, undefined, mini));
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const sync = () => setMobile(isMobileViewport(undefined, undefined, useApp.getState().mini));
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [mini]);

  const isDownloading = !!track && downloadingIds.includes(track.id);
  const wantsPlayback = playing || playbackIntent;
  const preparing =
    playbackIntent &&
    (status === 'Carregando' || status === 'Sincronizando fonte de áudio...');
  const statusLabel = active ? describePlaybackStatus(status, playbackIntent, isJamGuest) : '';

  if (mobile) {
    return (
      <>
        <GlassMaterial
          as="footer"
          variant="thick"
          material="floating"
          className="player mobile-mini-player"
          aria-label="Controles de reprodução"
          onTouchStart={e => {
            const t = e.touches[0];
            if (t) touchOrigin.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={e => {
            const start = touchOrigin.current;
            touchOrigin.current = null;
            const end = e.changedTouches[0];
            if (!start || !end || !active) return;
            const dx = end.clientX - start.x;
            const dy = end.clientY - start.y;
            if (dy < -48 && Math.abs(dy) > Math.abs(dx)) {
              useApp.setState({ expanded: true });
            } else if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
              if (dx < 0) useApp.getState().next(true);
              else useApp.getState().previous();
            }
          }}
        >
          <PlayerEngine />
          <button
            type="button"
            className="mobile-mini-hit"
            aria-label="Abrir player expandido"
            disabled={!active}
            onClick={() => active && useApp.setState({ expanded: true })}
          >
            <span className="mobile-mini-cover">
              <motion.div
                key={track?.id || 'empty'}
                className="cover-transition-frame"
                {...coverMotion(reduced)}
              >
                <Cover track={track} />
              </motion.div>
            </span>
            <span className="mobile-mini-meta">
              <strong>{track?.title || 'Nenhuma faixa'}</strong>
              <small>
                {track && <OfflineIndicator offline={track.offline} downloading={isDownloading} />}
                <span>{track?.artist || 'Toque em uma música para ouvir'}</span>
                {statusLabel && (
                  <span className="player-status-pill" role="status">
                    {statusLabel}
                  </span>
                )}
              </small>
            </span>
          </button>
          <div className="mobile-mini-actions">
            <Favorite label="Curtir música atual" track={track} />
            <button
              type="button"
              className="mobile-mini-play"
              aria-label={wantsPlayback ? 'Pausar' : 'Reproduzir'}
              disabled={!track}
              onClick={() => {
                if (active) transport.toggle();
                else if (track)
                  useApp
                    .getState()
                    .play(track, useApp.getState().data.tracks.filter(t => t.kind === 'track'));
              }}
            >
              {preparing ? (
                <LoaderCircle className="spinner" size={18} />
              ) : wantsPlayback ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </button>
            <IconButton
              label="Próxima faixa"
              disabled={!active}
              onClick={() => useApp.getState().next(true)}
            >
              <SkipForward size={18} fill="currentColor" />
            </IconButton>
          </div>
          <MobileMiniProgress
            hasActive={Boolean(active)}
            fallbackDuration={active?.duration || track?.duration || 0}
          />
        </GlassMaterial>
        {error && (
          <div className="playback-error mobile-playback-error" role="alert">
            <span>{error}</span>
            {active && (
              <button
                className="button secondary"
                onClick={() => useApp.getState().play(active, useApp.getState().queue)}
              >
                Tentar
              </button>
            )}
            <IconButton
              label="Fechar aviso de reprodução"
              onClick={() => useApp.setState({ error: '' })}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
      </>
    );
  }

  return (
    <GlassMaterial
      as="footer"
      variant="thick"
      material="floating"
      className="player"
      aria-label="Controles de reprodução"
    >
      <PlayerEngine />
      <div className="now-playing">
        <button
          className="now-cover"
          aria-label="Abrir player expandido"
          disabled={!active}
          onClick={() => useApp.setState({ expanded: true })}
        >
          <motion.div
            key={track?.id || 'empty'}
            className="cover-transition-frame"
            {...coverMotion(reduced)}
          >
            <Cover track={track} />
          </motion.div>
          <span>
            <Maximize2 size={14} />
          </span>
        </button>
        <div className="now-info">
          <motion.div
            key={track?.id || 'empty-info'}
            className="now-info-motion"
            initial={reduced ? false : { opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] }}
          >
            <strong>{track?.title || 'Nenhuma faixa'}</strong>
            <small className="now-subline">
              {track && <OfflineIndicator offline={track.offline} downloading={isDownloading} />}
              <span>{track?.artist || '—'}</span>
              {track && track.streamProvider && track.source === 'link' && (
                <SourceBadge
                  source={track.source}
                  url={track.url}
                  catalogSource={track.catalogSource}
                  streamProvider={track.streamProvider}
                  compact
                />
              )}
              {statusLabel && (
                <span className="player-status-pill" role="status">
                  {statusLabel}
                </span>
              )}
            </small>
          </motion.div>
        </div>
        <Favorite label="Curtir música atual" track={track} />
        <TrackMenu label="Opções da música atual" track={track} />
      </div>
      <div className="player-center">
        <PlaybackControls />
        <div className="player-progress">
          <Seekbar />
        </div>
      </div>
      <div className="player-tools">
        <div className="compact-tools">
          {!jamActive && (
            <IconButton
              label="Iniciar ou entrar em uma JAM"
              active={false}
              onClick={() => useApp.getState().setDialog({ type: 'jam' })}
            >
              <Radio size={16} />
            </IconButton>
          )}
          <AuxiliaryControls />
          <IconButton
            label="Mostrar player lateral"
            active={sideOpen}
            aria-expanded={sideOpen}
            onClick={() => useApp.setState({ sideOpen: !useApp.getState().sideOpen })}
          >
            <PanelRightOpen size={16} />
          </IconButton>
        </div>
        <VolumeControl />
      </div>
      {error && (
        <div className="playback-error" role="alert">
          <span>{error}</span>
          {active && (
            <button
              className="button secondary"
              onClick={() => useApp.getState().play(active, useApp.getState().queue)}
            >
              Tentar novamente
            </button>
          )}
          <IconButton
            label="Fechar aviso de reprodução"
            onClick={() => useApp.setState({ error: '' })}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
    </GlassMaterial>
  );
}
