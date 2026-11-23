import { preparePlayback } from '../lib/playback';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { GlassContextMenu } from '../components/glass/materials';
import {
  Search,
  Pencil,
  Trash2,
  Download,
  Share2,
  Users,
  ExternalLink,
  Check,
  X,
  ListMusic,
  Globe,
  Link2,
  Lock,
  Plus,
  History,
} from 'lucide-react';
import type { MySharedPlaylistsResponse } from '../../shared/types';
import { resolveEffectiveBroker, useAccounts } from '../stores/accounts';
import { cleanError, useApp } from '../stores/app';
import PlaylistCover from '../components/library/PlaylistCover';
import TrackList from '../components/library/TrackList';
import { CollectionPlaybackActions } from '../components/library/CollectionPlaybackActions';
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
    hub = useAccounts(s => s.hub),
    preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl),
    [query, setQuery] = useState(''),
    [tab, setTab] = useState<LibTab>('all'),
    [myShared, setMyShared] = useState<MySharedPlaylistsResponse | null>(null),
    [inviteBusy, setInviteBusy] = useState('');

  const brokerUrl = resolveEffectiveBroker(undefined, { preferredBrokerUrl, hub });

  const refreshShared = useCallback(async () => {
    if (!hub.authenticated || !window.glass?.hubMyPlaylists || !data.preferences.onlineConsent) {
      setMyShared(null);
      return;
    }
    try {
      const res = await window.glass.hubMyPlaylists({ brokerUrl });
      setMyShared(res);
    } catch {
      // Keep local library responsive if broker is unreachable
    }
  }, [hub.authenticated, brokerUrl, data.preferences.onlineConsent]);

  useEffect(() => {
    if (page === 'library') {
      void refreshShared();
    }
  }, [page, refreshShared]);

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
          <div className="heading-actions library-quick-actions">
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
              <Link2 size={15} />
              Importar link
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => useApp.getState().setPage('downloads')}
            >
              <Download size={15} />
              Downloads
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => useApp.getState().setPage('history')}
            >
              <History size={15} />
              Histórico
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

        {(tab === 'all' || tab === 'playlists') &&
          myShared &&
          myShared.pendingInvites.length > 0 && (
            <section className="library-playlists" aria-label="Convites de colaboração">
              <div className="section-heading">
                <h2>Convites para playlists colaborativas</h2>
              </div>
              <div className="shared-invites-list">
                {myShared.pendingInvites.map(inv => (
                  <div className="notice collab-invite-banner" key={inv.id}>
                    <Users size={16} />
                    <div>
                      <strong>{inv.name}</strong>
                      <small style={{ display: 'block' }}>
                        Convite de @{inv.ownerHandle} · {inv.trackCount} faixa(s)
                      </small>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => useApp.getState().setPage(`shared-playlist:${inv.id}`)}
                      >
                        Abrir
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={inviteBusy === inv.id}
                        onClick={async () => {
                          if (!window.glass?.hubRespondPlaylistInvite) return;
                          setInviteBusy(inv.id);
                          try {
                            await window.glass.hubRespondPlaylistInvite({
                              brokerUrl,
                              shareId: inv.id,
                              accept: false,
                            });
                            await refreshShared();
                            useApp.getState().message('Convite recusado.');
                          } catch (e) {
                            useApp.getState().message(cleanError(e));
                          } finally {
                            setInviteBusy('');
                          }
                        }}
                      >
                        <X size={14} />
                        Recusar
                      </button>
                      <button
                        type="button"
                        className="button primary"
                        disabled={inviteBusy === inv.id}
                        onClick={async () => {
                          if (!window.glass?.hubRespondPlaylistInvite) return;
                          setInviteBusy(inv.id);
                          try {
                            await window.glass.hubRespondPlaylistInvite({
                              brokerUrl,
                              shareId: inv.id,
                              accept: true,
                            });
                            await refreshShared();
                            useApp.getState().setPage(`shared-playlist:${inv.id}`);
                            useApp.getState().message('Convite aceito! Playlist colaborativa aberta.');
                          } catch (e) {
                            useApp.getState().message(cleanError(e));
                          } finally {
                            setInviteBusy('');
                          }
                        }}
                      >
                        <Check size={14} />
                        Aceitar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

        {(tab === 'all' || tab === 'playlists') &&
          myShared &&
          myShared.collaborating.length > 0 && (
            <section className="library-playlists" aria-label="Playlists colaborativas">
              <div className="section-heading">
                <h2>Playlists colaborativas</h2>
              </div>
              <div className="playlist-grid">
                {myShared.collaborating.map(cp => (
                  <article className="library-playlist-card shared-playlist-card" key={cp.id}>
                    <button
                      className="playlist-card-open"
                      onClick={() => useApp.getState().setPage(`shared-playlist:${cp.id}`)}
                    >
                      <div className="shared-playlist-thumb">
                        {cp.artwork ? <img src={cp.artwork} alt="" /> : <ListMusic size={22} />}
                      </div>
                      <span>
                        <strong>{cp.name}</strong>
                        <small>
                          Por @{cp.ownerHandle} · {cp.trackCount} faixas
                        </small>
                      </span>
                      <span className="entity-badge entity-badge-collab" title="Colaborativa">
                        <Users size={11} />
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}

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
                        label: 'Compartilhar / Colaborar',
                        icon: <Users size={15} />,
                        action: () =>
                          useApp
                            .getState()
                            .setDialog({ type: 'sharePlaylist', playlistId: p.id }),
                      },
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
          {playlist && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="collection-type-label">Playlist</span>
              {playlist.shareId && (
                <span className="entity-badge entity-badge-privacy">
                  {playlist.visibility === 'public' ? (
                    <Globe size={11} />
                  ) : playlist.visibility === 'unlisted' ? (
                    <Link2 size={11} />
                  ) : (
                    <Lock size={11} />
                  )}
                  {playlist.visibility === 'public'
                    ? 'Pública'
                    : playlist.visibility === 'unlisted'
                      ? 'Com link'
                      : 'Privada'}
                </span>
              )}
              {playlist.collaborative && (
                <span className="entity-badge entity-badge-collab">
                  <Users size={11} />
                  Colaborativa
                </span>
              )}
            </div>
          )}
          <h1>{title}</h1>
          <p>
            {tracks.length} faixas
            {totalDur ? ` · ${totalDur}` : ''}
          </p>
        </div>
      </div>

      <div className="library-toolbar">
        <div>
          <CollectionPlaybackActions
            tracks={tracks}
            activeHere={activeHere}
            playing={playing}
            isPlaylist={!!playlist}
          />

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
              <button
                className="button secondary"
                onClick={() =>
                  useApp
                    .getState()
                    .setDialog({ type: 'sharePlaylist', playlistId: playlist.id })
                }
              >
                <Share2 size={14} />
                Compartilhar
              </button>
              {playlist.shareId && (
                <button
                  className="button secondary"
                  onClick={() =>
                    useApp.getState().setPage(`shared-playlist:${playlist.shareId}`)
                  }
                >
                  <ExternalLink size={14} />
                  Abrir compartilhada
                </button>
              )}
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

      <TrackList tracks={tracks} playlistId={playlist?.id} showHeaderShuffle={false} />
    </div>
  );
}
