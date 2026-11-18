import { useEffect, useRef, useState } from 'react';
import {
  Search as SearchIcon,
  LoaderCircle,
  AlertCircle,
  Link2,
  Play,
  Pause,
  Music2,
  Disc3,
  ListMusic,
  User,
  Users,
  Quote,
  Sparkles,
  Heart,
  Plus,
  ArrowRight,
} from 'lucide-react';
import { useApp, cleanError, looksLikeMusicLink, handleDirectLink } from '../stores/app';
import type { SearchKind, SearchSource, SearchResult, Track } from '../../shared/types';
import TrackList from '../components/library/TrackList';
import TrackCard from '../components/library/TrackCard';
import Cover, { coverURL } from '../components/glass/Cover';
import { IconButton, SourceBadge } from '../components/glass/controls';
import { GlassContextMenu } from '../components/glass/materials';
import { trackActions } from '../components/library/trackActions';
import { transport } from '../components/player/engine';

const KINDS: [SearchKind, string, typeof Music2 | null][] = [
  ['all', 'Todos', null],
  ['track', 'Músicas', Music2],
  ['album', 'Álbuns', Disc3],
  ['playlist', 'Playlists', ListMusic],
  ['artist', 'Artistas', User],
  ['lyrics', 'Letras', Quote],
];

const SOURCES: [SearchSource, string][] = [
  ['all', 'Todas'],
  ['youtube', 'YouTube'],
  ['deezer', 'Deezer'],
  ['apple', 'Apple Music'],
  ['soundcloud', 'SoundCloud'],
  ['local', 'Local'],
];

export default function Search() {
  const query = useApp(s => s.filter),
    local = useApp(s => s.data.tracks),
    likes = useApp(s => s.data.likes),
    current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing),
    consent = useApp(
      s =>
        s.data.preferences.onlineConsent &&
        (!s.integrations?.catalogConfigured || s.data.preferences.catalogConsent),
    );
  const [kind, setKind] = useState<SearchKind>('all');
  const [source, setSource] = useState<SearchSource>('all');
  const [result, setResult] = useState<SearchResult>({ items: [], next: {}, notices: [] });
  const [relatedArtists, setRelatedArtists] = useState<Track[]>([]);
  const [relatedPlaylists, setRelatedPlaylists] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const active = useRef<string[]>([]);

  useEffect(() => {
    useApp.setState({ searchBusy: loading });
    return () => useApp.setState({ searchBusy: false });
  }, [loading]);

  const isLink = looksLikeMusicLink(query);
  const localMatches =
    kind !== 'lyrics' && (source === 'all' || source === 'local')
      ? local.filter(
          t =>
            (source === 'local' ? t.source === 'local' : true) &&
            `${t.title} ${t.artist} ${t.album || ''}`
              .toLocaleLowerCase('pt-BR')
              .includes(query.toLocaleLowerCase('pt-BR')),
        )
      : [];

  useEffect(() => {
    const gen = ++generation.current;
    const q = query.trim();
    setResult({ items: [], next: {}, notices: [] });
    if (kind === 'all') {
      setRelatedArtists([]);
      setRelatedPlaylists([]);
    }
    active.current.forEach(id => void window.glass.cancelSearch(id));
    active.current = [];
    setLoading(false);
    if (!q || isLink || source === 'local') return;
    if (!consent) {
      setResult({ items: [], next: {}, notices: ['Ative o acesso online para buscar.'] });
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      const requestId = crypto.randomUUID();
      const artId = `${requestId}-art`;
      const plId = `${requestId}-pl`;
      active.current = kind === 'all' ? [requestId, artId, plId] : [requestId];
      try {
        const mainPromise = window.glass.search({ query: q, kind, source, requestId });
        if (kind === 'all') {
          void window.glass
            .search({ query: q, kind: 'artist', source: 'deezer', requestId: artId })
            .then(r => {
              if (generation.current === gen) setRelatedArtists(r.items.slice(0, 4));
            })
            .catch(() => {});
          void window.glass
            .search({ query: q, kind: 'playlist', source: 'deezer', requestId: plId })
            .then(r => {
              if (generation.current === gen) setRelatedPlaylists(r.items.slice(0, 4));
            })
            .catch(() => {});
        }
        const data = await mainPromise;
        if (generation.current === gen) setResult(data);
      } catch (e) {
        if (generation.current === gen)
          setResult({ items: [], next: {}, notices: [cleanError(e)] });
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    }, 340);
    return () => {
      clearTimeout(timer);
      generation.current++;
      active.current.forEach(id => void window.glass.cancelSearch(id));
    };
  }, [query, isLink, kind, source, consent]);

  const more = async () => {
    const gen = generation.current;
    setLoading(true);
    const requestId = crypto.randomUUID();
    active.current = Object.keys(result.next).map(provider => requestId + provider);
    try {
      const pages = await Promise.all(
        Object.keys(result.next).map(provider =>
          window.glass.search({
            query: query.trim(),
            kind,
            source: provider as SearchSource,
            cursor: result.next,
            requestId: requestId + provider,
          }),
        ),
      );
      if (gen === generation.current)
        setResult(prev => ({
          items: [
            ...new Map(
              [...prev.items, ...pages.flatMap(p => p.items)].map(t => [t.id, t]),
            ).values(),
          ],
          next: Object.assign({}, ...pages.map(p => p.next)),
          notices: pages.flatMap(p => p.notices),
        }));
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  };

  const localFiltered = kind === 'all' || kind === 'track' ? localMatches : [];
  const combined = [
    ...new Map([...localFiltered, ...result.items].map(t => [t.id, t])).values(),
  ];
  const tracksOnly = combined.filter(t => t.kind === 'track');
  const collectionsOnly = combined.filter(t => t.kind !== 'track');
  const topTrack = tracksOnly[0];
  const topActive = !!topTrack && current?.id === topTrack.id;

  const lyricDirect = kind === 'lyrics' ? tracksOnly.filter(t => !t.recommended) : [];
  const lyricRecs = kind === 'lyrics' ? tracksOnly.filter(t => t.recommended) : [];

  return (
    <div className="search-page">
      <div className="page-heading search-heading">
        <h1>{query.trim() ? `Resultados para “${query.trim()}”` : 'Buscar'}</h1>
        {loading && <LoaderCircle className="spinner" aria-label="Buscando" />}
      </div>

      <div className="lg-filter-bar">
        <div className="lg-pills" role="group" aria-label="Tipo de resultado">
          {KINDS.map(([id, label, Icon]) => (
            <button
              key={id}
              className={`lg-pill ${kind === id ? 'selected' : ''}`}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {Icon && <Icon size={14} />}
              <span>{label}</span>
            </button>
          ))}
        </div>
        {kind !== 'lyrics' && (
          <div className="lg-source-pills" role="group" aria-label="Plataforma">
            {SOURCES.map(([id, label]) => (
              <button
                key={id}
                className={`lg-subpill ${source === id ? 'selected' : ''}`}
                aria-pressed={source === id}
                onClick={() => setSource(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!query ? (
        <div className="lg-search-welcome">
          <div className="lg-hero-badge">
            <SearchIcon size={24} />
          </div>
          <h2>Encontre qualquer música, álbum ou trecho de letra</h2>
          <p>
            Pesquise em YouTube, Deezer, Apple Music e SoundCloud, digite um verso na aba{' '}
            <strong>Letras</strong> ou cole um link direto do Spotify, Bandcamp ou Tidal.
          </p>
        </div>
      ) : isLink ? (
        <div className="lg-link-banner">
          <div className="lg-hero-badge">
            <Link2 size={20} />
          </div>
          <div>
            <strong>Link direto detectado</strong>
            <p>Pronto para reproduzir ou importar diretamente no Glass Music.</p>
          </div>
          <button
            className="lg-cta-white"
            disabled={loading}
            onClick={() => void handleDirectLink(query)}
          >
            <Play size={15} fill="currentColor" /> Abrir no Glass
          </button>
        </div>
      ) : (
        <>
          {result.notices.map(n => (
            <div className="notice" key={n}>
              <AlertCircle size={17} />
              <span>{n}</span>
              {!consent && (
                <button
                  className="lg-pill-btn"
                  onClick={() => useApp.getState().setPage('settings')}
                >
                  Ativar acesso online
                </button>
              )}
            </div>
          ))}

          {kind === 'lyrics' ? (
            <div className="lg-lyrics-search-results">
              {lyricDirect.length > 0 && (
                <section>
                  <div className="section-heading">
                    <h2>
                      <Quote size={17} /> Encontradas pela letra ({lyricDirect.length})
                    </h2>
                  </div>
                  <TrackList tracks={lyricDirect} />
                </section>
              )}
              {lyricRecs.length > 0 && (
                <section style={{ marginTop: 28 }}>
                  <div className="section-heading">
                    <h2>
                      <Sparkles size={17} /> Recomendações no estilo desta música
                    </h2>
                  </div>
                  <TrackList tracks={lyricRecs} />
                </section>
              )}
              {!combined.length && !loading && (
                <div className="empty-state">
                  <Quote size={30} />
                  <h3>Nenhum trecho encontrado</h3>
                  <p>Tente digitar algumas palavras marcantes do refrão ou verso.</p>
                </div>
              )}
            </div>
          ) : kind === 'all' && topTrack ? (
            <div className="lg-search-layout">
              <div className="lg-search-main">
                <article
                  className="lg-top-result"
                  data-track-item
                  style={
                    topTrack.artwork
                      ? ({
                          '--top-art': `url("${coverURL(topTrack)}")`,
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  <div className="lg-top-result-glow" aria-hidden="true" />
                  <div className="lg-top-result-cover">
                    <Cover track={topTrack} />
                  </div>
                  <div className="lg-top-result-info">
                    <span className="lg-chip-badge">
                      <Sparkles size={11} /> Melhor resultado
                    </span>
                    <h2>{topTrack.title}</h2>
                    <p>
                      {topTrack.artist} • Música •{' '}
                      <SourceBadge source={topTrack.source} url={topTrack.url} />
                    </p>
                    <div className="lg-top-result-actions">
                      <button
                        className="lg-cta-white"
                        onClick={() =>
                          topActive
                            ? transport.toggle()
                            : useApp.getState().play(topTrack, tracksOnly)
                        }
                      >
                        {topActive && playing ? (
                          <Pause size={16} fill="currentColor" />
                        ) : (
                          <Play size={16} fill="currentColor" />
                        )}
                        <span>{topActive && playing ? 'Pausar' : 'Tocar'}</span>
                      </button>
                      <IconButton
                        label={`Curtir ${topTrack.title}`}
                        active={likes.includes(topTrack.id)}
                        onClick={() =>
                          void useApp
                            .getState()
                            .mutate({ action: 'like', track: topTrack })
                            .catch(() => {})
                        }
                      >
                        <Heart
                          size={17}
                          fill={likes.includes(topTrack.id) ? 'currentColor' : 'none'}
                        />
                      </IconButton>
                      <IconButton
                        label={`Adicionar ${topTrack.title} à playlist`}
                        onClick={() =>
                          useApp.getState().setDialog({ type: 'add', track: topTrack })
                        }
                      >
                        <Plus size={18} />
                      </IconButton>
                      <GlassContextMenu
                        label={`Opções de ${topTrack.title}`}
                        items={trackActions(topTrack, tracksOnly)}
                      />
                    </div>
                  </div>
                </article>

                <section className="lg-search-songs">
                  <div className="section-heading">
                    <h2>Músicas ({tracksOnly.length})</h2>
                  </div>
                  <TrackList tracks={tracksOnly} compact />
                </section>
              </div>

              {(relatedArtists.length > 0 ||
                relatedPlaylists.length > 0 ||
                collectionsOnly.length > 0) && (
                <aside className="lg-search-aside">
                  {relatedArtists.length > 0 && (
                    <section className="lg-aside-card">
                      <header>
                        <h3>
                          <Users size={15} /> Artistas relacionados
                        </h3>
                        <button className="text-button" onClick={() => setKind('artist')}>
                          Ver todos <ArrowRight size={13} />
                        </button>
                      </header>
                      <div className="lg-aside-list">
                        {relatedArtists.slice(0, 3).map(artist => (
                          <div className="lg-aside-item" key={artist.id}>
                            <div className="lg-aside-avatar">
                              <Cover track={artist} />
                            </div>
                            <div className="lg-aside-meta">
                              <strong>{artist.title}</strong>
                              <small>Artista</small>
                            </div>
                            <button
                              className="lg-circle-play"
                              aria-label={`Abrir ${artist.title}`}
                              onClick={() => useApp.getState().play(artist)}
                            >
                              <Play size={14} fill="currentColor" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {(relatedPlaylists.length > 0 || collectionsOnly.length > 0) && (
                    <section className="lg-aside-card">
                      <header>
                        <h3>
                          <ListMusic size={15} /> Playlists relacionadas
                        </h3>
                        <button className="text-button" onClick={() => setKind('playlist')}>
                          Ver todos <ArrowRight size={13} />
                        </button>
                      </header>
                      <div className="lg-aside-list">
                        {[...relatedPlaylists, ...collectionsOnly]
                          .slice(0, 3)
                          .map(pl => (
                            <div className="lg-aside-item" key={pl.id}>
                              <div className="lg-aside-square">
                                <Cover track={pl} />
                              </div>
                              <div className="lg-aside-meta">
                                <strong>{pl.title}</strong>
                                <small>
                                  {pl.kind === 'album' ? 'Álbum' : 'Playlist'} • {pl.artist}
                                </small>
                              </div>
                              <button
                                className="lg-circle-play"
                                aria-label={`Abrir ${pl.title}`}
                                onClick={() => useApp.getState().play(pl)}
                              >
                                <Play size={14} fill="currentColor" />
                              </button>
                            </div>
                          ))}
                      </div>
                    </section>
                  )}
                </aside>
              )}
            </div>
          ) : (
            <>
              {collectionsOnly.length > 0 && (
                <section className="catalog-section" style={{ marginBottom: 24 }}>
                  <div className="catalog-grid">
                    {collectionsOnly.map(item => (
                      <TrackCard key={item.id} track={item} list={collectionsOnly} />
                    ))}
                  </div>
                </section>
              )}
              {tracksOnly.length > 0 && <TrackList tracks={tracksOnly} />}
              {!combined.length && !loading && (
                <div className="empty-state">
                  <SearchIcon size={32} />
                  <h3>Sem resultados</h3>
                  <p>Experimente outro termo ou pesquise um trecho na aba Letras.</p>
                </div>
              )}
            </>
          )}

          {Object.keys(result.next).length > 0 && (
            <button
              className="lg-pill-btn load-more"
              disabled={loading}
              onClick={() => void more()}
            >
              {loading ? 'Buscando…' : 'Carregar mais resultados'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
