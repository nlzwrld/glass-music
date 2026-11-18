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
  Library as LibraryIcon,
  ListMusic,
  Disc3,
  Users,
  Heart,
  Sparkles,
  ArrowUpDown,
  Music2,
  Share2,
} from 'lucide-react';
import { useApp } from '../stores/app';
import PlaylistCover from '../components/library/PlaylistCover';
import TrackList from '../components/library/TrackList';
import Cover from '../components/glass/Cover';
import { IconButton } from '../components/glass/controls';

type LibTab = 'all' | 'playlists' | 'albums' | 'artists' | 'downloads' | 'tracks';
type SortMode = 'recent' | 'alpha' | 'count';

export default function Library() {
  const data = useApp(s => s.data),
    page = useApp(s => s.page),
    [query, setQuery] = useState(''),
    [tab, setTab] = useState<LibTab>('all'),
    [sort, setSort] = useState<SortMode>('recent');

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

  const likedTracks = useMemo(
    () =>
      data.likes
        .map(id => data.tracks.find(t => t.id === id))
        .filter((t): t is NonNullable<typeof t> => !!t),
    [data.likes, data.tracks],
  );
  const offlineTracks = useMemo(
    () => data.tracks.filter(t => t.offline),
    [data.tracks],
  );
  const historyTracks = useMemo(
    () =>
      [...new Set(data.history.map(h => h.id))]
        .map(id => data.tracks.find(t => t.id === id))
        .filter((t): t is NonNullable<typeof t> => !!t),
    [data.history, data.tracks],
  );

  // Hub view ("Sua Biblioteca") matching Reference Image 2!
  if (page === 'library') {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    const filteredPlaylists = [...data.playlists]
      .filter(p => !q || p.name.toLocaleLowerCase('pt-BR').includes(q))
      .sort((a, b) =>
        sort === 'alpha'
          ? a.name.localeCompare(b.name, 'pt-BR')
          : sort === 'count'
            ? b.trackIds.length - a.trackIds.length
            : b.createdAt - a.createdAt,
      );

    const filteredTracks = data.tracks.filter(
      t =>
        (tab === 'downloads' ? !!t.offline : true) &&
        (!q || `${t.title} ${t.artist} ${t.album || ''}`.toLocaleLowerCase('pt-BR').includes(q)),
    );

    const albumsMap = new Map<string, typeof data.tracks>();
    const artistsMap = new Map<string, typeof data.tracks>();
    for (const t of filteredTracks) {
      if (t.album) {
        const list = albumsMap.get(t.album) || [];
        list.push(t);
        albumsMap.set(t.album, list);
      }
      const primary = t.artist.split(/[,&]/)[0]?.trim() || t.artist;
      if (primary) {
        const list = artistsMap.get(primary) || [];
        list.push(t);
        artistsMap.set(primary, list);
      }
    }

    return (
      <div className="lg-library-hub">
        <header className="lg-section-hero">
          <div className="lg-hero-badge">
            <LibraryIcon size={24} />
          </div>
          <div>
            <h1>Sua Biblioteca</h1>
            <p>Suas músicas, álbuns e playlists em um só lugar</p>
          </div>
          <div className="lg-hero-actions">
            <button
              className="lg-pill-btn"
              onClick={() => void useApp.getState().importLocalFiles()}
            >
              <FolderInput size={15} />
              Arquivos
            </button>
            <button
              className="lg-pill-btn"
              onClick={() => useApp.getState().setDialog({ type: 'link', playlist: true })}
            >
              Importar playlist
            </button>
            <button
              className="lg-pill-btn"
              onClick={() => useApp.getState().setDialog({ type: 'link' })}
            >
              <Plus size={15} />
              Adicionar link
            </button>
            <button
              className="lg-cta-white"
              onClick={() => useApp.getState().setDialog({ type: 'playlist' })}
            >
              <Plus size={16} />
              Criar playlist
            </button>
          </div>
        </header>

        <div className="lg-library-controls">
          <div className="lg-pills" role="group" aria-label="Filtro da biblioteca">
            {(
              [
                ['all', 'Tudo', null],
                ['playlists', 'Playlists', ListMusic],
                ['albums', 'Álbuns', Disc3],
                ['artists', 'Artistas', Users],
                ['downloads', 'Downloads', Download],
                ['tracks', 'Músicas', Music2],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                className={`lg-pill ${tab === id ? 'selected' : ''}`}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {Icon && <Icon size={14} />}
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="lg-library-right-tools">
            <label className="lg-inline-search">
              <Search size={15} />
              <input
                aria-label="Pesquisar nesta coleção"
                placeholder="Buscar na biblioteca"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </label>
            <label className="lg-sort-select">
              <ArrowUpDown size={14} />
              <select
                aria-label="Ordenar biblioteca"
                value={sort}
                onChange={e => setSort(e.target.value as SortMode)}
              >
                <option value="recent">Mais recentes</option>
                <option value="alpha">Ordem A–Z</option>
                <option value="count">Mais faixas</option>
              </select>
            </label>
          </div>
        </div>

        {(tab === 'all' || tab === 'playlists') && (
          <section className="library-playlists" aria-label="Suas playlists">
            <div className="lg-collection-grid">
              {filteredPlaylists.map(p => {
                const plTracks = p.trackIds
                  .map(id => data.tracks.find(t => t.id === id))
                  .filter((t): t is NonNullable<typeof t> => !!t);
                return (
                  <article className="lg-collection-card playlist-row" key={p.id}>
                    <button
                      className="lg-collection-cover"
                      aria-label={p.name}
                      onClick={() => useApp.getState().setPage(`playlist:${p.id}`)}
                    >
                      <PlaylistCover playlist={p} />
                    </button>
                    <div className="lg-collection-body">
                      <button
                        className="lg-collection-title"
                        onClick={() => useApp.getState().setPage(`playlist:${p.id}`)}
                      >
                        <strong>{p.name}</strong>
                        <small>
                          <ListMusic size={12} /> Playlist • {p.trackIds.length} faixas
                        </small>
                      </button>
                      <div className="lg-collection-actions">
                        <button
                          className="lg-play-pill"
                          disabled={!plTracks.length}
                          onClick={() => {
                            if (plTracks[0]) useApp.getState().play(plTracks[0], plTracks);
                            else useApp.getState().setPage(`playlist:${p.id}`);
                          }}
                        >
                          <Play size={13} fill="currentColor" /> Reproduzir
                        </button>
                        <GlassContextMenu
                          label={`Opções de ${p.name}`}
                          items={[
                            {
                              label: 'Editar playlist',
                              icon: <Pencil size={16} />,
                              action: () =>
                                useApp.getState().setDialog({
                                  type: 'playlist',
                                  id: p.id,
                                  name: p.name,
                                  description: p.description,
                                  artwork: p.artwork,
                                }),
                            },
                            {
                              label: 'Baixar playlist offline',
                              icon: <Download size={16} />,
                              disabled: !plTracks.length,
                              action: () => void useApp.getState().downloadPlaylist(plTracks),
                            },
                            {
                              label: 'Exportar playlist',
                              icon: <Share2 size={16} />,
                              action: () => void window.glass.exportLibrary(p.id),
                            },
                            {
                              label: 'Excluir',
                              icon: <Trash2 size={16} />,
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
                      </div>
                    </div>
                  </article>
                );
              })}

              {/* Smart System Cards matching Reference Image 2 */}
              {!q && (
                <>
                  <article className="lg-collection-card">
                    <button
                      className="lg-collection-cover lg-emblem-likes"
                      onClick={() => useApp.getState().setPage('likes')}
                    >
                      <Heart size={38} />
                    </button>
                    <div className="lg-collection-body">
                      <button
                        className="lg-collection-title"
                        onClick={() => useApp.getState().setPage('likes')}
                      >
                        <strong>Curtidas</strong>
                        <small>
                          <Heart size={12} /> {likedTracks.length} músicas
                        </small>
                      </button>
                      <div className="lg-collection-actions">
                        <button
                          className="lg-play-pill"
                          disabled={!likedTracks.length}
                          onClick={() =>
                            likedTracks[0] &&
                            useApp.getState().play(likedTracks[0], likedTracks)
                          }
                        >
                          <Play size={13} fill="currentColor" /> Reproduzir
                        </button>
                      </div>
                    </div>
                  </article>

                  <article className="lg-collection-card">
                    <button
                      className="lg-collection-cover lg-emblem-offline"
                      onClick={() => setTab('downloads')}
                    >
                      <Download size={38} />
                    </button>
                    <div className="lg-collection-body">
                      <button
                        className="lg-collection-title"
                        onClick={() => setTab('downloads')}
                      >
                        <strong>Para ouvir offline</strong>
                        <small>
                          <Download size={12} /> {offlineTracks.length} faixas
                        </small>
                      </button>
                      <div className="lg-collection-actions">
                        <button
                          className="lg-play-pill"
                          disabled={!offlineTracks.length}
                          onClick={() =>
                            offlineTracks[0] &&
                            useApp.getState().play(offlineTracks[0], offlineTracks)
                          }
                        >
                          <Play size={13} fill="currentColor" /> Reproduzir
                        </button>
                      </div>
                    </div>
                  </article>

                  <article className="lg-collection-card">
                    <button
                      className="lg-collection-cover lg-emblem-discover"
                      onClick={() => useApp.getState().setPage('explore')}
                    >
                      <Sparkles size={38} />
                    </button>
                    <div className="lg-collection-body">
                      <button
                        className="lg-collection-title"
                        onClick={() => useApp.getState().setPage('explore')}
                      >
                        <strong>Descobertas & Mix</strong>
                        <small>
                          <Sparkles size={12} /> {historyTracks.length || data.tracks.length} referências
                        </small>
                      </button>
                      <div className="lg-collection-actions">
                        <button
                          className="lg-play-pill"
                          onClick={() => void useApp.getState().startStyleRadio()}
                        >
                          <Play size={13} fill="currentColor" /> Reproduzir
                        </button>
                      </div>
                    </div>
                  </article>
                </>
              )}
            </div>
          </section>
        )}

        {tab === 'albums' && (
          <section className="lg-collection-grid">
            {[...albumsMap.entries()].map(([album, items]) => (
              <article className="lg-collection-card" key={album}>
                <div className="lg-collection-cover">
                  <Cover track={items[0]} />
                </div>
                <div className="lg-collection-body">
                  <div className="lg-collection-title">
                    <strong>{album}</strong>
                    <small>
                      <Disc3 size={12} /> {items[0]?.artist} • {items.length} faixas
                    </small>
                  </div>
                  <div className="lg-collection-actions">
                    <button
                      className="lg-play-pill"
                      onClick={() => items[0] && useApp.getState().play(items[0], items)}
                    >
                      <Play size={13} fill="currentColor" /> Reproduzir
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}

        {tab === 'artists' && (
          <section className="lg-collection-grid">
            {[...artistsMap.entries()].map(([artist, items]) => (
              <article className="lg-collection-card" key={artist}>
                <div className="lg-collection-cover">
                  <Cover track={items[0]} />
                </div>
                <div className="lg-collection-body">
                  <div className="lg-collection-title">
                    <strong>{artist}</strong>
                    <small>
                      <Users size={12} /> {items.length} faixas salvas
                    </small>
                  </div>
                  <div className="lg-collection-actions">
                    <button
                      className="lg-play-pill"
                      onClick={() => items[0] && useApp.getState().play(items[0], items)}
                    >
                      <Play size={13} fill="currentColor" /> Reproduzir
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}

        {(tab === 'all' || tab === 'tracks' || tab === 'downloads') && (
          <section style={{ marginTop: tab === 'all' ? 28 : 0 }}>
            {tab === 'all' && (
              <div className="section-heading">
                <h2>Todas as músicas ({filteredTracks.length})</h2>
              </div>
            )}
            <TrackList
              tracks={filteredTracks}
              empty={
                tab === 'downloads'
                  ? 'Nenhuma música baixada ainda. Use “Baixar para ouvir offline” no menu da faixa.'
                  : 'Adicione um link ou arquivo para começar.'
              }
            />
          </section>
        )}
      </div>
    );
  }

  // Detail View (Playlist / Curtidas / Histórico — matching Reference Image 5!)
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
  ).filter(t =>
    `${t.title} ${t.artist}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR')),
  );

  const activeHere = !!current && tracks.some(t => t.id === current.id);

  return (
    <div className="playlist-page">
      <div className="page-heading lg-playlist-hero">
        {playlist ? (
          <div className="playlist-hero-art">
            <PlaylistCover playlist={playlist} />
          </div>
        ) : page === 'likes' ? (
          <div className="playlist-hero-art lg-emblem-likes">
            <Heart size={36} />
          </div>
        ) : (
          <div className="playlist-hero-art lg-emblem-discover">
            <Sparkles size={36} />
          </div>
        )}
        <div>
          <h1>{title}</h1>
          {playlist?.description && <p className="playlist-desc">{playlist.description}</p>}
          <p>{tracks.length} faixas</p>
        </div>
        <button
          className="lg-pill-btn"
          onClick={() => useApp.getState().setDialog({ type: 'link' })}
        >
          <Plus size={16} />
          Adicionar link
        </button>
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
              if (activeHere) {
                transport.toggle();
              } else if (tracks[0]) useApp.getState().play(tracks[0], tracks);
            }}
          >
            {activeHere && playing ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
            <span>{activeHere && playing ? 'Pausar' : 'Reproduzir'}</span>
          </button>

          {playlist &&
            tracks.some(t => ['youtube', 'link'].includes(t.source) && !t.offline) && (
              <IconButton
                label="Baixar playlist para ouvir offline"
                onClick={() => void useApp.getState().downloadPlaylist(tracks)}
              >
                <Download size={17} />
              </IconButton>
            )}
          {playlist && (
            <>
              <IconButton
                label="Renomear playlist"
                onClick={() =>
                  useApp.getState().setDialog({
                    type: 'playlist',
                    id: playlist.id,
                    name: playlist.name,
                    description: playlist.description,
                    artwork: playlist.artwork,
                  })
                }
              >
                <Pencil size={17} />
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
                <Trash2 size={17} />
              </IconButton>
            </>
          )}
          {page === 'history' && (
            <IconButton
              label="Limpar histórico"
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
              <Trash2 size={17} />
            </IconButton>
          )}
        </div>
        <label className="lg-inline-search">
          <Search size={15} />
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
