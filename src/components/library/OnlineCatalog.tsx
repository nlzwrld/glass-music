import { useEffect, useState } from 'react';
import { Cloud, LoaderCircle, Music2, RefreshCw } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import type { CatalogResult } from '../../../shared/types';
import TrackCard from './TrackCard';
import {cachedDiscoveries,discoverMusic,cancelDiscoveries} from '../../lib/discovery';

export default function OnlineCatalog({ expanded = false }: { expanded?: boolean }) {
  const consent = useApp(s => s.data.preferences.onlineConsent && s.data.preferences.catalogConsent && s.data.preferences.onboardingDone);
  const configured = useApp(s => s.integrations?.catalogConfigured);
  const [result, setResult] = useState<CatalogResult>(()=>consent?cachedDiscoveries()||{ sections: [], notices: [] }:{sections:[],notices:[]});
  const [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!consent || !configured) {if(!consent)cancelDiscoveries();return;}
    let active = true;setLoading(true);const previous=cachedDiscoveries();if(previous)setResult(previous);
    void discoverMusic(retry>0).then(value => { if (active) setResult(value); }).catch(error => {
      if (active) setResult(old=>({ sections:old.sections, notices: [cleanError(error)] }));
    }).finally(() => { if (active) setLoading(false); });
    // Navigation does not discard an in-flight public discovery request.
    return () => { active = false; };
  }, [consent, configured, retry]);
  if (!consent) return <section className="catalog-intro"><Music2 size={24} /><div><strong>Acesso online desativado</strong></div><button className="button secondary" onClick={() => useApp.getState().setPage('settings')}>Ativar acesso online</button></section>;
  if (!configured) return <section className="catalog-intro" role="status"><Cloud size={24} /><div><strong>Componente de busca indisponível</strong></div><button className="button secondary" onClick={() => useApp.getState().setDialog({ type: 'link' })}>Abrir link</button></section>;
  return <div className="online-catalog" aria-busy={loading}>
    {loading && <div className="catalog-loading" role="status"><LoaderCircle size={19} className="spinner" />Buscando músicas…</div>}
    {loading&&!result.sections.length&&<div className="catalog-grid skeleton-grid" aria-label="Carregando capas">{Array.from({length:6},(_,i)=><div className="skeleton-card" key={i}><div/><span/><small/></div>)}</div>}
    {result.sections.map(section => <section className="catalog-section" key={section.id} aria-label={section.title}><div className="section-heading"><h2>{section.title}</h2></div>{section.items.length ? <div className="catalog-grid">{section.items.slice(0, expanded ? 10 : 5).map(track => <TrackCard key={track.id} track={track} list={section.items} />)}</div> : <p className="catalog-empty">Nenhuma faixa disponível nesta seleção agora.</p>}</section>)}
    {result.notices.length > 0 && <div className="catalog-notices" role="status">{result.notices.map(n => <p key={n}>{n}</p>)}<button className="text-button" disabled={loading} onClick={() => setRetry(n => n + 1)}><RefreshCw size={14} />Tentar novamente</button></div>}
  </div>;
}
