import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

await mkdir('../../work/profiles', { recursive: true });
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(resolve('../../work/profiles/direct-catalog-'));
const exe = process.env.GLASS_EXE || join(process.env.LOCALAPPDATA, 'Liquid Hub/liquid-hub.exe');
const proc = spawn(exe, [], { windowsHide: true, env: { ...process.env,
  GLASS_TEST_DATA: profile, GLASS_TEST_CATALOG_URL: '', GLASS_TEST_DISABLE_DIRECT: '0',
  WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9340' } });
let browser;
const result = { testedAt: new Date().toISOString(), livePlatforms: true, credentials: false, queries: [], errors: [] };
try {
  for (let i=0; i<90; i++) { try { if ((await fetch('http://127.0.0.1:9340/json/version')).ok) break; } catch {} await new Promise(r=>setTimeout(r,300)); }
  browser=await chromium.connectOverCDP('http://127.0.0.1:9340');
  const page=browser.contexts()[0].pages()[0];
  page.on('pageerror',e=>result.errors.push(e.message));
  await expect(page.getByRole('button',{name:'Aceitar e continuar'})).toBeVisible({timeout:20000});
  const status=await page.evaluate(()=>window.glass.integrations());
  expect(status).toMatchObject({version:'1.8.0',catalogConfigured:true,catalogMode:'direct',youtube:true,soundcloud:true});
  result.integration=status;
  const denied=await page.evaluate(()=>window.glass.search({query:'Daft Punk',kind:'track',source:'all',requestId:crypto.randomUUID()}));
  expect(denied.items).toHaveLength(0); expect(denied.notices.length).toBeGreaterThan(0);
  result.requiresConsent=true;
  await page.getByRole('button',{name:'Aceitar e continuar',exact:true}).click();
  await page.getByRole('button',{name:'Início',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Descobertas no YouTube',exact:true})).toBeVisible({timeout:50000});
  await expect(page.getByRole('heading',{name:'Eletrônica no SoundCloud',exact:true})).toBeVisible({timeout:50000});
  await expect(page.locator('.online-catalog .track-card')).toHaveCount(10);
  expect(await page.locator('.catalog-notices').count()).toBe(0);
  result.discoveryBothSources=true;
  const session=await browser.contexts()[0].newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false});
  await page.locator('.online-catalog').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({path:'test-results/direct-catalog-home.png'});
  const search=async(source,kind,cursor)=>page.evaluate(r=>window.glass.search(r),{query:'Daft Punk',source,kind,cursor,requestId:crypto.randomUUID()});
  for (const source of ['youtube','soundcloud']) {
    for (const kind of ['track','artist','playlist']) {
      const start=Date.now(); const data=await search(source,kind);
      expect(data.notices).toEqual([]);expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every(t=>t.source===source && t.kind===kind && t.url.startsWith('https://'))).toBe(true);
      const record={source,kind,count:data.items.length,ms:Date.now()-start,sample:data.items.slice(0,2).map(({title,artist,url})=>({title,artist,url}))};
      if(kind==='track') {
        expect(data.next[source]).toBeTruthy();
        const more=await search(source,kind,data.next);
        expect(more.notices).toEqual([]);expect(more.items.length).toBeGreaterThan(0);
        record.newPageItems=more.items.filter(t=>!data.items.some(p=>p.id===t.id)).length;
        expect(record.newPageItems).toBeGreaterThan(0);
        const before=Date.now();expect((await search(source,kind)).items).toEqual(data.items);record.cachedMs=Date.now()-before;
        await page.evaluate(t=>window.glass.library({action:'save',track:t}),data.items[0]);
      }
      result.queries.push(record); console.log(JSON.stringify(record));
    }
  }
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox',{name:'Buscar músicas, artistas e playlists'}).fill('Daft Punk');
  await expect(page.locator('.results-count')).toContainText('40 resultados',{timeout:50000});
  await page.getByRole('button',{name:'Artistas',exact:true}).click();
  await expect(page.locator('.search-page [aria-label="Buscando"]')).toHaveCount(0,{timeout:50000});
  await expect(page.locator('.results-count')).not.toHaveText('0 resultados');
  await page.getByRole('button',{name:'Músicas',exact:true}).click();
  await expect(page.locator('.results-count')).toContainText('40 resultados',{timeout:50000});
  await page.screenshot({path:'test-results/direct-catalog-search.png'});
  result.searchUI=true;
  const cancellation=await page.evaluate(async()=>{
    const requestId=crypto.randomUUID();
    const pending=window.glass.search({query:'glass cancellation '+requestId,kind:'track',source:'all',requestId}).then(()=> 'completed').catch(String);
    await new Promise(r=>setTimeout(r,200));await window.glass.cancelSearch(requestId);return pending;
  });
  expect(cancellation).toContain('cancelada');result.cancellation=cancellation;
  await page.waitForTimeout(1500);
  const remaining=Number(execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-Process -Name yt-dlp -ErrorAction SilentlyContinue).Count"],{encoding:'utf8',windowsHide:true}).trim());
  expect(remaining).toBe(0);result.helperProcessesAfterCancel=remaining;
  const invalid=await page.evaluate(()=>window.glass.search({query:'test',kind:'track',source:'youtube',cursor:{youtube:'999999'},requestId:crypto.randomUUID()}));
  expect(invalid.items).toHaveLength(0);expect(invalid.notices.join(' ')).toContain('Página de busca inválida');result.invalidCursorRejected=true;
  await page.getByRole('button',{name:'Configurações',exact:true}).click();
  await page.getByRole('switch',{name:'Acesso online'}).click();
  const off=await search('youtube','track');expect(off.items).toHaveLength(0);expect(off.notices.length).toBeGreaterThan(0);
  result.revocationBlocksSearch=true;
  expect(result.errors).toEqual([]);
} catch(e) {result.failure=e.message;process.exitCode=1;console.error(e.stack);}
finally {await writeFile('test-results/direct-catalog-validation.json',JSON.stringify(result,null,2));proc.kill();if(browser)await browser.close().catch(()=>{});}
