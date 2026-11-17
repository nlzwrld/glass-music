import { useRef } from 'react';
import { Heart, ChevronDown, GripVertical, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useApp } from '../../stores/app';
import Cover from '../glass/Cover';
import SVGPlane from '../glass/v3/SVGPlane';
import { IconButton, SourceBadge } from '../glass/controls';
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
            <span></span>
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
    index = useApp(s => s.index);
  const dragFrom = useRef<number | null>(null);
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="queue-panel glass"
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 30 }}
        >
          <SVGPlane variant="deep" />
          <header>
            <div>
              <h2>Fila de reprodução</h2>
            </div>
            <IconButton label="Fechar fila" onClick={() => useApp.setState({ queueOpen: false })}>
              <X size={20} />
            </IconButton>
          </header>
          <div className="queue-list">
            {queue.length ? (
              queue.map((t, i) => (
                <div
                  className={`queue-item ${i === index ? 'current' : ''}`}
                  key={`${t.id}-${i}`}
                  onDragOver={e => {
                    if (dragFrom.current !== null) e.preventDefault();
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    if (dragFrom.current !== null && dragFrom.current !== i) {
                      useApp.getState().moveQueue(dragFrom.current, i);
                    }
                    dragFrom.current = null;
                  }}
                >
                  <span
                    className="drag-handle"
                    draggable
                    onDragStart={e => {
                      dragFrom.current = i;
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
                    onClick={() =>
                      useApp.setState({
                        index: i,
                        autoAdvance: false,
                        revision: useApp.getState().revision + 1,
                        error: '',
                        position: 0,
                      })
                    }
                  >
                    <Cover track={t} />
                    <span>
                      <strong>{t.title}</strong>
                      <small>{t.artist}</small>
                    </span>
                  </button>
                  {i === index ? (
                    <span className="playing-bars">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <IconButton
                      label={`Remover ${t.title} da fila`}
                      onClick={() => useApp.getState().removeQueue(i)}
                    >
                      <X size={15} />
                    </IconButton>
                  )}
                </div>
              ))
            ) : (
              <p className="empty-small">Fila vazia</p>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
