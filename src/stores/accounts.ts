import { create } from 'zustand';
import type { AccountStatus } from '../../shared/types';
import { cleanError, useApp } from './app';
type Provider = AccountStatus['provider'];
interface State {
  accounts: AccountStatus[]; busy: string; notice: string;
  refresh(): Promise<void>; configure(): Promise<void>; connect(id: Provider): Promise<void>;
  sync(id: Provider, quiet?: boolean): Promise<void>; disconnect(id: Provider): Promise<void>; cancel(): Promise<void>;
}
const permitted = () => { const p=useApp.getState().data.preferences;return p.onlineConsent&&p.catalogConsent&&p.onboardingDone; };
const commit = (result: Awaited<ReturnType<typeof window.glass.syncAccount>>) => {
  useApp.setState({data:{...result.snapshot,preferences:useApp.getState().data.preferences}});
};
export const useAccounts=create<State>((set,get)=>({
  accounts:[],busy:'',notice:'',
  refresh:async()=>{try{set({accounts:await window.glass.accounts()});}catch(e){set({notice:cleanError(e)});}},
  configure:async()=>{if(get().busy)return;set({busy:'configure',notice:''});try{set({accounts:await window.glass.configureAccounts()});}catch(e){set({notice:cleanError(e)});}finally{set({busy:''});}},
  connect:async id=>{if(get().busy||!permitted())return;set({busy:`connect:${id}`,notice:'Autorize a conta no navegador e volte ao Glass.'});try{
    set({accounts:await window.glass.connectAccount(id),notice:'Importando playlists e curtidas…',busy:`sync:${id}`});
    const result=await window.glass.syncAccount(id);commit(result);set({accounts:result.accounts,notice:`${result.playlists} playlists sincronizadas.`});
  }catch(e){set({notice:cleanError(e)});await get().refresh();}finally{set({busy:''});}},
  sync:async(id,quiet=false)=>{if(get().busy||!permitted())return;set({busy:`sync:${id}`,...(!quiet?{notice:'Sincronizando…'}:{})});try{
    const result=await window.glass.syncAccount(id);commit(result);set({accounts:result.accounts,notice:quiet?'':`${result.playlists} playlists sincronizadas.`});
  }catch(e){set({notice:cleanError(e)});}finally{set({busy:''});}},
  disconnect:async id=>{if(get().busy)return;set({busy:`disconnect:${id}`,notice:''});try{set({accounts:await window.glass.disconnectAccount(id),notice:'Conta desconectada. As músicas importadas continuam no Glass.'});}catch(e){set({notice:cleanError(e)});}finally{set({busy:''});}},
  cancel:async()=>{await window.glass.cancelAccount();set({notice:'Cancelando…'});}
}));
export async function autoSyncAccounts(){
  if(!permitted()||useAccounts.getState().busy)return;
  await useAccounts.getState().refresh();
  for(const account of useAccounts.getState().accounts){
    if(!permitted())break;
    if(account.connected&&Date.now()-account.lastSync>=30*60*1000)await useAccounts.getState().sync(account.provider,true);
  }
}
