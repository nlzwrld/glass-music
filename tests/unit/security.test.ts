import { describe,it,expect,vi } from 'vitest';

import { artworkUrl, brokerUrl, officialUrl, trackSchema, librarySchema, credentialSchema } from '../../shared/validation';

import { validNext } from '../../server/broker';
describe('Security boundaries', () => {
  it('allows only official HTTPS destinations, blocking shell URLs, credentials and lookalike hosts', () => {
    ['file:///C:/Windows/system32/cmd.exe','javascript:alert(1)','https://youtube.com.attacker.example/x','https://youtube.com@attacker.example/','http://youtube.com/','https://youtube.com:444/'].forEach(u=>expect(officialUrl(u)).toBe(false)); expect(officialUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE')).toBe(true);
  });
  it('rejects arbitrary cover fetches and unsafe broker origins', () => { expect(artworkUrl('https://127.0.0.1/secret')).toBe(false); expect(artworkUrl('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(true); expect(brokerUrl('http://192.168.0.1')).toBe(false); expect(brokerUrl('https://a:b@host')).toBe(false); expect(brokerUrl('http://127.0.0.1:8787')).toBe(true); expect(credentialSchema.safeParse({brokerUrl:'javascript:alert(1)'}).success).toBe(false); });
  it('validates message shape, identity and duplicate-free names at the boundary', () => { expect(librarySchema.safeParse({action:'create',name:'   '}).success).toBe(false); expect(librarySchema.safeParse({action:'execute',code:'process.exit()'}).success).toBe(false); expect(trackSchema.safeParse({id:'youtube:other',source:'youtube',sourceId:'M7lc1UVf-VE',kind:'track',title:'x',artist:'y',duration:0,addedAt:0}).success).toBe(false); });
  it('does not accept untrusted API pagination destinations', () => { expect(()=>validNext('https://evil.example/tracks','tracks')).toThrow(); expect(()=>validNext('https://api.soundcloud.com/users','tracks')).toThrow(); expect(validNext('https://api.soundcloud.com/tracks?cursor=abc','tracks').hostname).toBe('api.soundcloud.com'); });
});
