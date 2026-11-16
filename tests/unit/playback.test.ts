import {it,expect,vi,afterEach} from 'vitest';
import {preparePlayback,invalidatePlayback} from '../../src/lib/playback';
import type {Track} from '../../shared/types';
const track=(id:string):Track=>({id:'youtube:'+id,source:'youtube',sourceId:id,title:'Example',artist:'Artist',duration:20,kind:'track',addedAt:0});
afterEach(()=>vi.unstubAllGlobals());
it('reuses a pending hover preparation when the same song is played',async()=>{
 let finish:(value:{url:string;duration:number})=>void=()=>{};
 const audioSource=vi.fn(()=>new Promise<{url:string;duration:number}>(r=>finish=r));
 const cancelSearch=vi.fn(async()=>{});vi.stubGlobal('window',{glass:{audioSource,cancelSearch}});
 const t=track('dedup123456');const warm=preparePlayback(t,false),playing=preparePlayback(t,true);warm.release();
 expect(audioSource).toHaveBeenCalledTimes(1);expect(cancelSearch).not.toHaveBeenCalled();
 finish({url:'http://127.0.0.1/test',duration:20});await expect(playing.promise).resolves.toMatchObject({track:t,source:{duration:20}});playing.release();
});
it('cancels speculative work before preparing a different selected song',async()=>{
 const cancelSearch=vi.fn(async()=>{});const audioSource=vi.fn(async()=>({url:'http://127.0.0.1/test',duration:20}));
 vi.stubGlobal('window',{glass:{audioSource,cancelSearch}});
 const warm=preparePlayback(track('warm1234567'),false);const selected=preparePlayback(track('live1234567'));
 expect(cancelSearch).toHaveBeenCalledTimes(1);await expect(warm.promise).rejects.toThrow('cancelada');await selected.promise;warm.release();selected.release();
});
it('drops prepared tickets when online permission is revoked',async()=>{
 const audioSource=vi.fn(async()=>({url:'http://127.0.0.1/test',duration:20}));vi.stubGlobal('window',{glass:{audioSource,cancelSearch:vi.fn(async()=>{})}});
 const t=track('reset123456');const first=preparePlayback(t);await first.promise;first.release();invalidatePlayback();
 const second=preparePlayback(t);await second.promise;second.release();expect(audioSource).toHaveBeenCalledTimes(2);
});
