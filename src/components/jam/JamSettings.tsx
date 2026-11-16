import { useEffect,useState } from 'react';
import { Check,Copy,Headphones,LogOut,Radio,Users } from 'lucide-react';
import { useApp,cleanError } from '../../stores/app';
import { canJam } from '../../../shared/jam';
import { useJam } from './state';
import { parseJamInvite } from '../../lib/jam';
import './jam.css';

export function JamSettings(){
 const jam=useJam(),consent=useApp(s=>s.data.preferences.onlineConsent&&s.data.preferences.onboardingDone),current=useApp(s=>s.queue[s.index]);
 const [name,setName]=useState(''),[code,setCode]=useState(''),[endpoint,setEndpoint]=useState(''),[advanced,setAdvanced]=useState(false),[copied,setCopied]=useState(false),[saving,setSaving]=useState(false);
 useEffect(()=>{void useJam.getState().refresh();},[]);
 useEffect(()=>{setEndpoint(jam.endpoint);},[jam.endpoint]);
 const invite=parseJamInvite(code,jam.endpoint);
 const save=async()=>{setSaving(true);try{await useApp.getState().setPreferences({jamEndpoint:endpoint.trim()} as Partial<ReturnType<typeof useApp.getState>['data']['preferences']>);await useJam.getState().refresh();}catch(e){useApp.getState().message(cleanError(e));}finally{setSaving(false);}};
 return <section className="jam-settings" aria-label="JAM"><header><Radio size={24}/><div><h2>JAM</h2><p>Ouça junto com até 7 amigos.</p></div></header>
 {!consent?<p>Permita o acesso online em Integrações para usar a JAM.</p>:jam.session?<>
  <div className="jam-room-code"><span>Código da sala<strong>{jam.session.code}</strong></span><button className="button secondary" aria-label="Copiar convite da JAM" onClick={()=>void navigator.clipboard.writeText(`${jam.session!.endpoint || jam.endpoint}/#jam=${jam.session!.code}`).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1800);}).catch(()=>useApp.getState().message('Não foi possível copiar o convite.'))}>{copied?<Check size={18}/>:<Copy size={18}/>}Copiar convite</button></div>
  <input className="input jam-invite" aria-label="Convite desta JAM" readOnly value={`${jam.session.endpoint||jam.endpoint}/#jam=${jam.session.code}`} onFocus={e=>e.currentTarget.select()}/>
  {jam.session.endpoint?.startsWith('http:')&&<p>JAM na rede local. Seu amigo deve estar na mesma rede e colar o convite no Glass.</p>}
  <div className="jam-status" role="status"><i data-connected={jam.connected}/>{jam.connected?'Conectado':'Reconectando…'} · {jam.session.host?'Você controla a reprodução':'A reprodução segue quem criou a sala'}</div>
  <div className="jam-members" aria-label="Pessoas na JAM">{jam.room?.members.map(member=><span key={member.id}><Headphones size={16}/>{member.name}{member.host&&<small>Anfitrião</small>}</span>)}</div>
  {jam.session.host&&current&&!canJam(current)&&<p>Escolha uma música online para os amigos acompanharem. Arquivos locais ficam no seu dispositivo.</p>}
  <button className="button secondary" onClick={()=>void jam.leave()}><LogOut size={17}/>{jam.session.host?'Encerrar JAM':'Sair da JAM'}</button>
 </>:<>
  <label className="field-label">Seu nome<input className="input" aria-label="Seu nome na JAM" maxLength={40} placeholder="Como seus amigos vão te ver" value={name} onChange={e=>setName(e.target.value)}/></label>
  <div className="jam-create"><button className="button primary" disabled={jam.busy||!name.trim()} onClick={()=>void jam.enter('createLocal',name)}><Radio size={17}/>{jam.busy?'Conectando…':'Criar na rede local'}</button>{jam.configured&&<button className="button secondary" disabled={jam.busy||!name.trim()} onClick={()=>void jam.enter('create',name)}>Criar no servidor online</button>}</div>
  <form className="jam-join" onSubmit={e=>{e.preventDefault();void jam.enter('join',name,invite.code,invite.endpoint);}}><label className="field-label">Convite ou código do amigo<input className="input" aria-label="Convite da JAM" maxLength={2200} autoCapitalize="off" spellCheck={false} placeholder="Cole o convite aqui" value={code} onChange={e=>setCode(e.target.value)}/></label><button className="button secondary" disabled={jam.busy||!name.trim()||!invite.code||!invite.endpoint}><Users size={17}/>Entrar</button></form>
  {!jam.configured&&<p className="jam-notice">A rede local funciona entre computadores na mesma rede. Para ouvir de redes diferentes, conecte um servidor online nas opções abaixo.</p>}
 </>}
 {jam.error&&<p className="jam-error" role="alert">{jam.error}</p>}
 {!jam.session&&<details className="jam-service" open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>Servidor da JAM</summary><label className="field-label">Endereço do serviço<input className="input" aria-label="Servidor da JAM" type="url" value={endpoint} maxLength={2048} placeholder="https://jam.exemplo.com" onChange={e=>setEndpoint(e.target.value)}/></label><p>Os dois computadores devem usar o mesmo endereço. Rede local também é aceita.</p><button className="button secondary" disabled={saving} onClick={()=>void save()}>{saving?'Salvando…':'Salvar servidor'}</button></details>}
 </section>;
}
