import { describe,it,expect,vi,afterEach } from 'vitest';
import { YouTubeProvider } from '../../desktop/providers/youtube';
import { SoundCloudProvider } from '../../desktop/providers/soundcloud';
import { SearchService } from '../../desktop/providers/search';
import { durationISO } from '../../desktop/providers/http';
import type { SearchRequest, MusicProvider } from '../../shared/types';
const req: SearchRequest={query:'test',kind:'track',source:'all',requestId:'test-1'};
afterEach(()=>vi.unstubAllGlobals());
describe('Official providers', () => {
  it('searches the official YouTube endpoint, passes pagination and joins durations/availability', async () => {
    const fn=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({nextPageToken:'next',items:[{id:{videoId:'M7lc1UVf-VE'},snippet:{title:'A &amp; B',channelTitle:'Channel',thumbnails:{high:{url:'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg'}}}}]}))).mockResolvedValueOnce(new Response(JSON.stringify({items:[{id:'M7lc1UVf-VE',contentDetails:{duration:'PT3M15S'},status:{embeddable:false}}]}))); vi.stubGlobal('fetch',fn);
    const result=await new YouTubeProvider(()=>'test-key').search({...req,cursor:{youtube:'page2'}},new AbortController().signal);
    const called=new URL(String(fn.mock.calls[0][0])); expect(called.origin).toBe('https://www.googleapis.com');expect(called.searchParams.get('pageToken')).toBe('page2');expect(called.searchParams.get('videoEmbeddable')).toBe('true'); expect(result.items[0].title).toBe('A & B');expect(result.items[0].duration).toBe(195);expect(result.items[0].available).toBe(false);expect(result.next).toBe('next');
  });
  it('does not invent working credentials', async () => { await expect(new YouTubeProvider(()=>'').search(req,new AbortController().signal)).rejects.toThrow('configure'); await expect(new SoundCloudProvider(()=>({url:'',token:''})).search(req,new AbortController().signal)).rejects.toThrow('configure'); });
  it('surfaces API limits and network failures without leaking credentials', async () => { vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:429}))); await expect(new YouTubeProvider(()=>'private-secret').search(req,new AbortController().signal)).rejects.toThrow('Limite');vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('network secret')));await expect(new YouTubeProvider(()=>'private-secret').search(req,new AbortController().signal)).rejects.toThrow('conexão'); });
  it('converts ISO durations and declares different platform capabilities',()=>{expect(durationISO('PT1H2M3S')).toBe(3723);expect(durationISO('P0D')).toBe(0);expect(new YouTubeProvider(()=>'').capabilities.background).toBe(false);expect(new SoundCloudProvider(()=>({url:'',token:''})).capabilities.equalizer).toBe(false);});
  it('combines results, isolates one provider failure and caches successful queries',async()=>{
    const yt=new YouTubeProvider(()=>''); const sc=new SoundCloudProvider(()=>({url:'',token:''})); const item={id:'youtube:M7lc1UVf-VE',sourceId:'M7lc1UVf-VE',source:'youtube' as const,kind:'track' as const,title:'Test',artist:'Test',duration:0,addedAt:0}; const a=vi.spyOn(yt,'search').mockResolvedValue({items:[item],next:undefined});const b=vi.spyOn(sc,'search').mockRejectedValue(new Error('No permission'));const service=new SearchService([yt,sc]);const first=await service.search(req);expect(first.items).toHaveLength(1);expect(first.notices).toHaveLength(1);b.mockResolvedValue({items:[]});await service.search(req);await service.search(req);expect(a).toHaveBeenCalledTimes(2);
  });
  it('cancels in-flight queries instead of publishing stale results',async()=>{
    const yt=new YouTubeProvider(()=>'');vi.spyOn(yt,'search').mockImplementation((_r,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));const service=new SearchService([yt]);const p=service.search(req);service.cancel(req.requestId);await expect(p).rejects.toThrow('cancelada');
  });
});
