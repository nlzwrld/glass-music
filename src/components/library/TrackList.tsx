import { GlassContextMenu } from '../glass/materials';
import { trackActions } from './trackActions';
import { moveWithinPlaylist } from '../../lib/playlist';
import { warmTrack, cancelWarmTrack, shufflePlay } from '../../lib/playback';
import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Play,
  Pause,
  Heart,
  Plus,
  ExternalLink,
  GripVertical,
  Music2,
  Clock3,
  Shuffle,
  ChevronUp,
  ChevronDown,
  Trash2,
} from 'lucide-react';
import { canPlay, type Track } from '../../../shared/types';
import { useApp, formatTime } from '../../stores/app';
import { transport } from '../player/engine';
import Cover from '../glass/Cover';
import { IconButton, OfflineIndicator, SourceBadge } from '../glass/controls';

export default function TrackList({
  tracks,
  playlistId,
  empty = 'Nenhuma música.',
  showHeaderShuffle = true,
  canReorder,
  onReorder,
  onRemoveTrack,
}: {
  tracks: Track[];
  playlistId?: string;
  empty?: string;
  showHeaderShuffle?: boolean;
  canReorder?: boolean;
  onReorder?: (fromId: string, toId: string) => Promise<void> | void;
  onRemoveTrack?: (track: Track) => Promise<void> | void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const pointerDragActive = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const likes = useApp(s => s.data.likes),
    downloadingIds = useApp(s => s.downloadingIds),
    current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing);

  const reorderEnabled = Boolean(canReorder ?? playlistId);
  const reorderHandler =
    onReorder ??
    (playlistId
      ? (fromId: string, toId: string) => moveWithinPlaylist(playlistId, fromId, toId)
      : undefined);

  const commitReorder = (fromId: string, toId: string) => {
    if (!reorderEnabled || !reorderHandler || !fromId || !toId || fromId === toId) return;
    void Promise.resolve(reorderHandler(fromId, toId)).catch(() => {});
  };

  const updateDropTarget = (targetId: string | null) => {
    dropTargetRef.current = targetId;
    setDropTargetId(curr => (curr === targetId ? curr : targetId));
  };

  const clearDragState = () => {
    dragIndex.current = null;
    pointerDragActive.current = false;
    dropTargetRef.current = null;
    setDraggingId(null);
    setDropTargetId(null);
    parent.current
      ?.querySelectorAll('.drop-target')
      .forEach(el => el.classList.remove('drop-target'));
  };

  const hasSnippets = tracks.some(t => !!t.lyricSnippet);
  const rowHeight = hasSnippets ? 56 : 48;
  const playableCount = tracks.filter(t => canPlay(t) && t.available !== false).length;

  const virtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parent.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  if (!tracks.length)
    return (
      <div className="empty-state">
        <Music2 size={20} />
        <h3>Lista vazia</h3>
        <p>{empty}</p>
        <button
          className="button secondary"
          onClick={() => void useApp.getState().importAudio()}
        >
          Adicionar link
        </button>
      </div>
    );

  return (
    <div className={`track-table ${reorderEnabled ? 'is-reorderable' : ''}`}>
      <div className="track-table-heading">
        <span className="col-index">#</span>
        <span>Título</span>
        <span>Álbum / Origem</span>
        <span className="col-quick-shuffle">
          {showHeaderShuffle && playableCount > 1 && (
            <button
              type="button"
              className="tracklist-shuffle-btn"
              aria-label="Embaralhar e reproduzir lista"
              title="Shuffle Play"
              onClick={() => shufflePlay(tracks)}
            >
              <Shuffle size={12} />
              <span>Aleatório</span>
            </button>
          )}
        </span>
        <span className="col-duration" title="Duração">
          <Clock3 size={13} />
        </span>
      </div>
      <div
        ref={parent}
        className="track-scroll"
        style={{ height: Math.min(tracks.length * rowHeight + 4, 680) }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map(row => {
            const track = tracks[row.index]!,
              active = current?.id === track.id;
            const playable = canPlay(track);
            const liked = likes.includes(track.id);
            const isDownloading = downloadingIds.includes(track.id);
            const prevTrack = row.index > 0 ? tracks[row.index - 1] : undefined;
            const nextTrack = row.index < tracks.length - 1 ? tracks[row.index + 1] : undefined;
            const contextItems = trackActions(track, tracks, playlistId);
            if (onRemoveTrack && !playlistId) {
              contextItems.push({
                label: 'Remover da playlist',
                icon: <Trash2 size={17} />,
                danger: true,
                action: () => void onRemoveTrack(track),
              });
            }
            return (
              <div
                data-track-item
                data-track-id={track.id}
                tabIndex={0}
                onPointerEnter={() => warmTrack(track)}
                onPointerLeave={cancelWarmTrack}
                className={`track-row ${active ? 'current' : ''} ${track.available === false ? 'unavailable' : ''} ${draggingId === track.id ? 'dragging' : ''} ${dropTargetId === track.id ? 'drop-target' : ''}`}
                key={track.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                  height: row.size,
                }}
                onDragLeave={() => {
                  if (dropTargetRef.current === track.id) updateDropTarget(null);
                }}
                onDragOver={
                  reorderEnabled
                    ? e => {
                        e.preventDefault();
                        if (!dragIndex.current || dragIndex.current === track.id) return;
                        updateDropTarget(track.id);
                        const box = parent.current?.getBoundingClientRect();
                        if (box && parent.current) {
                          if (e.clientY < box.top + 36) parent.current.scrollTop -= 12;
                          if (e.clientY > box.bottom - 36) parent.current.scrollTop += 12;
                        }
                      }
                    : undefined
                }
                onDrop={
                  reorderEnabled
                    ? e => {
                        e.preventDefault();
                        const from = dragIndex.current;
                        clearDragState();
                        if (from) commitReorder(from, track.id);
                      }
                    : undefined
                }
              >
                {reorderEnabled ? (
                  <span
                    className="drag-handle"
                    draggable
                    onDragStart={e => {
                      dragIndex.current = track.id;
                      setDraggingId(track.id);
                      e.dataTransfer.setData('text/plain', track.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      clearDragState();
                    }}
                    onPointerDown={e => {
                      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
                      pointerDragActive.current = true;
                      dragIndex.current = track.id;
                      setDraggingId(track.id);
                      updateDropTarget(null);
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {}
                    }}
                    onPointerMove={e => {
                      if (!pointerDragActive.current || dragIndex.current !== track.id) return;
                      const box = parent.current?.getBoundingClientRect();
                      if (box && parent.current) {
                        if (e.clientY < box.top + 40) parent.current.scrollTop -= 12;
                        if (e.clientY > box.bottom - 40) parent.current.scrollTop += 12;
                      }
                      const hovered = document
                        .elementFromPoint(e.clientX, e.clientY)
                        ?.closest<HTMLElement>('[data-track-id]');
                      const targetId = hovered?.dataset.trackId;
                      if (targetId && targetId !== track.id) {
                        updateDropTarget(targetId);
                      } else if (targetId === track.id) {
                        updateDropTarget(null);
                      }
                    }}
                    onPointerUp={e => {
                      if (!pointerDragActive.current || dragIndex.current !== track.id) return;
                      const from = dragIndex.current;
                      const to = dropTargetRef.current;
                      try {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                      } catch {}
                      clearDragState();
                      if (from && to) commitReorder(from, to);
                    }}
                    onPointerCancel={e => {
                      if (!pointerDragActive.current) return;
                      try {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                      } catch {}
                      clearDragState();
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Mover ${track.title}`}
                    onKeyDown={e => {
                      if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                        e.preventDefault();
                        const target = e.key === 'ArrowUp' ? prevTrack : nextTrack;
                        if (target) commitReorder(track.id, target.id);
                      }
                    }}
                    title="Arraste ou use Alt + ↑ / ↓"
                  >
                    <GripVertical size={14} />
                  </span>
                ) : (
                  <span className="row-number">{row.index + 1}</span>
                )}

                <button
                  className="track-identity"
                  onClick={() =>
                    active && playable
                      ? transport.toggle()
                      : useApp.getState().play(track, tracks)
                  }
                  aria-label={`${playable ? 'Reproduzir' : 'Abrir'} ${track.title}`}
                >
                  <div className="row-cover">
                    <Cover track={track} />
                    <span>
                      {active && playing ? (
                        <Pause size={14} fill="currentColor" />
                      ) : playable ? (
                        <Play size={14} fill="currentColor" />
                      ) : (
                        <ExternalLink size={13} />
                      )}
                    </span>
                  </div>
                  <span className="track-text">
                    <strong>{track.title}</strong>
                    <small className="track-subline">
                      <OfflineIndicator offline={track.offline} downloading={isDownloading} />
                      <span>
                        {track.lyricSnippet
                          ? `${track.artist} · “${track.lyricSnippet}”`
                          : track.artist}
                      </span>
                    </small>
                  </span>
                </button>

                <span className="track-meta-col">
                  {track.album && <span className="track-album-text">{track.album}</span>}
                  <SourceBadge
                    source={track.source}
                    url={track.url}
                    catalogSource={track.catalogSource}
                    streamProvider={track.streamProvider}
                    compact={!!track.album}
                  />
                </span>

                <div className="row-actions">
                  {reorderEnabled && (
                    <span className="reorder-step-controls">
                      <IconButton
                        label={`Mover ${track.title} para cima`}
                        disabled={row.index <= 0}
                        onClick={() => prevTrack && commitReorder(track.id, prevTrack.id)}
                      >
                        <ChevronUp size={14} />
                      </IconButton>
                      <IconButton
                        label={`Mover ${track.title} para baixo`}
                        disabled={row.index >= tracks.length - 1}
                        onClick={() => nextTrack && commitReorder(track.id, nextTrack.id)}
                      >
                        <ChevronDown size={14} />
                      </IconButton>
                    </span>
                  )}
                  <IconButton
                    label={`Curtir ${track.title}`}
                    active={liked}
                    onClick={() =>
                      void useApp
                        .getState()
                        .mutate({ action: 'like', track })
                        .catch(() => {})
                    }
                  >
                    <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
                  </IconButton>
                  <IconButton
                    label={`Adicionar ${track.title} à playlist`}
                    onClick={() => useApp.getState().setDialog({ type: 'add', track })}
                  >
                    <Plus size={15} />
                  </IconButton>
                  <GlassContextMenu
                    label={`Opções de ${track.title}`}
                    items={contextItems}
                  />
                </div>

                <time>{track.duration ? formatTime(track.duration) : '—'}</time>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
