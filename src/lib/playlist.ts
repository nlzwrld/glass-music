import {useApp} from '../stores/app';
export async function moveWithinPlaylist(playlistId:string,trackId:string,targetId:string){
 const playlist=useApp.getState().data.playlists.find(p=>p.id===playlistId);if(!playlist||trackId===targetId)return;
 const ids=[...playlist.trackIds],from=ids.indexOf(trackId),to=ids.indexOf(targetId);if(from<0||to<0)return;
 ids.splice(from,1);ids.splice(to,0,trackId);await useApp.getState().mutate({action:'reorder',id:playlistId,trackIds:ids});
}
