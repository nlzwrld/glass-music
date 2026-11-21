import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults,type Track} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';
import {activeAudio,openSidebarPlaylist} from './ui';

test('playlist play, filtered drag, keyboard order, context transfer, removal and individual song covers',async()=>{
 test.setTimeout(120000);await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/playlists-211-'));const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));');
 const tracks:Track[]=['A faixa','Oculta','B faixa'].map((title,i)=>({id:'local:qa'+i,source:'local',sourceId:'qa'+i,kind:'track',title,artist:'Teste',duration:20,addedAt:1}));
 for(const t of tracks)db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(t.id,JSON.stringify(t),resolve('assets/audio/prisma.wav'),Date.now());
 const remote=['4uLU6hMCjMI75M1A2tKUQC','7qiZfU4dY1lWllzX7mPBI3'].map((sourceId,i):Track=>({id:'link:cover'+i,source:'link',sourceId:'cover'+i,kind:'track',title:i?'Shape of You':'Never Gonna Give You Up',artist:i?'Ed Sheeran':'Rick Astley',duration:210,url:'https://open.spotify.com/track/'+sourceId,addedAt:1}));
 for(const t of remote)db.prepare('INSERT INTO tracks VALUES(?,?,NULL,?)').run(t.id,JSON.stringify(t),Date.now());
 for(const id of ['origem','destino'])db.prepare('INSERT INTO playlists VALUES(?,?,?)').run(id,id==='origem'?'Minha playlist':'Destino',1);
 tracks.forEach((t,i)=>db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('origem',t.id,i));remote.forEach((t,i)=>db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('destino',t.id,i));
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,onlineConsent:true,catalogConsent:false,volume:0,reducedMotion:true,appearance:{...opticalDefaults,background:'solid',backgroundMotion:0}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9368'}});let browser:Browser|undefined;const errors:string[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9368/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9368');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await openSidebarPlaylist(page,'Minha playlist');
  const play=page.getByRole('button',{name:'Reproduzir playlist',exact:true});await expect(play).toBeVisible();expect(await play.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgb(245, 245, 245)');expect((await play.boundingBox())!.height).toBe(34);
  await play.click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.2);await page.getByRole('button',{name:'Pausar playlist',exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
  await page.getByRole('textbox',{name:'Pesquisar nesta coleção'}).fill('faixa');await expect(page.locator('.track-row')).toHaveCount(2);
  const dt=await page.evaluateHandle(()=>new DataTransfer());await page.getByRole('button',{name:'Mover A faixa',exact:true}).dispatchEvent('dragstart',{dataTransfer:dt});await page.locator('.track-row').filter({hasText:'B faixa'}).dispatchEvent('drop',{dataTransfer:dt});
  const order=()=>page.evaluate(async()=>(await window.glass.bootstrap()).playlists.find(p=>p.id==='origem')!.trackIds);
  await expect.poll(order).toEqual(['local:qa1','local:qa2','local:qa0']);
  await page.getByRole('textbox',{name:'Pesquisar nesta coleção'}).fill('');await page.getByRole('button',{name:'Mover A faixa',exact:true}).press('Alt+ArrowUp');await expect.poll(order).toEqual(['local:qa1','local:qa0','local:qa2']);
  const row=page.locator('.track-row').filter({hasText:'A faixa'});await row.click({button:'right'});await expect(page.getByRole('menu',{name:'Opções de A faixa'})).toBeVisible();await page.getByRole('menuitem',{name:'Mover para outra playlist',exact:true}).click();await page.getByRole('dialog',{name:'Mover para playlist'}).getByRole('button',{name:/Destino/}).click();await expect.poll(order).toEqual(['local:qa1','local:qa2']);
  await openSidebarPlaylist(page,'Destino');await expect(page.locator('.track-row').filter({hasText:'A faixa'})).toBeVisible();
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.glass.bootstrap());return remote.map(t=>s.tracks.find(v=>v.id===t.id)?.artwork||'');},{timeout:50000}).toEqual([expect.stringMatching(/^https:\/\//),expect.stringMatching(/^https:\/\//)]);
  const artwork=await page.evaluate(async()=>{const s=await window.glass.bootstrap();return s.tracks.filter(t=>t.source==='link').map(t=>t.artwork!);});expect(new Set(artwork).size).toBe(2);
  for(const t of remote){const img=page.locator('.track-row').filter({hasText:t.title}).locator('.cover img');await expect.poll(()=>img.evaluate((im:HTMLImageElement)=>im.naturalWidth),{timeout:20000}).toBeGreaterThan(0);}
  await page.locator('.track-row').filter({hasText:'A faixa'}).click({button:'right'});await page.getByRole('menuitem',{name:'Remover da playlist',exact:true}).click();await expect(page.locator('.track-row').filter({hasText:'A faixa'})).toHaveCount(0);expect((await page.evaluate(()=>window.glass.bootstrap())).tracks.some(t=>t.id==='local:qa0')).toBe(true);
  const edge=page.locator('.track-row').first();await edge.focus();await edge.press('Shift+F10');const menu=page.getByRole('menu');await expect(menu).toBeVisible();await menu.press('End');await expect(menu.getByRole('menuitem',{name:'Remover da biblioteca',exact:true})).toBeFocused();await menu.press('Escape');await expect(menu).toHaveCount(0);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.playlist-page')!.parentElement!).opacity==='1');await page.screenshot({path:'test-results/playlists-211-dark.png'});
  await openSidebarPlaylist(page,'Minha playlist');await page.getByRole('button',{name:'Opções de B faixa',exact:true}).click();await page.getByRole('menuitem',{name:'Remover da biblioteca',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();await expect.poll(order).toEqual(['local:qa1']);
  const saved=await page.evaluate(()=>window.glass.bootstrap());await page.evaluate(async p=>{await window.glass.preferences({...p,theme:'light'});},saved.preferences);await page.reload();await openSidebarPlaylist(page,'Destino');await expect(page.locator('.track-row .cover img')).toHaveCount(2);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.playlist-page')!.parentElement!).opacity==='1');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:'test-results/playlists-211-light.png'});expect(errors).toEqual([]);
  await writeFile('test-results/playlists-211.json',JSON.stringify({mattePlayStyle:true,filteredReorder:true,keyboardReorder:true,atomicTransfer:true,playlistRemovalPreservesLibrary:true,libraryRemoval:true,keyboardMenu:true,individualArtwork:{count:artwork.length,distinct:2,persisted:true,loaded:true},errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
