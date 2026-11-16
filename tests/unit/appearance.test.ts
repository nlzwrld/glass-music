import {describe,it,expect} from 'vitest';
import {normalizeOptics,opticalDefaults,surfaceTint} from '../../src/components/glass/v3/model';
import {paletteFromPixels,neutralPalette,mixPalette} from '../../src/components/glass/v3/ambient';
describe('visual preference migration and ambient palette',()=>{
 it('preserves the old desktop choice and supplies new fields',()=>{expect(normalizeOptics({background:'desktop',blur:6})).toMatchObject({background:'desktop',blur:6,ior:1.42,scale:100});});
 it('bounds imported settings and refuses unsafe image sources',()=>{expect(normalizeOptics({scale:200,blur:-1,customImage:'https://unknown.test/a.jpg',tint:'red',background:'invalid'})).toMatchObject({scale:125,blur:0,customImage:'',tint:opticalDefaults.tint,background:'dynamic'});});
 it('retains a saved custom image when another background is selected',()=>{expect(normalizeOptics({customImage:'data:image/jpeg;base64,YQ==',background:'solid'}).customImage).toBe('data:image/jpeg;base64,YQ==');});
 it('keeps desktop glass achromatic when blur or saturation changes',()=>{for(const blur of [0,12,24])for(const saturation of [.5,1,2]){const settings=normalizeOptics({background:'desktop',blur,saturation,solidColor:'#ff00ff'});expect(surfaceTint(settings,false)).toBe('#202020');expect(surfaceTint(settings,true)).toBe('#f4f4f4');}});
 it('uses a neutral environment for black and transparent art',()=>{expect(paletteFromPixels(new Uint8ClampedArray([0,0,0,255,255,0,0,0]))).toEqual(neutralPalette);});
 it('keeps a dominant green hue but caps saturation and brightness',()=>{const p=paletteFromPixels(new Uint8ClampedArray([0,255,0,255,0,255,0,255]));expect(p[0][1]).toBeGreaterThan(p[0][0]);expect(Math.max(...p.flat())).toBeLessThanOrEqual(176);expect(p[0][1]-p[0][0]).toBeLessThan(100);});
 it('interpolates continuously without mutating the cached palette',()=>{const target:[[number,number,number],[number,number,number],[number,number,number]]=[[100,20,40],[50,80,100],[80,90,90]];expect(mixPalette(neutralPalette,target,0)).toEqual(neutralPalette);expect(mixPalette(neutralPalette,target,1)).toEqual(target);expect(mixPalette(neutralPalette,target,.5)[0][0]).toBe(81);});
});
