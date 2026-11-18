import { trackActions } from './trackActions';
import { warmTrack, cancelWarmTrack } from '../../lib/playback';
import { Play, Plus, ArrowUpRight } from 'lucide-react';
import { canPlay, type Track } from '../../../shared/types';
import { useApp } from '../../stores/app';
import Cover from '../glass/Cover';
import { GlassCard, GlassContextMenu } from '../glass/materials';
import { SourceBadge } from '../glass/controls';

export default function TrackCard({ track, list }: { track: Track; list?: Track[] }) {
  return (
    <GlassCard data-track-item className="track-card" tabIndex={0}>
      <div className="card-art">
        <button
          onPointerEnter={() => warmTrack(track)}
          onPointerLeave={cancelWarmTrack}
          className="card-cover"
          onClick={() => useApp.getState().play(track, list)}
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
        <SourceBadge source={track.source} url={track.url} compact />
      </div>
    </GlassCard>
  );
}
