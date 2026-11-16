import { Play, X, RotateCcw } from 'lucide-react';
import { useEffect,useRef } from 'react';
import { GlassMaterial } from '../materials';
import { useOptics } from './OpticalEngine';
import SVGPlane from './SVGPlane';
import { opticalDefaults,type OpticalSettings } from './model';
export default function GlassLaboratory(){
 const {settings:s,setSettings,lab,setLab}=useOptics(),dialog=useRef<HTMLElement>(null);
 useEffect(()=>{if(!lab)return;const before=document.activeElement as HTMLElement|null;return()=>{before?.focus();};},[lab]);
 if(!lab)return null;
 const controls:[keyof OpticalSettings,string,number,number,number,string][]=[['blur','Blur',0,24,.5,'px'],['refraction','Refração',0,12,.25,'px'],['opacity','Opacidade',0,.14,.005,'%'],['saturation','Saturação',.5,2,.05,'%'],['specular','Reflexo especular',0,1,.025,''],['chromatic','Aberração cromática',0,.2,.005,''],['thickness','Espessura óptica',3,30,1,'px']];
 return <section ref={dialog} className="glass-laboratory" role="dialog" aria-modal="true" aria-labelledby="lab-title" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setLab(false);}if(e.key==='Tab'){const controls=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,select'));if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus();}}}}>
  <header className="lab-heading"><div><h1 id="lab-title">Glass Laboratory</h1><p>O mesmo fundo. Três materiais.</p></div><button className="icon-button" aria-label="Fechar laboratório" onClick={()=>setLab(false)} autoFocus><X/></button></header>
  <div className="lab-body"><div className="lab-comparisons">{(['css','svg','webgl'] as const).map(method=><article key={method} className="lab-column"><h2>{method==='css'?'CSS':method==='svg'?'SVG':'WebGL2'}</h2><div className="lab-demo" data-lab-scene={method}>
   <GlassMaterial method={method} variant="regular" className="lab-card"><strong>Crystal Regular</strong><span>Texto nítido, fundo refratado.</span></GlassMaterial>
   <GlassMaterial method={method} variant="thick" className="lab-panel"><strong>Crystal Deep</strong><span>Transmissão • profundidade • luz</span><button className="lab-play" data-optic={method} data-crystal="thin" aria-label={`Testar botão ${method}`} onClick={e=>{e.currentTarget.animate([{transform:'scale(1)'},{transform:'scale(.93)'},{transform:'scale(1)'}],{duration:220});}}>{method==='svg'&&<SVGPlane variant="thin"/>}<Play size={20}/></button></GlassMaterial>
   <span className="lab-scene-label">Imagem, texto e movimento atrás do vidro</span>
  </div></article>)}</div>
  <aside className="lab-controls">{controls.map(([key,label,min,max,step,unit])=><label key={key}><span>{label}<output>{unit==='%'?Math.round(Number(s[key])*100):Number(s[key]).toFixed(unit==='px'?1:2)}{unit}</output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={Number(s[key])} onChange={e=>setSettings({[key]:Number(e.target.value)})}/></label>)}<label className="lab-tint"><span>Tint</span><input type="color" aria-label="Tint" value={s.tint} onChange={e=>setSettings({tint:e.target.value})}/></label><label><span>Qualidade</span><select aria-label="Qualidade de renderização" value={s.quality} onChange={e=>setSettings({quality:e.target.value as OpticalSettings['quality']})}><option value="economy">Econômica</option><option value="balanced">Equilibrada</option><option value="high">Alta</option></select></label><button className="text-button" onClick={()=>setSettings({...opticalDefaults,background:s.background})}><RotateCcw size={14}/>Restaurar material</button><p className="lab-note">WebGL refrata o ambiente interno. SVG filtra o conteúdo atrás da superfície. A área de trabalho usa o efeito nativo do Windows.</p></aside></div>
 </section>;
}
