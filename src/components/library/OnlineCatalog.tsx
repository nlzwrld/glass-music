import { useEffect, useMemo, useState } from 'react';
import { Cloud, LoaderCircle, Music2, RefreshCw } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import type { CatalogResult, Track } from '../../../shared/types';
import TrackCard from './TrackCard';
import { cachedDiscoveries, discoverMusic, cancelDiscoveries } from '../../lib/discovery';
import {
  buildTasteProfile,
  fetchPersonalizedTracks,
  rankCatalogByTaste,
} from '../../lib/recommendations';

export default function OnlineCatalog({ expanded = false }: { expanded?: boolean }) {
  const consent = useApp(
    s =>
      s.data.preferences.onlineConsent &&
      s.data.preferences.catalogConsent &&
      s.data.preferences.onboardingDone,
  );
  const configured = useApp(s => s.integrations?.catalogConfigured);
  const tracks = useApp(s => s.data.tracks);
  const history = useApp(s => s.data.history);
  const likes = useApp(s => s.data.likes);

  const taste = useMemo(
    () => buildTasteProfile({ tracks, history, likes }),
    [tracks, history, likes],
  );

  const [result, setResult] = useState<CatalogResult>(() =>
    consent
      ? cachedDiscoveries() || { sections: [], notices: [] }
      : { sections: [], notices: [] },
  );
  const [personalTracks, setPersonalTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!consent || !configured) {
      if (!consent) cancelDiscoveries();
      return;
    }
    let active = true;
    setLoading(true);
    const previous = cachedDiscoveries();
    if (previous) setResult(previous);
    void discoverMusic(retry > 0)
      .then(value => {
        if (active) setResult(value);
      })
      .catch(error => {
        if (active) setResult(old => ({ sections: old.sections, notices: [cleanError(error)] }));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [consent, configured, retry]);

  useEffect(() => {
    if (!consent || !taste.seeds.length) {
      setPersonalTracks([]);
      return;
    }
    let active = true;
    const excludeIds = history.slice(0, 15).map(h => h.id);
    void fetchPersonalizedTracks(taste, excludeIds, retry > 0).then(items => {
      if (active) setPersonalTracks(items);
    });
    return () => {
      active = false;
    };
  }, [consent, taste.signature, retry]);

  const rankedResult = useMemo(() => {
    const base = rankCatalogByTaste(result, taste);
    if (!personalTracks.length) return base;
    const subtitle = taste.topArtists.length
      ? `Recomendado para você · ${taste.topArtists.slice(0, 2).join(', ')}`
      : 'Recomendado para você';
    const personalSections: CatalogResult['sections'] = [
      {
        id: 'personal:recent-vibe',
        source: 'youtube',
        title: subtitle,
        items: personalTracks,
      },
    ];
    if (expanded && personalTracks.length > 6 && taste.topArtists[0]) {
      personalSections.push({
        id: 'personal:more-like-top',
        source: 'youtube',
        title: `Mais no estilo de ${taste.topArtists[0]}`,
        items: personalTracks.slice(6),
      });
    }
    return {
      ...base,
      sections: [...personalSections, ...base.sections],
    };
  }, [result, taste, personalTracks, expanded]);

  if (!consent)
    return (
      <section className="catalog-intro">
        <Music2 size={18} />
        <div>
          <strong>Acesso online desativado</strong>
        </div>
        <button
          className="button secondary"
          onClick={() => useApp.getState().setPage('settings')}
        >
          Configurações
        </button>
      </section>
    );

  if (!configured)
    return (
      <section className="catalog-intro" role="status">
        <Cloud size={18} />
        <div>
          <strong>Catálogo indisponível</strong>
        </div>
        <button
          className="button secondary"
          onClick={() => useApp.getState().setDialog({ type: 'link' })}
        >
          Adicionar link
        </button>
      </section>
    );

  return (
    <div className="online-catalog" aria-busy={loading}>
      {loading && !rankedResult.sections.length && (
        <div className="catalog-loading" role="status">
          <LoaderCircle size={16} className="spinner" />
          Carregando…
        </div>
      )}
      {rankedResult.sections.map(section => (
        <section className="catalog-section" key={section.id} aria-label={section.title}>
          <div className="section-heading">
            <h2>{section.title}</h2>
          </div>
          {section.items.length ? (
            <div className="catalog-grid">
              {section.items.slice(0, expanded ? 12 : 6).map(track => (
                <TrackCard key={track.id} track={track} list={section.items} />
              ))}
            </div>
          ) : (
            <p className="catalog-empty">Sem faixas.</p>
          )}
        </section>
      ))}
      {rankedResult.notices.length > 0 && (
        <div className="catalog-notices" role="status">
          {rankedResult.notices.map(n => (
            <p key={n}>{n}</p>
          ))}
          <button
            className="text-button"
            disabled={loading}
            onClick={() => setRetry(n => n + 1)}
          >
            <RefreshCw size={13} />
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}
