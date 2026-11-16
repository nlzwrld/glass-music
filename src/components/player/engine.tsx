import { useEffect, useRef } from 'react';
import { useApp, currentTrack, cleanError } from '../../stores/app';
import type { Track } from '../../../shared/types';
import {preparePlayback,invalidatePlayback} from '../../lib/playback';
import { nativeResource } from '../../lib/native';
import {AudioGraph,transitionSeconds} from '../../lib/audioGraph';

type Driver = { play(): void; pause(): void; seek(n: number): void; volume(n: number): void };
let driver: Driver | undefined;
export const transport = {
  toggle: () => { if (!currentTrack()) return; useApp.getState().playing ? driver?.pause() : driver?.play(); },
  pause: () => driver?.pause(), seek: (n: number) => driver?.seek(n), volume: (n: number) => driver?.volume(n)
};
function upcomingTrack():Track|undefined{
 const s=useApp.getState(),p=s.data.preferences;
 if(p.repeat==='one')return s.queue[s.index];
 if(p.shuffle)return; // The shuffled selection is chosen at the moment of advancing.
 return s.queue[s.index+1]||(p.repeat==='all'?s.queue[0]:undefined);
}
export function PlayerEngine() {
  const first=useRef<HTMLAudioElement>(null),second=useRef<HTMLAudioElement>(null),iframe=useRef<HTMLIFrameElement>(null);
  const activeDeck=useRef(0),graph=useRef<AudioGraph|undefined>(undefined),retire=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const track=useApp(s=>s.queue[s.index]),revision=useApp(s=>s.revision),preferences=useApp(s=>s.data.preferences),queue=useApp(s=>s.queue),index=useApp(s=>s.index);
  const consent=preferences.onlineConsent&&preferences.onboardingDone;
  const playbackAllowed=track?.source==='local'||track?.offline||consent;
  const activeGeneration=useRef(0);
  const elements=()=>[first.current!,second.current!];
  const setupGraph=()=>{
   if(!graph.current){graph.current=new AudioGraph();elements().forEach(el=>graph.current!.attach(el));}
   void graph.current.configure(useApp.getState().data.preferences).catch(e=>useApp.getState().message(cleanError(e)));
   void graph.current.resume();return graph.current;
  };
  useEffect(()=>{if(!consent)invalidatePlayback();},[consent]);
  useEffect(()=>{
    const generation=++activeGeneration.current,all=elements();clearTimeout(retire.current);
    const former=all[activeDeck.current],hadPrevious=former.hasAttribute('src'),canContinue=!!track&&playbackAllowed&&preferences.transition==='crossfade'&&track.source!=='soundcloud'&&hadPrevious&&!former.paused;
    const outgoing=canContinue?former:undefined;
    const selected=canContinue?1-activeDeck.current:activeDeck.current;activeDeck.current=selected;
    const el=all[selected],frame=iframe.current!;let cancelled=false,recorded=false,advanced=false,started=false,pausedDuringPreparation=false,frameOrigin='',resolvedTrack=track;
    let preparation:ReturnType<typeof preparePlayback>|undefined;
    all.forEach((deck,i)=>{deck.dataset.active=String(i===selected);if(deck!==outgoing){deck.pause();deck.removeAttribute('src');deck.load();}});
    frame.src='about:blank';driver=undefined;
    const update=(state:Partial<ReturnType<typeof useApp.getState>>)=>{if(!cancelled&&generation===activeGeneration.current)useApp.setState(state);};
    const stopOutgoing=()=>{if(outgoing){outgoing.pause();graph.current?.level(outgoing,0);}};
    const fail=(message:string)=>{stopOutgoing();update({error:message,playing:false,status:'Indisponível'});};
    const onPlay=()=>{
      if(cancelled)return;
      if(!started){
       started=true;const p=useApp.getState().data.preferences,g=graph.current;
       if(g){
        const duration=p.transition==='off'?0:hadPrevious?transitionSeconds(p.transitionSeconds):.12;
        if(outgoing&&p.transition==='crossfade'){
         g.level(el,0);g.level(el,1,duration);g.level(outgoing,0,duration);retire.current=setTimeout(stopOutgoing,duration*1000+40);
        }else{stopOutgoing();g.level(el,p.transition==='off'?1:0);g.level(el,1,duration);}
       }else stopOutgoing();
      }
      update({playing:true,status:'Reproduzindo',error:''});
      if(!recorded&&resolvedTrack){recorded=true;void useApp.getState().mutate({action:'history',track:resolvedTrack}).catch(()=>{});void window.glass.notify({title:resolvedTrack.title,artist:resolvedTrack.artist});}
    };
    const onPause=()=>update({playing:false,status:'Pausado'});
    const onTime=()=>{
      const duration=Number.isFinite(el.duration)?el.duration:track?.duration||0;
      update({position:el.currentTime,duration});
      const p=useApp.getState().data.preferences,remaining=duration-el.currentTime;
      if(duration>0&&el.currentTime>0&&!el.paused&&!advanced&&remaining>0){
       const seconds=transitionSeconds(p.transitionSeconds);
       if(p.transition==='crossfade'&&remaining<=seconds&&upcomingTrack()){
        advanced=true;useApp.getState().next(false);
       }else if(p.transition==='fade'&&remaining<=seconds)graph.current?.level(el,0,remaining);
      }
    };
    const onEnded=()=>{if(!advanced){advanced=true;useApp.getState().next(false);}};
    const onError=()=>{if(track)invalidatePlayback(track.id);if(el.hasAttribute('src'))fail(track?.source!=='local'?'O áudio não pôde ser carregado. Tente reproduzir novamente.':'Não foi possível abrir o arquivo de áudio.');};
    const message=(e:MessageEvent)=>{
      if(e.origin!==frameOrigin||e.source!==frame.contentWindow||e.data?.channel!=='glass-player'||cancelled)return;
      const d=e.data;if(d.type==='playing')onPlay();if(d.type==='paused')onPause();if(d.type==='ended')onEnded();if(d.type==='buffering')update({status:'Carregando'});
      if(d.type==='ready')driver?.volume(useApp.getState().data.preferences.volume);
      if(d.type==='time'&&Number.isFinite(d.position)&&Number.isFinite(d.duration))update({position:Math.max(0,d.position),duration:Math.max(0,d.duration)});
      if(d.type==='error')fail(String(d.message).slice(0,500));if(d.type==='blocked'){onPause();useApp.getState().message(String(d.message));}
    };
    el.addEventListener('playing',onPlay);el.addEventListener('pause',onPause);el.addEventListener('timeupdate',onTime);el.addEventListener('loadedmetadata',onTime);el.addEventListener('ended',onEnded);el.addEventListener('error',onError);window.addEventListener('message',message);
    if(track&&track.available!==false){
      if(track.source==='local'||(['youtube','link'].includes(track.source)&&playbackAllowed)){
        const play=()=>{
          pausedDuringPreparation=false;if(!el.hasAttribute('src'))return;
          setupGraph();void el.play().catch(e=>{if(e.name==='NotAllowedError'){onPause();useApp.getState().message('Clique em reproduzir para iniciar o áudio.');}else if(e.name!=='AbortError')fail('Falha ao reproduzir o áudio.');});
        };
        el.volume=1;setupGraph().level(el,0);
        driver={play,pause:()=>{pausedDuringPreparation=true;all.forEach(deck=>deck.pause());},seek:n=>{if(Number.isFinite(el.duration)){el.currentTime=Math.max(0,Math.min(n,el.duration));if(useApp.getState().data.preferences.transition==='fade')graph.current?.level(el,1,.08);}},volume:n=>{if(graph.current)void graph.current.configure({...useApp.getState().data.preferences,volume:n}).catch(()=>{});}};
        if(track.source==='local'){el.src=nativeResource(`media/${encodeURIComponent(track.id)}`);play();}
        else{
          preparation=preparePlayback(track);
          void preparation.promise.then(({track:matched,source})=>{
            if(cancelled)return;resolvedTrack=matched;
            if(track.source==='link'&&track.playbackId!==matched.playbackId){
             update({queue:useApp.getState().queue.map(t=>t.id===matched.id?matched:t)});void useApp.getState().mutate({action:'save',track:matched}).catch(()=>{});
            }
            update({duration:source.duration||track.duration});el.src=source.url;
            if(!pausedDuringPreparation)play();else stopOutgoing();
          }).catch(error=>{if(!cancelled)fail(cleanError(error));});
        }
      }else if(playbackAllowed&&track.source==='soundcloud'){
        stopOutgoing();void window.glass.playerUrl().then(url=>{
          if(cancelled)return;frameOrigin=new URL(url).origin;
          const send=(action:string,value?:number)=>frame.contentWindow?.postMessage({channel:'glass-control',action,value},frameOrigin);
          driver={play:()=>send('play'),pause:()=>send('pause'),seek:n=>send('seek',n),volume:n=>send('volume',n)};
          frame.src=`${url}?${new URLSearchParams({parent:location.origin,provider:track.source,ref:track.url!,volume:String(useApp.getState().data.preferences.volume)})}`;
        }).catch(e=>fail(cleanError(e)));
      }else fail('Ative o acesso online nas configurações ou baixe esta faixa.');
    }else{stopOutgoing();if(track)fail(track.reason||'Faixa indisponível.');}
    return()=>{
      cancelled=true;preparation?.release();el.removeEventListener('playing',onPlay);el.removeEventListener('pause',onPause);el.removeEventListener('timeupdate',onTime);el.removeEventListener('loadedmetadata',onTime);el.removeEventListener('ended',onEnded);el.removeEventListener('error',onError);window.removeEventListener('message',message);frame.src='about:blank';driver=undefined;
      // The following generation keeps this deck alive until the incoming audio is ready.
      // Older tails are always stopped when navigation interrupts an existing transition.
      if(outgoing)stopOutgoing();
    };
  },[track?.id,revision,playbackAllowed]);
  useEffect(()=>{
   const next=upcomingTrack();if(!next||!consent||!['youtube','link'].includes(next.source))return;
   const timeout=setTimeout(()=>{
    const warm=preparePlayback(next,false);release=warm.release;
    void warm.promise.then(({track:matched})=>{
     if(!alive||next.source!=='link'||next.playbackId===matched.playbackId)return;
     useApp.setState(s=>({queue:s.queue.map(t=>t.id===matched.id?matched:t)}));void useApp.getState().mutate({action:'save',track:matched}).catch(()=>{});
    }).catch(()=>{});
   },350);
   let alive=true,release:(()=>void)|undefined;
   return()=>{alive=false;clearTimeout(timeout);release?.();};
  },[track?.id,index,queue.length,consent,preferences.repeat,preferences.shuffle]);
  useEffect(()=>{if(graph.current)void graph.current.configure(preferences).catch(e=>useApp.getState().message(cleanError(e)));if(track?.source==='soundcloud')transport.volume(preferences.volume);},[preferences]);
  useEffect(()=>()=>{clearTimeout(retire.current);elements().forEach(el=>el?.pause());void graph.current?.close();graph.current=undefined;},[]);
  useEffect(()=>{
    const off=window.glass.onMedia(command=>{if(command==='playPause')transport.toggle();if(command==='next')useApp.getState().next();if(command==='previous')useApp.getState().previous();});
    const key=(e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName)||target.isContentEditable||useApp.getState().dialog)return;if(e.code==='Space'){e.preventDefault();transport.toggle();}if(e.altKey&&e.code==='ArrowRight')useApp.getState().next();if(e.altKey&&e.code==='ArrowLeft')useApp.getState().previous();};
    window.addEventListener('keydown',key);return()=>{off();window.removeEventListener('keydown',key);};
  },[]);
  useEffect(()=>{
    if(!('mediaSession'in navigator)||!track)return;
    navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album||'Glass Music'});
    const actions:[MediaSessionAction,()=>void][]=[['play',()=>driver?.play()],['pause',()=>driver?.pause()],['nexttrack',()=>useApp.getState().next()],['previoustrack',()=>useApp.getState().previous()]];
    actions.forEach(([name,action])=>{try{navigator.mediaSession.setActionHandler(name,action);}catch{}});return()=>{actions.forEach(([name])=>{try{navigator.mediaSession.setActionHandler(name,null);}catch{}});};
  },[track?.id]);
  const external=track?.source==='soundcloud';
  return <><audio ref={first} data-active={activeDeck.current===0?'true':'false'} crossOrigin="anonymous" preload="auto"/><audio ref={second} data-active={activeDeck.current===1?'true':'false'} crossOrigin="anonymous" preload="auto"/><section className={`official-player ${external?'visible':''}`} aria-label="Áudio SoundCloud" aria-hidden={!external}><iframe ref={iframe} title="Áudio SoundCloud" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups"/></section></>;
}
