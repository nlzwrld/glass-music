import { useEffect, useMemo, useState } from 'react';
import {
  HardDrive,
  HardDriveDownload,
  Pause,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useApp, formatTime } from '../stores/app';
import { transport } from '../components/player/engine';
import type { OfflineSummary, OfflineTrackInfo } from '../../shared/types';
import Cover from '../components/glass/Cover';
import { IconButton, OfflineIndicator, SourceBadge } from '../components/glass/controls';
import { CollectionPlaybackActions } from '../components/library/CollectionPlaybackActions';

type SourceFilter = 'all' | 'youtube' | 'link';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function Downloads() {
  const allTracks = useApp(s => s.data.tracks);
  const integrations = useApp(s => s.integrations);
  const downloadItems = useApp(s => s.downloadItems);
  const downloadingIds = useApp(s => s.downloadingIds);
  const downloadsPaused = useApp(s => s.downloadsPaused);
  const current = useApp(s => s.queue[s.index]);
  const queueContext = useApp(s => s.queueContext);
  const playing = useApp(s => s.playing);

  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [summary, setSummary] = useState<OfflineSummary | null>(null);
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  const offlineTracks = useMemo(() => allTracks.filter(t => t.offline), [allTracks]);

  const inProgressItems = useMemo(
    () =>
      Object.values(downloadItems)
        .filter(item => ['queued', 'downloading', 'paused', 'failed'].includes(item.status))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [downloadItems],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (typeof window === 'undefined' || typeof window.glass?.offlineSummary !== 'function') {
      return;
    }
    void window.glass
      .offlineSummary()
      .then(data => {
        if (active && data) setSummary(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [offlineTracks.length, inProgressItems.length]);

  const sizeMap = useMemo(() => {
    const map = new Map<string, OfflineTrackInfo>();
    if (summary?.tracks) {
      for (const entry of summary.tracks) map.set(entry.trackId, entry);
    }
    return map;
  }, [summary]);

  const filteredOffline = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    return offlineTracks.filter(t => {
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (!q) return true;
      return `${t.title} ${t.artist} ${t.album || ''}`.toLocaleLowerCase('pt-BR').includes(q);
    });
  }, [offlineTracks, sourceFilter, query]);

  const totalBytes = summary?.totalBytes ?? integrations?.offlineBytes ?? 0;
  const totalCount = summary?.totalTracks ?? offlineTracks.length;
  const activeHere =
    !!current && queueContext === 'downloads' && filteredOffline.some(t => t.id === current.id);
  const canPauseAny = inProgressItems.some(i => i.status === 'downloading' || i.status === 'queued');
  const canResumeAny = inProgressItems.some(i => i.status === 'paused' || i.status === 'failed');
  const failedItems = useMemo(
    () => inProgressItems.filter(i => i.status === 'failed'),
    [inProgressItems],
  );

  return (
    <div className="downloads-page">
      <div className="page-heading downloads-heading">
        <div className="heading-title-group">
          <h1>Downloads</h1>
          <span className="heading-count">
            {totalCount} {totalCount === 1 ? 'faixa offline' : 'faixas offline'} ·{' '}
            {formatBytes(totalBytes)}
          </span>
        </div>
        <div
          className={`downloads-status-pill ${online ? 'is-online' : 'is-offline'}`}
          role="status"
          aria-label={online ? 'Conectado à internet' : 'Modo offline ativo'}
        >
          {online ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span>{online ? 'Online · Reprodução offline pronta' : 'Sem internet · Tocando cache local'}</span>
        </div>
      </div>

      <section className="downloads-summary-card" aria-label="Armazenamento offline">
        <div className="downloads-summary-info">
          <HardDrive size={18} />
          <div>
            <strong>Armazenamento local</strong>
            <small>
              {totalCount} música(s) salva(s) neste dispositivo ocupando {formatBytes(totalBytes)}.
              Excluir arquivos locais não remove as faixas da sua biblioteca.
            </small>
          </div>
        </div>
        {offlineTracks.length > 0 && (
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              useApp.getState().setDialog({
                type: 'confirm',
                title: 'Remover todos os arquivos offline?',
                text: 'Os arquivos baixados serão apagados do disco para liberar espaço, mas todas as músicas e playlists continuarão na sua biblioteca.',
                action: () => useApp.getState().clearAllOffline(),
              })
            }
          >
            <Trash2 size={14} />
            Limpar arquivos locais
          </button>
        )}
      </section>

      {inProgressItems.length > 0 && (
        <section className="downloads-queue-section" aria-label="Downloads em andamento">
          <div className="section-heading">
            <h2>Em andamento ({inProgressItems.length})</h2>
            <div className="downloads-queue-bulk">
              {failedItems.length > 0 && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    void Promise.all(
                      failedItems.map(item => useApp.getState().cancelDownload(item.track.id)),
                    )
                  }
                >
                  <X size={13} />
                  Limpar falhas ({failedItems.length})
                </button>
              )}
              {canPauseAny && !downloadsPaused && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void useApp.getState().pauseAllDownloads()}
                >
                  <Pause size={13} />
                  Pausar fila
                </button>
              )}
              {(canResumeAny || downloadsPaused) && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void useApp.getState().resumeAllDownloads()}
                >
                  <Play size={13} fill="currentColor" />
                  Retomar fila
                </button>
              )}
            </div>
          </div>

          <div className="downloads-queue-list">
            {inProgressItems.map(item => {
              const statusLabel =
                item.status === 'downloading'
                  ? `Baixando · ${Math.round(item.percent)}%`
                  : item.status === 'queued'
                    ? 'Na fila'
                    : item.status === 'paused'
                      ? 'Pausado'
                      : item.error || 'Falha no download';
              return (
                <div className="download-queue-row" key={item.track.id}>
                  <div className="download-queue-cover">
                    <Cover track={item.track} />
                  </div>
                  <div className="download-queue-meta">
                    <strong>{item.track.title}</strong>
                    <small>
                      {item.track.artist} · {statusLabel}
                      {item.totalBytes > 0
                        ? ` (${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)})`
                        : ''}
                    </small>
                    <div className="download-progress-track" aria-hidden="true">
                      <div
                        className={`download-progress-fill is-${item.status}`}
                        style={{ width: `${Math.max(4, Math.min(100, item.percent))}%` }}
                      />
                    </div>
                  </div>
                  <div className="download-queue-actions">
                    {(item.status === 'downloading' || item.status === 'queued') && (
                      <IconButton
                        label={`Pausar download de ${item.track.title}`}
                        onClick={() => void useApp.getState().pauseDownload(item.track.id)}
                      >
                        <Pause size={14} />
                      </IconButton>
                    )}
                    {(item.status === 'paused' || item.status === 'failed') && (
                      <IconButton
                        label={
                          item.status === 'failed'
                            ? `Tentar novamente download de ${item.track.title}`
                            : `Retomar download de ${item.track.title}`
                        }
                        onClick={() => void useApp.getState().resumeDownload(item.track.id)}
                      >
                        {item.status === 'failed' ? (
                          <RotateCcw size={14} />
                        ) : (
                          <Play size={14} fill="currentColor" />
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      label={`Cancelar download de ${item.track.title}`}
                      onClick={() => void useApp.getState().cancelDownload(item.track.id)}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="library-toolbar">
        <div>
          <CollectionPlaybackActions
            tracks={filteredOffline}
            activeHere={activeHere}
            playing={playing}
            contextId="downloads"
          />
          <div className="pills" role="group" aria-label="Filtrar downloads por origem">
            {(
              [
                ['all', 'Todas'],
                ['youtube', 'YouTube'],
                ['link', 'Links'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={sourceFilter === id ? 'selected' : ''}
                aria-pressed={sourceFilter === id}
                onClick={() => setSourceFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="library-search">
          <Search size={14} />
          <input
            aria-label="Filtrar downloads"
            placeholder="Filtrar downloads"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </label>
      </div>

      {filteredOffline.length === 0 ? (
        <div className="empty-state">
          <HardDriveDownload size={22} />
          <h3>
            {offlineTracks.length === 0
              ? 'Nenhum download offline ainda'
              : 'Nenhum resultado encontrado'}
          </h3>
          <p>
            {offlineTracks.length === 0
              ? 'Use "Baixar para ouvir offline" no menu de qualquer faixa ou playlist.'
              : 'Tente outro termo de busca ou filtro.'}
          </p>
        </div>
      ) : (
        <div className="downloads-list" role="list" aria-label="Músicas disponíveis offline">
          {filteredOffline.map(track => {
            const info = sizeMap.get(track.id);
            const active = current?.id === track.id;
            const isPlayingHere = active && playing;
            const rowBusy = downloadingIds.includes(track.id);
            return (
              <div
                key={track.id}
                role="listitem"
                className={`download-row ${active ? 'current' : ''}`}
              >
                <button
                  type="button"
                  className="track-identity"
                  aria-label={`${isPlayingHere ? 'Pausar' : 'Reproduzir'} offline ${track.title}`}
                  onClick={() => {
                    const live = useApp.getState();
                    const liveActive = live.queue[live.index]?.id === track.id;
                    if (liveActive && live.queueContext === 'downloads') {
                      transport.toggle();
                    } else {
                      live.play(track, filteredOffline, { contextId: 'downloads' });
                    }
                  }}
                >
                  <div className="row-cover">
                    <Cover track={track} />
                    <span>
                      {isPlayingHere ? (
                        <Pause size={14} fill="currentColor" />
                      ) : (
                        <Play size={14} fill="currentColor" />
                      )}
                    </span>
                  </div>
                  <span className="track-text">
                    <strong>{track.title}</strong>
                    <small className="track-subline">
                      <OfflineIndicator offline />
                      <span>{track.artist}</span>
                    </small>
                  </span>
                </button>

                <div className="download-row-meta">
                  <SourceBadge
                    source={track.source}
                    url={track.url}
                    catalogSource={track.catalogSource}
                    streamProvider={track.streamProvider}
                    compact
                  />
                  {info && info.size > 0 && (
                    <span className="download-row-size">{formatBytes(info.size)}</span>
                  )}
                  <time>{track.duration ? formatTime(track.duration) : '—'}</time>
                </div>

                <button
                  type="button"
                  className="button secondary"
                  disabled={rowBusy}
                  aria-label={`Remover arquivo local de ${track.title}`}
                  title="Remove o arquivo do disco sem apagar da biblioteca"
                  onClick={() => void useApp.getState().removeOfflineFile(track.id)}
                >
                  <Trash2 size={14} />
                  Remover arquivo
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
