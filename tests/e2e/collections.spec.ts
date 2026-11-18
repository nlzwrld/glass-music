import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
test('public playlists become real local collections; account setup is honest and imports stay inside Glass',async()=>{
 test.setTimeout(240000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/collections-190-'));let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'0',GLASS_TEST_CATALOG_URL:'',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9354'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9354/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9354');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Permitir e continuar'}).click({timeout:15000});await page.evaluate(()=>window.glass.window('restore'));
  await page.evaluate(()=>{(window as any).__externalCalls=[];window.glass.external=async url=>{(window as any).__externalCalls.push(url);};});
  const url='https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
  await page.getByRole('button',{name:'Importar playlist',exact:true}).click();await page.getByRole('textbox',{name:'Link da playlist'}).fill(url);await page.getByRole('dialog').getByRole('button',{name:'Importar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:30000});
  const first=await page.evaluate(()=>window.glass.bootstrap());expect(first.playlists).toHaveLength(1);expect(first.playlists[0].trackIds.length).toBeGreaterThan(0);expect(first.tracks.every(t=>t.kind==='track')).toBe(true);
  await expect(page.locator('.toast')).toContainText('pode limitar');await expect(page.locator('.page-heading h1')).toHaveText(first.playlists[0].name);
  const repeat=await page.evaluate(url=>window.glass.importLink(url,true),url);expect(repeat.playlistId).toBe(first.playlists[0].id);expect(repeat.snapshot.playlists[0].trackIds).toEqual(first.playlists[0].trackIds);expect(repeat.snapshot.tracks).toHaveLength(first.tracks.length);
  const imports=[{provider:'spotify',name:first.playlists[0].name,count:first.tracks.length,warning:repeat.warning}];
  for(const [provider,url] of [['youtube','https://www.youtube.com/playlist?list=PLBB231211A4F62143'],['soundcloud','https://soundcloud.com/forss/sets/soulhack'],['deezer','https://www.deezer.com/playlist/908622995']]){
   const result=await page.evaluate(url=>window.glass.importLink(url,true),url);expect(result.count).toBeGreaterThan(0);expect(result.snapshot.playlists.find(p=>p.id===result.playlistId)?.trackIds).toHaveLength(result.count!);imports.push({provider,name:result.snapshot.playlists.find(p=>p.id===result.playlistId)!.name,count:result.count!,warning:result.warning});
  }
  const before=await page.evaluate(()=>window.glass.bootstrap());
  const invalid=await page.evaluate(async()=>{try{await window.glass.importLink('https://127.0.0.1/playlist/a',true);return '';}catch(e){return String(e);}});expect(invalid).toContain('HTTPS');expect((await page.evaluate(()=>window.glass.bootstrap())).playlists).toEqual(before.playlists);
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.locator('.account-row')).toHaveCount(3);for(const name of ['YouTube','SoundCloud','Spotify'])await expect(page.getByRole('button',{name:`Conectar ${name}`,exact:true})).toBeDisabled();await expect(page.locator('.account-row').first()).toContainText('Indisponível');
  const accounts=await page.evaluate(()=>window.glass.accounts());expect(accounts.every(a=>!a.configured&&!a.connected)).toBe(true);expect(JSON.stringify(accounts)).not.toMatch(/access_token|refresh_token|clientSecret/);
  const missing=await page.evaluate(async()=>{try{await window.glass.connectAccount('spotify');return '';}catch(e){return String(e);}});expect(missing).toContain('cadastro');
  expect(await page.evaluate(()=>(window as any).__externalCalls)).toEqual([]);expect(errors).toEqual([]);await expect(page.locator('video,iframe[src*="youtube"]')).toHaveCount(0);await page.screenshot({path:'test-results/accounts-190.png'});
  await writeFile('test-results/collections-190-validation.json',JSON.stringify({version:'2.0.1',imports,realTracks:true,idempotentReimport:true,invalidImportIsAtomic:true,noBrowserOnImport:true,noVideo:true,accounts: 'Prepared; unregistered and not live-authorized',errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
