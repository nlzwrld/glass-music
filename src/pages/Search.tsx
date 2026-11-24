import { useEffect, useRef, useState } from 'react';
import {
  Search as SearchIcon,
  LoaderCircle,
  AlertCircle,
  Link2,
  Play,
  UserRound,
} from 'lucide-react';
import { useApp, cleanError, looksLikeMusicLink, handleDirectLink } from '../stores/app';
import { resolveEffectiveBroker, useAccounts } from '../stores/accounts';
import type { SearchKind, SearchSource, SearchResult, UserSearchItem } from '../../shared/types';
import TrackList from '../components/library/TrackList';
import TrackCard from '../components/library/TrackCard';
import { rankSearchTracks } from '../lib/searchRanking';

const KINDS: [SearchKind, string][] = [
  ['all', 'Tudo'],
  ['track', 'Músicas'],
  ['album', 'Álbuns'],
  ['playlist', 'Playlists'],
  ['artist', 'Artistas'],
  ['user', 'Usuários'],
  ['lyrics', 'Letras'],
];

const SOURCES: [SearchSource, string][] = [
  ['all', 'Todas'],
  ['spotify', 'Spotify'],
  ['youtube', 'YouTube'],
  ['deezer', 'Deezer'],
  ['apple', 'Apple Music'],
  ['soundcloud', 'SoundCloud'],
  ['local', 'Local'],
];

export default function Search() {
  const query = useApp(s => s.filter),
    searchBusy = useApp(s => s.searchBusy),
    local = useApp(s => s.data.tracks),
    onlineConsent = useApp(s => s.data.preferences.onlineConsent),
    consent = useApp(
      s =>
        s.data.preferences.onlineConsent &&
        (!s.integrations?.catalogConfigured || s.data.preferences.catalogConsent),
    ),
    hub = useAccounts(s => s.hub),
    preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl);
  const initialSession = useRef(useApp.getState().searchSession);
  const [kind, setKind] = useState<SearchKind>(() => initialSession.current.kind);
  const [source, setSource] = useState<SearchSource>(() => initialSession.current.source);
  const [result, setResult] = useState<SearchResult>(() => initialSession.current.result);
  const [users, setUsers] = useState<UserSearchItem[]>(() => initialSession.current.users);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const active = useRef<string[]>([]);
  const brokerUrl = resolveEffectiveBroker(undefined, { preferredBrokerUrl, hub });
  const lastResolvedSig = useRef(
    initialSession.current.query &&
      (initialSession.current.result.items.length > 0 ||
        initialSession.current.users.length > 0 ||
        initialSession.current.result.notices.length > 0)
      ? `${initialSession.current.query}::${initialSession.current.kind}::${initialSession.current.source}::${consent ? '1' : '0'}::${onlineConsent ? '1' : '0'}`
      : '',
  );

  useEffect(() => {
    useApp.setState({ searchBusy: loading });
    return () => useApp.setState({ searchBusy: false });
  }, [loading]);

  useEffect(() => {
    useApp.getState().setSearchSession({ kind, source });
  }, [kind, source]);

  const isLink = looksLikeMusicLink(query);
  const localMatches =
    kind !== 'lyrics' && kind !== 'user' && (source === 'all' || source === 'local')
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
    const sig = `${q}::${kind}::${source}::${consent ? '1' : '0'}::${onlineConsent ? '1' : '0'}`;
    active.current.forEach(id => void window.glass.cancelSearch(id));
    active.current = [];
    if (!q || isLink) {
      lastResolvedSig.current = '';
      const emptyResult: SearchResult = { items: [], next: {}, notices: [] };
      setResult(emptyResult);
      setUsers([]);
      setLoading(false);
      useApp.getState().setSearchSession({ query: q, result: emptyResult, users: [] });
      return;
    }
    if (lastResolvedSig.current === sig) {
      setLoading(false);
      return;
    }
    if (kind === 'user') {
      setResult({ items: [], next: {}, notices: [] });
      if (!onlineConsent) {
        const noticeRes: SearchResult = {
          items: [],
          next: {},
          notices: ['Ative o acesso online para buscar usuários.'],
        };
        setResult(noticeRes);
        setUsers([]);
        setLoading(false);
        useApp.getState().setSearchSession({ query: q, result: noticeRes, users: [] });
        return;
      }
      if (!window.glass?.hubSearchUsers) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const timer = setTimeout(async () => {
        try {
          const res = await window.glass.hubSearchUsers({
            brokerUrl,
            query: q,
            limit: 24,
          });
          if (generation.current === gen) {
            const nextUsers = Array.isArray(res?.users) ? res.users : [];
            lastResolvedSig.current = sig;
            setUsers(nextUsers);
            useApp.getState().setSearchSession({
              query: q,
              kind,
              source,
              result: { items: [], next: {}, notices: [] },
              users: nextUsers,
            });
          }
        } catch (e) {
          if (generation.current === gen) {
            const errRes: SearchResult = { items: [], next: {}, notices: [cleanError(e)] };
            setResult(errRes);
            useApp.getState().setSearchSession({ query: q, result: errRes });
          }
        } finally {
          if (generation.current === gen) setLoading(false);
        }
      }, 300);
      return () => {
        clearTimeout(timer);
        generation.current++;
      };
    }

    if (source === 'local' && kind !== 'lyrics') {
      lastResolvedSig.current = sig;
      const localRes: SearchResult = { items: [], next: {}, notices: [] };
      setResult(localRes);
      setUsers([]);
      setLoading(false);
      useApp.getState().setSearchSession({ query: q, kind, source, result: localRes, users: [] });
      return;
    }
    if (!consent) {
      const consentRes: SearchResult = {
        items: [],
        next: {},
        notices: ['Ative o acesso online para buscar.'],
      };
      lastResolvedSig.current = sig;
      setResult(consentRes);
      setUsers([]);
      setLoading(false);
      useApp.getState().setSearchSession({ query: q, kind, source, result: consentRes, users: [] });
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      const requestId = crypto.randomUUID();
      active.current = [requestId];
      if (kind === 'all' && source === 'all' && window.glass?.hubSearchUsers) {
        void window.glass
          .hubSearchUsers({ brokerUrl, query: q, limit: 8 })
          .then(userData => {
            if (generation.current === gen) {
              const nextUsers = Array.isArray(userData?.users) ? userData.users : [];
              setUsers(nextUsers);
              useApp.getState().setSearchSession({ users: nextUsers });
            }
          })
          .catch(() => {
            if (generation.current === gen) {
              setUsers([]);
              useApp.getState().setSearchSession({ users: [] });
            }
          });
      } else {
        setUsers([]);
        useApp.getState().setSearchSession({ users: [] });
      }
      try {
        const data = await window.glass.search({ query: q, kind, source, requestId });
        if (generation.current === gen) {
          lastResolvedSig.current = sig;
          setResult(data);
          useApp.getState().setSearchSession({ query: q, kind, source, result: data });
        }
      } catch (e) {
        if (generation.current === gen) {
          const errRes: SearchResult = { items: [], next: {}, notices: [cleanError(e)] };
          setResult(errRes);
          useApp.getState().setSearchSession({ query: q, kind, source, result: errRes });
        }
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    }, 340);
    return () => {
      clearTimeout(timer);
      generation.current++;
      active.current.forEach(id => void window.glass.cancelSearch(id));
    };
  }, [query, isLink, kind, source, consent, onlineConsent, brokerUrl]);

  const more = async () => {
    const gen = generation.current;
    setLoading(true);
    const requestId = crypto.randomUUID();
    const providers = Object.keys(result.next);
    active.current = providers.map(provider => requestId + provider);
    try {
      const settled = await Promise.allSettled(
        providers.map(provider =>
          window.glass.search({
            query: query.trim(),
            kind,
            source: provider as SearchSource,
            cursor: result.next,
            requestId: requestId + provider,
          }),
        ),
      );
      if (gen === generation.current) {
        const pages = settled
          .filter((r): r is PromiseFulfilledResult<SearchResult> => r.status === 'fulfilled')
          .map(r => r.value);
        const failures = settled
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map(r => cleanError(r.reason));
        if (pages.length > 0) {
          setResult(prev => {
            const merged: SearchResult = {
              items: [
                ...new Map(
                  [...prev.items, ...pages.flatMap(p => p.items)].map(t => [t.id, t]),
                ).values(),
              ],
              next: Object.assign({}, ...pages.map(p => p.next)),
              notices: [...new Set([...pages.flatMap(p => p.notices), ...failures])],
            };
            useApp.getState().setSearchSession({ result: merged });
            return merged;
          });
        } else if (failures.length > 0) {
          useApp.getState().message(failures[0]!);
        }
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  };

  const localFiltered = kind === 'all' || kind === 'track' ? localMatches : [];
  const rawCombined = [
    ...new Map([...localFiltered, ...result.items].map(t => [t.id, t])).values(),
  ];
  const combined = query.trim() ? rankSearchTracks(rawCombined, query, kind) : rawCombined;
  const tracksOnly = combined.filter(t => t.kind === 'track');
  const collectionsOnly = combined.filter(t => t.kind !== 'track');
  const hasSpotifyResults = combined.some(t => t.catalogSource === 'spotify');

  return (
    <div className={`search-page ${loading ? 'is-updating' : ''}`}>
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
        {kind !== 'lyrics' && kind !== 'user' && (
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
          <p>Pesquise por música, álbum, artista, usuário, letra ou link.</p>
        </div>
      ) : isLink ? (
        <div className="notice">
          <Link2 size={16} />
          <span>Link direto detectado.</span>
          <button
            className="button primary"
            disabled={loading || searchBusy}
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
              {(!consent || n.includes('Configurações')) && (
                <button
                  className="button secondary"
                  onClick={() => {
                    useApp.getState().setSettingsTab('privacy');
                    useApp.getState().setPage('settings');
                  }}
                >
                  Configurações
                </button>
              )}
            </div>
          ))}
          {hasSpotifyResults && (
            <div className="notice spotify-provenance-banner" role="note">
              <span>
                Metadados via Spotify Web API · A reprodução utiliza as fontes de áudio integradas do Liquid Hub.
              </span>
            </div>
          )}
          {users.length > 0 && (kind === 'user' || kind === 'all') && (
            <section className="catalog-section" style={{ marginBottom: 20 }} aria-label="Usuários do Liquid Hub">
              {kind === 'all' && (
                <div className="section-heading">
                  <h2>Usuários do Liquid Hub</h2>
                </div>
              )}
              <div className="user-search-grid">
                {users.map(u => (
                  <button
                    key={u.handle}
                    type="button"
                    className="user-search-card"
                    onClick={() => useApp.getState().setPage(`profile:${u.handle}`)}
                  >
                    <div className="user-search-avatar" aria-hidden="true">
                      {u.avatarUrl ? (
                        <img src={u.avatarUrl} alt="" />
                      ) : (
                        <span>{(u.displayName || u.handle).charAt(0).toUpperCase()}</span>
                      )}
                    </div>
                    <div className="user-search-meta">
                      <div className="user-search-title-row">
                        <strong>{u.displayName}</strong>
                        <span className="entity-badge entity-badge-user">
                          <UserRound size={10} />
                          Perfil
                        </span>
                      </div>
                      <small>
                        @{u.handle} · {u.publicPlaylistCount} playlist(s) pública(s)
                      </small>
                      {u.bio && <p className="user-search-bio">{u.bio}</p>}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {collectionsOnly.length > 0 && (
            <section className="catalog-section" style={{ marginBottom: 20 }}>
              {(tracksOnly.length > 0 || users.length > 0) && (
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
          {tracksOnly.length > 0 && <TrackList tracks={tracksOnly} contextId="search" />}
          {!combined.length && !users.length && !loading && (
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
