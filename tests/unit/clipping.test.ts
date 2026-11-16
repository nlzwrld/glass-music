import { describe, expect, it } from 'vitest';
import { intersectClip } from '../../src/components/glass/v3/clipping';
describe('shared canvas clipping',()=>{
 it('crops a surface to the visible scroll viewport',()=>{
  expect(intersectClip({left:10,top:20,right:210,bottom:320},{left:0,top:200,right:250,bottom:400})).toEqual({left:10,top:200,right:210,bottom:320});
 });
 it('rejects surfaces completely above the viewport, including boundary contact',()=>{
  expect(intersectClip({left:10,top:20,right:210,bottom:320},{left:0,top:-60,right:250,bottom:20})).toBeNull();
 });
 it('can clip only the scroll axis without narrowing the other axis',()=>{
  expect(intersectClip({left:10,top:20,right:210,bottom:320},{left:-Infinity,top:30,right:Infinity,bottom:100})).toEqual({left:10,top:30,right:210,bottom:100});
 });
});
