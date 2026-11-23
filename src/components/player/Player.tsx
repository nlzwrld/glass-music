import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
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
  shouldRenderLyricsButton,
} from './GlassPlayer';
export { default, SidePlayer, shouldRenderLyricsButton } from './GlassPlayer';

export function ExpandedPlayer() {
  const expanded = useApp(s => s.expanded),
    track = useApp(s => s.queue[s.index]),
    likes = useApp(s => s.data.likes),
    queueCount = useApp(s => Math.max(0, s.queue.length - (s.index >= 0 ? 1 : 0))),
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

  const showLyrics = shouldRenderLyricsButton({ hasActive: true, lyricsAvailable });
  const isDownloading = !!track && downloadingIds.includes(track.id);
  const canOffline = !!track && ['youtube', 'link'].includes(track.source) && track.kind === 'track';

  return (
    <AnimatePresence>
      {expanded && track && (
        <motion.section
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
              {track.album && <small>{track.album}</small>}
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
              <AnimatePresence mode="wait">
                <motion.div
                  key={track.id}
                  className="cover-transition-frame"
                  {...coverMotion(reduced)}
                >
                  <Cover track={track} />
                </motion.div>
              </AnimatePresence>
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
                    active={likes.includes(track.id)}
                    onClick={() =>
                      void useApp
                        .getState()
                        .mutate({ action: 'like', track })
                        .catch(() => {})
                    }
                  >
                    <Heart size={18} fill={likes.includes(track.id) ? 'currentColor' : 'none'} />
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
                  disabled={!showLyrics}
                  onClick={() => useApp.setState({ lyricsOpen: !lyricsOpen, queueOpen: false })}
                >
                  <MicVocal size={16} />
                  <span>Letras</span>
                </button>
                <button
                  type="button"
                  className={`expanded-tool-pill ${jamSession ? 'active is-live' : ''}`}
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
                  onClick={() => setShowVolume(v => !v)}
                >
                  <Volume2 size={16} />
                  <span>Volume</span>
                </button>
                <button
                  type="button"
                  className={`expanded-tool-pill ${queueOpen ? 'active' : ''}`}
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
  const open = useApp(s => s.queueOpen),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    isGlass = useApp(s => (s.data.preferences.uiStyle ?? 'matte') === 'glass');
  const reduced = useReducedUI();
  const dragFrom = useRef<number | null>(null);

  const current = index >= 0 ? queue[index] : undefined;
  const upcoming = queue
    .map((t, idx) => ({ t, idx }))
    .filter(({ idx }) => idx !== index);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="queue-drawer"
          className="queue-panel glass"
          aria-label="Fila"
          {...drawerMotion(reduced, 'x')}
        >
          {isGlass && <SVGPlane variant="deep" />}
          <header>
            <h2>Fila</h2>
            <div className="queue-header-actions">
              {queue.length > 1 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => useApp.getState().clearQueue()}
                >
                  Limpar
                </button>
              )}
              <IconButton label="Fechar fila" onClick={() => useApp.setState({ queueOpen: false })}>
                <X size={16} />
              </IconButton>
            </div>
          </header>
          <div className="queue-list">
            {current ? (
              <>
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

                {upcoming.length > 0 && (
                  <>
                    <div className="queue-section-title">A seguir ({upcoming.length})</div>
                    {upcoming.map(({ t, idx }, pos) => (
                      <div
                        className="queue-item"
                        key={`${t.id}-${idx}`}
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
                          draggable
                          onDragStart={e => {
                            dragFrom.current = idx;
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragEnd={() => {
                            dragFrom.current = null;
                          }}
                          title="Arraste para reordenar"
                        >
                          <GripVertical size={13} />
                        </span>
                        <button
                          className="queue-track"
                          onClick={() => useApp.getState().jumpQueue(idx)}
                        >
                          <Cover track={t} />
                          <span>
                            <strong>{t.title}</strong>
                            <small>{t.artist}</small>
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
                          onClick={() => useApp.getState().removeQueue(idx)}
                        >
                          <X size={14} />
                        </IconButton>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : (
              <p className="empty-small">Fila vazia.</p>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
