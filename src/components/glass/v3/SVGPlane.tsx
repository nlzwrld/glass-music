import { useEffect, useId, useRef, useState } from 'react';
import { displacementMap } from '../refraction';
import { crystals,materialPresets,type Crystal } from './model';
import { useOptics } from './OpticalEngine';
export default function SVGPlane({variant='regular'}:{variant?:Crystal}){
 const id=`optics-${useId().replace(/[^a-z0-9]/gi,'')}`,ref=useRef<HTMLSpanElement>(null),[map,setMap]=useState<{url:string;width:number;height:number}>();
 const {settings:s,lab}=useOptics(),preset=lab?crystals[variant]:materialPresets[s.material];
 useEffect(()=>{
  const host=ref.current?.parentElement;if(!host)return;let timer=0;
  const update=()=>{const w=Math.round(host.clientWidth),h=Math.round(host.clientHeight);if(w&&h)setMap({url:displacementMap(w,h,parseFloat(getComputedStyle(host).borderTopLeftRadius)||20,s.thickness*preset.thickness),width:w,height:h});};
  update();const observer=new ResizeObserver(()=>{clearTimeout(timer);timer=window.setTimeout(update,80);});observer.observe(host);return()=>{observer.disconnect();clearTimeout(timer);};
 },[s.thickness,preset]);
 return <span ref={ref} aria-hidden="true" className="svg-plane" style={{backdropFilter:map?`url(#${id}) saturate(${s.saturation})`:undefined}}>{map&&<svg width="0" height="0"><defs><filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB"><feImage href={map.url} width="100%" height="100%" preserveAspectRatio="none" result="normals"/><feDisplacementMap in="SourceGraphic" in2="normals" scale={s.refraction*preset.refraction*2} xChannelSelector="R" yChannelSelector="G" result="bent"/><feGaussianBlur in="bent" stdDeviation={s.blur*preset.blur*.16}/></filter></defs></svg>}</span>;
}
