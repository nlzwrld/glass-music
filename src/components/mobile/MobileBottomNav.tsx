import { Home, Library, Radio, Search, UserRound } from 'lucide-react';
import { motion } from 'motion/react';
import { useApp, type Page } from '../../stores/app';
import { useAccounts } from '../../stores/accounts';
import { useJam } from '../jam/state';
import { useReducedUI } from '../../lib/motion';

export function MobileBottomNav() {
  const page = useApp(s => s.page);
  const setPage = useApp(s => s.setPage);
  const hub = useAccounts(s => s.hub);
  const visitorMode = useAccounts(s => s.visitorMode);
  const openAuthModal = useAccounts(s => s.openAuthModal);
  const jamSession = useJam(s => s.session);
  const jamListeners = useJam(s => s.room?.members.length ?? (s.session ? 1 : 0));
  const reduced = useReducedUI();

  const items: Array<{
    id: string;
    label: string;
    icon: typeof Home;
    badge?: string;
    live?: boolean;
    activeMatch: (current: Page) => boolean;
    onClick: () => void;
  }> = [
    {
      id: 'home',
      label: 'Início',
      icon: Home,
      activeMatch: current => current === 'home' || current === 'explore',
      onClick: () => setPage('home'),
    },
    {
      id: 'search',
      label: 'Buscar',
      icon: Search,
      activeMatch: current => current === 'search',
      onClick: () => setPage('search'),
    },
    {
      id: 'library',
      label: 'Biblioteca',
      icon: Library,
      activeMatch: current =>
        current === 'library' ||
        current === 'collection' ||
        current === 'downloads' ||
        current === 'history' ||
        current.startsWith('playlist:') ||
        current.startsWith('shared-playlist:'),
      onClick: () => setPage('library'),
    },
    {
      id: 'jam',
      label: 'JAM',
      icon: Radio,
      live: Boolean(jamSession),
      badge: jamSession ? String(jamListeners) : undefined,
      activeMatch: current => current === 'jam',
      onClick: () => setPage('jam'),
    },
    {
      id: 'profile',
      label: visitorMode && !hub.authenticated ? 'Entrar' : 'Perfil',
      icon: UserRound,
      activeMatch: current => current.startsWith('profile:') || current === 'settings',
      onClick: () => {
        if (hub.authenticated && (hub.publicHandle || hub.username)) {
          setPage(`profile:${hub.publicHandle || hub.username || ''}`);
        } else if (hub.authenticated) {
          useApp.getState().setSettingsTab('account');
          setPage('settings');
        } else {
          openAuthModal({ view: 'choose' });
        }
      },
    },
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label="Navegação principal mobile">
      {items.map(item => {
        const Icon = item.icon;
        const active = item.activeMatch(page);
        return (
          <button
            key={item.id}
            type="button"
            className={`mobile-bottom-nav-item ${active ? 'active' : ''} ${item.live ? 'is-live' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={item.onClick}
          >
            {active && (
              <motion.span
                layoutId={reduced ? undefined : 'mobile-nav-active-pill'}
                className="mobile-nav-pill"
                transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                aria-hidden="true"
              />
            )}
            <span className="mobile-nav-icon-wrap">
              <Icon size={20} strokeWidth={active ? 2.2 : 1.85} />
              {item.live && <span className="mobile-nav-live-dot" aria-hidden="true" />}
              {item.badge && <span className="mobile-nav-badge">{item.badge}</span>}
            </span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
