import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Minus, Square, X, AudioLines } from 'lucide-react';
import {repairArtwork} from '../lib/artwork';
import { autoSyncAccounts } from '../stores/accounts';
import { useApp } from '../stores/app';
import Sidebar from '../components/sidebar/Sidebar';
import Player, { ExpandedPlayer, Queue, SidePlayer } from '../components/player/Player';
import { GlassWindow } from '../components/glass/materials';
import GlassSearch from '../components/glass/GlassSearch';
import Dialogs from '../components/glass/Dialogs';
import Cover from '../components/glass/Cover';
import Home from '../pages/Home';
import {AutoUpdates} from '../lib/updates';
import {LyricsWindowBridge} from '../lib/lyricsWindow';
import {JamEngine} from '../components/jam/JamEngine';
import Lyrics from '../components/player/Lyrics';
import Welcome from '../components/glass/Welcome';
import { OpticalEngine } from '../components/glass/v3/OpticalEngine';
import GlassLaboratory from '../components/glass/v3/GlassLaboratory';
const Explore = lazy(() => import('../pages/Explore'));
const Search = lazy(() => import('../pages/Search'));
const Library = lazy(() => import('../pages/Library'));
const Collection = lazy(() => import('../pages/Collection'));
const Settings = lazy(() => import('../pages/Settings'));
export default function App() {
  const ready = useApp(s => s.ready), page = useApp(s => s.page), p = useApp(s => s.data.preferences), toast = useApp(s => s.toast), mini = useApp(s => s.mini), track = useApp(s => s.queue[s.index]), expanded = useApp(s => s.expanded);
  const searchInput = useRef<HTMLInputElement>(null); const [systemLight,setSystemLight] = useState(matchMedia('(prefers-color-scheme: light)').matches);
  const artworkTracks=useApp(s=>s.data.tracks);
  useEffect(()=>{if(ready)repairArtwork();},[ready,artworkTracks,p.onlineConsent,p.onboardingDone]);
  useEffect(() => { void useApp.getState().boot(); }, []);
  useEffect(()=>{if(!ready||!p.onlineConsent||!p.catalogConsent||!p.onboardingDone)return;const initial=setTimeout(()=>void autoSyncAccounts(),5000),timer=setInterval(()=>void autoSyncAccounts(),30*60*1000);return()=>{clearTimeout(initial);clearInterval(timer);};},[ready,p.onlineConsent,p.catalogConsent,p.onboardingDone]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: light)'); const changed = () => setSystemLight(media.matches); media.addEventListener('change',changed); return () => media.removeEventListener('change',changed); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = p.theme === 'system' ? systemLight ? 'light' : 'dark' : p.theme;
    document.documentElement.dataset.performance = String(p.performance); document.documentElement.dataset.motion = p.reducedMotion ? 'reduced' : 'full';
    document.documentElement.style.setProperty('--blur', p.performance ? '0px' : `${p.blur}px`);
    document.documentElement.style.setProperty('--glass-alpha', `${0.025 + p.glass / 1000}`);
  }, [p.theme,p.performance,p.reducedMotion,p.blur,p.glass,systemLight]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (mini) { void window.glass.window('restore'); useApp.setState({mini:false}); } useApp.getState().setPage('search'); setTimeout(() => searchInput.current?.focus(),0); } if (e.key === 'Escape') useApp.setState({expanded:false,queueOpen:false,lyricsOpen:false}); }; window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key); }, [mini]);
  useEffect(() => { document.querySelector('.main-scroll')?.scrollTo({top:0}); }, [page]);
  const external = !!track && track.source !== 'local';
  const collapsed = useApp(s => s.collapsed), sideOpen = useApp(s => s.sideOpen);
  if (!window.glass) return <div className="boot-screen"><AudioLines size={40} /><h1>Glass Music</h1><p>Abra o aplicativo desktop para acessar sua biblioteca com segurança.</p></div>;
  return <MotionConfig reducedMotion={p.reducedMotion || p.performance ? 'always' : 'user'}><GlassWindow className={`${mini ? 'mini' : ''} ${external ? 'has-external' : ''} ${expanded ? 'is-expanded' : ''} ${collapsed ? 'sidebar-collapsed' : ''} ${sideOpen ? 'side-open' : ''}`}>
    <OpticalEngine><header className="titlebar" data-tauri-drag-region onDoubleClick={() => void window.glass.window('maximize')}><span data-tauri-drag-region /><div><button aria-label="Minimizar janela" onClick={() => void window.glass.window('minimize')}><Minus size={19} /></button><button aria-label="Maximizar janela" onClick={() => void window.glass.window('maximize')}><Square size={16} /></button><button className="window-close" aria-label="Fechar janela" onClick={() => void window.glass.window('close')}><X size={21} /></button></div></header>
    <div className="app-body"><Sidebar /><div className="main-shell"><GlassSearch inputRef={searchInput} /><main className="main-scroll"><Suspense fallback={<div className="loading-page">Carregando…</div>}><motion.div key={page} initial={{ opacity:p.reducedMotion||p.performance?1:0, y:p.reducedMotion||p.performance?0:8 }} animate={{ opacity: 1, y: 0 }} transition={{duration:p.reducedMotion||p.performance?0:.3,ease:[.22,1,.36,1]}}>{!ready ? <div className="loading-page">Carregando…</div> : page === 'home' ? <Home /> : page === 'explore' ? <Explore /> : page === 'search' ? <Search /> : page === 'collection' ? <Collection /> : page === 'settings' ? <Settings /> : <Library key={page} />}</motion.div></Suspense></main></div><SidePlayer /></div>
    <div className="mini-content"><Cover track={track} /><h2>{track?.title || 'Glass Music'}</h2><p>{track?.artist || ''}</p></div>
    <AutoUpdates/><LyricsWindowBridge/><JamEngine/><ExpandedPlayer /><Queue /><Lyrics /><Player /><Dialogs /><Welcome /><GlassLaboratory />
    {toast && <div className="toast glass" role="status"><span>{toast}</span><button aria-label="Fechar notificação" onClick={() => useApp.setState({toast:''})}><X size={16} /></button></div>}
  </OpticalEngine></GlassWindow></MotionConfig>;
}
