import {it,expect,vi,afterEach} from 'vitest';
import {boostedGain,transitionSeconds} from '../../src/lib/audioGraph';
import {preparePlayback,invalidatePlayback} from '../../src/lib/playback';
import {detectPlatform} from '../../src/components/glass/controls';
import {upcomingIndex,useApp} from '../../src/stores/app';
import {defaults,type Track} from '../../shared/types';
afterEach(()=>{invalidatePlayback();vi.unstubAllGlobals();});
it('keeps zero volume silent with booster and bounds invalid transition values',()=>{
 expect(boostedGain(0,12)).toBe(0);expect(boostedGain(100,6)).toBeCloseTo(1.995,2);expect(boostedGain(200,99)).toBeCloseTo(3.981,2);
 expect(transitionSeconds(NaN)).toBe(3);expect(transitionSeconds(100)).toBe(10);expect(transitionSeconds(-1)).toBe(.5);
});
it('detects Spotify, Deezer, Apple Music, YT Music, Bandcamp and Tidal badges from track URLs',()=>{
 expect(detectPlatform('link','https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe('spotify');
 expect(detectPlatform('link','https://www.deezer.com/track/916424')).toBe('deezer');
 expect(detectPlatform('link','https://music.apple.com/br/album/617154241?i=617154366')).toBe('apple');
 expect(detectPlatform('youtube','https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('ytmusic');
 expect(detectPlatform('link','https://c418.bandcamp.com/track/sweden')).toBe('bandcamp');
 expect(detectPlatform('link','https://tidal.com/track/123456')).toBe('tidal');
 expect(detectPlatform('local')).toBe('local');
});
it('keeps deterministic upcoming track in shuffle mode and supports playNext + moveQueue',()=>{
 const a:Track={id:'local:a',source:'local',sourceId:'a',kind:'track',title:'A',artist:'X',duration:100,addedAt:0};
 const b:Track={id:'local:b',source:'local',sourceId:'b',kind:'track',title:'B',artist:'X',duration:100,addedAt:0};
 const c:Track={id:'local:c',source:'local',sourceId:'c',kind:'track',title:'C',artist:'X',duration:100,addedAt:0};
 useApp.setState({queue:[a,b],index:0,shufflePlayed:[0],shuffleNext:1,data:{tracks:[a,b,c],playlists:[],likes:[],history:[],preferences:{...defaults,shuffle:true}}});
 expect(upcomingIndex(useApp.getState())).toBe(1);
 useApp.getState().playNext(c);
 expect(useApp.getState().queue.map(t=>t.id)).toEqual(['local:a','local:c','local:b']);
 expect(upcomingIndex(useApp.getState())).toBe(1);
 useApp.getState().moveQueue(2,0);
 expect(useApp.getState().queue.map(t=>t.id)).toEqual(['local:b','local:a','local:c']);
 expect(useApp.getState().index).toBe(1);
});
it('never repeats any song in shuffle mode until every playable song has been played, while allowing manual replay',()=>{
 const list:Track[]=Array.from({length:10},(_,i)=>({id:`local:s${i}`,source:'local',sourceId:`s${i}`,kind:'track',title:`Song ${i}`,artist:'Artist',duration:120,addedAt:0}));
 for(let trial=0;trial<20;trial++){
  useApp.setState({queue:[],index:-1,shufflePlayed:[],shuffleNext:null,status:'',data:{tracks:list,playlists:[],likes:[],history:[],preferences:{...defaults,shuffle:true,repeat:'off'}}});
  useApp.getState().play(list[3],list);
  const visited=[useApp.getState().queue[useApp.getState().index].id];
  for(let step=0;step<9;step++){
   const predicted=upcomingIndex(useApp.getState(),false);
   useApp.getState().next(false);
   expect(useApp.getState().index).toBe(predicted);
   visited.push(useApp.getState().queue[useApp.getState().index].id);
  }
  expect(new Set(visited).size).toBe(10);
  expect(upcomingIndex(useApp.getState(),false)).toBe(-1);
  useApp.getState().next(false);
  expect(useApp.getState().status).toBe('Fim da fila');
 }
 // With repeat: 'all', cycles wrap seamlessly without repeating within a cycle or back-to-back across the boundary
 useApp.setState({queue:[],index:-1,shufflePlayed:[],shuffleNext:null,status:'',data:{tracks:list,playlists:[],likes:[],history:[],preferences:{...defaults,shuffle:true,repeat:'all'}}});
 useApp.getState().play(list[0],list);
 const cycle1=[useApp.getState().queue[useApp.getState().index].id];
 for(let i=0;i<9;i++){useApp.getState().next(false);cycle1.push(useApp.getState().queue[useApp.getState().index].id);}
 expect(new Set(cycle1).size).toBe(10);
 const lastOfCycle1=cycle1[9];
 const cycle2:string[]=[];
 for(let i=0;i<10;i++){useApp.getState().next(false);cycle2.push(useApp.getState().queue[useApp.getState().index].id);}
 expect(cycle2[0]).not.toBe(lastOfCycle1);
 expect(new Set(cycle2).size).toBe(10);
 // Manual replay mid-cycle plays the requested song immediately and still finishes the remaining unplayed songs
 useApp.setState({queue:[],index:-1,shufflePlayed:[],shuffleNext:null,status:'',data:{tracks:list,playlists:[],likes:[],history:[],preferences:{...defaults,shuffle:true,repeat:'off'}}});
 useApp.getState().play(list[2],list);
 useApp.getState().next(false);
 useApp.getState().next(false);
 const heardSoFar=new Set(useApp.getState().shufflePlayed.map(i=>list[i].id));
 expect(heardSoFar.size).toBe(3);
 // User explicitly replays list[2] (already heard!)
 useApp.getState().play(list[2],list);
 expect(useApp.getState().queue[useApp.getState().index].id).toBe('local:s2');
 const remaining:string[]=[];
 for(let i=0;i<7;i++){useApp.getState().next(false);remaining.push(useApp.getState().queue[useApp.getState().index].id);}
 expect(remaining.every(id=>!heardSoFar.has(id))).toBe(true);
 expect(new Set([...heardSoFar,...remaining]).size).toBe(10);
});
it('uses saved audio before trying remote matching or extraction',async()=>{
 const offlineSource=vi.fn(async()=>({url:'http://127.0.0.1/offline/file',duration:213}));const audioSource=vi.fn();const linkPlayback=vi.fn();
 vi.stubGlobal('window',{glass:{offlineSource,audioSource,linkPlayback,cancelSearch:vi.fn(async()=>{})}});
 const track:Track={id:'link:offline',source:'link',sourceId:'offline',kind:'track',title:'Saved song',artist:'Artist',duration:213,addedAt:0,offline:true};
 const prepared=preparePlayback(track);await expect(prepared.promise).resolves.toMatchObject({source:{url:'http://127.0.0.1/offline/file'}});prepared.release();
 expect(offlineSource).toHaveBeenCalledOnce();expect(audioSource).not.toHaveBeenCalled();expect(linkPlayback).not.toHaveBeenCalled();
});
