import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults,type Track} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';

test('real imported audio latency, queued crossfade and persistent instant discoveries',async()=>{
 test.setTimeout(150000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/audio-212-'));const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));');
 const local:Track[]=[0,1].map(i=>({id:'local:transition'+i,source:'local',sourceId:'transition'+i,kind:'track',title:'Transição '+i,artist:'Teste',duration:20,addedAt:i}));
 let remote:Track={id:'link:coldrick',source:'link',sourceId:'coldrick',kind:'track',title:'Never Gonna Give You Up',artist:'Rick Astley',duration:213,url:'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',addedAt:2};
 if(process.env.GLASS_BENCH_TRACK_FILE)remote=JSON.parse(await readFile(process.env.GLASS_BENCH_TRACK_FILE,'utf8'));
 delete remote.playbackId;delete remote.offline;
 for(const t of local)db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(t.id,JSON.stringify(t),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO tracks VALUES(?,?,NULL,?)').run(remote.id,JSON.stringify(remote),Date.now());
 db.prepare('INSERT INTO playlists VALUES(?,?,?)').run('transitions','Transições',1);local.forEach((t,i)=>db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('transitions',t.id,i));
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,onlineConsent:true,catalogConsent:false,transition:'crossfade',transitionSeconds:1.5,reducedMotion:true,volume:0,appearance:{...opticalDefaults,background:'ambient',backgroundMotion:0}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'0',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9374'}});let browser:Browser|undefined;const errors:string[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9374/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9374');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
  const active=page.locator('audio[data-active="true"]');await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,catalogConsent:true});});const homeCold=Date.now();await page.reload();await expect(page.locator('.catalog-section').first()).toBeVisible({timeout:40000});const discoveryColdMs=Date.now()-homeCold;await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.evaluate(()=>{(window as any).__audioTiming=[];for(const key of ['linkPlayback','audioSource'] as const){const original=window.glass[key].bind(window.glass) as any;(window.glass as any)[key]=async(...args:any[])=>{const at=Date.now();try{const value=await original(...args);(window as any).__audioTiming.push({key,ms:Date.now()-at,ok:true});return value;}catch(e){(window as any).__audioTiming.push({key,ms:Date.now()-at,error:String(e)});throw e;}};}});const cold=Date.now();await page.getByRole('button',{name:'Reproduzir '+remote.title,exact:true}).click();
  await expect.poll(()=>active.evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:45000,intervals:[50,100,150]}).toBeGreaterThan(.1);const coldMs=Date.now()-cold;
  const persisted=await page.evaluate(async id=>(await window.glass.bootstrap()).tracks.find(t=>t.id===id)?.playbackId,remote.id);expect(persisted).toMatch(/^[\w-]{11}$/);
  await page.getByRole('button',{name:'Reproduzir '+local[0].title,exact:true}).click();await expect.poll(()=>active.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.1);
  const warm=Date.now();await page.getByRole('button',{name:'Reproduzir '+remote.title,exact:true}).click();await expect.poll(()=>active.evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:10000,intervals:[50,100]}).toBeGreaterThan(.1);const warmMs=Date.now()-warm;
  await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:'Transições',exact:true}).click();await page.getByRole('button',{name:'Reproduzir playlist',exact:true}).click();await expect.poll(()=>active.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.2);
  await active.evaluate((a:HTMLAudioElement)=>{a.currentTime=a.duration-1.3;});
  await expect.poll(()=>page.locator('audio').evaluateAll(list=>list.filter(a=>!(a as HTMLAudioElement).paused).length),{intervals:[25,50]}).toBe(2);
  await expect.poll(()=>active.evaluate((a:HTMLAudioElement)=>a.currentTime),{intervals:[50,100]}).toBeGreaterThan(.2);
  await expect.poll(()=>page.locator('audio').evaluateAll(list=>list.filter(a=>!(a as HTMLAudioElement).paused).length),{timeout:5000}).toBe(1);
  const before=await active.evaluate((a:HTMLAudioElement)=>a.currentTime);await page.evaluate(async t=>window.glass.library({action:'save',track:t}),local[1]);await page.waitForTimeout(300);expect(await active.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(before);
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();expect(await page.locator('audio').evaluateAll(list=>list.every(a=>(a as HTMLAudioElement).paused))).toBe(true);
  await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,catalogConsent:true});});
  await page.getByRole('button',{name:'Biblioteca',exact:true}).click();const homeWarm=Date.now();await page.getByRole('button',{name:'Início',exact:true}).click();await expect(page.locator('.catalog-section').first()).toBeVisible();const discoveryWarmMs=Date.now()-homeWarm;
  expect(errors).toEqual([]);await writeFile('test-results/audio-212.json',JSON.stringify({coldImportedAudioMs:coldMs,warmImportedAudioMs:warmMs,matchPersisted:!!persisted,crossfadeTwoAudibleDecks:true,oldDeckRetired:true,pauseStopsBoth:true,metadataMutationDoesNotRestart:true,discoveryColdMs,discoveryWarmMs,errors},null,2));
 }finally{if(browser){const page=browser.contexts()[0].pages()[0];console.log(JSON.stringify(await page.evaluate(()=>({timings:(window as any).__audioTiming,states:[...document.querySelectorAll('audio')].map(a=>({active:a.dataset.active,time:a.currentTime,ready:a.readyState,error:a.error?.message}))})).catch(()=>({}))))};proc.kill();await browser?.close().catch(()=>{});}
});
