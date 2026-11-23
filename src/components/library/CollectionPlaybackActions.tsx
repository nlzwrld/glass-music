import { Pause, Play, Shuffle } from 'lucide-react';
import { canPlay, type Track } from '../../../shared/types';
import { shufflePlay } from '../../lib/playback';
import { useApp } from '../../stores/app';
import { SmartShuffleIcon } from '../glass/controls';
import { transport } from '../player/engine';

/**
 * Shared Play + Shuffle control pair for playlists and collections with identical geometry,
 * surface, border and interaction feedback.
 * - Play always starts THIS playlist/collection when another playlist or track context is playing.
 * - Playlist Shuffle Play is strictly isolated from the player's global shuffle toggle.
 */
export function CollectionPlaybackActions({
  tracks,
  activeHere,
  playing,
  isPlaylist = false,
  contextId,
}: {
  tracks: Track[];
  activeHere: boolean;
  playing: boolean;
  isPlaylist?: boolean;
  contextId?: string | null;
}) {
  const queueShuffled = useApp(s => s.queueShuffled);
  const queueShuffleMode = useApp(s => s.queueShuffleMode);
  const preferredMode = useApp(s => s.data.preferences.shuffleMode ?? 'smart');

  const playlistShuffleActive = activeHere && queueShuffled;
  const activeMode = playlistShuffleActive ? (queueShuffleMode ?? preferredMode) : preferredMode;

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
  const shuffleTitle = `${shuffleLabel} (${activeMode === 'smart' ? 'Inteligente' : 'Tradicional'})`;

  const firstPlayable = tracks.find(t => canPlay(t) && t.available !== false) ?? tracks[0];

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
          else if (firstPlayable) {
            useApp.getState().play(firstPlayable, tracks, {
              contextId: contextId ?? null,
              playlistShuffled: false,
            });
          }
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
        className={`collection-action-btn playlist-shuffle-play ${playlistShuffleActive ? 'is-active' : ''} ${playlistShuffleActive && activeMode === 'smart' ? 'is-smart' : ''}`}
        disabled={!tracks.length}
        aria-label={shuffleLabel}
        title={shuffleTitle}
        aria-pressed={playlistShuffleActive}
        data-active={playlistShuffleActive ? 'true' : 'false'}
        data-shuffle-mode={playlistShuffleActive ? activeMode : 'off'}
        onClick={() => shufflePlay(tracks, undefined, { contextId: contextId ?? null })}
      >
        {playlistShuffleActive && activeMode === 'smart' ? (
          <SmartShuffleIcon size={16} />
        ) : (
          <Shuffle size={15} />
        )}
        {playlistShuffleActive && (
          <span
            className={`action-active-dot ${activeMode === 'smart' ? 'is-smart' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>
    </div>
  );
}
