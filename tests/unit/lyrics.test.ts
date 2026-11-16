import {describe,it,expect} from 'vitest';
import {parseLRC,activeLyric} from '../../src/lib/lyrics';
describe('lyric timing',()=>{
 it('reads repeated timestamps, fractions and metadata offsets in order',()=>{
  expect(parseLRC('[ar:Example]\n[offset:500]\n[00:03.25][00:08.000]Second\n[00:01]First')).toEqual([{time:.5,text:'First'},{time:2.75,text:'Second'},{time:7.5,text:'Second'}]);
 });
 it('handles intros, exact timestamps and seeking backwards',()=>{
  const lines=parseLRC('[00:05]First\n[00:12.5]Second\n[00:20]Third');
  expect([0,5,19,12.49,25].map(t=>activeLyric(lines,t))).toEqual([-1,0,1,0,2]);
 });
 it('removes enhanced word timestamps while preserving the line timestamp',()=>{expect(parseLRC('[00:12.40]<00:12.40>Hello <00:12.80>world')).toEqual([{time:12.4,text:'Hello world'}]);});
 it('does not invent synchronization for plain text',()=>{expect(parseLRC('A line without timing')).toEqual([]);});
});
