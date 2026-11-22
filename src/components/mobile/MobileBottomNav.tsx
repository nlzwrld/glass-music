import { Home, Library, Search, Settings, UserRound } from 'lucide-react';
import { useApp, type Page } from '../../stores/app';
import { useAccounts } from '../../stores/accounts';

export function MobileBottomNav() {
  const page = useApp(s => s.page);
  const setPage = useApp(s => s.setPage);
  const hub = useAccounts(s => s.hub);
  const visitorMode = useAccounts(s => s.visitorMode);
  const openAuthModal = useAccounts(s => s.openAuthModal);

  const items: Array<{
    id: string;
    label: string;
    icon: typeof Home;
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
        current === 'collection' ||
        current === 'downloads' ||
        current.startsWith('playlist:') ||
        current.startsWith('shared-playlist:'),
      onClick: () => setPage('collection'),
    },
    {
      id: 'profile',
      label: visitorMode && !hub.authenticated ? 'Entrar' : 'Perfil',
      icon: UserRound,
      activeMatch: current => current.startsWith('profile:'),
      onClick: () => {
        if (hub.authenticated && (hub.publicHandle || hub.username)) {
          setPage(`profile:${hub.publicHandle || hub.username || ''}`);
        } else {
          openAuthModal({ view: 'choose' });
        }
      },
    },
    {
      id: 'settings',
      label: 'Ajustes',
      icon: Settings,
      activeMatch: current => current === 'settings',
      onClick: () => setPage('settings'),
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
            className={`mobile-bottom-nav-item ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={item.onClick}
          >
            <Icon size={19} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
