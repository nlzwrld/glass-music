import { useMemo } from 'react';
import {
  Home,
  Compass,
  Search,
  Library,
  Heart,
  Download,
  Play,
  Plus,
  ListPlus,
  Link2,
  FolderInput,
  Radio,
} from 'lucide-react';
import { motion } from 'motion/react';
import { MOTION_DURATION, motionTransition } from '../../lib/motion';
import { useApp, type Page } from '../../stores/app';
import { useJam } from '../jam/state';
import { openJamWindow } from '../../lib/jamWindow';
import { IconButton } from '../glass/controls';
import { GlassContextMenu, GlassSidebar } from '../glass/materials';
import { useOptics } from '../glass/v3/OpticalEngine';
import Cover from '../glass/Cover';
import PlaylistCover from '../library/PlaylistCover';
import { warmTrack, cancelWarmTrack } from '../../lib/playback';

const nav = [
  ['home', 'Início', Home],
  ['explore', 'Explorar', Compass],
  ['search', 'Buscar', Search],
  ['library', 'Biblioteca', Library],
  ['likes', 'Curtidas', Heart],
  ['downloads', 'Downloads', Download],
] as const;

export default function Sidebar() {
  const page = useApp(s => s.page),
    data = useApp(s => s.data),
    setPage = useApp(s => s.setPage),
    activeDownloadsCount = useApp(
      s =>
        Object.values(s.downloadItems).filter(
          item => item.status === 'downloading' || item.status === 'queued',
        ).length || s.downloadingIds.length,
    ),
    jamSession = useJam(s => s.session),
    jamConnected = useJam(s => s.connected),
    jamMembersCount = useJam(s => s.room?.members.length ?? (s.session ? 1 : 0)),
    { reduced } = useOptics();
  const isGlass = (data.preferences.uiStyle ?? 'matte') === 'glass';

  const recent = useMemo(() => {
    if (!data.history.length || !data.tracks.length) return [];
    const trackMap = new Map(data.tracks.map(track => [track.id, track]));
    const seen = new Set<string>();
    const out: typeof data.tracks = [];
    for (const entry of data.history) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const found = trackMap.get(entry.id);
      if (found) {
        out.push(found);
        if (out.length >= 20) break;
      }
    }
    return out;
  }, [data.history, data.tracks]);

  return (
    <GlassSidebar aria-label="Barra lateral">
      <nav aria-label="Navegação principal">
        {nav.map(([id, label, Icon]) => (
          <button
            key={id}
            aria-label={label}
            title={label}
            aria-current={page === id ? 'page' : undefined}
            className={`nav-item ${page === id ? 'selected' : ''}`}
            onClick={() => setPage(id as Page)}
          >
            {isGlass && page === id && (
              <motion.span
                className="nav-capsule"
                layoutId="navigation-capsule"
                transition={{
                  type: 'tween',
                  ...motionTransition(reduced, MOTION_DURATION.panel),
                }}
              />
            )}
            <Icon size={16} />
            <span>{label}</span>
            {id === 'downloads' && activeDownloadsCount > 0 && (
              <span className="nav-item-badge" aria-label={`${activeDownloadsCount} download(s) ativo(s)`}>
                {activeDownloadsCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {jamSession && (
        <button
          type="button"
          className={`jam-live-pill ${jamConnected ? 'connected' : 'reconnecting'}`}
          aria-label={`JAM ao vivo com ${jamMembersCount} ouvinte(s)`}
          title={`Sala ${jamSession.code} · ${jamMembersCount} ouvinte(s)`}
          onClick={() => {
            void openJamWindow();
          }}
        >
          <span className="jam-pulse-dot" aria-hidden="true" />
          <Radio size={14} />
          <span className="jam-live-text">JAM ao vivo</span>
          <span className="jam-live-count">{jamMembersCount}</span>
        </button>
      )}

      <div className="playlist-heading recent-heading">
        <span>Playlists</span>
        <GlassContextMenu
          label="Criar ou importar"
          icon={<Plus size={15} />}
          className="sidebar-add-btn"
          align="start"
          items={[
            {
              label: 'Nova playlist',
              icon: <ListPlus size={15} />,
              action: () => useApp.getState().setDialog({ type: 'playlist' }),
            },
            {
              label: jamSession ? 'Abrir janela da JAM' : 'Nova JAM',
              icon: <Radio size={15} />,
              action: () => {
                if (jamSession) {
                  void openJamWindow();
                } else {
                  useApp.getState().setDialog({ type: 'jam' });
                }
              },
            },
            {
              label: 'Importar por link',
              icon: <Link2 size={15} />,
              action: () => useApp.getState().setDialog({ type: 'link' }),
            },
            {
              label: 'Arquivos locais',
              icon: <FolderInput size={15} />,
              action: () => {
                void useApp.getState().importLocalFiles();
              },
            },
          ]}
        />
      </div>

      <div
        className="sidebar-playlists sidebar-recents"
        aria-label={data.playlists.length > 0 ? 'Playlists' : 'Músicas recentes'}
      >
        {data.playlists.length > 0 ? (
          data.playlists.map(pl => {
            const target = `playlist:${pl.id}` as Page;
            const active = page === target;
            return (
              <button
                key={pl.id}
                className={`recent-track ${active ? 'selected' : ''}`}
                title={pl.name}
                aria-current={active ? 'page' : undefined}
                onClick={() => setPage(target)}
              >
                <span className="recent-art">
                  <PlaylistCover playlist={pl} />
                </span>
                <span className="recent-caption">
                  <strong>{pl.name}</strong>
                  <small>{pl.trackIds.length} faixas</small>
                </span>
              </button>
            );
          })
        ) : recent.length > 0 ? (
          recent.map(track => (
            <button
              key={track.id}
              className="recent-track"
              title={`${track.title} · ${track.artist}`}
              aria-label={`Reproduzir recente ${track.title}`}
              onPointerEnter={() => warmTrack(track)}
              onPointerLeave={cancelWarmTrack}
              onFocus={() => warmTrack(track)}
              onBlur={cancelWarmTrack}
              onClick={() => useApp.getState().play(track, recent)}
            >
              <span className="recent-art">
                <Cover track={track} />
                <span>
                  <Play size={12} fill="currentColor" />
                </span>
              </span>
              <span className="recent-caption">
                <strong>{track.title}</strong>
                <small>{track.artist}</small>
              </span>
            </button>
          ))
        ) : (
          <p className="recent-empty">Nenhuma playlist.</p>
        )}
      </div>
    </GlassSidebar>
  );
}
