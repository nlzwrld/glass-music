import { Pause, Play, Shuffle } from 'lucide-react';
import type { Track } from '../../../shared/types';
import { shufflePlay } from '../../lib/playback';
import { useApp } from '../../stores/app';
import { transport } from '../player/engine';

/**
 * Shared Play + Shuffle control pair for playlists and collections with identical geometry,
 * surface, border and interaction feedback, differentiated only by icon and active state.
 */
export function CollectionPlaybackActions({
  tracks,
  activeHere,
  playing,
  isPlaylist = false,
}: {
  tracks: Track[];
  activeHere: boolean;
  playing: boolean;
  isPlaylist?: boolean;
}) {
  const shuffle = useApp(s => s.data.preferences.shuffle);
  const shuffleMode = useApp(s => s.data.preferences.shuffleMode ?? 'smart');
  const playLabel = isPlaylist
    ? activeHere && playing
      ? 'Pausar playlist'
      : 'Reproduzir playlist'
    : activeHere && playing
      ? 'Pausar coleção'
      : 'Reproduzir coleção';
  const shuffleLabel = isPlaylist
    ? 'Reproduzir playlist no aleatório'
    : 'Reproduzir coleção no aleatório';
  const shuffleTitle = shuffle
    ? `${shuffleLabel} (${shuffleMode === 'smart' ? 'Inteligente' : 'Tradicional'})`
    : `${shuffleLabel} (${shuffleMode === 'smart' ? 'Inteligente' : 'Tradicional'})`;

  return (
    <div
      className="collection-playback-actions"
      role="group"
      aria-label="Controles de reprodução da lista"
    >
      <button
        type="button"
        className="collection-action-btn playlist-play"
        disabled={!tracks.length}
        aria-label={playLabel}
        title={playLabel}
        onClick={() => {
          if (activeHere) transport.toggle();
          else if (tracks[0]) useApp.getState().play(tracks[0], tracks);
        }}
      >
        {activeHere && playing ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" className="play-icon-optical" />
        )}
      </button>
      <button
        type="button"
        className={`collection-action-btn playlist-shuffle-play ${shuffle ? 'is-active' : ''}`}
        disabled={!tracks.length}
        aria-label={shuffleLabel}
        title={shuffleTitle}
        aria-pressed={shuffle}
        data-active={shuffle ? 'true' : 'false'}
        data-shuffle-mode={shuffle ? shuffleMode : 'off'}
        onClick={() => shufflePlay(tracks)}
      >
        <Shuffle size={15} />
        {shuffle && <span className="action-active-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
