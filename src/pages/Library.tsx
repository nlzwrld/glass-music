import { preparePlayback } from '../lib/playback';
import { useState, useEffect, useMemo } from 'react';
import { GlassContextMenu } from '../components/glass/materials';
import { transport } from '../components/player/engine';
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Play,
  Pause,
  Download,
  FolderInput,
  Share2,
} from 'lucide-react';
import { useApp } from '../stores/app';
import PlaylistCover from '../components/library/PlaylistCover';
import TrackList from '../components/library/TrackList';
import Cover from '../components/glass/Cover';
import { IconButton } from '../components/glass/controls';

type LibTab = 'all' | 'playlists' | 'albums' | 'artists' | 'downloads';

function formatTotalDuration(seconds: number) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

export default function Library() {
  const data = useApp(s => s.data),
    page = useApp(s => s.page),
    [query, setQuery] = useState(''),
    [tab, setTab] = useState<LibTab>('all');

  const playlist = page.startsWith('playlist:')
    ? data.playlists.find(p => p.id === page.slice(9))
    : undefined;

  useEffect(() => {
    const first = playlist?.trackIds
      .map(id => data.tracks.find(t => t.id === id))
      .find(t => t && ['youtube', 'link'].includes(t.source) && t.available !== false);
    if (!first || !data.preferences.onlineConsent) return;
    let release: (() => void) | undefined;
    const timer = setTimeout(() => {
      release = preparePlayback(first, false).release;
    }, 250);
    return () => {
      clearTimeout(timer);
      release?.();
    };
  }, [playlist?.id, data.preferences.onlineConsent]);

  const current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing);

  const q = query.trim().toLocaleLowerCase('pt-BR');

  const filteredPlaylists = useMemo(
    () => data.playlists.filter(p => !q || p.name.toLocaleLowerCase('pt-BR').includes(q)),
    [data.playlists, q],
  );

  const filteredTracks = useMemo(
    () =>
      data.tracks.filter(
        t =>
          (tab === 'downloads' ? !!t.offline : true) &&
          (!q ||
            `${t.title} ${t.artist} ${t.album || ''}`.toLocaleLowerCase('pt-BR').includes(q)),
      ),
    [data.tracks, tab, q],
  );

  const albums = useMemo(() => {
    const map = new Map<string, typeof data.tracks>();
    for (const t of filteredTracks) {
      if (!t.album) continue;
      const list = map.get(t.album) || [];
      list.push(t);
      map.set(t.album, list);
    }
    return [...map.entries()];
  }, [filteredTracks]);

  const artists = useMemo(() => {
    const map = new Map<string, typeof data.tracks>();
    for (const t of filteredTracks) {
      const name = t.artist.split(/[,&]/)[0]?.trim() || t.artist;
      if (!name) continue;
      const list = map.get(name) || [];
      list.push(t);
      map.set(name, list);
    }
    return [...map.entries()];
  }, [filteredTracks]);

  if (page === 'library') {

    return (
      <div className="collection-page">
        <div className="page-heading">
          <div className="heading-title-group">
            <h1>Biblioteca</h1>
            <span className="heading-count">
              {data.playlists.length} playlists · {data.tracks.length} faixas
            </span>
          </div>
          <div className="heading-actions">
            <button
              className="button secondary"
              onClick={() => void useApp.getState().importLocalFiles()}
            >
              <FolderInput size={15} />
              Arquivos
            </button>
            <button
              className="button secondary"
              onClick={() => useApp.getState().setDialog({ type: 'link', playlist: true })}
            >
              Importar playlist
            </button>
            <button
              className="button secondary"
              onClick={() => useApp.getState().setDialog({ type: 'link' })}
            >
              <Plus size={15} />
              Adicionar link
            </button>
            <button
              className="button primary"
              onClick={() => useApp.getState().setDialog({ type: 'playlist' })}
            >
              <Plus size={15} />
              Criar playlist
            </button>
          </div>
        </div>

        <div className="library-toolbar">
          <div className="pills" role="group" aria-label="Filtro da biblioteca">
            {(
              [
                ['all', 'Tudo'],
                ['playlists', 'Playlists'],
                ['albums', 'Álbuns'],
                ['artists', 'Artistas'],
                ['downloads', 'Downloads'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? 'selected' : ''}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="library-search">
            <Search size={14} />
            <input
              aria-label="Pesquisar nesta coleção"
              placeholder="Filtrar"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </label>
        </div>

        {(tab === 'all' || tab === 'playlists') && filteredPlaylists.length > 0 && (
          <section className="library-playlists" aria-label="Playlists">
            {tab === 'all' && (
              <div className="section-heading">
                <h2>Playlists</h2>
              </div>
            )}
            <div className="playlist-grid">
              {filteredPlaylists.map(p => (
                <article className="library-playlist-card playlist-row" key={p.id}>
                  <button
                    className="playlist-card-open"
                    onClick={() => useApp.getState().setPage(`playlist:${p.id}`)}
                  >
                    <PlaylistCover playlist={p} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.trackIds.length} faixas</small>
                    </span>
                  </button>
                  <GlassContextMenu
                    label={`Opções de ${p.name}`}
                    items={[
                      {
                        label: 'Renomear',
                        icon: <Pencil size={15} />,
                        action: () =>
                          useApp
                            .getState()
                            .setDialog({ type: 'playlist', id: p.id, name: p.name }),
                      },
                      {
                        label: 'Exportar playlist',
                        icon: <Share2 size={15} />,
                        action: () => void window.glass.exportLibrary(p.id),
                      },
                      {
                        label: 'Excluir',
                        icon: <Trash2 size={15} />,
                        danger: true,
                        action: () =>
                          useApp.getState().setDialog({
                            type: 'confirm',
                            title: `Excluir “${p.name}”?`,
                            text: 'As músicas continuam na biblioteca.',
                            action: async () => {
                              await useApp.getState().mutate({ action: 'delete', id: p.id });
                            },
                          }),
                      },
                    ]}
                  />
                </article>
              ))}
            </div>
          </section>
        )}

        {tab === 'playlists' && !filteredPlaylists.length && (
          <div className="empty-state">
            <h3>Nenhuma playlist</h3>
            <button
              className="button secondary"
              onClick={() => useApp.getState().setDialog({ type: 'playlist' })}
            >
              Criar playlist
            </button>
          </div>
        )}

        {tab === 'albums' && (
          <section className="library-playlists" aria-label="Álbuns">
            {albums.length ? (
              <div className="playlist-grid">
                {albums.map(([album, items]) => (
                  <article className="library-playlist-card" key={album}>
                    <button
                      className="playlist-card-open"
                      onClick={() => items[0] && useApp.getState().play(items[0], items)}
                    >
                      <Cover track={items[0]} />
                      <span>
                        <strong>{album}</strong>
                        <small>
                          {items[0]?.artist} · {items.length} faixas
                        </small>
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <h3>Nenhum álbum</h3>
              </div>
            )}
          </section>
        )}

        {tab === 'artists' && (
          <section className="library-playlists" aria-label="Artistas">
            {artists.length ? (
              <div className="playlist-grid">
                {artists.map(([artist, items]) => (
                  <article className="library-playlist-card" key={artist}>
                    <button
                      className="playlist-card-open"
                      onClick={() => items[0] && useApp.getState().play(items[0], items)}
                    >
                      <Cover track={items[0]} />
                      <span>
                        <strong>{artist}</strong>
                        <small>{items.length} faixas</small>
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <h3>Nenhum artista</h3>
              </div>
            )}
          </section>
        )}

        {(tab === 'all' || tab === 'downloads') && (
          <section>
            {tab === 'all' && filteredPlaylists.length > 0 && (
              <div className="section-heading">
                <h2>Músicas</h2>
              </div>
            )}
            <TrackList
              tracks={filteredTracks}
              empty={
                tab === 'downloads'
                  ? 'Nenhuma faixa salva offline.'
                  : 'Adicione um arquivo ou link.'
              }
            />
          </section>
        )}
      </div>
    );
  }

  const title =
    playlist?.name ||
    ({
      likes: 'Curtidas',
      history: 'Histórico',
      local: 'Arquivos locais',
    } as Record<string, string>)[page] ||
    'Playlist';

  const ids =
    playlist?.trackIds ||
    (page === 'likes'
      ? data.likes
      : page === 'history'
        ? [...new Set(data.history.map(h => h.id))]
        : undefined);

  const tracks = (
    ids ? ids.map(id => data.tracks.find(t => t.id === id)).filter(t => !!t) : data.tracks
  ).filter(
    t => !q || `${t.title} ${t.artist}`.toLocaleLowerCase('pt-BR').includes(q),
  );

  const totalDur = formatTotalDuration(tracks.reduce((sum, t) => sum + (t.duration || 0), 0));
  const activeHere = !!current && tracks.some(t => t.id === current.id);

  return (
    <div className={playlist ? 'playlist-page' : 'collection-page'}>
      <div className="page-heading collection-hero">
        {playlist && (
          <div className="playlist-hero-art">
            <PlaylistCover playlist={playlist} />
          </div>
        )}
        <div>
          {playlist && <span className="collection-type-label">Playlist</span>}
          <h1>{title}</h1>
          <p>
            {tracks.length} faixas
            {totalDur ? ` · ${totalDur}` : ''}
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={() => useApp.getState().setDialog({ type: 'link' })}
          >
            <Plus size={15} />
            Adicionar link
          </button>
        </div>
      </div>

      <div className="library-toolbar">
        <div>
          <button
            className="playlist-play"
            disabled={!tracks.length}
            aria-label={
              playlist
                ? activeHere && playing
                  ? 'Pausar playlist'
                  : 'Reproduzir playlist'
                : activeHere && playing
                  ? 'Pausar coleção'
                  : 'Reproduzir coleção'
            }
            onClick={() => {
              if (activeHere) transport.toggle();
              else if (tracks[0]) useApp.getState().play(tracks[0], tracks);
            }}
          >
            {activeHere && playing ? (
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            <span>{activeHere && playing ? 'Pausar' : 'Reproduzir'}</span>
          </button>

          {playlist &&
            tracks.some(t => ['youtube', 'link'].includes(t.source) && !t.offline) && (
              <button
                className="button secondary"
                onClick={() => void useApp.getState().downloadPlaylist(tracks)}
              >
                <Download size={14} />
                Baixar offline
              </button>
            )}

          {playlist && (
            <>
              <IconButton
                label="Renomear playlist"
                onClick={() =>
                  useApp
                    .getState()
                    .setDialog({ type: 'playlist', id: playlist.id, name: playlist.name })
                }
              >
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label="Excluir playlist"
                onClick={() =>
                  useApp.getState().setDialog({
                    type: 'confirm',
                    title: `Excluir “${playlist.name}”?`,
                    text: 'As músicas continuam na biblioteca.',
                    action: async () => {
                      await useApp.getState().mutate({ action: 'delete', id: playlist.id });
                      useApp.getState().setPage('library');
                    },
                  })
                }
              >
                <Trash2 size={15} />
              </IconButton>
            </>
          )}

          {page === 'history' && tracks.length > 0 && (
            <button
              className="button secondary"
              onClick={() =>
                useApp.getState().setDialog({
                  type: 'confirm',
                  title: 'Limpar histórico?',
                  text: 'As músicas continuam na biblioteca.',
                  action: async () => {
                    await useApp.getState().mutate({ action: 'clearHistory' });
                  },
                })
              }
            >
              <Trash2 size={14} />
              Limpar
            </button>
          )}
        </div>

        <label className="library-search">
          <Search size={14} />
          <input
            aria-label="Pesquisar nesta coleção"
            placeholder="Filtrar"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </label>
      </div>

      <TrackList tracks={tracks} playlistId={playlist?.id} />
    </div>
  );
}
