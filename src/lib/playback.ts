import type {Track} from '../../shared/types';
import {useApp} from '../stores/app';
type Prepared={track:Track;source:{url:string;duration:number}};
type Job={id:string;users:number;warm:number;cancelled:boolean;done:boolean;created:number;promise:Promise<Prepared>};
const jobs=new Map<string,Job>();
function cancel(key:string,job:Job){job.cancelled=true;if(!job.done)void window.glass.cancelSearch(job.id);if(jobs.get(key)===job)jobs.delete(key);}
export function invalidatePlayback(id?:string){
 for(const [key,job]of jobs)if(!id||key===id)cancel(key,job);
}
export function preparePlayback(track:Track,active=true){
 if(active)for(const [key,job]of jobs)if(key!==track.id&&!job.done&&job.users===0)cancel(key,job);
 let job=jobs.get(track.id);
 if(job&&(job.cancelled||Date.now()-job.created>240000)){cancel(track.id,job);job=undefined;}
 if(!job){
  const created:Job={id:crypto.randomUUID(),users:0,warm:0,cancelled:false,done:false,created:Date.now(),promise:undefined!};
  created.promise=(async()=>{
   if(track.offline){
    const source=await window.glass.offlineSource(track.id);
    if(created.cancelled)throw new Error('Preparação cancelada.');
    if(source){created.done=true;return {track,source};}
    const p=useApp.getState().data.preferences;
    if(!p.onlineConsent||!p.onboardingDone)throw new Error('O arquivo offline não está disponível neste dispositivo.');
   }
   const matched=track.source==='link'&&!track.playbackId?await window.glass.linkPlayback(track,created.id):track;
   if(created.cancelled)throw new Error('Preparação cancelada.');
   const source=await window.glass.audioSource(matched.playbackId||matched.sourceId,created.id);
   if(created.cancelled)throw new Error('Preparação cancelada.');
   created.done=true;return {track:matched,source};
  })().catch(error=>{if(jobs.get(track.id)===created)jobs.delete(track.id);throw error;});
  // A speculative request may have no remaining consumer when it rejects.
  void created.promise.catch(()=>{});jobs.set(track.id,created);job=created;
  if(jobs.size>24)for(const [key,entry]of jobs){if(entry.users===0&&entry.warm===0&&entry.done){jobs.delete(key);if(jobs.size<=24)break;}}
 }
 const current=job;if(active)current.users++;else current.warm++;
 let released=false;
 return {promise:current.promise,release:()=>{if(released)return;released=true;if(active)current.users--;else current.warm--;if(current.users===0&&current.warm===0&&!current.done)cancel(track.id,current);}};
}
let warmTimer:ReturnType<typeof setTimeout>|undefined,warmStop:ReturnType<typeof setTimeout>|undefined,warmKey='',releaseWarm:(()=>void)|undefined;
export function warmTrack(track:Track){
 const p=useApp.getState().data.preferences;
 if(!p.onlineConsent||!p.onboardingDone||!['youtube','link'].includes(track.source)||track.kind!=='track')return;
 clearTimeout(warmStop);if(warmKey===track.id)return;
 clearTimeout(warmTimer);releaseWarm?.();releaseWarm=undefined;warmKey=track.id;
 warmTimer=setTimeout(()=>{const job=preparePlayback(track,false);releaseWarm=job.release;},220);
}
export function cancelWarmTrack(){
 clearTimeout(warmTimer);warmStop=setTimeout(()=>{releaseWarm?.();releaseWarm=undefined;warmKey='';},500);
}
