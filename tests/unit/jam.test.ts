import { describe,it,expect } from 'vitest';
import { createJam } from '../../server/jam';
import { JamClient,JamClock,type JamSend } from '../../src/lib/jam';
import { canJam,jamPosition,type JamRoom } from '../../shared/jam';
import type { Track } from '../../shared/types';

const song:Track={id:'youtube:M7lc1UVf-VE',source:'youtube',sourceId:'M7lc1UVf-VE',kind:'track',title:'Teste sincronizado',artist:'Glass',duration:180,url:'https://www.youtube.com/watch?v=M7lc1UVf-VE',addedAt:0};
async function withServer(run:(send:JamSend,raw:(body:unknown)=>Promise<Response>,clock:{now:number})=>Promise<void>,env:NodeJS.ProcessEnv={}){
 const clock={now:Date.now()},server=createJam(env,()=>clock.now);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const raw=(body:unknown)=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/jam`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const send:JamSend=async<T>(body:unknown)=>{const response=await raw(body),value=await response.json();if(!response.ok)throw new Error(value.error);return value as T;};
 try{await run(send,raw,clock);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('JAM coordinator and two independent clients',()=>{
 it('follows host track, play, pause, seek and next without sharing private session tokens',async()=>{
  await withServer(async(send,raw,clock)=>{
   const host=new JamClient(send),friend=new JamClient(send);const h=await host.enter('create','Casa');const f=await friend.enter('join','Amigo',h.code);
   expect(h.code).toMatch(/^[A-F0-9]{10}$/);expect(h.token).not.toBe(f.token);expect(f.members).toHaveLength(2);
   expect(JSON.stringify(f.members)).not.toContain(h.token);expect(JSON.stringify(f.members)).not.toContain(f.token);
   await host.update({track:song,playing:true,position:25});clock.now+=2600;
   let room=await friend.update();expect(room.playback.track?.id).toBe(song.id);expect(jamPosition(room.playback,clock.now)).toBeCloseTo(27.6,5);
   await host.update({track:song,playing:false,position:30});clock.now+=5000;room=await friend.update();expect(room.playback.playing).toBe(false);expect(jamPosition(room.playback,clock.now)).toBe(30);
   await host.update({track:song,playing:true,position:90});room=await friend.update();expect(jamPosition(room.playback,clock.now)).toBe(90);
   const next={...song,id:'youtube:dQw4w9WgXcQ',sourceId:'dQw4w9WgXcQ',title:'Outra música',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'};
   await host.update({track:next,playing:true,position:0});expect((await friend.update()).playback.track?.id).toBe(next.id);
   const forbidden=await raw({action:'sync',code:f.code,token:f.token,playback:{track:song,playing:true,position:0}});expect(forbidden.status).toBe(403);
   await friend.leave();expect((await host.update({track:next,playing:true,position:0})).members).toHaveLength(1);expect(friend.session).toBeNull();
   const guest=new JamClient(send);await guest.enter('join','Novo',h.code);await host.leave();await expect(guest.update()).rejects.toThrow(/encerrada|expirou/);
  });
 });
 it('rejects local files, credential-bearing URLs, oversized requests and uninvited requests',async()=>{
  await withServer(async(send,raw)=>{
   const host=new JamClient(send),session=await host.enter('create','Host');
   for(const track of [{...song,source:'local',url:'file:///C:/music.mp3'},{...song,url:'https://user:password@www.youtube.com/watch?v=M7lc1UVf-VE'},{...song,url:'http://169.254.169.254/latest/meta-data'}]){
    expect((await raw({action:'sync',code:session.code,token:session.token,playback:{track,playing:true,position:0}})).status).toBe(400);
   }
   expect((await raw({action:'poll',code:session.code,token:'invalid'})).status).toBe(401);
   expect((await raw({action:'create',name:'a'.repeat(18000)})).status).toBe(413);
   expect(canJam({...song,source:'local'})).toBe(false);
  });
 });
 it('caps room members and removes absent guests while host heartbeats keep the room alive',async()=>{
  await withServer(async(send,raw,clock)=>{
   const host=new JamClient(send),h=await host.enter('create','Host');const guests:JamClient[]=[];
   for(let i=0;i<7;i++){const guest=new JamClient(send);await guest.enter('join',`Friend ${i}`,h.code);guests.push(guest);}
   expect((await raw({action:'join',code:h.code,name:'extra'})).status).toBe(409);
   clock.now+=36000;const room=await host.update({track:null,playing:false,position:0});expect(room.members).toHaveLength(1);
   await expect(guests[0].update()).rejects.toThrow(/expirou/);
   clock.now+=900001;await expect(host.update({track:null,playing:false,position:0})).rejects.toThrow(/expirou/);
  });
 });
 it('limits room creation to bounded capacity and repeated entry attempts',async()=>{
  await withServer(async(send,raw)=>{await new JamClient(send).enter('create','Host');expect((await raw({action:'create',name:'Other'})).status).toBe(503);},{JAM_MAX_ROOMS:'1'});
  await withServer(async(send,raw)=>{for(let i=0;i<30;i++)await raw({action:'join',code:'0000000000'});expect((await raw({action:'join',code:'0000000000'})).status).toBe(429);});
 });
});
describe('JAM timing',()=>{
 it('uses round-trip midpoint and favors fast clock samples instead of network queue delay',()=>{
  const clock=new JamClock();clock.sample(1000,1100,1550);expect(clock.offset).toBe(500);
  clock.sample(2000,4000,2800);expect(clock.offset).toBe(500);
  clock.sample(5000,5100,5550);expect(clock.offset).toBe(500);
  clock.sample(8000,8050,8525);expect(clock.offset).toBe(500);
 });
 it('never seeks behind zero or beyond the end and does not advance a paused song',()=>{
  const room:JamRoom={code:'0000000000',members:[],serverTime:1000,playback:{track:song,playing:true,position:179.5,updatedAt:1000,sequence:1}};
  expect(jamPosition(room.playback,900000)).toBe(180);expect(jamPosition({...room.playback,playing:false},900000)).toBe(179.5);expect(jamPosition({...room.playback,position:0},0)).toBe(0);
 });
});
