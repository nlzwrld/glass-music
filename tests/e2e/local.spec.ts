import { test,expect,chromium,type Browser } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createBroker } from '../../server/broker';
import { defaults } from '../../shared/types';
import { activeAudio, navButton, openProfileMenuPage, waitForCdp } from './ui';

test('existing local audio remains playable offline with the optical engine',async()=>{
 test.setTimeout(45000);await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const brokerServer = createBroker(
  {
   BROKER_ACCESS_TOKEN: 'local-e2e-broker-secret-token-123456',
   SOUNDCLOUD_CLIENT_ID: 'local-sc-id',
   SOUNDCLOUD_CLIENT_SECRET: 'local-sc-secret',
  },
  async () => new Response(JSON.stringify({ access_token: 'sc', expires_in: 3600 })),
  Date.now,
  { argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 } },
 );
 await new Promise<void>(r => brokerServer.listen(0, '127.0.0.1', r));
 const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;
 const profile=await mkdtemp(resolve('.test-data/profiles/local-v3-'));
 // A legacy library fixture exercises playback without adding a file-import UI.
 const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 const track={id:'local:qa-legacy',source:'local',kind:'track',sourceId:'qa-legacy',title:'Áudio local de validação',artist:'Teste',duration:20,addedAt:Date.now()};
 db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,volume:0,reducedMotion:true}));db.close();
 let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',LIQUID_HUB_BROKER_URL:brokerUrl,WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9347'}});
 try{
  await waitForCdp(proc, 9347, 90, 200);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9347');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  const gate=page.locator('.auth-gate');await expect(gate).toBeVisible({timeout:15000});
  await gate.locator('input[type="checkbox"]').check();
  await gate.getByRole('button',{name:'Entrar com e-mail',exact:true}).click();
  await gate.getByRole('button',{name:'Criar conta com e-mail',exact:true}).click();
  await gate.getByLabel('Nome de exibição').fill('OfflineUser');
  await gate.getByLabel('E-mail').fill('local-qa@liquidhub.dev');
  await gate.getByLabel('Senha (mínimo 12 caracteres)').fill('LocalOfflinePass!2026');
  await gate.getByRole('button',{name:'Criar conta',exact:true}).click();
  await expect(page.locator('.sidebar .brand')).toBeVisible({timeout:15000});
  await openProfileMenuPage(page, 'Configurações');
  await page.getByRole('switch',{name:'Acesso online'}).click();
  await expect.poll(async()=>(await page.evaluate(()=>window.glass.bootstrap())).preferences.onlineConsent).toBe(false);
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await navButton(page,'Biblioteca').click();await page.getByRole('button',{name:`Reproduzir ${track.title}`,exact:true}).click();
  await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.8);await expect(page.locator('html')).toHaveAttribute('data-optical-engine',/webgl|css/);
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();await expect.poll(()=>activeAudio(page).evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
  expect((await page.evaluate(()=>window.glass.bootstrap())).preferences.onlineConsent).toBe(false);expect(errors).toEqual([]);
  await writeFile('test-results/local-v3-validation.json',JSON.stringify({version:'2.0.1',legacyLocalPlayback:true,offline:true,glassActive:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});brokerServer.closeAllConnections();await new Promise<void>(r=>brokerServer.close(()=>r()));}
});
