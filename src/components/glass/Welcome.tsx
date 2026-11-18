import { useEffect, useState } from 'react';
import { AudioLines, ArrowUpRight } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useApp } from '../../stores/app';

export function greeting(hour: number) { return hour >= 5 && hour < 12 ? 'Bom dia' : hour >= 12 && hour < 18 ? 'Boa tarde' : 'Boa noite'; }
export default function Welcome() {
  const ready = useApp(s => s.ready), preferences = useApp(s => s.data.preferences);
  const [date] = useState(() => new Date());
  const [done, setDone] = useState(false), [leaving,setLeaving] = useState(false), [busy,setBusy] = useState(false);
  const phrase = greeting(date.getHours());
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const systemReduced=useReducedMotion(),reduced=preferences.reducedMotion||preferences.performance||systemReduced;
  const isMatte = (preferences.uiStyle ?? 'matte') === 'matte';
  useEffect(() => {
    if(!ready||!preferences.onboardingDone||done)return;
    if(isMatte){setDone(true);return;}
    const fade=setTimeout(()=>setLeaving(true),reduced?180:1650);
    const finish=setTimeout(()=>setDone(true),reduced?220:2150);
    return()=>{clearTimeout(fade);clearTimeout(finish);};
  },[ready,preferences.onboardingDone,done,reduced,isMatte]);
  useEffect(()=>{document.documentElement.dataset.starting=String(!done);return()=>{delete document.documentElement.dataset.starting;};},[done]);
  useEffect(()=>{
    if(!ready || preferences.onboardingDone) return;
    const focus=setTimeout(()=>document.querySelector<HTMLButtonElement>('.onboarding .primary')?.focus(),0);
    const trap=(e:KeyboardEvent)=>{
      if(e.key!=='Tab')return;
      const nodes=Array.from(document.querySelectorAll<HTMLButtonElement>('.onboarding button:not(:disabled)'));
      const first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    };
    window.addEventListener('keydown',trap);return()=>{clearTimeout(focus);window.removeEventListener('keydown',trap);};
  },[ready,preferences.onboardingDone]);
  const accept = async (online:boolean) => {
    setBusy(true);
    try {
      const next={...useApp.getState().data.preferences,onboardingDone:true,onlineConsent:online,catalogConsent:online};
      // Persist permission before mounting components that may initiate online requests.
      await window.glass.preferences(next);
      useApp.setState(s=>({data:{...s.data,preferences:next}}));
    } catch(error) { useApp.getState().message(String(error)); }
    finally { setBusy(false); }
  };
  if(!ready)return null;
  if(preferences.onboardingDone) return (done||isMatte)?null:<motion.div className="welcome-screen welcome-smooth" role="status" aria-label="Abertura" initial={reduced?false:{opacity:0}} animate={{opacity:leaving?0:1}} transition={{duration:reduced?0:.45,ease:[.22,1,.36,1]}}>
   <motion.div className="welcome-content" initial={reduced?false:{opacity:0,y:16,scale:.985}} animate={{opacity:leaving?0:1,y:leaving&&!reduced?-6:0,scale:1}} transition={{duration:reduced?0:.85,ease:[.22,1,.36,1]}}><motion.div className="welcome-emblem" initial={reduced?false:{opacity:0,scale:.94}} animate={{opacity:1,scale:1}} transition={{duration:reduced?0:1,ease:[.22,1,.36,1]}}><AudioLines size={29} strokeWidth={1.35}/></motion.div>
   <motion.h1 initial={reduced?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:reduced?0:.8,delay:reduced?0:.08,ease:[.22,1,.36,1]}}>{phrase}</motion.h1>
   <motion.time initial={reduced?false:{opacity:0,y:5}} animate={{opacity:.8,y:0}} transition={{duration:reduced?0:.8,delay:reduced?0:.18,ease:[.22,1,.36,1]}}>{time}</motion.time></motion.div>
  </motion.div>;
  return <div className="modal-backdrop onboarding"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><h2 id="welcome-title">Acesso online</h2><p>Buscas, capas e letras consultam catálogos externos e o LRCLIB. Sua biblioteca permanece salva localmente neste computador.</p><div className="terms-links">{[['YouTube','https://www.youtube.com/t/terms'],['SoundCloud','https://soundcloud.com/terms-of-use'],['Privacidade Google','https://policies.google.com/privacy'],['Privacidade SoundCloud','https://soundcloud.com/pages/privacy'],['LRCLIB','https://lrclib.net']].map(([label,url])=><button key={label} onClick={()=>void window.glass.external(url)}>{label}<ArrowUpRight size={12}/></button>)}</div><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>void accept(false)}>Agora não</button><button className="button primary" disabled={busy} onClick={()=>void accept(true)}>Permitir e continuar</button></div></section></div>;
}
