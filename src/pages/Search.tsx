import { useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, LoaderCircle, AlertCircle } from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import type { SearchKind, Source, Track, SearchResult } from '../../shared/types';
import TrackList from '../components/library/TrackList';

export default function Search() {
  const query = useApp(s => s.filter), local = useApp(s => s.data.tracks), consent = useApp(s => s.data.preferences.onlineConsent && (!s.integrations?.catalogConfigured || s.data.preferences.catalogConsent));
  const kind:SearchKind='all' as SearchKind, source:'all'|Source='all' as 'all'|Source; const [result,setResult] = useState<SearchResult>({ items: [], next: {}, notices: [] });
  const [loading,setLoading] = useState(false); const generation = useRef(0); const active = useRef<string[]>([]);
  useEffect(()=>{useApp.setState({searchBusy:loading});return()=>useApp.setState({searchBusy:false});},[loading]);
  const localMatches = source === 'all' || source === 'local' ? local.filter(t => t.source === 'local' && `${t.title} ${t.artist} ${t.album || ''}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))) : [];
  useEffect(() => {
    const gen = ++generation.current; const q = query.trim(); setResult({ items: [], next: {}, notices: [] });
    active.current.forEach(id => void window.glass.cancelSearch(id)); active.current=[]; setLoading(false);
    if (!q || source === 'local' || kind === 'album') return;
    if (!consent) { setResult({ items: [], next: {}, notices: ['Ative o acesso online para buscar.'] }); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      const requestId = crypto.randomUUID(); active.current = [requestId];
      try { const data = await window.glass.search({ query: q, kind, source, requestId }); if (generation.current === gen) setResult(data); }
      catch (e) { if (generation.current === gen) setResult({ items: [], next: {}, notices: [cleanError(e)] }); }
      finally { if (generation.current === gen) setLoading(false); }
    }, 550);
    return () => { clearTimeout(timer); generation.current++; active.current.forEach(id => void window.glass.cancelSearch(id)); };
  }, [query, kind, source, consent]);
  const more = async () => {
    const gen = generation.current; setLoading(true); const requestId = crypto.randomUUID(); active.current = Object.keys(result.next).map(provider => requestId + provider);
    try {
      const pages = await Promise.all(Object.keys(result.next).map(provider => window.glass.search({ query: query.trim(), kind, source: provider as Source, cursor: result.next, requestId: requestId + provider })));
      if (gen === generation.current) setResult(prev => ({ items: [...new Map([...prev.items, ...pages.flatMap(p => p.items)].map(t => [t.id,t])).values()], next: Object.assign({}, ...pages.map(p => p.next)), notices: pages.flatMap(p => p.notices) }));
    } catch (e) { useApp.getState().message(cleanError(e)); } finally { if (gen === generation.current) setLoading(false); }
  };
  const localFiltered = kind === 'all' || kind === 'track' ? localMatches : [];
  const items = [...new Map([...localFiltered, ...result.items].map(t=>[t.id,t])).values()];
  return <div className="search-page"><div className="page-heading"><h1>Buscar</h1>{loading && <LoaderCircle className="spinner" aria-label="Buscando" />}</div>

    {!query ? <div className="search-empty"><SearchIcon size={27}/></div> : <>
      {result.notices.map(n => <div className="notice" key={n}><AlertCircle size={17} /><span>{n}</span>{!consent && <button onClick={() => useApp.getState().setPage('settings')}>Ativar acesso online</button>}</div>)}
      {kind === 'album' ? <div><div className="notice"><AlertCircle size={18} /><span>Álbuns salvos na sua biblioteca.</span></div>{[...new Set(localMatches.map(t => t.album).filter(Boolean))].map(album => <section key={album}><div className="section-heading"><h2>{album}</h2></div><TrackList tracks={localMatches.filter(t => t.album === album)} /></section>)}</div> : <><div className="results-count">{loading ? 'Buscando…' : ''}</div>{items.length ? <TrackList tracks={items} /> : !loading && <div className="empty-state"><SearchIcon size={32} /><h3>Sem resultados</h3></div>}</>}
      {Object.keys(result.next).length > 0 && <button className="button secondary load-more" disabled={loading} onClick={() => void more()}>{loading ? 'Buscando…' : 'Carregar mais resultados'}</button>}
    </>}
  </div>;
}
