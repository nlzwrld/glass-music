import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { useApp } from '../../../stores/app';
import { coverURL } from '../Cover';
import { CrystalRenderer } from './renderer';
import { drawBackground } from './scene';
import { getPalette, neutralPalette, mixPalette, paletteStats } from './ambient';
import { loadOptics, normalizeOptics, opticalDefaults, materialPresets, surfaceTint, type OpticalSettings } from './model';

const Context=createContext<{settings:OpticalSettings;setSettings:(p:Partial<OpticalSettings>)=>void;lab:boolean;setLab:(v:boolean)=>void;reduced:boolean}>({settings:opticalDefaults,setSettings:()=>{},lab:false,setLab:()=>{},reduced:false});
export const useOptics=()=>useContext(Context);
export function OpticalEngine({children}:{children:ReactNode}){
 const saved=useApp(s=>s.data.preferences.appearance),booted=useApp(s=>s.ready);
 const [legacy]=useState(loadOptics),settings=useMemo(()=>normalizeOptics(saved||{...legacy}),[saved,legacy]);
 const [lab,setLab]=useState(false),[ready,setReady]=useState(false),[systemReduced,setSystemReduced]=useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
 const source=useRef<HTMLCanvasElement>(null),surface=useRef<HTMLCanvasElement>(null),renderer=useRef<CrystalRenderer|null>(null);
 const current=useRef({settings,lab}),invalidate=useRef<(scene?:boolean)=>void>(()=>{}),custom=useRef<HTMLImageElement|undefined>(undefined),poster=useRef<HTMLImageElement|undefined>(undefined);
 const palette=useRef({from:neutralPalette,to:neutralPalette,value:neutralPalette,start:0});
 current.current={settings,lab};
 const uiStyle=useApp(s=>s.data.preferences.uiStyle)??'matte';
 const performanceMode=useApp(s=>s.data.preferences.performance),userReduced=useApp(s=>s.data.preferences.reducedMotion),glass=useApp(s=>s.data.preferences.glass);
 const reduced=userReduced||systemReduced||performanceMode,artwork=useApp(s=>s.queue[s.index]?.artwork);
 const disabled=uiStyle==='matte'||performanceMode||settings.quality==='economy'||(!lab&&settings.background==='desktop');
 useEffect(()=>{if(booted&&(!saved||Object.keys(opticalDefaults).some(key=>saved[key]!==settings[key as keyof OpticalSettings])))void useApp.getState().setPreferences({appearance:{...settings}});},[booted,saved,settings]);
 useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>setSystemReduced(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
 useEffect(()=>{useApp.setState({collapsed:settings.sidebarCompact});document.documentElement.style.setProperty('--ui-scale',String(settings.scale/100));invalidate.current(true);},[settings]);
 useEffect(()=>{document.documentElement.dataset.opticalLab=String(lab);invalidate.current(true);},[lab]);
 useEffect(()=>{
  let cancelled=false;const url=coverURL(artwork?{artwork} as Parameters<typeof coverURL>[0]:undefined);
  void getPalette(url).then(next=>{if(cancelled)return;palette.current={from:palette.current.value,to:next,value:palette.current.value,start:performance.now()};invalidate.current(true);});return()=>{cancelled=true;};
 },[artwork]);
 useEffect(()=>{
  custom.current=undefined;if(!settings.customImage){invalidate.current(true);return;}
  const img=new Image();let cancelled=false;img.onload=()=>{if(!cancelled){custom.current=img;invalidate.current(true);}};img.src=settings.customImage;return()=>{cancelled=true;};
 },[settings.customImage]);
 useEffect(()=>{if(!lab||poster.current)return;const img=new Image();img.onload=()=>{poster.current=img;invalidate.current(true);};img.src='/lab-optics.svg';return()=>{img.onload=null;};},[lab]);
 useEffect(()=>{invalidate.current(true);},[glass,reduced]);
 useEffect(()=>{
  const scene=source.current!,canvas=surface.current!,root=canvas.parentElement!;
  let disposed=false,windowVisible=true,raf=0,timer=0,dirtyScene=true,settleUntil=0,lastFrame=0,light:[number,number]=[-.6,-.8];
  let effective:OpticalSettings['quality']=settings.quality==='auto'?'balanced':settings.quality;
  let capability='fallback',maxTexture=4096;const html=document.documentElement;
  const status=(value:string)=>{html.dataset.opticalEngine=value;setReady(value==='webgl');};
  const init=()=>{
   try{
    const engine=new CrystalRenderer(canvas),gl=engine.gl;maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const ext=gl.getExtension('WEBGL_debug_renderer_info');capability=ext?String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER));
    if(settings.quality==='auto'&&(/swiftshader|llvmpipe|software/i.test(capability)||maxTexture<4096||navigator.hardwareConcurrency<=2)){effective='economy';engine.dispose();renderer.current=null;status('css');}
    else{renderer.current=engine;status('webgl');}
   }catch(error){canvas.width=canvas.height=1;status('css');console.warn('Glass: usando material CSS.',String(error));}
  };
  if(!disabled)init();else{effective='economy';status('css');}
  html.dataset.glassQuality=effective;
  const render=(now:number)=>{
   raf=0;clearTimeout(timer);timer=0;if(disposed||document.hidden||!windowVisible)return;
   const {settings:s,lab:open}=current.current;
   const cap=effective==='high'?2:effective==='economy'?1:1.5;
   const dpr=Math.min(devicePixelRatio,cap,maxTexture/Math.max(root.clientWidth,root.clientHeight));
   const w=Math.max(1,Math.round(root.clientWidth*dpr)),h=Math.max(1,Math.round(root.clientHeight*dpr));
   if(scene.width!==w||scene.height!==h){scene.width=w;scene.height=h;dirtyScene=true;}
   const blend=reduced||performanceMode?1:Math.min(1,Math.max(0,(now-palette.current.start)/900));
   if(blend<1||palette.current.value!==palette.current.to){palette.current.value=blend===1?palette.current.to:mixPalette(palette.current.from,palette.current.to,blend*blend*(3-2*blend));dirtyScene=true;}
   if(dirtyScene&&(s.background!=='desktop'||open))drawBackground(scene,root,html.dataset.theme==='light',s,palette.current.value,custom.current,reduced||performanceMode?0:now,open,poster.current);
   const opacity=open?s.opacity:useApp.getState().data.preferences.glass/100;
   const tint=open?s.tint:surfaceTint(s,html.dataset.theme==='light');
   root.style.setProperty('--appearance-tint',tint);
   renderer.current?.draw(scene,root,{...s,quality:effective,opacity,tint},light,dirtyScene,open);dirtyScene=false;lastFrame=now;
   (window as unknown as {__glassOptics:unknown}).__glassOptics={mode:html.dataset.opticalEngine,quality:effective,gpu:capability,draws:renderer.current?.draws||0,uploads:renderer.current?.uploads||0,lastDrawMs:renderer.current?.lastDrawMs||0,contexts:renderer.current?1:0,source:[w,h],lab:open,palette:palette.current.value,paletteStats:{...paletteStats}};
   if((!reduced&&!performanceMode&&s.backgroundMotion>0&&s.background!=='desktop'&&s.background!=='custom')||(open&&!reduced&&!performanceMode)||(blend<1&&s.background==='dynamic'))timer=window.setTimeout(()=>{dirtyScene=true;request();},Math.max(8,(open?33:66)-(performance.now()-now)));
   else if(now<settleUntil)raf=requestAnimationFrame(render);
  };
  const request=(sceneDirty=false,settle=false)=>{dirtyScene ||=sceneDirty;if(settle)settleUntil=performance.now()+340;if(!raf&&!document.hidden&&windowVisible)raf=requestAnimationFrame(render);};
  invalidate.current=(sceneDirty=true)=>request(sceneDirty,true);
  const resize=()=>request(true,true),layout=()=>request(false,true),visibility=()=>{html.dataset.opticalVisible=String(windowVisible&&!document.hidden);if(document.hidden||!windowVisible){cancelAnimationFrame(raf);clearTimeout(timer);raf=0;timer=0;}else request(true,true);};
  const offVisibility=window.glass.onVisualVisibility(visible=>{windowVisible=visible;visibility();});
  void window.glass.visualState().then(visible=>{if(!disposed){windowVisible=visible;visibility();}}).catch(()=>{});
  const pointer=(event:PointerEvent)=>{if(reduced||effective==='economy'||!event.target||!(event.target as Element).closest('[data-optic],.play-main'))return;if(performance.now()-lastFrame<33)return;const x=(event.clientX/innerWidth-.5)*1.1,y=-.8+(event.clientY/innerHeight-.5)*.35,len=Math.hypot(x,y);light=[x/len,y/len];request();};
  const observer=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.attributeName==='class'||r.attributeName==='data-optic'))request(!!current.current.lab,true);});
  observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class','data-optic']});
  const sizing=new ResizeObserver(resize);sizing.observe(root);
  const theme=new MutationObserver(()=>request(true,true));theme.observe(html,{attributes:true,attributeFilter:['data-theme']});
  root.addEventListener('scroll',layout,{capture:true,passive:true});root.addEventListener('click',layout);root.addEventListener('pointermove',pointer,{passive:true});document.addEventListener('visibilitychange',visibility);
  const lost=(e:Event)=>{e.preventDefault();renderer.current=null;status('css');request(true);};
  const restored=()=>{if(!disposed&&!disabled){init();request(true,true);}};
  canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);request(true,true);
  return()=>{disposed=true;invalidate.current=()=>{};offVisibility();cancelAnimationFrame(raf);clearTimeout(timer);observer.disconnect();sizing.disconnect();theme.disconnect();root.removeEventListener('scroll',layout,true);root.removeEventListener('click',layout);root.removeEventListener('pointermove',pointer);document.removeEventListener('visibilitychange',visibility);canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);renderer.current?.dispose();renderer.current=null;};
 },[disabled,reduced,performanceMode,settings.quality]);
 const setSettings=(patch:Partial<OpticalSettings>)=>{const next=normalizeOptics({...settings,...patch});void useApp.getState().setPreferences({appearance:{...next}});};
 const windowPreset=materialPresets[settings.material];
 return <Context.Provider value={{settings,setSettings,lab,setLab,reduced}}><MotionConfig reducedMotion={reduced?'always':'never'} transition={{duration:reduced?0:.3,ease:[.22,1,.36,1]}}><div className={`optical-root ${ready?'engine-ready':''}`} data-background={settings.background} style={{'--lab-blur':`${settings.blur}px`,'--lab-saturation':`${settings.saturation*100}%`,'--appearance-opacity':glass/100,'--appearance-blur-scale':windowPreset.blur,'--appearance-blur':`${performanceMode?0:settings.blur}px`,'--appearance-specular':settings.specular,'--appearance-saturation':`${settings.background==='desktop'?100:settings.saturation*100}%`,'--glass-tint':settings.tint,'--glass-opacity':settings.opacity} as React.CSSProperties}><canvas ref={source} className="optical-scene" aria-hidden="true"/><canvas ref={surface} className="optical-surfaces" aria-hidden="true"/><div className="glass-material optical-window-material" data-window-material data-optic="auto" data-material={settings.material} data-crystal={windowPreset.crystal} aria-hidden="true"/>{children}</div></MotionConfig></Context.Provider>;
}
