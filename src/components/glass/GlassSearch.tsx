import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  History,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  Settings,
  UserRound,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useApp, looksLikeMusicLink, handleDirectLink } from '../../stores/app';
import { useAccounts } from '../../stores/accounts';
import { menuMotion, useReducedUI } from '../../lib/motion';
import { GlassMaterial } from './materials';

function TopbarProfileMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const page = useApp(s => s.page);
  const setPage = useApp(s => s.setPage);
  const hub = useAccounts(s => s.hub);
  const reduced = useReducedUI();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const displayName = hub.displayName || hub.username || hub.subject || 'Visitante';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'L';
  const avatarActive =
    open || page === 'settings' || page === 'history' || page.startsWith('profile:');

  const navigateAndClose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="topbar-profile" ref={rootRef}>
      <button
        type="button"
        className={`topbar-avatar-btn ${avatarActive ? 'active' : ''}`}
        aria-label="Perfil e configurações"
        aria-haspopup="menu"
        aria-expanded={open}
        title={hub.authenticated ? `${displayName} · Perfil e configurações` : 'Perfil e configurações'}
        onClick={() => setOpen(v => !v)}
      >
        {hub.authenticated && hub.avatarUrl ? (
          <img src={hub.avatarUrl} alt={displayName} className="topbar-avatar-img" />
        ) : hub.authenticated ? (
          <span className="topbar-avatar-initial" aria-hidden="true">
            {initial}
          </span>
        ) : (
          <UserRound size={16} aria-hidden="true" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="topbar-profile-menu glass"
            role="menu"
            aria-label="Menu do perfil"
            {...menuMotion(reduced)}
          >
            <div className="topbar-profile-header">
              <span className="topbar-profile-thumb" aria-hidden="true">
                {hub.authenticated && hub.avatarUrl ? (
                  <img src={hub.avatarUrl} alt="" />
                ) : hub.authenticated ? (
                  initial
                ) : (
                  <UserRound size={15} />
                )}
              </span>
              <div className="topbar-profile-meta">
                <strong>{displayName}</strong>
                <small>
                  {hub.authenticated
                    ? hub.publicHandle
                      ? `@${hub.publicHandle}`
                      : hub.email || 'Conta conectada'
                    : 'Modo visitante'}
                </small>
              </div>
            </div>

            <div className="topbar-profile-divider" />

            {hub.authenticated ? (
              <button
                type="button"
                role="menuitem"
                className={page.startsWith('profile:') ? 'active' : ''}
                onClick={() =>
                  navigateAndClose(() => {
                    if (hub.publicHandle) {
                      setPage(`profile:${hub.publicHandle}`);
                    } else {
                      useApp.getState().setSettingsTab('account');
                      setPage('settings');
                    }
                  })
                }
              >
                <UserRound size={15} />
                <span>Perfil</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  navigateAndClose(() => {
                    useAccounts.getState().openAuthModal({ view: 'choose' });
                  })
                }
              >
                <LogIn size={15} />
                <span>Entrar</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              className={page === 'history' ? 'active' : ''}
              onClick={() => navigateAndClose(() => setPage('history'))}
            >
              <History size={15} />
              <span>Histórico</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className={page === 'settings' ? 'active' : ''}
              onClick={() => navigateAndClose(() => setPage('settings'))}
            >
              <Settings size={15} />
              <span>Configurações</span>
            </button>

            {hub.authenticated && (
              <>
                <div className="topbar-profile-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() =>
                    navigateAndClose(() => {
                      void useAccounts.getState().logoutHub();
                    })
                  }
                >
                  <LogOut size={15} />
                  <span>Sair</span>
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

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
      <TopbarProfileMenu />
    </header>
  );
}
