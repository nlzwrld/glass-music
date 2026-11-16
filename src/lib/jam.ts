import { invoke } from '@tauri-apps/api/core';
import type { JamRequest, JamRoom, JamSession } from '../../shared/jam';
export type JamSend = <T>(request: JamRequest | {action:'status'}) => Promise<T>;
export const sendJam: JamSend = request => invoke('call',{action:'jam',payload:request});
export function parseJamInvite(value:string,defaultEndpoint=''){
 const clean=value.trim().replace(/\s/g,'');if(/^[A-F0-9]{10}$/i.test(clean))return{code:clean.toUpperCase(),endpoint:defaultEndpoint};
 try{const url=new URL(clean),code=new URLSearchParams(url.hash.slice(1)).get('jam')||'';if(/^[A-F0-9]{10}$/i.test(code)&&!url.username&&!url.password&&url.pathname==='/')return{code:code.toUpperCase(),endpoint:url.origin};}catch{}
 return{code:'',endpoint:''};
}

/** Clock sample uses the request midpoint; prefer faster samples to reduce queueing bias. */
export class JamClock {
  offset=0; private best=Number.POSITIVE_INFINITY;
  sample(start:number,end:number,serverTime:number) {
    const roundTrip=Math.max(0,end-start),offset=serverTime-(start+end)/2;
    if (!Number.isFinite(offset)) return;
    if (roundTrip <= this.best*1.5) { this.offset=Number.isFinite(this.best)?this.offset*.3+offset*.7:offset;this.best=Math.min(this.best,roundTrip); }
    else this.best=Math.min(this.best*1.1,roundTrip);
  }
  now(){return Date.now()+this.offset;}
}
export class JamClient {
  session:JamSession|null=null;readonly clock=new JamClock();
  constructor(private send:JamSend=sendJam){}
  private async request<T extends {serverTime:number}>(request:JamRequest){const start=Date.now(),value=await this.send<T>(request);this.clock.sample(start,Date.now(),value.serverTime);return value;}
  async enter(action:'create'|'createLocal'|'join',name:string,code?:string,endpoint?:string){const session=await this.request<JamSession>({action,name,code,endpoint});this.session=session;return session;}
  async update(playback?:JamRequest['playback']){const s=this.session;if(!s)throw new Error('Entre em uma JAM.');
   const t=playback?.track,clean=t?{id:t.id,source:t.source,sourceId:t.sourceId,kind:t.kind,title:t.title,artist:t.artist,duration:t.duration,url:t.url,artwork:t.artwork,playbackId:t.playbackId,addedAt:0}:null;
   return this.request<JamRoom>({action:s.host?'sync':'poll',code:s.code,token:s.token,endpoint:s.endpoint,...(s.host?{playback:playback?{...playback,track:clean}:undefined}: {})});}
  async leave(){const s=this.session;this.session=null;if(s)await this.request<{serverTime:number}>({action:'leave',code:s.code,token:s.token,endpoint:s.endpoint});}
}
