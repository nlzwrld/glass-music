import { Play } from 'lucide-react';
import { useApp } from '../stores/app';
import TrackCard from '../components/library/TrackCard';
import OnlineCatalog from '../components/library/OnlineCatalog';
import Cover from '../components/glass/Cover';
import { warmTrack, cancelWarmTrack } from '../lib/playback';

export default function Home() {
  const data = useApp(s => s.data);
  const recent = [...new Set(data.history.map(h => h.id))]
    .map(id => data.tracks.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .slice(0, 6);

  return (
    <div className="home-page">
      <header className="page-heading">
        <h1>Início</h1>
      </header>

      {recent.length > 0 && (
        <section aria-label="Tocadas recentemente">
          <div className="quick-grid">
            {recent.map(track => (
              <button
                key={track.id}
                className="quick-tile"
                onPointerEnter={() => warmTrack(track)}
                onPointerLeave={cancelWarmTrack}
                onClick={() =>
                  useApp.getState().play(track, recent, { contextId: 'home:recent' })
                }
              >
                <span className="quick-tile-art">
                  <Cover track={track} />
                </span>
                <span className="quick-tile-text">
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </span>
                <span className="quick-tile-play" aria-hidden="true">
                  <Play size={14} fill="currentColor" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <OnlineCatalog />

      {data.tracks.length > 0 && (
        <section aria-labelledby="home-library-title">
          <div className="section-heading">
            <h2 id="home-library-title">Biblioteca</h2>
            <button
              className="text-button"
              onClick={() => useApp.getState().setPage('library')}
            >
              Ver tudo
            </button>
          </div>
          <div className="catalog-grid">
            {data.tracks.slice(0, 6).map(track => (
              <TrackCard
                key={track.id}
                track={track}
                list={data.tracks}
                contextId="home:library"
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
