import { useRef } from 'react';
import { Heart, ChevronDown, GripVertical, X } from 'lucide-react';
import { useApp, formatTime } from '../../stores/app';
import Cover from '../glass/Cover';
import SVGPlane from '../glass/v3/SVGPlane';
import { IconButton, SourceBadge } from '../glass/controls';
import { PlaybackControls, Seekbar } from './GlassPlayer';
export { default, SidePlayer } from './GlassPlayer';

export function ExpandedPlayer() {
  const expanded = useApp(s => s.expanded),
    track = useApp(s => s.queue[s.index]),
    likes = useApp(s => s.data.likes),
    isGlass = useApp(s => (s.data.preferences.uiStyle ?? 'matte') === 'glass');

  if (!expanded || !track) return null;

  return (
    <section
      className={`expanded-player ${track.source !== 'local' ? 'with-external' : ''}`}
      aria-label="Tocando agora"
    >
      {isGlass && <SVGPlane variant="deep" />}
      <div className="expanded-header">
        <IconButton
          label="Fechar player expandido"
          onClick={() => useApp.setState({ expanded: false })}
        >
          <ChevronDown size={18} />
        </IconButton>
        <SourceBadge source={track.source} url={track.url} />
      </div>
      <div className="expanded-content">
        <div className="expanded-art">
          <Cover track={track} />
        </div>
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
            <Heart size={16} fill={likes.includes(track.id) ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
        <Seekbar />
        <PlaybackControls large localSurface />
      </div>
    </section>
  );
}

export function Queue() {
  const open = useApp(s => s.queueOpen),
    queue = useApp(s => s.queue),
    index = useApp(s => s.index),
    isGlass = useApp(s => (s.data.preferences.uiStyle ?? 'matte') === 'glass');
  const dragFrom = useRef<number | null>(null);

  if (!open) return null;

  const current = index >= 0 ? queue[index] : undefined;
  const upcoming = queue
    .map((t, idx) => ({ t, idx }))
    .filter(({ idx }) => idx !== index);

  return (
    <aside className="queue-panel glass" aria-label="Fila">
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
                {upcoming.map(({ t, idx }) => (
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
    </aside>
  );
}
