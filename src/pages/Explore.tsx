import { Compass } from 'lucide-react';
import OnlineCatalog from '../components/library/OnlineCatalog';

export default function Explore() {
  return (
    <div className="explore-page">
      <header className="lg-section-hero">
        <div className="lg-hero-badge">
          <Compass size={24} />
        </div>
        <div>
          <h1>Explorar</h1>
          <p>Descobertas, lançamentos e faixas em alta no YouTube, Deezer e SoundCloud</p>
        </div>
      </header>
      <OnlineCatalog expanded />
    </div>
  );
}
