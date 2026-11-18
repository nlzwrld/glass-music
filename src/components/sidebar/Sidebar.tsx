import {
  Home,
  Compass,
  Search,
  Library,
  Heart,
  History,
  Settings,
  AudioLines,
  Play,
  Plus,
  ListPlus,
  Link2,
  FolderInput,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useApp, type Page } from '../../stores/app';
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
  ['history', 'Histórico', History],
] as const;

export default function Sidebar() {
  const page = useApp(s => s.page),
    data = useApp(s => s.data),
    setPage = useApp(s => s.setPage),
    { settings, setSettings, reduced } = useOptics();
  const isGlass = (data.preferences.uiStyle ?? 'matte') === 'glass';

  const recent = data.history
    .filter((entry, index, all) => all.findIndex(row => row.id === entry.id) === index)
    .map(entry => data.tracks.find(track => track.id === entry.id))
    .filter((track): track is NonNullable<typeof track> => !!track)
    .slice(0, 20);

  return (
    <GlassSidebar aria-label="Barra lateral">
      <div className="sidebar-brand-row">
        <button
          className="brand"
          onClick={() => setPage('home')}
          aria-label="Glass Music início"
        >
          <span className="brand-mark">
            <AudioLines size={16} />
          </span>
          <span>Glass Music</span>
        </button>
        <IconButton
          label={settings.sidebarCompact ? 'Expandir sidebar' : 'Recolher sidebar'}
          className="sidebar-toggle"
          onClick={() => setSettings({ sidebarCompact: !settings.sidebarCompact })}
        >
          {settings.sidebarCompact ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </IconButton>
      </div>

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
                  duration: reduced ? 0 : 0.25,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
            )}
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

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

      <div className="sidebar-bottom">
        <button
          aria-label="Configurações"
          title="Configurações"
          aria-current={page === 'settings' ? 'page' : undefined}
          className={`nav-item ${page === 'settings' ? 'selected' : ''}`}
          onClick={() => setPage('settings')}
        >
          <Settings size={16} />
          <span>Configurações</span>
        </button>
      </div>
    </GlassSidebar>
  );
}
