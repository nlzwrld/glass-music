import { test, expect, chromium, type Browser } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chooseSidebarCreation, importUrlInput, navButton, openSidebarPlaylist } from './ui';

test('minimal desktop: onboarding, real links, square artwork, audio, layouts and persistence', async()=>{
 test.setTimeout(180000);
 await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/minimal-'));
 let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',GLASS_TEST_CATALOG_URL:'',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9336'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9336/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9336');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('button',{name:'Permitir e continuar'})).toBeVisible({timeout:15000});
  await page.screenshot({path:'test-results/minimal-first-use.png'});
  const initial=await page.evaluate(()=>window.glass.bootstrap());expect(initial.tracks).toHaveLength(0);expect(initial.preferences.onboardingDone).toBe(false);
  expect(await page.evaluate(()=>typeof (window as any).require)).toBe('undefined');
  await page.getByRole('button',{name:'Permitir e continuar'}).click();
  await expect(page.locator('.onboarding')).toHaveCount(0);
  await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,volume:0});});await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});
  expect((await page.evaluate(()=>window.glass.bootstrap())).preferences).toMatchObject({onboardingDone:true,onlineConsent:true,catalogConsent:true});
  await expect(page.getByRole('button',{name:'Downloads',exact:true})).toHaveCount(0);
  await expect(page.getByText('Prisma',{exact:true})).toHaveCount(0);
  await expect(page.locator('.liquid-backdrop,.glass-optics,.liquid-lens,video')).toHaveCount(0);
  const imported=[];
  for(const [label,url] of [['Spotify','https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],['Deezer','https://www.deezer.com/track/3135556'],['YouTube','https://www.youtube.com/watch?v=a5uQMwRMHcs']]){
   await chooseSidebarCreation(page,'Importar por link');
   await importUrlInput(page).fill(url);
   await page.getByRole('dialog').getByRole('button',{name:'Adicionar',exact:true}).click();
   await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:25000});
   const data=await page.evaluate(()=>window.glass.bootstrap());const track=data.tracks.find(t=>t.url===url)!;expect(track).toBeTruthy();expect(track.source).toBe(label==='YouTube'?'youtube':'link');
   imported.push({label,title:track.title,artist:track.artist,artwork:!!track.artwork});
  }
  expect(imported[0].title.toLowerCase()).toContain('never gonna');expect(imported[0].artwork).toBe(true);expect(imported[1].artist).toBe('Daft Punk');
  await chooseSidebarCreation(page,'Nova playlist');await page.getByRole('textbox',{name:'Nome da playlist',exact:true}).fill('Minha seleção');await page.getByRole('dialog').getByRole('button',{name:'Criar playlist',exact:true}).click();
  const data=await page.evaluate(()=>window.glass.bootstrap());const spotify=data.tracks.find(t=>t.url?.includes('open.spotify.com'))!;
  await page.getByRole('button',{name:`Adicionar ${spotify.title} à playlist`,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/Minha seleção/}).click();
  await openSidebarPlaylist(page,'Minha seleção');
  expect((await page.evaluate(()=>window.glass.bootstrap())).playlists[0].trackIds).toContain(spotify.id);
  const cdp=await browser.contexts()[0].newCDPSession(page);
  const layouts=[];
  for(const [width,height] of [[1672,941],[1360,860],[920,650]]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   const layout=await page.evaluate(()=>{const main=document.querySelector('.main-scroll')!,footer=document.querySelector('.player')!.getBoundingClientRect();return{overflow:main.scrollWidth>main.clientWidth+1,footerInside:footer.bottom<=innerHeight,covers:Array.from(document.querySelectorAll('.cover')).filter(el=>el.getBoundingClientRect().width>0).map(el=>{const b=el.getBoundingClientRect();return Math.abs(b.width-b.height)<1.1;})};});
   expect(layout.overflow).toBe(false);expect(layout.footerInside).toBe(true);expect(layout.covers.every(Boolean)).toBe(true);layouts.push({width,height,...layout});
   await page.screenshot({path:`test-results/minimal-${width}.png`});
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await navButton(page,'Configurações').click();await page.getByRole('button',{name:'Claro',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.screenshot({path:'test-results/minimal-settings-light.png'});await page.getByRole('button',{name:'Escuro',exact:true}).click();
  await navButton(page,'Biblioteca').click();await chooseSidebarCreation(page,'Importar por link');await importUrlInput(page).fill('https://soundcloud.com/forss/flickermood');await page.getByRole('dialog').getByRole('button',{name:'Adicionar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:25000});
  const sc=(await page.evaluate(()=>window.glass.bootstrap())).tracks.find(t=>t.source==='soundcloud')!;expect(sc).toBeTruthy();
  await page.getByRole('button',{name:`Reproduzir ${sc.title}`,exact:true}).click();
  const position=()=>page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).inputValue().then(Number);
  await expect.poll(position,{timeout:30000}).toBeGreaterThan(.5);
  await expect(page.locator('iframe[src*="provider=youtube"]')).toHaveCount(0);await expect(page.locator('video')).toHaveCount(0);
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
  await page.getByRole('button',{name:'Mini-player',exact:true}).click();await expect(page.locator('.app')).toHaveClass(/mini/);await page.screenshot({path:'test-results/minimal-mini.png'});await page.locator('footer.player').getByRole('button',{name:'Sair do mini-player',exact:true}).click();
  await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await expect(page.locator('.onboarding')).toHaveCount(0);expect((await page.evaluate(()=>window.glass.bootstrap())).tracks).toHaveLength(4);
  const injection=await page.evaluate(async()=>{try{await window.glass.resolveLink('file:///C:/Windows');return true;}catch{return false;}});expect(injection).toBe(false);
  expect(errors).toEqual([]);
  await writeFile('test-results/minimal-validation.json',JSON.stringify({version:'2.0.1',firstUseConsent:true,noDemoTracks:true,realImports:imported,playlistWorks:true,layouts,soundcloudPlayed:true,noVideoPlayer:true,sharedOpticalEngine:true,consentPersisted:true,errors},null,2));
 }finally{proc.kill();if(browser)await browser.close().catch(()=>{});await writeFile('test-results/runtime-errors.json',JSON.stringify(errors));}
});
