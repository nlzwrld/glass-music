import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Minus, Square, X } from 'lucide-react';
import { LiquidHubLogo } from '../components/brand/LiquidHubLogo';
import { purgeSensitiveWebStorage } from '../../shared/validation';
import { repairArtwork } from '../lib/artwork';
import { MOTION_DURATION, MOTION_EASE, pageMotion, toastMotion, useReducedUI } from '../lib/motion';
import { useApp } from '../stores/app';
import Sidebar from '../components/sidebar/Sidebar';
import Player, { ExpandedPlayer, Queue, SidePlayer } from '../components/player/Player';
import { GlassWindow } from '../components/glass/materials';
import GlassSearch from '../components/glass/GlassSearch';
import Dialogs from '../components/glass/Dialogs';
import Cover from '../components/glass/Cover';
import Home from '../pages/Home';
import { AutoUpdates } from '../lib/updates';
import { useAndroidBetaLifecycle } from '../lib/androidBeta';
import { MandatoryUpdateModal } from '../components/glass/MandatoryUpdateModal';
import { VisitorVisualAdBanner } from '../components/glass/VisitorVisualAdBanner';
import { MobileBottomNav } from '../components/mobile/MobileBottomNav';
import { JamWindowBridge } from '../lib/jamWindow';
import { LyricsWindowBridge } from '../lib/lyricsWindow';
import { JamEngine } from '../components/jam/JamEngine';
import { JamInviteModal } from '../components/jam/JamInviteModal';
import { AuthModal } from '../components/auth/AuthModal';
import { useAccounts, autoSyncAccounts } from '../stores/accounts';
import { useJam } from '../components/jam/state';
import { parseJamInvite } from '../lib/jam';
import { parseLiquidHubLink } from '../lib/playlist';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import Lyrics from '../components/player/Lyrics';
import Welcome from '../components/glass/Welcome';
import { BackgroundVideoLayer } from '../components/glass/BackgroundVideoLayer';
import { BeatPulseOverlay } from '../components/glass/BeatPulseOverlay';
import { OpticalEngine } from '../components/glass/v3/OpticalEngine';
import GlassLaboratory from '../components/glass/v3/GlassLaboratory';

const Explore = lazy(() => import('../pages/Explore'));
const Search = lazy(() => import('../pages/Search'));
const Library = lazy(() => import('../pages/Library'));
const Collection = lazy(() => import('../pages/Collection'));
const Downloads = lazy(() => import('../pages/Downloads'));
const JamPage = lazy(() =>
  import('../components/jam/JamSettings').then(m => ({ default: m.JamSettings })),
);
const Settings = lazy(() => import('../pages/Settings'));
const UserProfile = lazy(() => import('../pages/UserProfile'));
const SharedPlaylist = lazy(() => import('../pages/SharedPlaylist'));

export default function App() {
  const ready = useApp(s => s.ready),
    page = useApp(s => s.page),
    navigationIndex = useApp(s => s.navigationIndex),
    navigationMotion = useApp(s => s.navigationMotion),
    p = useApp(s => s.data.preferences),
    toast = useApp(s => s.toast),
    mini = useApp(s => s.mini),
    track = useApp(s => s.queue[s.index]),
    expanded = useApp(s => s.expanded),
    hub = useAccounts(s => s.hub),
    hubHydrated = useAccounts(s => s.hubHydrated),
    visitorMode = useAccounts(s => s.visitorMode);
  const { isAndroid, isMobile } = useAndroidBetaLifecycle();
  const lockedByAuth =
    ready &&
    p.onboardingDone &&
    (!hubHydrated || ((!hub.authenticated || Boolean(hub.needsTermsAcceptance)) && !visitorMode));
  const searchInput = useRef<HTMLInputElement>(null);
  const [systemLight, setSystemLight] = useState(
    matchMedia('(prefers-color-scheme: light)').matches,
  );
  const artworkTracks = useApp(s => s.data.tracks);
  const queuedDeepLink = useRef('');
  const uiReduced = useReducedUI();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const pendingInviteCode = () => {
      const pInvite = useJam.getState().pendingInvite;
      if (!pInvite) return '';
      return pInvite.result?.preview?.code || parseJamInvite(pInvite.raw).code;
    };
    const openOrQueue = (url: string) => {
      if (disposed) return;
      const hubLink = parseLiquidHubLink(url);
      if (hubLink) {
        if (!useApp.getState().ready) {
          queuedDeepLink.current = url;
          return;
        }
        useApp
          .getState()
          .setPage(
            hubLink.kind === 'profile'
              ? `profile:${hubLink.handle}`
              : `shared-playlist:${hubLink.shareId}`,
          );
        return;
      }
      const parsed = parseJamInvite(url);
      if (!parsed.code) return;
      if (!useApp.getState().ready) {
        queuedDeepLink.current = url;
        return;
      }
      if (pendingInviteCode() === parsed.code) return;
      void useJam.getState().openInviteModal(url);
    };
    const receive = (urls: string[]) => {
      const target = urls.find(
        url =>
          parseLiquidHubLink(url) !== null ||
          (url.startsWith('liquidhub://') && !!parseJamInvite(url).code),
      );
      if (target) openOrQueue(target);
    };
    void (async () => {
      try {
        const off = await onOpenUrl(receive);
        if (disposed) { off(); return; }
        unlisten = off;
        const urls = await getCurrent();
        if (urls) receive(urls);
      } catch (error) {
        console.error('Não foi possível receber convites da JAM:', error);
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!ready || !queuedDeepLink.current) return;
    const queued = queuedDeepLink.current;
    queuedDeepLink.current = '';
    const hubLink = parseLiquidHubLink(queued);
    if (hubLink) {
      useApp
        .getState()
        .setPage(
          hubLink.kind === 'profile'
            ? `profile:${hubLink.handle}`
            : `shared-playlist:${hubLink.shareId}`,
        );
      return;
    }
    const parsed = parseJamInvite(queued);
    const pInvite = useJam.getState().pendingInvite;
    const currentCode = pInvite
      ? pInvite.result?.preview?.code || parseJamInvite(pInvite.raw).code
      : '';
    if (parsed.code && currentCode !== parsed.code) {
      void useJam.getState().openInviteModal(queued);
    }
  }, [ready]);

  useEffect(() => {
    purgeSensitiveWebStorage();
    void useApp.getState().boot();
    const offDownloadProgress =
      typeof window.glass?.onDownloadProgress === 'function'
        ? window.glass.onDownloadProgress(ev => useApp.getState().applyDownloadProgress(ev))
        : undefined;
    return () => {
      offDownloadProgress?.();
    };
  }, []);

  useEffect(() => {
    if (ready) repairArtwork();
  }, [ready, artworkTracks, p.onlineConsent, p.onboardingDone]);

  useEffect(() => {
    if (!ready) return;
    void useAccounts.getState().refresh();
  }, [ready, p.onlineConsent, p.onboardingDone]);

  useEffect(() => {
    if (!ready || lockedByAuth || !p.onlineConsent || !p.catalogConsent || !p.onboardingDone) return;
    const initial = setTimeout(() => void autoSyncAccounts(), 5000),
      timer = setInterval(() => void autoSyncAccounts(), 30 * 60 * 1000);
    const onReconnectOrResume = () => {
      void useAccounts.getState().flushPendingCloudSync();
    };
    window.addEventListener('online', onReconnectOrResume);
    window.addEventListener('liquid:app-foreground', onReconnectOrResume);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener('online', onReconnectOrResume);
      window.removeEventListener('liquid:app-foreground', onReconnectOrResume);
    };
  }, [ready, lockedByAuth, p.onlineConsent, p.catalogConsent, p.onboardingDone]);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: light)');
    const changed = () => setSystemLight(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const rawStyle = p.uiStyle ?? 'matte';
    const uiStyle = rawStyle === 'glass' ? 'glass' : 'matte';
    const beatPulseActive = Boolean((p.beatPulse ?? rawStyle === 'beat') && !p.performance);
    document.documentElement.dataset.uiStyle = uiStyle;
    document.documentElement.dataset.beatPulse = String(beatPulseActive);
    document.documentElement.dataset.theme =
      p.theme === 'system' ? (systemLight ? 'light' : 'dark') : p.theme;
    document.documentElement.dataset.performance = String(p.performance);
    document.documentElement.dataset.motion = p.reducedMotion ? 'reduced' : 'full';
    document.documentElement.style.setProperty('--user-accent', p.accent || '#52b79a');
    document.documentElement.style.setProperty(
      '--blur',
      p.performance || uiStyle === 'matte' ? '0px' : `${p.blur}px`,
    );
    document.documentElement.style.setProperty('--glass-alpha', `${0.025 + p.glass / 1000}`);
  }, [p.uiStyle, p.beatPulse, p.theme, p.performance, p.reducedMotion, p.blur, p.glass, p.accent, systemLight]);

  useEffect(() => {
    const syncFullscreen = () => {
      document.documentElement.dataset.fullscreen = String(Boolean(document.fullscreenElement));
    };
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    const offMax = window.glass?.onWindowMaximized?.(maximized => {
      document.documentElement.dataset.maximized = String(maximized);
    });
    void window.glass
      ?.windowShape?.()
      .then(shape => {
        if (shape) {
          document.documentElement.dataset.maximized = String(Boolean(shape.maximized));
        }
      })
      .catch(() => {});
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      offMax?.();
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        } else {
          void document.documentElement.requestFullscreen().catch(() => {});
        }
        return;
      }
      if (lockedByAuth || !p.onboardingDone) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (mini) {
          void window.glass.window('restore');
          useApp.setState({ mini: false });
        }
        useApp.getState().setPage('search');
        setTimeout(() => searchInput.current?.focus(), 0);
      }
      if (e.key === 'Escape') {
        if (
          e.defaultPrevented ||
          useApp.getState().dialog ||
          Boolean(
            document.querySelector(
              '[aria-modal="true"], [role="menu"], .glass-context-menu, .topbar-profile-menu, .auth-modal-backdrop, .jam-invite-backdrop',
            ),
          )
        ) {
          return;
        }
        const curr = useApp.getState();
        if (curr.lyricsOpen || curr.queueOpen) {
          useApp.setState({ lyricsOpen: false, queueOpen: false });
        } else if (curr.expanded) {
          useApp.setState({ expanded: false });
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mini, lockedByAuth, p.onboardingDone]);

  useEffect(() => {
    const scroller = document.querySelector('.main-scroll');
    if (!scroller) return;
    if (navigationMotion === 'traverse') {
      const targetTop = useApp.getState().scrollPositions[navigationIndex] ?? 0;
      scroller.scrollTo({ top: targetTop });
      const raf = requestAnimationFrame(() => {
        scroller.scrollTo({ top: targetTop });
      });
      return () => cancelAnimationFrame(raf);
    }
    scroller.scrollTo({ top: 0 });
  }, [page, navigationIndex, navigationMotion]);

  const external = !!track && track.source !== 'local';
  const collapsed = useApp(s => s.collapsed),
    sideOpen = useApp(s => s.sideOpen);
  if (!window.glass) {
    return (
      <div className="boot-screen">
        <LiquidHubLogo size={38} />
        <h1>Liquid Hub</h1>
        <p>Execute o aplicativo desktop.</p>
      </div>
    );
  }
  return (
    <MotionConfig
      reducedMotion={uiReduced ? 'always' : 'user'}
      transition={{ duration: uiReduced ? 0 : MOTION_DURATION.base, ease: MOTION_EASE.standard }}
    >
      <GlassWindow
        className={`${mini ? 'mini' : ''} ${external ? 'has-external' : ''} ${expanded ? 'is-expanded' : ''} ${collapsed ? 'sidebar-collapsed' : ''} ${sideOpen ? 'side-open' : ''}`}
      >
        <BackgroundVideoLayer />
        <BeatPulseOverlay />
        <OpticalEngine>
          {!isAndroid && (
            <header
              className="titlebar"
              data-tauri-drag-region
              onDoubleClick={e => {
                const el = e.target as HTMLElement;
                if (el === e.currentTarget || el.hasAttribute('data-tauri-drag-region')) {
                  void window.glass.window('maximize');
                }
              }}
            >
              <button
                type="button"
                className="titlebar-brand brand"
                onClick={() => useApp.getState().setPage('home')}
                aria-label="Liquid Hub início"
              >
                <span className="brand-mark titlebar-brand-mark">
                  <LiquidHubLogo size={16} />
                </span>
                <span className="titlebar-brand-name">Liquid Hub</span>
              </button>
              <span className="titlebar-drag" data-tauri-drag-region />
              <div className="titlebar-window-controls">
                <button
                  type="button"
                  className="window-control-btn"
                  aria-label="Minimizar janela"
                  onClick={() => void window.glass.window('minimize')}
                >
                  <Minus size={15} />
                </button>
                <button
                  type="button"
                  className="window-control-btn"
                  aria-label="Maximizar janela"
                  onClick={() => void window.glass.window('maximize')}
                >
                  <Square size={13} />
                </button>
                <button
                  type="button"
                  className="window-control-btn window-close"
                  aria-label="Fechar janela"
                  onClick={() => void window.glass.window('close')}
                >
                  <X size={16} />
                </button>
              </div>
            </header>
          )}
          {lockedByAuth ? (
            <>
              <JamEngine />
              {!hubHydrated ? (
                <div className="auth-gate auth-gate-loading" role="status">
                  Carregando sessão…
                </div>
              ) : (
                <AuthModal mandatory />
              )}
            </>
          ) : (
            <>
              <div className="app-body">
                <Sidebar />
                <div className="main-shell">
                  <GlassSearch inputRef={searchInput} />
                  <AutoUpdates />
                  <VisitorVisualAdBanner />
                  <main className="main-scroll">
                    <Suspense fallback={<div className="loading-page">Carregando…</div>}>
                      <motion.div
                        key={page}
                        {...pageMotion(uiReduced)}
                      >
                        {!ready ? (
                          <div className="loading-page">Carregando…</div>
                        ) : page === 'home' ? (
                          <Home />
                        ) : page === 'explore' ? (
                          <Explore />
                        ) : page === 'search' ? (
                          <Search />
                        ) : page === 'collection' ? (
                          <Collection />
                        ) : page === 'downloads' ? (
                          <Downloads />
                        ) : page === 'jam' ? (
                          <JamPage />
                        ) : page === 'settings' ? (
                          <Settings />
                        ) : page.startsWith('profile:') ? (
                          <UserProfile key={page} handle={page.slice('profile:'.length)} />
                        ) : page.startsWith('shared-playlist:') ? (
                          <SharedPlaylist key={page} shareId={page.slice('shared-playlist:'.length)} />
                        ) : (
                          <Library key={page} />
                        )}
                      </motion.div>
                    </Suspense>
                  </main>
                </div>
                <SidePlayer />
              </div>
              <div className="mini-content">
                <Cover track={track} />
                <h2>{track?.title || 'Liquid Hub'}</h2>
                <p>{track?.artist || ''}</p>
              </div>
              <LyricsWindowBridge />
              <JamWindowBridge />
              <JamEngine />
              <JamInviteModal />
              <AuthModal />
              <ExpandedPlayer />
              <Queue />
              <Lyrics />
              <Player />
              {isMobile && <MobileBottomNav />}
              <Dialogs />
              <GlassLaboratory />
            </>
          )}
          <MandatoryUpdateModal />
          <Welcome />
          <AnimatePresence>
            {toast && (
              <motion.div
                key="app-toast"
                className="toast glass"
                role="status"
                {...toastMotion(uiReduced)}
              >
                <span>{toast}</span>
                <button
                  aria-label="Fechar notificação"
                  onClick={() => useApp.setState({ toast: '' })}
                >
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </OpticalEngine>
      </GlassWindow>
    </MotionConfig>
  );
}
