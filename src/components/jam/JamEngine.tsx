import { useEffect } from 'react';
import { jamPosition,canJam,type JamRoom } from '../../../shared/jam';
import { useApp,cleanError } from '../../stores/app';
import { transport } from '../player/engine';
import { jamClient,useJam } from './state';

export function JamEngine(){
 const session=useJam(s=>s.session),consent=useApp(s=>s.data.preferences.onlineConsent&&s.data.preferences.onboardingDone);
 useEffect(()=>{
  if(!session)return;
  if(!consent){void useJam.getState().leave();transport.pause();return;}
  let disposed=false,timer:ReturnType<typeof setTimeout>,room:JamRoom|null=null,lastSeek=0,changing='',lastSuccess=Date.now(),followTimer:ReturnType<typeof setTimeout>;
  const follow=()=>{
   if(disposed||session.host||!room)return;
   const target=room.playback,s=useApp.getState(),current=s.queue[s.index];
   if(!target.track){if(s.playing)transport.pause();return;}
   if(current?.id!==target.track.id){if(changing!==target.track.id){changing=target.track.id;lastSeek=0;useApp.getState().play(target.track);}return;}
   changing='';
   // A stream that is still preparing will align as soon as it reports readiness.
   if(s.status==='Carregando'||s.status==='Preparando áudio')return;
   if(!target.playing&&s.playing)transport.pause();else if(target.playing&&!s.playing&&!s.error)transport.toggle();
   const position=jamPosition(target,jamClient.clock.now());
   if(Math.abs(position-s.position)>.85&&Date.now()-lastSeek>1800){lastSeek=Date.now();transport.seek(position);}
  };
  const off=useApp.subscribe((state,previous)=>{
   if(session.host)return;
   if(state.playing!==previous.playing||state.status!==previous.status||state.queue[state.index]?.id!==previous.queue[previous.index]?.id){clearTimeout(followTimer);followTimer=setTimeout(follow,0);}
  });
  const tick=async()=>{
   try{
    const s=useApp.getState(),track=s.queue[s.index],shared=canJam(track)?track:null;
    const value=await jamClient.update(session.host?{track:shared,playing:!!shared&&s.playing,position:shared?s.position:0}:undefined);
    if(disposed)return;room=value;lastSuccess=Date.now();useJam.setState({room:value,connected:true,error:''});follow();
   }catch(e){if(disposed)return;const error=cleanError(e);useJam.setState({connected:false,error});if(Date.now()-lastSuccess>20000){if(!session.host)transport.pause();void useJam.getState().leave();useApp.getState().message(`JAM desconectada. ${error}`);return;}}
   if(!disposed)timer=setTimeout(()=>void tick(),900);
  };
  void tick();return()=>{disposed=true;clearTimeout(timer);clearTimeout(followTimer);off();};
 },[session?.token,consent]);
 return null;
}
