import type { RefObject } from 'react';
import { ArrowLeft, ArrowRight, Search, X, LoaderCircle } from 'lucide-react';
import { useApp, looksLikeMusicLink, handleDirectLink } from '../../stores/app';
import { GlassMaterial } from './materials';

export default function GlassSearch({
  inputRef,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const filter = useApp(s => s.filter),
    index = useApp(s => s.navigationIndex),
    count = useApp(s => s.navigation.length),
    busy = useApp(s => s.searchBusy);
  return (
    <header className="topbar">
      <div className="navigation-controls">
        <button
          aria-label="Voltar"
          disabled={index === 0}
          onClick={() => useApp.getState().navigate(-1)}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          aria-label="Avançar"
          disabled={index >= count - 1}
          onClick={() => useApp.getState().navigate(1)}
        >
          <ArrowRight size={16} />
        </button>
      </div>
      <GlassMaterial as="label" variant="thin" material="clear" className="global-search">
        {busy ? (
          <LoaderCircle size={15} className="spinner" aria-label="Buscando" />
        ) : (
          <Search size={15} />
        )}
        <input
          ref={inputRef}
          aria-label="Buscar músicas, artistas e playlists"
          placeholder="Buscar ou colar link"
          value={filter}
          onChange={e => {
            if (useApp.getState().page !== 'search') useApp.getState().setPage('search');
            useApp.setState({ filter: e.target.value });
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && looksLikeMusicLink(filter)) {
              e.preventDefault();
              void handleDirectLink(filter);
            }
          }}
        />
        {!filter && <kbd>Ctrl K</kbd>}
        {filter && (
          <button
            aria-label="Limpar pesquisa"
            onClick={() => useApp.setState({ filter: '' })}
          >
            <X size={14} />
          </button>
        )}
      </GlassMaterial>
    </header>
  );
}
