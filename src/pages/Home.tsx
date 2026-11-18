import { Plus, Sparkles, Play, FolderInput, ArrowRight } from 'lucide-react';
import { useApp } from '../stores/app';
import TrackCard from '../components/library/TrackCard';
import OnlineCatalog from '../components/library/OnlineCatalog';
import Cover from '../components/glass/Cover';
import { greeting } from '../components/glass/Welcome';
import '../styles/home.css';

export default function Home() {
  const data = useApp(s => s.data);
  const recent = [...new Set(data.history.map(h => h.id))]
    .map(id => data.tracks.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .slice(0, 6);

  const seed = recent[0] || data.tracks[0];
  const phrase = greeting(new Date().getHours());

  return (
    <div className="home-page">
      <header className="lg-page-hero">
        <div>
          <span className="lg-eyebrow">ATMOSFERA SONORA</span>
          <h1>{phrase}</h1>
          <p>Sua coleção pessoal, descobertas e rádio inteligente em Liquid Glass.</p>
        </div>
        <div className="lg-hero-actions">
          <button
            className="lg-pill-btn"
            onClick={() => void useApp.getState().importLocalFiles()}
          >
            <FolderInput size={16} />
            Arquivos
          </button>
          <button
            className="lg-pill-btn primary"
            aria-label="Adicionar link"
            onClick={() => useApp.getState().setDialog({ type: 'link' })}
          >
            <Plus size={16} />
            Adicionar link
          </button>
        </div>
      </header>

      {seed && (
        <section className="lg-spotlight-banner" aria-label="Mix do seu estilo">
          <div className="lg-spotlight-art">
            <Cover track={seed} />
          </div>
          <div className="lg-spotlight-body">
            <span className="lg-chip-badge">
              <Sparkles size={12} /> Mix contínuo do seu estilo
            </span>
            <h2>Baseado em {seed.title}</h2>
            <p>
              {seed.artist} • Quando sua fila acabar, o Glass continua tocando músicas novas que combinam com o que você ouve.
            </p>
            <div className="lg-spotlight-cta">
              <button
                className="lg-cta-white"
                onClick={() => void useApp.getState().startStyleRadio(seed)}
              >
                <Play size={16} fill="currentColor" />
                Iniciar mix agora
              </button>
              <button
                className="lg-pill-btn"
                onClick={() => useApp.getState().setPage('library')}
              >
                Abrir biblioteca <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section aria-labelledby="home-recent-title">
          <div className="section-heading">
            <h2 id="home-recent-title">Ouvidas recentemente</h2>
            <button
              className="text-button"
              onClick={() => useApp.getState().setPage('history')}
            >
              Ver histórico <ArrowRight size={14} />
            </button>
          </div>
          <div className="catalog-grid">
            {recent.map(track => (
              <TrackCard key={track.id} track={track} list={recent} />
            ))}
          </div>
        </section>
      )}

      <OnlineCatalog />

      {data.tracks.length > 0 && (
        <section aria-labelledby="home-library-title">
          <div className="section-heading">
            <h2 id="home-library-title">Sua biblioteca</h2>
            <button
              className="text-button"
              onClick={() => useApp.getState().setPage('library')}
            >
              Ver tudo <ArrowRight size={14} />
            </button>
          </div>
          <div className="catalog-grid">
            {data.tracks.slice(0, 6).map(track => (
              <TrackCard key={track.id} track={track} list={data.tracks} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
