import { trackActions } from './trackActions';
import { warmTrack, cancelWarmTrack } from '../../lib/playback';
import { Play, Plus, ArrowUpRight, BadgeCheck } from 'lucide-react';
import { canPlay, type Track } from '../../../shared/types';
import { useApp } from '../../stores/app';
import Cover from '../glass/Cover';
import { GlassCard, GlassContextMenu } from '../glass/materials';
import { OfflineIndicator, SourceBadge } from '../glass/controls';

export default function TrackCard({
  track,
  list,
  contextId,
}: {
  track: Track;
  list?: Track[];
  contextId?: string | null;
}) {
  const downloading = useApp(s => s.downloadingIds.includes(track.id));
  const savedOffline = useApp(
    s => Boolean(track.offline || s.data.tracks.find(t => t.id === track.id)?.offline),
  );

  return (
    <GlassCard data-track-item className="track-card" tabIndex={0}>
      <div className="card-art">
        <button
          onPointerEnter={() => warmTrack(track)}
          onPointerLeave={cancelWarmTrack}
          className="card-cover"
          onClick={() =>
            useApp.getState().play(track, list, contextId ? { contextId } : undefined)
          }
          aria-label={`${!canPlay(track) ? 'Abrir' : 'Reproduzir'} ${track.title}`}
        >
          <Cover track={track} />
          <span className="card-play">
            {!canPlay(track) ? (
              <ArrowUpRight size={15} />
            ) : (
              <Play fill="currentColor" size={15} />
            )}
          </span>
        </button>
        <button
          className="card-add"
          aria-label={`Salvar ${track.title} em playlist`}
          title="Adicionar à playlist"
          onClick={() => useApp.getState().setDialog({ type: 'add', track })}
        >
          <Plus size={14} />
        </button>
        <div className="card-menu">
          <GlassContextMenu
            label={`Opções de ${track.title}`}
            items={trackActions(track, list || [track])}
          />
        </div>
      </div>
      <div className="card-caption">
        <div>
          <h3>{track.title}</h3>
          <p>{track.artist}</p>
        </div>
        <span className="card-badges">
          {track.kind === 'artist' && (
            <span className="entity-badge entity-badge-artist" title="Artista verificado no catálogo">
              <BadgeCheck size={11} />
              Artista verificado
            </span>
          )}
          <OfflineIndicator offline={savedOffline} downloading={downloading} />
          <SourceBadge
            source={track.source}
            url={track.url}
            catalogSource={track.catalogSource}
            streamProvider={track.streamProvider}
            compact
          />
        </span>
      </div>
    </GlassCard>
  );
}
