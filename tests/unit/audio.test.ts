import {it,expect,vi,afterEach} from 'vitest';
import {boostedGain,transitionSeconds} from '../../src/lib/audioGraph';
import {preparePlayback,invalidatePlayback} from '../../src/lib/playback';
import type {Track} from '../../shared/types';
afterEach(()=>{invalidatePlayback();vi.unstubAllGlobals();});
it('keeps zero volume silent with booster and bounds invalid transition values',()=>{
 expect(boostedGain(0,12)).toBe(0);expect(boostedGain(100,6)).toBeCloseTo(1.995,2);expect(boostedGain(200,99)).toBeCloseTo(3.981,2);
 expect(transitionSeconds(NaN)).toBe(3);expect(transitionSeconds(100)).toBe(10);expect(transitionSeconds(-1)).toBe(.5);
});
it('uses saved audio before trying remote matching or extraction',async()=>{
 const offlineSource=vi.fn(async()=>({url:'http://127.0.0.1/offline/file',duration:213}));const audioSource=vi.fn();const linkPlayback=vi.fn();
 vi.stubGlobal('window',{glass:{offlineSource,audioSource,linkPlayback,cancelSearch:vi.fn(async()=>{})}});
 const track:Track={id:'link:offline',source:'link',sourceId:'offline',kind:'track',title:'Saved song',artist:'Artist',duration:213,addedAt:0,offline:true};
 const prepared=preparePlayback(track);await expect(prepared.promise).resolves.toMatchObject({source:{url:'http://127.0.0.1/offline/file'}});prepared.release();
 expect(offlineSource).toHaveBeenCalledOnce();expect(audioSource).not.toHaveBeenCalled();expect(linkPlayback).not.toHaveBeenCalled();
});
