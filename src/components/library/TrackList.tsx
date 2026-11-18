import { GlassContextMenu } from '../glass/materials';
import { trackActions } from './trackActions';
import { moveWithinPlaylist } from '../../lib/playlist';
import { warmTrack, cancelWarmTrack, shufflePlay } from '../../lib/playback';
import { useRef } from 'react';
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
}: {
  tracks: Track[];
  playlistId?: string;
  empty?: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<string | null>(null);
  const likes = useApp(s => s.data.likes),
    downloadingIds = useApp(s => s.downloadingIds),
    current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing);

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
    <div className="track-table">
      <div className="track-table-heading">
        <span className="col-index">#</span>
        <span>Título</span>
        <span>Álbum / Origem</span>
        <span className="col-quick-shuffle">
          {playableCount > 1 && (
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
            return (
              <div
                data-track-item
                tabIndex={0}
                onPointerEnter={() => warmTrack(track)}
                onPointerLeave={cancelWarmTrack}
                className={`track-row ${active ? 'current' : ''} ${track.available === false ? 'unavailable' : ''}`}
                key={track.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                  height: row.size,
                }}
                onDragLeave={e => e.currentTarget.classList.remove('drop-target')}
                onDragOver={
                  playlistId
                    ? e => {
                        e.preventDefault();
                        if (!dragIndex.current) return;
                        e.currentTarget.classList.add('drop-target');
                        const box = parent.current?.getBoundingClientRect();
                        if (box && parent.current) {
                          if (e.clientY < box.top + 36) parent.current.scrollTop -= 12;
                          if (e.clientY > box.bottom - 36) parent.current.scrollTop += 12;
                        }
                      }
                    : undefined
                }
                onDrop={
                  playlistId
                    ? e => {
                        e.preventDefault();
                        e.currentTarget.classList.remove('drop-target');
                        const from = dragIndex.current;
                        dragIndex.current = null;
                        if (from) void moveWithinPlaylist(playlistId, from, track.id).catch(() => {});
                      }
                    : undefined
                }
              >
                {playlistId ? (
                  <span
                    className="drag-handle"
                    draggable
                    onDragStart={e => {
                      dragIndex.current = track.id;
                      e.dataTransfer.setData('text/plain', track.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      dragIndex.current = null;
                      parent.current
                        ?.querySelectorAll('.drop-target')
                        .forEach(el => el.classList.remove('drop-target'));
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Mover ${track.title}`}
                    onKeyDown={e => {
                      if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                        e.preventDefault();
                        const p = useApp
                            .getState()
                            .data.playlists.find(p => p.id === playlistId),
                          i = p?.trackIds.indexOf(track.id) ?? -1,
                          target = p?.trackIds[i + (e.key === 'ArrowUp' ? -1 : 1)];
                        if (target)
                          void moveWithinPlaylist(playlistId, track.id, target).catch(() => {});
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
                    items={trackActions(track, tracks, playlistId)}
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
