import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  Heart,
  ListMusic,
  LoaderCircle,
  MicVocal,
  Radio,
  Volume2,
  X,
} from 'lucide-react';
import { useApp, formatTime } from '../../stores/app';
import { useJam } from '../jam/state';
import { openJamWindow } from '../../lib/jamWindow';
import { coverMotion, drawerMotion, useReducedUI } from '../../lib/motion';
import Cover from '../glass/Cover';
import SVGPlane from '../glass/v3/SVGPlane';
import { IconButton, OfflineIndicator, SourceBadge } from '../glass/controls';
import {
  PlaybackControls,
  Seekbar,
  TrackMenu,
  VolumeControl,
  describePlaybackStatus,
  getUpcomingQueueItems,
  shouldRenderLyricsButton,
} from './GlassPlayer';
export {
  default,
  SidePlayer,
  getUpcomingQueueItems,
  shouldRenderLyricsButton,
} from './GlassPlayer';

export function ExpandedPlayer() {
  const expanded = useApp(s => s.expanded),
    track = useApp(s => s.queue[s.index]),
    status = useApp(s => s.status),
    playbackIntent = useApp(s => s.playbackIntent),
    likes = useApp(s => s.data.likes),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    queueShuffled = useApp(s => s.queueShuffled),
    shufflePlayed = useApp(s => s.shufflePlayed),
    shuffleNext = useApp(s => s.shuffleNext),
    shuffle = useApp(s => s.data.preferences.shuffle),
    queueOpen = useApp(s => s.queueOpen),
    lyricsOpen = useApp(s => s.lyricsOpen),
    lyricsAvailable = useApp(s => s.lyricsAvailable),
    downloadingIds = useApp(s => s.downloadingIds),
    jamSession = useJam(s => s.session),
    jamListeners = useJam(s => s.room?.members.length ?? (s.session ? 1 : 0)),
    isGlass = useApp(s => (s.data.preferences.uiStyle ?? 'matte') === 'glass');
  const reduced = useReducedUI();
  const [showVolume, setShowVolume] = useState(false);
  const sheetTouch = useRef<{ x: number; y: number } | null>(null);
  const coverTouch = useRef<{ x: number; y: number } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (expanded) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      const t = setTimeout(() => {
        sectionRef.current
          ?.querySelector<HTMLButtonElement>('button[aria-label="Fechar player expandido"]')
          ?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    if (prev && prev.isConnected && prev !== document.body) {
      prev.focus();
    }
  }, [expanded]);

  const showLyrics = shouldRenderLyricsButton({ hasActive: true, lyricsAvailable });
  const isDownloading = !!track && downloadingIds.includes(track.id);
  const canOffline = !!track && ['youtube', 'link'].includes(track.source) && track.kind === 'track';
  const statusLabel = describePlaybackStatus(
    status,
    playbackIntent,
    Boolean(jamSession && !jamSession.host),
  );
  const liked = !!track && likes.includes(track.id);

  return (
    <AnimatePresence>
      {expanded && track && (
        <motion.section
          ref={sectionRef}
          key="expanded-player"
          className={`expanded-player ${track.source !== 'local' ? 'with-external' : ''}`}
          aria-label="Tocando agora"
          {...drawerMotion(reduced, 'y')}
          onTouchStart={e => {
            const t = e.touches[0];
            if (t) sheetTouch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={e => {
            const start = sheetTouch.current;
            sheetTouch.current = null;
            const end = e.changedTouches[0];
            if (!start || !end) return;
            const dy = end.clientY - start.y;
            const dx = end.clientX - start.x;
            if (dy > 84 && Math.abs(dy) > Math.abs(dx) * 1.4 && start.y < 220) {
              useApp.setState({ expanded: false });
            }
          }}
        >
          {isGlass && <SVGPlane variant="deep" />}
          <div className="expanded-grabber" aria-hidden="true" />
          <div className="expanded-header">
            <IconButton
              label="Fechar player expandido"
              onClick={() => useApp.setState({ expanded: false })}
            >
              <ChevronDown size={20} />
            </IconButton>
            <div className="expanded-header-center">
              <span className="expanded-header-kicker">Tocando agora</span>
              {statusLabel ? (
                <small className="expanded-status-line" role="status">
                  {statusLabel}
                </small>
              ) : (
                track.album && <small>{track.album}</small>
              )}
            </div>
            <div className="expanded-header-right">
              <OfflineIndicator offline={track.offline} downloading={isDownloading} />
              <SourceBadge
                source={track.source}
                url={track.url}
                catalogSource={track.catalogSource}
                streamProvider={track.streamProvider}
                compact
              />
              <TrackMenu label="Opções no player expandido" track={track} />
            </div>
          </div>
          <div className="expanded-content">
            <div
              className="expanded-art"
              onTouchStart={e => {
                const t = e.touches[0];
                if (t) coverTouch.current = { x: t.clientX, y: t.clientY };
              }}
              onTouchEnd={e => {
                const start = coverTouch.current;
                coverTouch.current = null;
                const end = e.changedTouches[0];
                if (!start || !end) return;
                const dx = end.clientX - start.x;
                const dy = end.clientY - start.y;
                if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                  e.stopPropagation();
                  if (dx < 0) useApp.getState().next(true);
                  else useApp.getState().previous();
                }
              }}
            >
              <motion.div
                key={track.id}
                className="cover-transition-frame"
                {...coverMotion(reduced)}
              >
                <Cover track={track} />
              </motion.div>
            </div>
            <div className="expanded-controls-column">
              <div className="expanded-title">
                <div>
                  <h1>{track.title}</h1>
                  <p>{track.artist}</p>
                </div>
                <div className="expanded-title-actions">
                  {canOffline && (
                    <IconButton
                      label={track.offline ? 'Baixada offline' : 'Baixar para ouvir offline'}
                      active={Boolean(track.offline)}
                      aria-pressed={Boolean(track.offline)}
                      disabled={isDownloading}
                      onClick={() => {
                        if (!track.offline) void useApp.getState().downloadTrack(track);
                      }}
                    >
                      {isDownloading ? (
                        <LoaderCircle size={16} className="spinner" />
                      ) : track.offline ? (
                        <Check size={16} />
                      ) : (
                        <Download size={16} />
                      )}
                    </IconButton>
                  )}
                  <IconButton
                    label="Curtir no player expandido"
                    active={liked}
                    aria-pressed={liked}
                    onClick={() =>
                      void useApp
                        .getState()
                        .mutate({ action: 'like', track })
                        .catch(() => {})
                    }
                  >
                    <Heart size={18} fill={liked ? 'currentColor' : 'none'} />
                  </IconButton>
                </div>
              </div>
              <Seekbar />
              <PlaybackControls large localSurface />
              {showVolume && (
                <div className="expanded-volume-drawer">
                  <VolumeControl />
                </div>
              )}
              <div className="expanded-bottom-bar" role="toolbar" aria-label="Ferramentas do player">
                <button
                  type="button"
                  className={`expanded-tool-pill ${lyricsOpen ? 'active' : ''}`}
                  aria-pressed={lyricsOpen}
                  disabled={!showLyrics}
                  onClick={() => useApp.setState({ lyricsOpen: !lyricsOpen, queueOpen: false })}
                >
                  <MicVocal size={16} />
                  <span>Letras</span>
                </button>
                <button
                  type="button"
                  className={`expanded-tool-pill ${jamSession ? 'active is-live' : ''}`}
                  aria-pressed={Boolean(jamSession)}
                  onClick={() => {
                    useApp.setState({ expanded: false });
                    if (jamSession) void openJamWindow();
                    else useApp.getState().setDialog({ type: 'jam' });
                  }}
                >
                  <Radio size={16} />
                  <span>{jamSession ? `JAM (${jamListeners})` : 'JAM'}</span>
                </button>
                <button
                  type="button"
                  className={`expanded-tool-pill ${showVolume ? 'active' : ''}`}
                  aria-label="Controle de volume"
                  aria-expanded={showVolume}
                  onClick={() => setShowVolume(v => !v)}
                >
                  <Volume2 size={16} />
                  <span>Volume</span>
                </button>
                <button
                  type="button"
                  className={`expanded-tool-pill ${queueOpen ? 'active' : ''}`}
                  aria-expanded={queueOpen}
                  onClick={() => useApp.setState({ queueOpen: !queueOpen, lyricsOpen: false })}
                >
                  <ListMusic size={16} />
                  <span>{queueCount > 0 ? `Fila (${queueCount})` : 'Fila'}</span>
                </button>
              </div>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

export function Queue() {
  const open = useApp(s => s.queueOpen);
  return <AnimatePresence>{open && <QueueDrawer key="queue-drawer" />}</AnimatePresence>;
}

function QueueDrawer() {
  const queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    queueShuffled = useApp(s => s.queueShuffled),
    shufflePlayed = useApp(s => s.shufflePlayed),
    shuffleNext = useApp(s => s.shuffleNext),
    shuffle = useApp(s => s.data.preferences.shuffle),
    repeat = useApp(s => s.data.preferences.repeat),
    isGlass = useApp(s => (s.data.preferences.uiStyle ?? 'matte') === 'glass');
  const reduced = useReducedUI();
  const dragFrom = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    return () => {
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) {
        prevFocus.focus();
      }
    };
  }, []);

  const current = index >= 0 ? queue[index] : undefined;
  const upcoming = useMemo(
    () =>
      getUpcomingQueueItems({
        queue,
        index,
        queueShuffled,
        shufflePlayed,
        shuffleNext,
        shuffle,
      }),
    [queue, index, queueShuffled, shufflePlayed, shuffleNext, shuffle],
  );

  const virtual = useVirtualizer({
    count: upcoming.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  const handleRemoveQueueItem = (queueIdx: number, upcomingPos: number) => {
    useApp.getState().removeQueue(queueIdx);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const buttons = Array.from(
          panel.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remover "]'),
        );
        if (buttons.length > 0) {
          buttons[Math.min(upcomingPos, buttons.length - 1)]?.focus();
        } else {
          panel.querySelector<HTMLButtonElement>('button[aria-label="Fechar fila"]')?.focus();
        }
      });
    });
  };

  return (
    <motion.aside
      ref={panelRef}
      className="queue-panel glass"
      aria-label="Fila"
      {...drawerMotion(reduced, 'x')}
    >
      {isGlass && <SVGPlane variant="deep" />}
      <header>
        <h2>Fila</h2>
        <div className="queue-header-actions">
          {upcoming.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                useApp.getState().clearQueue();
                requestAnimationFrame(() => {
                  panelRef.current
                    ?.querySelector<HTMLButtonElement>('button[aria-label="Fechar fila"]')
                    ?.focus();
                });
              }}
            >
              Limpar
            </button>
          )}
          <IconButton label="Fechar fila" onClick={() => useApp.setState({ queueOpen: false })}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      {current ? (
        <div className="queue-body">
          <div className="queue-current-block">
            <div className="queue-section-title">Tocando agora</div>
            <div className="queue-item current">
              <div className="queue-track">
                <Cover track={current} />
                <span>
                  <strong>{current.title}</strong>
                  <small>{current.artist}</small>
                </span>
              </div>
              {current.duration > 0 && (
                <time className="queue-time">{formatTime(current.duration)}</time>
              )}
            </div>
            <div className="queue-section-title">
              A seguir ({upcoming.length})
              {repeat === 'all' ? ' · Repetir fila' : repeat === 'one' ? ' · Repetir faixa' : ''}
            </div>
          </div>

          <div ref={listRef} className="queue-list">
            {upcoming.length > 0 ? (
              <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                {virtual.getVirtualItems().map(vRow => {
                  const pos = vRow.index;
                  const item = upcoming[pos];
                  if (!item) return null;
                  const { t, idx } = item;
                  const unavailable = t.available === false;
                  return (
                    <div
                      className={`queue-item ${unavailable ? 'unavailable' : ''}`}
                      key={`${t.id}-${idx}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: vRow.size,
                        transform: `translateY(${vRow.start}px)`,
                      }}
                      onDragOver={e => {
                        if (dragFrom.current !== null) e.preventDefault();
                      }}
                      onDrop={e => {
                        e.preventDefault();
                        if (dragFrom.current !== null && dragFrom.current !== idx) {
                          useApp.getState().moveQueue(dragFrom.current, idx);
                        }
                        dragFrom.current = null;
                      }}
                    >
                      <span
                        className="drag-handle"
                        role="button"
                        tabIndex={0}
                        aria-label={`Reordenar ${t.title} na fila`}
                        draggable
                        onDragStart={e => {
                          dragFrom.current = idx;
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          dragFrom.current = null;
                        }}
                        onKeyDown={e => {
                          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                            e.preventDefault();
                            const targetPos = e.key === 'ArrowUp' ? pos - 1 : pos + 1;
                            const neighbor = upcoming[targetPos];
                            if (neighbor) {
                              useApp.getState().moveQueue(idx, neighbor.idx);
                            }
                          }
                        }}
                        title="Arraste ou use Alt + ↑ / ↓"
                      >
                        <GripVertical size={13} />
                      </span>
                      <button
                        type="button"
                        className="queue-track"
                        disabled={unavailable}
                        title={unavailable ? t.reason || 'Faixa indisponível' : undefined}
                        onClick={() => useApp.getState().jumpQueue(idx)}
                      >
                        <Cover track={t} />
                        <span>
                          <strong>{t.title}</strong>
                          <small>
                            {unavailable && <span className="unavailable-pill">Indisponível</span>}
                            {t.artist}
                          </small>
                        </span>
                      </button>
                      {t.duration > 0 && (
                        <time className="queue-time">{formatTime(t.duration)}</time>
                      )}
                      <span className="queue-touch-reorder">
                        {pos > 0 && (
                          <IconButton
                            label={`Mover ${t.title} para cima`}
                            onClick={() =>
                              useApp.getState().moveQueue(idx, upcoming[pos - 1]!.idx)
                            }
                          >
                            <ChevronUp size={14} />
                          </IconButton>
                        )}
                        {pos < upcoming.length - 1 && (
                          <IconButton
                            label={`Mover ${t.title} para baixo`}
                            onClick={() =>
                              useApp.getState().moveQueue(idx, upcoming[pos + 1]!.idx)
                            }
                          >
                            <ChevronDown size={14} />
                          </IconButton>
                        )}
                      </span>
                      <IconButton
                        label={`Remover ${t.title} da fila`}
                        onClick={() => handleRemoveQueueItem(idx, pos)}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-small">Nenhuma música a seguir.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="queue-list">
          <p className="empty-small">Fila vazia.</p>
        </div>
      )}
    </motion.aside>
  );
}
