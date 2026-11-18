import { useState } from 'react';
import { ArrowLeft, Download, ExternalLink, LoaderCircle, Pause, Play, Plus } from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import { transport } from '../components/player/engine';
import Cover from '../components/glass/Cover';
import TrackList from '../components/library/TrackList';
import { SourceBadge } from '../components/glass/controls';

export default function Collection() {
  const preview = useApp(s => s.preview),
    busy = useApp(s => s.previewBusy),
    current = useApp(s => s.queue[s.index]),
    playing = useApp(s => s.playing);
  const [saving, setSaving] = useState(false);

  if (busy && (!preview || !preview.tracks.length)) {
    return (
      <div className="loading-page" role="status">
        <LoaderCircle size={22} className="spinner" /> Carregando faixas da coleção…
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="empty-state">
        <h3>Nenhuma coleção selecionada</h3>
        <button className="button secondary" onClick={() => useApp.getState().navigate(-1)}>
          Voltar
        </button>
      </div>
    );
  }

  const tracks = preview.tracks;
  const activeHere = !!current && tracks.some(t => t.id === current.id);

  const importToLibrary = async () => {
    setSaving(true);
    try {
      const result = await window.glass.importLink(preview.url, true);
      useApp.setState({
        data: { ...result.snapshot, preferences: useApp.getState().data.preferences },
      });
      if (result.playlistId) {
        useApp.getState().setPage(`playlist:${result.playlistId}`);
        useApp
          .getState()
          .message(`${result.count || tracks.length} faixas salvas na sua biblioteca.`);
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="playlist-page">
      <div className="page-heading lg-playlist-hero">
        <div className="playlist-hero-art">
          <Cover
            track={{ title: preview.name, artwork: preview.artwork, source: 'link' }}
          />
        </div>
        <div>
          <SourceBadge source="link" url={preview.url} />
          <h1>{preview.name}</h1>
          <p>{tracks.length} faixas</p>
        </div>
        <div className="lg-hero-actions">
          <button
            className="lg-cta-white"
            disabled={saving || !tracks.length}
            onClick={() => void importToLibrary()}
          >
            <Plus size={16} />
            {saving ? 'Salvando…' : 'Salvar na biblioteca'}
          </button>
          {preview.url && (
            <button
              className="lg-pill-btn"
              onClick={() =>
                void window.glass
                  .external(preview.url)
                  .catch(e => useApp.getState().message(cleanError(e)))
              }
            >
              <ExternalLink size={15} />
              Abrir origem
            </button>
          )}
        </div>
      </div>

      {preview.warning && <div className="notice"><span>{preview.warning}</span></div>}

      <div className="library-toolbar">
        <div>
          <button
            className="playlist-play"
            disabled={!tracks.length}
            aria-label={activeHere && playing ? 'Pausar coleção' : 'Reproduzir coleção'}
            onClick={() => {
              if (activeHere) transport.toggle();
              else if (tracks[0]) useApp.getState().play(tracks[0], tracks);
            }}
          >
            {activeHere && playing ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
            <span>{activeHere && playing ? 'Pausar' : 'Reproduzir'}</span>
          </button>
          {tracks.some(t => ['youtube', 'link'].includes(t.source)) && (
            <button
              className="lg-pill-btn"
              onClick={() => void useApp.getState().downloadPlaylist(tracks)}
            >
              <Download size={15} />
              Baixar offline
            </button>
          )}
        </div>
        <button className="lg-pill-btn" onClick={() => useApp.getState().navigate(-1)}>
          <ArrowLeft size={15} />
          Voltar
        </button>
      </div>

      <TrackList tracks={tracks} />
    </div>
  );
}
