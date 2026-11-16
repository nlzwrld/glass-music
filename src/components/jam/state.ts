import { create } from 'zustand';
import type { JamRoom, JamSession } from '../../../shared/jam';
import { JamClient, sendJam } from '../../lib/jam';
import { useApp,cleanError } from '../../stores/app';
export const jamClient=new JamClient();
interface State {session:JamSession|null;room:JamRoom|null;busy:boolean;error:string;connected:boolean;endpoint:string;configured:boolean;refresh():Promise<void>;enter(action:'create'|'createLocal'|'join',name:string,code?:string,endpoint?:string):Promise<void>;leave():Promise<void>}
export const useJam=create<State>((set,get)=>({
 session:null,room:null,busy:false,error:'',connected:false,endpoint:'',configured:false,
 refresh:async()=>{try{const config=await sendJam<{endpoint:string;configured:boolean}>({action:'status'});set(config);}catch(e){set({configured:false,error:cleanError(e)});}},
 enter:async(action,name,code,endpoint)=>{if(get().busy||get().session)return;set({busy:true,error:''});try{const session=await jamClient.enter(action,name,code,endpoint);set({session,room:session,connected:true});}catch(e){set({error:cleanError(e)});}finally{set({busy:false});}},
 leave:async()=>{const wasGuest=!!get().session&&!get().session?.host;set({session:null,room:null,connected:false,error:''});try{await jamClient.leave();}catch{}if(wasGuest)useApp.getState().message('Você saiu da JAM. A reprodução voltou ao seu controle.');}
}));
