import { test,expect,chromium,type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import type { Track } from '../../shared/types';
import { activeAudio, chooseSidebarCreation, importUrlInput, navButton, selectGlass } from './ui';

test('YouTube songs play inside Glass as audio, with seek, queue and no browser or video',async()=>{
 test.setTimeout(150000);await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/audio-'));let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_CATALOG_URL:'',GLASS_TEST_DISABLE_DIRECT:'0',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9342'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9342/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9342');const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('button',{name:'Permitir e continuar'})).toBeVisible({timeout:15000});
  const denied=await page.evaluate(async()=>{try{await window.glass.audioSource('a5uQMwRMHcs','before-consent');return false;}catch{return true;}});expect(denied).toBe(true);
  await page.getByRole('button',{name:'Permitir e continuar'}).click();
  await page.evaluate(()=>window.glass.window('restore'));
  await navButton(page,'Configurações').click();
  await selectGlass(page);
  await page.getByRole('button',{name:'Ambiente',exact:true}).click();
  await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,volume:0});});
  await page.addInitScript(()=>{const w=window as any;w.__audioContexts=[];const Orig=w.AudioContext;w.AudioContext=class extends Orig{constructor(...args:any[]){super(...args);w.__audioContexts.push(this);}};});
  await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});
  await page.evaluate(()=>{const w=window as any;w.__externalCalls=[];window.glass.external=async(url)=>{w.__externalCalls.push(url);};});
  const tracks:Track[]=[];
  for(const id of ['a5uQMwRMHcs','dQw4w9WgXcQ']){
   await chooseSidebarCreation(page,'Importar por link');await importUrlInput(page).fill(`https://www.youtube.com/watch?v=${id}`);await page.getByRole('dialog').getByRole('button',{name:'Adicionar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:25000});
   tracks.push((await page.evaluate(()=>window.glass.bootstrap())).tracks.find(t=>t.sourceId===id)!);
  }
  const started=Date.now();await page.getByRole('button',{name:`Reproduzir ${tracks[0].title}`,exact:true}).click();
  await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:45000}).toBeGreaterThan(.8);
  await expect.poll(()=>page.evaluate(()=>(window as any).__audioContexts.every((a:AudioContext)=>a.state==='running'))).toBe(true);
  const duration=await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.duration);expect(duration).toBeGreaterThan(300);
  const url=await activeAudio(page).getAttribute('src');expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/audio\/[a-f0-9]+$/);
  expect(await page.evaluate(()=>(window as any).__externalCalls)).toEqual([]);await expect(page.locator('video,iframe[src*="youtube"]')).toHaveCount(0);expect(await page.locator('.official-player.visible').count()).toBe(0);
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();const at=await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime);await page.waitForTimeout(250);expect(await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeCloseTo(at,1);
  await page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).fill('110');await page.locator('footer.player').getByRole('button',{name:'Reproduzir',exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(110.5);
  const beforeLoss=await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime);
  await page.evaluate(()=>{const ext=document.querySelector<HTMLCanvasElement>('.optical-surfaces')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;(window as any).__loss=ext;ext.loseContext();});
  await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');
  await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(beforeLoss+.3);
  await page.evaluate(()=>(window as any).__loss.restoreContext());await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  const range=await context.request.get(url!,{headers:{Range:'bytes=0-1023'}});expect(range.status()).toBe(206);expect(range.headers()['content-type']).toBe('audio/mp4');expect((await range.body()).length).toBe(1024);
  const malformed=await context.request.get(url!,{headers:{Range:'bytes=0-10,20-30'}});expect(malformed.status()).toBe(416);
  await navButton(page,'Configurações').click();await page.locator('.advanced-appearance').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();
  const beforeLab=await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime);await page.waitForTimeout(1500);expect(await activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(beforeLab+.8);
  await page.getByRole('button',{name:'Fechar laboratório',exact:true}).click();await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
  await page.locator('footer.player').getByRole('button',{name:'Fila de reprodução',exact:true}).click();await expect(page.locator('.queue-panel')).toBeVisible();await page.getByRole('button',{name:'Fechar fila',exact:true}).click();
  await page.locator('footer.player').getByRole('button',{name:'Abrir player expandido',exact:true}).click();await expect(page.locator('.expanded-player')).toBeVisible();await page.getByRole('button',{name:'Fechar player expandido',exact:true}).click();
  await page.getByRole('button',{name:'Mostrar player lateral',exact:true}).click();await expect(page.getByRole('region',{name:'Tocando agora',exact:true})).toBeVisible();await page.screenshot({path:'test-results/youtube-audio-inside-glass.png'});
  await page.locator('footer.player').getByRole('button',{name:'Próxima faixa',exact:true}).click();await expect(page.locator('.now-info strong')).toHaveText(tracks[1].title);await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:45000}).toBeGreaterThan(.5);
  expect(await page.evaluate(()=>(window as any).__externalCalls)).toEqual([]);
  const history=(await page.evaluate(()=>window.glass.bootstrap())).history;expect(history.some(h=>h.id===tracks[0].id)).toBe(true);expect(history.some(h=>h.id===tracks[1].id)).toBe(true);
  await navButton(page,'Configurações').click();await page.getByRole('switch',{name:'Acesso online',exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);expect((await context.request.get(url!)).status()).toBe(403);
  expect(errors).toEqual([]);
  await writeFile('test-results/youtube-audio-validation.json',JSON.stringify({version:'2.0.1',liveSongs:tracks.map(t=>({title:t.title,sourceId:t.sourceId})),loadAndPlaybackMs:Date.now()-started,duration,noBrowserOpened:true,noVideo:true,pause:true,seek:true,rangeBytes:1024,graphicsLossDoesNotStopAudio:true,laboratoryAnimationDoesNotStopAudio:true,floatingAudioPanels:true,queue:true,history:true,audioContextRunning:true,consentBeforePlayback:true,revocationStopsPlayback:true,errors},null,2));
 }finally{proc.kill();if(browser)await browser.close().catch(()=>{});}
});
