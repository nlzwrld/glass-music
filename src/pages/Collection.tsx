import { useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  Download,
  ExternalLink,
  LoaderCircle,
  Plus,
} from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import { inspectMusicLink } from '../lib/playlist';
import Cover from '../components/glass/Cover';
import TrackList from '../components/library/TrackList';
import { CollectionPlaybackActions } from '../components/library/CollectionPlaybackActions';
import { SourceBadge } from '../components/glass/controls';

export default function Collection() {
  const preview = useApp(s => s.preview),
    busy = useApp(s => s.previewBusy),
    current = useApp(s => s.queue[s.index]),
    queueContext = useApp(s => s.queueContext),
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
  const contextId = `collection:${preview.url || preview.name}`;
  const activeHere =
    !!current && queueContext === contextId && tracks.some(t => t.id === current.id);
  const isVerifiedArtist = inspectMusicLink(preview.url).kind === 'artist';

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <SourceBadge source="link" url={preview.url} />
            {isVerifiedArtist && (
              <span className="entity-badge entity-badge-artist">
                <BadgeCheck size={12} />
                Artista verificado
              </span>
            )}
          </div>
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
          <CollectionPlaybackActions
            tracks={tracks}
            activeHere={activeHere}
            playing={playing}
            contextId={contextId}
          />
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

      <TrackList tracks={tracks} contextId={contextId} showHeaderShuffle={false} />
    </div>
  );
}
