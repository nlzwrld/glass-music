import { useState } from 'react';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Shuffle,
} from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import { shufflePlay } from '../lib/playback';
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
        <LoaderCircle size={16} className="spinner" /> Carregando…
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
          .message(`${result.count || tracks.length} faixas salvas na biblioteca.`);
      }
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="playlist-page">
      <div className="page-heading collection-hero">
        <div className="playlist-hero-art">
          <Cover track={{ title: preview.name, artwork: preview.artwork, source: 'link' }} />
        </div>
        <div>
          <SourceBadge source="link" url={preview.url} />
          <h1>{preview.name}</h1>
          <p>{tracks.length} faixas</p>
        </div>
        <div className="heading-actions">
          <button
            className="button primary"
            disabled={saving || !tracks.length}
            onClick={() => void importToLibrary()}
          >
            <Plus size={15} />
            {saving ? 'Salvando…' : 'Salvar na biblioteca'}
          </button>
          {preview.url && (
            <button
              className="button secondary"
              onClick={() =>
                void window.glass
                  .external(preview.url)
                  .catch(e => useApp.getState().message(cleanError(e)))
              }
            >
              <ExternalLink size={14} />
              Abrir origem
            </button>
          )}
        </div>
      </div>

      {preview.warning && (
        <div className="notice">
          <span>{preview.warning}</span>
        </div>
      )}

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
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            <span>{activeHere && playing ? 'Pausar' : 'Reproduzir'}</span>
          </button>
          <button
            type="button"
            className="button secondary playlist-shuffle-play"
            disabled={!tracks.length}
            aria-label="Reproduzir coleção no aleatório"
            onClick={() => shufflePlay(tracks)}
          >
            <Shuffle size={15} />
            <span>Aleatório</span>
          </button>
          {tracks.some(t => ['youtube', 'link'].includes(t.source)) && (
            <button
              className="button secondary"
              onClick={() => void useApp.getState().downloadPlaylist(tracks)}
            >
              <Download size={14} />
              Baixar offline
            </button>
          )}
        </div>
        <button className="text-button" onClick={() => useApp.getState().navigate(-1)}>
          <ArrowLeft size={14} />
          Voltar
        </button>
      </div>

      <TrackList tracks={tracks} />
    </div>
  );
}
