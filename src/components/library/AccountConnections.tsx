import { useEffect } from 'react';
import { Link2, RefreshCw, Unplug, LoaderCircle } from 'lucide-react';
import { useApp } from '../../stores/app';
import { useAccounts } from '../../stores/accounts';
const names={youtube:'YouTube',soundcloud:'SoundCloud',spotify:'Spotify'};
export default function AccountConnections(){
 const {accounts,busy,notice,refresh,configure,connect,sync,disconnect,cancel}=useAccounts();
 const p=useApp(s=>s.data.preferences),online=p.onlineConsent&&p.catalogConsent&&p.onboardingDone;
 useEffect(()=>{void refresh();},[refresh]);
 return <section className="settings-section account-connections"><h2>Contas</h2>
 {accounts.map(a=><div className="setting-row account-row" key={a.provider} data-provider={a.provider}>
  <div><strong>{names[a.provider]}</strong><small>{a.connected?(a.name||'Conectada'):a.configured?'Desconectada':'Indisponível'}</small>{a.lastSync>0&&<small>Atualizada em {new Date(a.lastSync).toLocaleString()}</small>}</div>
  <div className="account-actions">{a.connected?<><button className="button secondary" aria-label={`Sincronizar ${names[a.provider]}`} disabled={!!busy||!online} onClick={()=>void sync(a.provider)}><RefreshCw size={15}/>Sincronizar</button><button className="icon-button" aria-label={`Desconectar ${names[a.provider]}`} title="Desconectar" disabled={!!busy} onClick={()=>void disconnect(a.provider)}><Unplug size={17}/></button></>:<button className="button secondary" aria-label={`Conectar ${names[a.provider]}`} disabled={!!busy||!online||!a.configured} title={!a.configured?a.reason:undefined} onClick={()=>void connect(a.provider)}><Link2 size={15}/>Conectar</button>}</div>
 </div>)}
 {!online&&<p className="fine-print">Ative o acesso online para conectar.</p>}
 {notice&&<p className="account-notice" role="status">{busy&&<LoaderCircle size={14} className="spinner"/>}{notice}</p>}
 {(busy.startsWith('connect:')||busy.startsWith('sync:'))&&<button className="text-button" onClick={()=>void cancel()}>Cancelar</button>}
 <details className="account-setup"><summary>Ativar conexões do Glass</summary><p className="fine-print">Contas exigem o cadastro do aplicativo. Playlists públicas podem ser importadas por link.</p><button className="text-button" disabled={!!busy} onClick={()=>void configure()}>Carregar cadastro do aplicativo…</button></details>
 </section>;
}
