import type {Preferences} from '../../shared/types';

type OutputContext=AudioContext&{setSinkId?(id:string):Promise<void>};
type DevicePicker=MediaDevices&{selectAudioOutput?():Promise<MediaDeviceInfo>};
export async function audioOutputDevices(){
 const devices=await navigator.mediaDevices?.enumerateDevices()||[];
 return devices.filter(d=>d.kind==='audiooutput');
}
export async function requestAudioOutput(){
 const picker=navigator.mediaDevices as DevicePicker;
 if(!picker?.selectAudioOutput)throw new Error('Selecione a saída de som nas configurações de som do Windows.');
 return picker.selectAudioOutput();
}
export function transitionSeconds(value:number){return Math.min(10,Math.max(.5,Number.isFinite(value)?value:3));}
export function boostedGain(volume:number,boost:number){return Math.min(1,Math.max(0,volume/100))*10**(Math.min(12,Math.max(0,boost||0))/20);}

export class AudioGraph{
 readonly context:OutputContext;
 readonly decks=new Map<HTMLAudioElement,GainNode>();
 private filters:BiquadFilterNode[];
 private boost:GainNode;
 private limiter:DynamicsCompressorNode;
 private limited=false;
 private sink='default';
 constructor(){
  this.context=new AudioContext({latencyHint:'interactive'});
  this.filters=[60,230,910,3600,14000].map(f=>{const node=this.context.createBiquadFilter();node.type='peaking';node.frequency.value=f;node.Q.value=.8;return node;});
  this.boost=this.context.createGain();this.limiter=this.context.createDynamicsCompressor();
  this.limiter.threshold.value=-1;this.limiter.knee.value=0;this.limiter.ratio.value=20;this.limiter.attack.value=.002;this.limiter.release.value=.08;
  this.filters.forEach((f,i)=>f.connect(this.filters[i+1]||this.boost));
  this.boost.connect(this.context.destination);
 }
 attach(element:HTMLAudioElement){
  if(this.decks.has(element))return;
  const gain=this.context.createGain();this.context.createMediaElementSource(element).connect(gain);gain.connect(this.filters[0]);this.decks.set(element,gain);
 }
 level(element:HTMLAudioElement,value:number,seconds=0){
  const gain=this.decks.get(element)?.gain;if(!gain)return;
  const time=this.context.currentTime;gain.cancelAndHoldAtTime(time);
  if(seconds>0)gain.linearRampToValueAtTime(value,time+seconds);else gain.setValueAtTime(value,time);
 }
 async configure(p:Preferences){
  const time=this.context.currentTime;
  this.filters.forEach((f,i)=>f.gain.setTargetAtTime(p.eq[i]||0,time,.025));
  this.boost.gain.setTargetAtTime(boostedGain(p.volume,p.volumeBoost),time,.025);
  if(p.limiter!==this.limited){
   this.boost.disconnect();this.limiter.disconnect();this.limited=p.limiter;
   if(this.limited){this.boost.connect(this.limiter);this.limiter.connect(this.context.destination);}else this.boost.connect(this.context.destination);
  }
  const output=p.outputDevice||'default';
  if(output!==this.sink){
   if(!this.context.setSinkId&&output!=='default')throw new Error('Esta versão do Windows usa a saída padrão de som.');
   if(this.context.setSinkId)await this.context.setSinkId(output==='default'?'':output);
   this.sink=output;
  }
 }
 async resume(){await this.context.resume();}
 close(){return this.context.close();}
}
