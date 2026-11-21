import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults,type Track} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';
import {activeAudio,navButton,sidebarPlaylist} from './ui';

test('real audio startup, warm replay, live synchronized lyrics and imported playlist image',async()=>{
 test.setTimeout(150000);await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/live-210-'));const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 const remote:Track={id:'youtube:dQw4w9WgXcQ',source:'youtube',sourceId:'dQw4w9WgXcQ',kind:'track',title:'Never Gonna Give You Up',artist:'Rick Astley',duration:213,artwork:'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',addedAt:Date.now()};
 const local:Track={id:'local:latency',source:'local',sourceId:'latency',kind:'track',title:'Teste local',artist:'Teste',duration:20,addedAt:Date.now()};
 const insert=db.prepare('INSERT INTO tracks VALUES(?,?,?,?)');insert.run(remote.id,JSON.stringify(remote),null,Date.now());insert.run(local.id,JSON.stringify(local),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,onlineConsent:true,catalogConsent:true,reducedMotion:true,volume:0,appearance:{...opticalDefaults,backgroundMotion:0,background:'ambient'}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'0',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9367'}});
 let browser:Browser|undefined;
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9367/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9367');const page=browser.contexts()[0].pages()[0];
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await navButton(page,'Biblioteca').click();
  const start=Date.now();await page.getByRole('button',{name:'Reproduzir '+remote.title,exact:true}).click();
  await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:45000,intervals:[100,200,300]}).toBeGreaterThan(.1);const coldMs=Date.now()-start;
  await page.getByRole('button',{name:'Reproduzir Teste local',exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.1);
  const warmStart=Date.now();await page.getByRole('button',{name:'Reproduzir '+remote.title,exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime),{timeout:15000,intervals:[100,200,300]}).toBeGreaterThan(.1);const warmMs=Date.now()-warmStart;
  const lyrics=await page.evaluate(async t=>{const l=await window.glass.lyrics(t);return l?{provider:l.provider,syncedLines:(l.syncedLyrics||'').split('\n').filter(v=>v.startsWith('[')).length,instrumental:l.instrumental}:null;},remote);
  expect(lyrics?.syncedLines).toBeGreaterThan(5);
  const result=await page.evaluate(()=>window.glass.importLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',true));
  const list=result.snapshot.playlists.find(p=>p.id===result.playlistId)!;expect(list.artwork).toMatch(/^https:\/\//);
  await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:10000});
  const importedArtwork=sidebarPlaylist(page,list.name).locator('.cover img');await expect(importedArtwork).toBeVisible();await expect.poll(()=>importedArtwork.evaluate((im:HTMLImageElement)=>im.naturalWidth),{timeout:15000}).toBeGreaterThan(0);
  const report={coldMs,warmMs,lyrics,playlist:{count:result.count,artworkHost:new URL(list.artwork!).hostname,imageLoaded:true}};console.log(JSON.stringify(report));await writeFile('test-results/live-210.json',JSON.stringify(report,null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
