import { useMemo, useState } from 'react';
import { FolderInput, Link2, Compass, Pause, Play, Plus } from 'lucide-react';
import { canPlay, type Playlist, type Track } from '../../shared/types';
import { useApp } from '../stores/app';
import { useAccounts } from '../stores/accounts';
import { transport } from '../components/player/engine';
import TrackCard from '../components/library/TrackCard';
import PlaylistCover from '../components/library/PlaylistCover';
import OnlineCatalog from '../components/library/OnlineCatalog';
import Cover from '../components/glass/Cover';
import { greeting } from '../components/glass/Welcome';
import { warmTrack, cancelWarmTrack } from '../lib/playback';

type HomeFilter = 'all' | 'music' | 'playlists';

type QuickItem =
  | { kind: 'playlist'; playlist: Playlist; tracks: Track[] }
  | { kind: 'track'; track: Track };

function EqBars() {
  return (
    <span className="eq-bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export default function Home() {
  const data = useApp(s => s.data);
  const current = useApp(s => s.queue[s.index]);
  const queueContext = useApp(s => s.queueContext);
  const playing = useApp(s => s.playing);
  const hub = useAccounts(s => s.hub);
  const [filter, setFilter] = useState<HomeFilter>('all');

  const trackMap = useMemo(() => {
    const map = new Map<string, Track>();
    for (const t of data.tracks) map.set(t.id, t);
    return map;
  }, [data.tracks]);

  const recentTracks = useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const h of data.history) {
      if (seen.has(h.id)) continue;
      const found = trackMap.get(h.id);
      if (found) {
        seen.add(h.id);
        out.push(found);
      }
      if (out.length >= 6) break;
    }
    return out;
  }, [data.history, trackMap]);

  const playlistEntries = useMemo(
    () =>
      data.playlists.map(playlist => ({
        playlist,
        tracks: playlist.trackIds
          .map(id => trackMap.get(id))
          .filter((t): t is Track => !!t),
      })),
    [data.playlists, trackMap],
  );

  const quickItems = useMemo<QuickItem[]>(() => {
    if (filter === 'playlists') {
      return playlistEntries.slice(0, 6).map(p => ({ kind: 'playlist', ...p }));
    }
    if (filter === 'music') {
      const source = recentTracks.length ? recentTracks : data.tracks.slice(0, 6);
      return source.slice(0, 6).map(track => ({ kind: 'track', track }));
    }
    const items: QuickItem[] = [];
    for (const p of playlistEntries.slice(0, 2)) {
      items.push({ kind: 'playlist', ...p });
    }
    const trackPool = recentTracks.length ? recentTracks : data.tracks;
    for (const track of trackPool) {
      if (items.length >= 6) break;
      items.push({ kind: 'track', track });
    }
    return items;
  }, [filter, playlistEntries, recentTracks, data.tracks]);

  const hour = new Date().getHours();
  const baseGreeting = greeting(hour);
  const firstName = hub.authenticated
    ? (hub.displayName || hub.username || '').trim().split(/\s+/)[0]
    : '';
  const heading = firstName ? `${baseGreeting}, ${firstName}` : baseGreeting;

  const hasContent = data.tracks.length > 0 || data.playlists.length > 0;

  const playPlaylist = (playlist: Playlist, tracks: Track[]) => {
    const ctxId = `playlist:${playlist.id}`;
    const isActive = !!current && queueContext === ctxId && tracks.some(t => t.id === current.id);
    if (isActive) {
      transport.toggle();
      return;
    }
    const first = tracks.find(t => canPlay(t) && t.available !== false) ?? tracks[0];
    if (first) {
      useApp.getState().play(first, tracks, { contextId: ctxId, playlistShuffled: false });
    } else {
      useApp.getState().setPage(`playlist:${playlist.id}`);
    }
  };

  return (
    <div className="home-page">
      <header className="home-hero-header">
        <div className="home-hero-top">
          <h1>{heading}</h1>
          <div className="home-filter-pills" role="tablist" aria-label="Filtrar início">
            {(
              [
                ['all', 'Tudo'],
                ['music', 'Músicas'],
                ['playlists', 'Playlists'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={`home-pill ${filter === id ? 'selected' : ''}`}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {quickItems.length > 0 && (
        <section className="home-quick-section" aria-label="Acesso rápido">
          <div className="quick-grid">
            {quickItems.map(item => {
              if (item.kind === 'playlist') {
                const { playlist, tracks } = item;
                const ctxId = `playlist:${playlist.id}`;
                const activeHere =
                  !!current && queueContext === ctxId && tracks.some(t => t.id === current.id);
                const isPlayingHere = activeHere && playing;
                return (
                  <div
                    key={`pl:${playlist.id}`}
                    className={`quick-tile ${activeHere ? 'is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="quick-tile-main"
                      onClick={() => useApp.getState().setPage(`playlist:${playlist.id}`)}
                    >
                      <span className="quick-tile-art">
                        <PlaylistCover playlist={playlist} />
                      </span>
                      <span className="quick-tile-text">
                        <strong>{playlist.name}</strong>
                        <small>{tracks.length} faixas</small>
                      </span>
                    </button>
                    {isPlayingHere && <EqBars />}
                    <button
                      type="button"
                      className={`quick-tile-play ${isPlayingHere ? 'visible' : ''}`}
                      aria-label={
                        isPlayingHere
                          ? `Pausar ${playlist.name}`
                          : `Reproduzir ${playlist.name}`
                      }
                      onClick={() => playPlaylist(playlist, tracks)}
                    >
                      {isPlayingHere ? (
                        <Pause size={13} fill="currentColor" />
                      ) : (
                        <Play size={13} fill="currentColor" className="play-icon-optical" />
                      )}
                    </button>
                  </div>
                );
              }

              const { track } = item;
              const activeHere = current?.id === track.id;
              const isPlayingHere = activeHere && playing;
              return (
                <div
                  key={`tr:${track.id}`}
                  className={`quick-tile ${activeHere ? 'is-active' : ''}`}
                  onPointerEnter={() => warmTrack(track)}
                  onPointerLeave={cancelWarmTrack}
                >
                  <button
                    type="button"
                    className="quick-tile-main"
                    onClick={() =>
                      activeHere && queueContext === 'home:recent'
                        ? transport.toggle()
                        : useApp.getState().play(track, recentTracks.length ? recentTracks : data.tracks, {
                            contextId: 'home:recent',
                          })
                    }
                  >
                    <span className="quick-tile-art">
                      <Cover track={track} />
                    </span>
                    <span className="quick-tile-text">
                      <strong>{track.title}</strong>
                      <small>{track.artist}</small>
                    </span>
                  </button>
                  {isPlayingHere && <EqBars />}
                  <button
                    type="button"
                    className={`quick-tile-play ${isPlayingHere ? 'visible' : ''}`}
                    aria-label={
                      isPlayingHere ? `Pausar ${track.title}` : `Reproduzir ${track.title}`
                    }
                    onClick={() =>
                      activeHere && queueContext === 'home:recent'
                        ? transport.toggle()
                        : useApp.getState().play(track, recentTracks.length ? recentTracks : data.tracks, {
                            contextId: 'home:recent',
                          })
                    }
                  >
                    {isPlayingHere ? (
                      <Pause size={13} fill="currentColor" />
                    ) : (
                      <Play size={13} fill="currentColor" className="play-icon-optical" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(filter === 'all' || filter === 'playlists') && playlistEntries.length > 0 && (
        <section className="home-section" aria-labelledby="home-playlists-title">
          <div className="section-heading">
            <h2 id="home-playlists-title">Suas playlists</h2>
            <div className="section-heading-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => useApp.getState().setDialog({ type: 'playlist' })}
              >
                <Plus size={13} />
                Nova
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => useApp.getState().setPage('library')}
              >
                Ver tudo
              </button>
            </div>
          </div>
          <div className="catalog-grid home-playlist-shelf">
            {playlistEntries.slice(0, 6).map(({ playlist, tracks }) => {
              const ctxId = `playlist:${playlist.id}`;
              const activeHere =
                !!current && queueContext === ctxId && tracks.some(t => t.id === current.id);
              const isPlayingHere = activeHere && playing;
              return (
                <article
                  key={playlist.id}
                  className={`track-card home-playlist-card ${activeHere ? 'is-playing' : ''}`}
                >
                  <div className="card-art">
                    <button
                      type="button"
                      className="card-cover"
                      onClick={() => useApp.getState().setPage(`playlist:${playlist.id}`)}
                      aria-label={`Abrir ${playlist.name}`}
                    >
                      <PlaylistCover playlist={playlist} />
                    </button>
                    <button
                      type="button"
                      className={`card-play-fab ${isPlayingHere ? 'visible' : ''}`}
                      aria-label={
                        isPlayingHere
                          ? `Pausar ${playlist.name}`
                          : `Reproduzir ${playlist.name}`
                      }
                      onClick={e => {
                        e.stopPropagation();
                        playPlaylist(playlist, tracks);
                      }}
                    >
                      {isPlayingHere ? (
                        <Pause size={16} fill="currentColor" />
                      ) : (
                        <Play size={16} fill="currentColor" className="play-icon-optical" />
                      )}
                    </button>
                  </div>
                  <div className="card-caption">
                    <div>
                      <h3>{playlist.name}</h3>
                      <p>{tracks.length} faixas</p>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {filter !== 'playlists' && <OnlineCatalog />}

      {(filter === 'all' || filter === 'music') && data.tracks.length > 0 && (
        <section className="home-section" aria-labelledby="home-library-title">
          <div className="section-heading">
            <h2 id="home-library-title">Biblioteca</h2>
            <button
              type="button"
              className="text-button"
              onClick={() => useApp.getState().setPage('library')}
            >
              Ver tudo
            </button>
          </div>
          <div className="catalog-grid">
            {data.tracks.slice(0, 6).map(track => (
              <TrackCard
                key={track.id}
                track={track}
                list={data.tracks}
                contextId="home:library"
              />
            ))}
          </div>
        </section>
      )}

      {!hasContent && filter === 'playlists' && (
        <div className="home-empty-actions">
          <button
            type="button"
            className="button primary"
            onClick={() => useApp.getState().setDialog({ type: 'playlist' })}
          >
            <Plus size={15} />
            Nova playlist
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => useApp.getState().setDialog({ type: 'link' })}
          >
            <Link2 size={14} />
            Importar link
          </button>
        </div>
      )}

      {!hasContent && filter !== 'playlists' && (
        <div className="home-empty-actions">
          <button
            type="button"
            className="button primary"
            onClick={() => useApp.getState().setDialog({ type: 'link' })}
          >
            <Link2 size={14} />
            Importar link
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => void useApp.getState().importLocalFiles()}
          >
            <FolderInput size={14} />
            Arquivos locais
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => useApp.getState().setPage('explore')}
          >
            <Compass size={14} />
            Explorar
          </button>
        </div>
      )}
    </div>
  );
}
