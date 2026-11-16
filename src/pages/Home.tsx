import { Plus } from 'lucide-react';
import { useApp } from '../stores/app';
import TrackCard from '../components/library/TrackCard';
import OnlineCatalog from '../components/library/OnlineCatalog';
import '../styles/home.css';

export default function Home() {
  const data = useApp(s => s.data);
  const recent = [...new Set(data.history.map(h => h.id))]
    .map(id => data.tracks.find(t => t.id === id))
    .filter(t => !!t)
    .slice(0, 6);

  return <div className="home-page">
    <header className="page-heading home-heading">
      <h1>Início</h1>
      <button className="icon-button home-add-link" aria-label="Adicionar link" title="Adicionar link" onClick={() => useApp.getState().setDialog({ type: 'link' })}>
        <Plus size={20} />
      </button>
    </header>
    {recent.length > 0 && <section aria-labelledby="home-recent-title">
      <div className="section-heading"><h2 id="home-recent-title">Recentes</h2></div>
      <div className="catalog-grid">{recent.map(track => <TrackCard key={track.id} track={track} list={recent} />)}</div>
    </section>}
    <OnlineCatalog />
    {data.tracks.length > 0 && <section aria-labelledby="home-library-title">
      <div className="section-heading">
        <h2 id="home-library-title">Sua biblioteca</h2>
        <button className="text-button" onClick={() => useApp.getState().setPage('library')}>Ver tudo</button>
      </div>
      <div className="catalog-grid">{data.tracks.slice(0, 6).map(track => <TrackCard key={track.id} track={track} list={data.tracks} />)}</div>
    </section>}
  </div>;
}
