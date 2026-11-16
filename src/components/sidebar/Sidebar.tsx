import { Home, Compass, Search, Library, Heart, History, Settings, AudioLines, Play, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { motion } from 'motion/react';
import { useApp, type Page } from '../../stores/app';
import { IconButton } from '../glass/controls';
import { GlassSidebar } from '../glass/materials';
import { useOptics } from '../glass/v3/OpticalEngine';
import Cover from '../glass/Cover';
import { warmTrack, cancelWarmTrack } from '../../lib/playback';
const nav=[['home','Início',Home],['explore','Explorar',Compass],['search','Buscar',Search],['library','Biblioteca',Library],['likes','Curtidas',Heart],['history','Histórico',History]] as const;
export default function Sidebar(){
 const page=useApp(s=>s.page),data=useApp(s=>s.data),setPage=useApp(s=>s.setPage),{settings,setSettings,reduced}=useOptics();
 const recent=data.history.filter((entry,index,all)=>all.findIndex(row=>row.id===entry.id)===index).map(entry=>data.tracks.find(track=>track.id===entry.id)).filter((track):track is NonNullable<typeof track>=>!!track).slice(0,30);
 return <GlassSidebar aria-label="Barra lateral"><div className="sidebar-brand-row"><button className="brand" onClick={()=>setPage('home')} aria-label="Glass Music início"><span className="brand-mark"><AudioLines size={24}/></span><span>Glass<span className="brand-word"> music</span></span></button><IconButton label={settings.sidebarCompact?'Expandir sidebar':'Recolher sidebar'} className="sidebar-toggle" onClick={()=>setSettings({sidebarCompact:!settings.sidebarCompact})}>{settings.sidebarCompact?<PanelLeftOpen/>:<PanelLeftClose/>}</IconButton></div><nav aria-label="Navegação principal">{nav.map(([id,label,Icon])=><button key={id} aria-label={label} title={label} aria-current={page===id?'page':undefined} className={`nav-item ${page===id?'selected':''}`} onClick={()=>setPage(id as Page)}>{page===id&&<motion.span className="nav-capsule" layoutId="navigation-capsule" transition={{type:'tween',duration:reduced?0:.32,ease:[.22,1,.36,1]}}/>}<Icon size={20}/><span>{label}</span></button>)}</nav>
 <div className="playlist-heading recent-heading"><span>Recentes</span></div><div className="sidebar-playlists sidebar-recents" aria-label="Músicas recentes">{recent.length?recent.map(track=><button key={track.id} className="recent-track" title={`${track.title} · ${track.artist}`} aria-label={`Reproduzir recente ${track.title}`} onPointerEnter={()=>warmTrack(track)} onPointerLeave={cancelWarmTrack} onFocus={()=>warmTrack(track)} onBlur={cancelWarmTrack} onClick={()=>useApp.getState().play(track,recent)}><span className="recent-art"><Cover track={track}/><span><Play size={14} fill="currentColor"/></span></span><span className="recent-caption"><strong>{track.title}</strong><small>{track.artist}</small></span></button>):<p className="recent-empty">Suas músicas ouvidas aparecem aqui.</p>}</div>
 <div className="sidebar-bottom"><button aria-label="Configurações" title="Configurações" className={`nav-item ${page==='settings'?'selected':''}`} onClick={()=>setPage('settings')}><Settings size={20}/><span>Configurações</span></button></div></GlassSidebar>;
}
