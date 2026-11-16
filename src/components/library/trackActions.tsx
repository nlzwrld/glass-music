import {Play,Heart,ListPlus,Plus,ArrowRightLeft,ArrowUp,ArrowDown,ExternalLink,Trash2,Library,Copy,Download,HardDriveDownload} from 'lucide-react';
import {canPlay,type Track} from '../../../shared/types';
import {useApp} from '../../stores/app';
import {moveWithinPlaylist} from '../../lib/playlist';
import type {GlassMenuItem} from '../glass/materials';
export function trackActions(track:Track,list:Track[],playlistId?:string):GlassMenuItem[]{
 const s=useApp.getState(),saved=s.data.tracks.some(t=>t.id===track.id),playlist=s.data.playlists.find(p=>p.id===playlistId),index=playlist?.trackIds.indexOf(track.id)??-1;
 const items:GlassMenuItem[]=[
 {label:'Reproduzir',icon:<Play size={17}/>,disabled:!canPlay(track),action:()=>s.play(track,list)},
 {label:'Adicionar à fila',icon:<ListPlus size={17}/>,disabled:!canPlay(track),action:()=>s.enqueue(track)},
 {label:s.data.likes.includes(track.id)?'Remover curtida':'Curtir',icon:<Heart size={17}/>,action:()=>{void s.mutate({action:'like',track}).catch(()=>{});}},
 {label:'Adicionar à playlist',icon:<Plus size={17}/>,action:()=>s.setDialog({type:'add',track})}
 ];
 if(playlist){items.push(
 {label:'Mover para outra playlist',icon:<ArrowRightLeft size={17}/>,action:()=>s.setDialog({type:'add',track,fromPlaylist:playlist.id})},
 {label:'Mover para cima',icon:<ArrowUp size={17}/>,disabled:index<=0,action:()=>{void moveWithinPlaylist(playlist.id,track.id,playlist.trackIds[index-1]).catch(()=>{});}},
 {label:'Mover para baixo',icon:<ArrowDown size={17}/>,disabled:index<0||index>=playlist.trackIds.length-1,action:()=>{void moveWithinPlaylist(playlist.id,track.id,playlist.trackIds[index+1]).catch(()=>{});}},
 {label:'Remover da playlist',icon:<Trash2 size={17}/>,danger:true,action:()=>{void s.mutate({action:'remove',id:playlist.id,trackId:track.id}).catch(()=>{});}}
 );}
 if(['youtube','link'].includes(track.source))items.push({label:track.offline?'Remover download':'Baixar para ouvir offline',icon:track.offline?<HardDriveDownload size={17}/>:<Download size={17}/>,action:()=>{s.message(track.offline?'Removendo download…':'Baixando música…');void (track.offline?window.glass.removeOffline(track.id):window.glass.downloadOffline(track)).then(data=>{useApp.setState({data:{...data,preferences:useApp.getState().data.preferences}});useApp.getState().message(track.offline?'Download removido.':'Música disponível offline.');}).catch(e=>s.message(String(e)));}});
 if(track.url)items.push({label:'Abrir na plataforma',icon:<ExternalLink size={17}/>,action:()=>{void window.glass.external(track.url!);}}, {label:'Copiar link',icon:<Copy size={17}/>,action:()=>{void navigator.clipboard.writeText(track.url!).then(()=>s.message('Link copiado.')).catch(()=>s.message('Não foi possível copiar o link.'));}});
 items.push(saved?{label:'Remover da biblioteca',icon:<Trash2 size={17}/>,danger:true,action:()=>s.setDialog({type:'confirm',title:`Remover “${track.title}”?`,text:'A música sairá das playlists, curtidas e histórico. O arquivo original permanece no computador.',action:async()=>{await useApp.getState().mutate({action:'removeTrack',id:track.id});}})}:{label:'Salvar na biblioteca',icon:<Library size={17}/>,action:()=>{void s.mutate({action:'save',track}).catch(()=>{});}});
 return items;
}
