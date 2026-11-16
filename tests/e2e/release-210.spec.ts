import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,copyFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';

test('first permission, playlist artwork, animated colors, minimal search and synchronized lyrics',async()=>{
 test.setTimeout(90000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/release-210-'));await mkdir(join(profile,'covers'));await copyFile('assets/icon.png',join(profile,'covers','aa.png'));
 const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE playlist_tracks(playlist_id TEXT,track_id TEXT,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));');
 const track={id:'local:lyrics-test',source:'local',sourceId:'lyrics-test',kind:'track',title:'Validação de letras',artist:'Teste local',duration:20,addedAt:Date.now()};
 db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO playlists VALUES(?,?,?)').run('qa-playlist','Playlist importada',Date.now());db.prepare('INSERT INTO playlist_tracks VALUES(?,?,0)').run('qa-playlist',track.id);
 db.prepare('INSERT INTO settings VALUES(?,?)').run('playlist-artwork:qa-playlist','glass://app/covers/aa.png');
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,volume:0,appearance:{...opticalDefaults,background:'solid',solidColor:'#207a9a'}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9366'}});
 let browser:Browser|undefined;const errors:string[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9366/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9366');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('dialog',{name:'Permitir acesso online?'})).toBeVisible();await expect(page.locator('.welcome-screen')).toHaveCount(0);
  const initial=await page.evaluate(()=>window.glass.bootstrap());expect(initial.preferences).toMatchObject({onlineConsent:false,onboardingDone:false,reducedMotion:false});
  const denied=await page.evaluate(async t=>{try{await window.glass.lyrics(t as any);return false;}catch{return true;}},track);expect(denied).toBe(true);
  await page.getByRole('button',{name:'Permitir e continuar',exact:true}).click();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:10000});
  await expect(page.locator('.playlist-thumbnail img')).toBeVisible();await expect.poll(()=>page.locator('.playlist-thumbnail img').evaluate((im:HTMLImageElement)=>im.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Explorar',exact:true}).click();await expect(page.locator('.explore-terms')).toHaveCount(0);await expect(page.getByRole('button',{name:'Jazz',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Buscar',exact:true}).click();await expect(page.locator('.search-filters,.source-filters')).toHaveCount(0);
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.getByRole('switch',{name:'Reduzir animações',exact:true})).toHaveAttribute('aria-checked','false');
  await expect(page.getByRole('slider',{name:'Movimento do fundo',exact:true})).toHaveValue('0.35');
  const samples=await page.evaluate(()=>{const c=document.querySelector<HTMLCanvasElement>('.optical-scene')!,ctx=c.getContext('2d')!;return [ctx.getImageData(10,10,1,1).data[1],ctx.getImageData(c.width-10,c.height-10,1,1).data[1]];});expect(Math.abs(samples[0]-samples[1])).toBeGreaterThan(0);
  await page.getByRole('slider',{name:'Movimento do fundo',exact:true}).fill('1');await page.waitForTimeout(500);const start=await page.evaluate(()=>(window as any).__glassOptics.draws);await page.waitForTimeout(800);const finish=await page.evaluate(()=>(window as any).__glassOptics.draws);expect(finish-start).toBeGreaterThan(2);
  await page.getByRole('slider',{name:'Movimento do fundo',exact:true}).fill('0');
  await page.evaluate(()=>{window.glass.lyrics=async()=>({id:1,title:'Teste',artist:'Teste',instrumental:false,provider:'LRCLIB',syncedLyrics:'[00:00.00]Primeira linha\n[00:03.00]Segunda linha\n[00:10.00]Terceira linha'});});
  await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:'Reproduzir Validação de letras',exact:true}).click();
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.2);
  await page.locator('footer.player').getByRole('button',{name:'Letras',exact:true}).click();await expect(page.locator('.lyrics-lines button.active')).toHaveText('Primeira linha');
  await page.getByRole('button',{name:'Ir para Terceira linha',exact:true}).click();await expect(page.locator('.lyrics-lines button.active')).toHaveText('Terceira linha');
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();const position=await page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime);await page.waitForTimeout(300);expect(await page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeCloseTo(position,1);
  await page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).fill('4');await expect(page.locator('.lyrics-lines button.active')).toHaveText('Segunda linha');
  await page.screenshot({path:'test-results/release-210-lyrics.png'});expect(errors).toEqual([]);
  await writeFile('test-results/release-210.json',JSON.stringify({firstPermission:true,defaultReducedMotion:false,playlistImageLoaded:true,filtersRemoved:true,animatedBackground:true,lyricsSeekAndPause:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
