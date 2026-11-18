import { GlassContextMenu } from '../glass/materials';
import { trackActions } from './trackActions';
import { moveWithinPlaylist } from '../../lib/playlist';
import { warmTrack, cancelWarmTrack } from '../../lib/playback';
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
  Sparkles,
} from 'lucide-react';
import { canPlay, type Track } from '../../../shared/types';
import { useApp, formatTime } from '../../stores/app';
import { transport } from '../player/engine';
import Cover from '../glass/Cover';
import { IconButton, SourceBadge } from '../glass/controls';

export default function TrackList({
  tracks,
  playlistId,
  compact = false,
  empty = 'Adicione um link ou música para começar.',
}: {
  tracks: Track[];
  playlistId?: string;
  compact?: boolean;
  empty?: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<string | null>(null);
  const likes = useApp(s => s.data.likes),
    current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing);
  const rowHeight = tracks.some(t => t.lyricSnippet) ? 78 : 64;
  const virtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parent.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  if (!tracks.length)
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <Music2 size={28} />
        </span>
        <h3>Sem músicas</h3>
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
    <div className={`track-table ${compact ? 'track-table-compact' : ''}`}>
      <div className="track-table-heading">
        <span>#</span>
        <span>FAIXA / ARTISTA</span>
        {!compact && <span>ORIGEM</span>}
        <span>DURAÇÃO</span>
        <span />
      </div>
      <div
        ref={parent}
        className="track-scroll"
        style={{ height: Math.min(tracks.length * rowHeight + 6, 540) }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map(row => {
            const track = tracks[row.index],
              active = current?.id === track.id;
            const playable = canPlay(track);
            return (
              <div
                data-track-item
                tabIndex={0}
                onPointerEnter={() => warmTrack(track)}
                onPointerLeave={cancelWarmTrack}
                className={`track-row ${compact ? 'compact-row' : ''} ${active ? 'current' : ''} ${track.available === false ? 'unavailable' : ''}`}
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
                          if (e.clientY < box.top + 40) parent.current.scrollTop -= 12;
                          if (e.clientY > box.bottom - 40) parent.current.scrollTop += 12;
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
                    <GripVertical size={15} />
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
                        <Pause size={16} fill="currentColor" />
                      ) : playable ? (
                        <Play size={16} fill="currentColor" />
                      ) : (
                        <ExternalLink size={15} />
                      )}
                    </span>
                  </div>
                  <span className="track-text">
                    <strong>
                      {track.title}
                      {track.recommended && (
                        <em className="recommended-chip" title="Recomendada pelo seu estilo">
                          <Sparkles size={11} /> Mix
                        </em>
                      )}
                    </strong>
                    <small>{track.artist}</small>
                    {track.lyricSnippet && (
                      <q className="lyric-match-snippet">“{track.lyricSnippet}”</q>
                    )}
                  </span>
                </button>
                {!compact && <SourceBadge source={track.source} url={track.url} />}
                <time>{track.duration ? formatTime(track.duration) : '—'}</time>
                <div className="row-actions">
                  <IconButton
                    label={`Curtir ${track.title}`}
                    active={likes.includes(track.id)}
                    onClick={() =>
                      void useApp
                        .getState()
                        .mutate({ action: 'like', track })
                        .catch(() => {})
                    }
                  >
                    <Heart
                      size={16}
                      fill={likes.includes(track.id) ? 'currentColor' : 'none'}
                    />
                  </IconButton>
                  <IconButton
                    label={`Adicionar ${track.title} à playlist`}
                    onClick={() => useApp.getState().setDialog({ type: 'add', track })}
                  >
                    <Plus size={17} />
                  </IconButton>
                  <GlassContextMenu
                    label={`Opções de ${track.title}`}
                    items={trackActions(track, tracks, playlistId)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
