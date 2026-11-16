import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

test('Spotify and Deezer links automatically play matching audio inside Glass, including saved links',async()=>{
 test.setTimeout(180000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/link-playback-'));let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Glass Music/glass-music.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'0',GLASS_TEST_CATALOG_URL:'',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9350'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9350/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9350');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Permitir e continuar'}).click({timeout:15000});await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,volume:0});});await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.evaluate(()=>window.glass.window('restore'));
  const external=()=>page.evaluate(()=>(window as any).__externalCalls);await page.evaluate(()=>{(window as any).__externalCalls=[];window.glass.external=async url=>{(window as any).__externalCalls.push(url);};});
  const imports=[];
  for(const url of ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC','https://www.deezer.com/track/3135556']){
   await page.getByRole('button',{name:'Adicionar link',exact:true}).first().click();await page.getByRole('textbox',{name:'Link da música'}).fill(url);await page.getByRole('dialog').getByRole('button',{name:'Adicionar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:30000});
   await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:60000}).toBeGreaterThan(.8);
   const track=(await page.evaluate(()=>window.glass.bootstrap())).tracks.find(t=>t.url===url)!;expect(track.playbackId).toMatch(/^[\w-]{11}$/);expect(track.reason).toBe('Áudio via YouTube');expect(track.source).toBe('link');
   expect(await page.locator('audio').getAttribute('src')).toMatch(/\/audio\/[a-f0-9]+$/);expect(await external()).toEqual([]);imports.push({url,title:track.title,artist:track.artist,playbackId:track.playbackId});
   await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
  }
  const before=await page.evaluate(()=>window.glass.bootstrap()),legacy=before.tracks.find(t=>t.url?.includes('spotify.com'))!;delete legacy.playbackId;delete legacy.reason;
  await page.evaluate(async track=>{await window.glass.library({action:'save',track});await window.glass.library({action:'create',name:'Links antigos'});const s=await window.glass.bootstrap();await window.glass.library({action:'add',id:s.playlists[0].id,track});},legacy);
  await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.evaluate(()=>{(window as any).__externalCalls=[];window.glass.external=async url=>{(window as any).__externalCalls.push(url);};});await page.getByRole('button',{name:'Links antigos',exact:true}).click();await page.getByRole('button',{name:`Reproduzir ${legacy.title}`,exact:true}).click();
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:60000}).toBeGreaterThan(.8);const after=await page.evaluate(()=>window.glass.bootstrap());expect(after.playlists[0].trackIds).toEqual([legacy.id]);expect(after.tracks.find(t=>t.id===legacy.id)?.playbackId).toBeTruthy();expect(after.history.some(h=>h.id===legacy.id)).toBe(true);expect(await external()).toEqual([]);
  await page.screenshot({path:'test-results/link-playback-inside-glass.png'});await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
  await page.getByRole('button',{name:'Adicionar link',exact:true}).first().click();await page.getByRole('textbox',{name:'Link da música'}).fill('https://music.apple.com/us/album/discovery/697194953');await page.getByRole('dialog').getByRole('button',{name:'Adicionar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:25000});await expect(page.getByRole('alert').filter({hasText:'Este link ainda não tem áudio compatível'})).toBeVisible({timeout:10000});expect(await external()).toEqual([]);
  await expect(page.locator('video,iframe[src*="youtube"]')).toHaveCount(0);expect(errors).toEqual([]);
  await writeFile('test-results/link-playback-validation.json',JSON.stringify({version:'2.0.1',imports,automaticPlayback:true,legacyLinksWork:true,preservesPlaylistIds:true,noBrowserOnPlay:true,unsupportedStaysInside:true,noVideo:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
