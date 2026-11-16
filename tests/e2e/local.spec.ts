import { test,expect,chromium,type Browser } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { defaults } from '../../shared/types';

test('existing local audio remains playable offline with the optical engine',async()=>{
 test.setTimeout(45000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/local-v3-'));
 // A legacy library fixture exercises playback without adding a file-import UI.
 const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 const track={id:'local:qa-legacy',source:'local',kind:'track',sourceId:'qa-legacy',title:'Áudio local de validação',artist:'Teste',duration:20,addedAt:Date.now()};
 db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,volume:0,reducedMotion:true}));db.close();
 let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Glass Music/glass-music.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9347'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9347/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9347');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:`Reproduzir ${track.title}`,exact:true}).click();
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.8);await expect(page.locator('html')).toHaveAttribute('data-optical-engine',/webgl|css/);
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
  expect((await page.evaluate(()=>window.glass.bootstrap())).preferences.onlineConsent).toBe(false);expect(errors).toEqual([]);
  await writeFile('test-results/local-v3-validation.json',JSON.stringify({version:'2.0.1',legacyLocalPlayback:true,offline:true,glassActive:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
