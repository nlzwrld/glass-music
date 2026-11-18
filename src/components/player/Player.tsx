import { useRef } from 'react';
import {
  Heart,
  ChevronDown,
  GripVertical,
  X,
  ListMusic,
  AudioLines,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useApp, formatTime } from '../../stores/app';
import Cover from '../glass/Cover';
import SVGPlane from '../glass/v3/SVGPlane';
import { IconButton, SourceBadge } from '../glass/controls';
import { GlassContextMenu } from '../glass/materials';
import { trackActions } from '../library/trackActions';
import { PlaybackControls, Seekbar } from './GlassPlayer';
export { default, SidePlayer } from './GlassPlayer';

export function ExpandedPlayer() {
  const expanded = useApp(s => s.expanded),
    track = useApp(s => s.queue[s.index]),
    likes = useApp(s => s.data.likes);
  return (
    <AnimatePresence>
      {expanded && track && (
        <motion.section
          className={`expanded-player ${track.source !== 'local' ? 'with-external' : ''}`}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          aria-label="Player expandido"
        >
          <SVGPlane variant="deep" />
          <div className="expanded-header">
            <IconButton
              label="Fechar player expandido"
              onClick={() => useApp.setState({ expanded: false })}
            >
              <ChevronDown />
            </IconButton>
            <span />
            <SourceBadge source={track.source} url={track.url} />
          </div>
          <div className="expanded-content">
            <motion.div layoutId="expanded-art" className="expanded-art">
              <Cover track={track} />
            </motion.div>
            <div className="expanded-title">
              <div>
                <h1>{track.title}</h1>
                <p>{track.artist}</p>
              </div>
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
                <Heart fill={likes.includes(track.id) ? 'currentColor' : 'none'} />
              </IconButton>
            </div>
            <Seekbar />
            <PlaybackControls large localSurface />
            <p className="expanded-album">
              {track.album || (track.source === 'local' ? 'Da sua coleção' : '')}
            </p>
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
    likes = useApp(s => s.data.likes),
    autoplay = useApp(s => s.data.preferences.autoplay);
  const dragFrom = useRef<number | null>(null);

  const current = index >= 0 ? queue[index] : undefined;
  const upcomingEntries = queue
    .map((track, idx) => ({ track, idx }))
    .filter(({ idx }) => idx > index);
  const previousEntries = queue
    .map((track, idx) => ({ track, idx }))
    .filter(({ idx }) => idx < index);
  const orderedUpcoming = [...upcomingEntries, ...previousEntries];

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="queue-panel glass lg-queue-panel"
          initial={{ opacity: 0, x: 24, scale: 0.99 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24, scale: 0.99 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          aria-label="Fila de reprodução"
        >
          <SVGPlane variant="deep" />
          <header className="lg-queue-header">
            <div className="lg-queue-title">
              <ListMusic size={19} />
              <h2>Fila de reprodução</h2>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <GlassContextMenu
                label="Opções da fila"
                disabled={!queue.length}
                items={[
                  {
                    label: 'Adicionar mix do estilo atual',
                    icon: <Sparkles size={16} />,
                    action: () => {
                      void useApp.getState().extendWithRecommendations();
                    },
                  },
                  {
                    label: 'Limpar próximas músicas',
                    icon: <Trash2 size={16} />,
                    danger: true,
                    disabled: queue.length <= 1,
                    action: () => useApp.getState().clearQueue(),
                  },
                ]}
              />
              <IconButton
                label="Fechar fila"
                onClick={() => useApp.setState({ queueOpen: false })}
              >
                <X size={19} />
              </IconButton>
            </div>
          </header>

          <div className="queue-list">
            {current ? (
              <>
                <div className="lg-queue-section-label">
                  <strong>Tocando agora</strong>
                </div>
                <div className="lg-queue-now" data-track-item>
                  <div className="lg-queue-now-art">
                    <Cover track={current} />
                    <span className="lg-eq-pill" aria-hidden="true">
                      <AudioLines size={13} />
                    </span>
                  </div>
                  <div className="lg-queue-now-meta">
                    <strong>{current.title}</strong>
                    <small>{current.artist}</small>
                  </div>
                  <IconButton
                    label={`Curtir ${current.title}`}
                    active={likes.includes(current.id)}
                    onClick={() =>
                      void useApp
                        .getState()
                        .mutate({ action: 'like', track: current })
                        .catch(() => {})
                    }
                  >
                    <Heart
                      size={16}
                      fill={likes.includes(current.id) ? 'currentColor' : 'none'}
                    />
                  </IconButton>
                  <GlassContextMenu
                    label={`Opções de ${current.title}`}
                    items={trackActions(current, queue)}
                  />
                </div>

                <div className="lg-queue-section-label" style={{ marginTop: 18 }}>
                  <strong>Próximas músicas</strong>
                  <span>{orderedUpcoming.length} músicas</span>
                </div>

                {orderedUpcoming.length ? (
                  orderedUpcoming.map(({ track: t, idx }) => (
                    <div
                      data-track-item
                      className="queue-item lg-queue-row"
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
                        <GripVertical size={14} />
                      </span>
                      <button
                        className="queue-track"
                        onClick={() => useApp.getState().jumpQueue(idx)}
                      >
                        <Cover track={t} />
                        <span>
                          <strong>
                            {t.title}
                            {t.recommended && (
                              <em className="recommended-chip">
                                <Sparkles size={10} /> Mix
                              </em>
                            )}
                          </strong>
                          <small>{t.artist}</small>
                        </span>
                      </button>
                      <time className="lg-queue-time">
                        {t.duration ? formatTime(t.duration) : '—'}
                      </time>
                      <IconButton
                        label={`Curtir ${t.title}`}
                        active={likes.includes(t.id)}
                        onClick={() =>
                          void useApp
                            .getState()
                            .mutate({ action: 'like', track: t })
                            .catch(() => {})
                        }
                      >
                        <Heart
                          size={15}
                          fill={likes.includes(t.id) ? 'currentColor' : 'none'}
                        />
                      </IconButton>
                      <GlassContextMenu
                        label={`Opções de ${t.title}`}
                        items={[
                          ...trackActions(t, queue),
                          {
                            label: 'Remover da fila',
                            icon: <X size={16} />,
                            danger: true,
                            action: () => useApp.getState().removeQueue(idx),
                          },
                        ]}
                      />
                    </div>
                  ))
                ) : (
                  <p className="empty-small">
                    {autoplay
                      ? 'Ao terminar esta música, o Glass buscará novas faixas no seu estilo.'
                      : 'Sem próximas músicas na fila.'}
                  </p>
                )}
              </>
            ) : (
              <p className="empty-small">Escolha uma música para iniciar a fila.</p>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
