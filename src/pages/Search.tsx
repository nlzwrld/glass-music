import { useEffect, useRef, useState } from 'react';
import {
  Search as SearchIcon,
  LoaderCircle,
  AlertCircle,
  Link2,
  Play,
} from 'lucide-react';
import { useApp, cleanError, looksLikeMusicLink, handleDirectLink } from '../stores/app';
import type { SearchKind, SearchSource, SearchResult } from '../../shared/types';
import TrackList from '../components/library/TrackList';
import TrackCard from '../components/library/TrackCard';

const KINDS: [SearchKind, string][] = [
  ['all', 'Tudo'],
  ['track', 'Músicas'],
  ['album', 'Álbuns'],
  ['playlist', 'Playlists'],
  ['artist', 'Artistas'],
  ['lyrics', 'Letras'],
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
    consent = useApp(
      s =>
        s.data.preferences.onlineConsent &&
        (!s.integrations?.catalogConfigured || s.data.preferences.catalogConsent),
    );
  const [kind, setKind] = useState<SearchKind>('all');
  const [source, setSource] = useState<SearchSource>('all');
  const [result, setResult] = useState<SearchResult>({ items: [], next: {}, notices: [] });
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
    active.current.forEach(id => void window.glass.cancelSearch(id));
    active.current = [];
    setLoading(false);
    if (!q || isLink || (source === 'local' && kind !== 'lyrics')) return;
    if (!consent) {
      setResult({ items: [], next: {}, notices: ['Ative o acesso online para buscar.'] });
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      const requestId = crypto.randomUUID();
      active.current = [requestId];
      try {
        const data = await window.glass.search({ query: q, kind, source, requestId });
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

  return (
    <div className="search-page">
      <div className="page-heading">
        <h1>Buscar</h1>
        {loading && <LoaderCircle size={16} className="spinner" aria-label="Buscando" />}
      </div>

      <div className="search-filters">
        <div className="pills" role="group" aria-label="Tipo de resultado">
          {KINDS.map(([id, label]) => (
            <button
              key={id}
              className={kind === id ? 'selected' : ''}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {kind !== 'lyrics' && (
          <div className="source-filters" role="group" aria-label="Plataforma">
            {SOURCES.map(([id, label]) => (
              <button
                key={id}
                className={source === id ? 'selected' : ''}
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
        <div className="search-empty">
          <SearchIcon size={20} />
          <p>Pesquise por música, álbum, artista, letra ou link.</p>
        </div>
      ) : isLink ? (
        <div className="notice">
          <Link2 size={16} />
          <span>Link direto detectado.</span>
          <button
            className="button primary"
            disabled={loading}
            onClick={() => void handleDirectLink(query)}
          >
            <Play size={14} fill="currentColor" /> Abrir
          </button>
        </div>
      ) : (
        <>
          {result.notices.map(n => (
            <div className="notice" key={n}>
              <AlertCircle size={15} />
              <span>{n}</span>
              {!consent && (
                <button
                  className="button secondary"
                  onClick={() => useApp.getState().setPage('settings')}
                >
                  Configurações
                </button>
              )}
            </div>
          ))}
          {collectionsOnly.length > 0 && (
            <section className="catalog-section" style={{ marginBottom: 20 }}>
              {tracksOnly.length > 0 && (
                <div className="section-heading">
                  <h2>Coleções e artistas</h2>
                </div>
              )}
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
              <SearchIcon size={20} />
              <h3>Sem resultados</h3>
            </div>
          )}
          {Object.keys(result.next).length > 0 && (
            <button
              className="button secondary load-more"
              disabled={loading}
              onClick={() => void more()}
            >
              {loading ? 'Buscando…' : 'Carregar mais'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
