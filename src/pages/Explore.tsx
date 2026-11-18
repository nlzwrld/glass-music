import OnlineCatalog from '../components/library/OnlineCatalog';

export default function Explore() {
  return (
    <div className="explore-page">
      <div className="page-heading">
        <h1>Explorar</h1>
      </div>
      <OnlineCatalog expanded />
    </div>
  );
}
