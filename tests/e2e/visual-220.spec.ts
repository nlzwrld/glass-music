import {test,expect,chromium,type Browser,type Page} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';

async function appearance(page:Page){
 await page.getByRole('button',{name:'Configurações',exact:true}).click();
 const category=page.getByRole('button',{name:'Aparência',exact:true});
 await category.click();
 await expect(page.getByRole('slider',{name:'Intensidade do gradiente',exact:true})).toBeVisible();
}

test('recent sidebar fits, vivid gradients remain tonal, desktop blur stays neutral and motion honors preference',async()=>{
 test.setTimeout(150000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/visual-220-')),db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE history(track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,played INTEGER NOT NULL);');
 for(let i=0;i<36;i++){
  const track={id:`local:recent-${i}`,source:'local',kind:'track',sourceId:`recent-${i}`,title:`Música ${i} com um título extenso para testar a barra lateral`,artist:'Artista com nome extenso de validação',artwork:'/covers/prisma.svg',duration:20,addedAt:Date.now()};
  db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now());
  db.prepare('INSERT INTO history VALUES(?,?)').run(track.id,Date.now()-i*1000);
 }
 db.prepare('INSERT INTO history VALUES(?,?)').run('local:recent-0',Date.now()+1000);
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,onlineConsent:false,catalogConsent:false,volume:0,glass:20,reducedMotion:false,appearance:{...opticalDefaults,background:'solid',solidColor:'#ff0000',backgroundMotion:0,quality:'balanced'}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9384'}});
 let browser:Browser|undefined;const errors:string[]=[],layouts:unknown[]=[],gradients:unknown[]=[],desktop:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9384/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9384');const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});
  await expect(page.locator('.sidebar .recent-track')).toHaveCount(30);
  await expect(page.locator('.sidebar .playlist-row')).toHaveCount(0);
  const cdp=await context.newCDPSession(page);
  for(const width of [1000,1280,1920]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:768,deviceScaleFactor:1,mobile:false});
   const layout=await page.locator('.sidebar-recents').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,overflowX:getComputedStyle(el).overflowX,vertical:el.scrollHeight>el.clientHeight}));
   expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);expect(layout.overflowX).toBe('hidden');expect(layout.vertical).toBe(true);layouts.push({viewportWidth:width,...layout});
  }
  await page.locator('.sidebar-recents').evaluate(el=>el.scrollTop=el.scrollHeight);
  await expect(page.locator('.sidebar .recent-track').last()).toBeInViewport();
  await page.getByRole('button',{name:/^Reproduzir recente Música 0 /}).click();
  await expect.poll(()=>page.locator('audio[data-active="true"]').evaluate((audio:HTMLAudioElement)=>audio.currentTime)).toBeGreaterThan(.1);
  await appearance(page);await page.getByRole('combobox',{name:'Escala da interface'}).selectOption('125');
  expect(await page.locator('.sidebar-recents').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.getByRole('combobox',{name:'Escala da interface'}).selectOption('100');
  const sample=()=>page.locator('.optical-scene').evaluate((canvas:HTMLCanvasElement)=>{
   const ctx=canvas.getContext('2d')!;return [[.06,.08],[.45,.4],[.94,.92]].map(([x,y])=>Array.from(ctx.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data).slice(0,3));
  });
  const spread=(points:number[][])=>Math.max(...points[0].map((_,i)=>Math.max(...points.map(p=>p[i]))-Math.min(...points.map(p=>p[i]))));
  const settle=()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  for(const color of ['#ff0000','#00ff00','#0000ff','#ffffff','#000000']){
   await page.locator('input[type=color]').fill(color);await page.getByRole('slider',{name:'Intensidade do gradiente',exact:true}).fill('1');
   await settle();
   await expect.poll(async()=>spread(await sample())).toBeGreaterThan(16);
   const strong=await sample();await page.getByRole('slider',{name:'Intensidade do gradiente',exact:true}).fill('.1');await settle();
   await expect.poll(async()=>JSON.stringify(await sample())).not.toBe(JSON.stringify(strong));
   const weak=await sample();expect(spread(strong),color).toBeGreaterThan(spread(weak));gradients.push({color,strong,weak});
  }
  await page.locator('input[type=color]').fill('#ff3333');await page.getByRole('slider',{name:'Intensidade do gradiente',exact:true}).fill('.8');
  await page.screenshot({path:'test-results/visual-220-gradient.png'});
  await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();
  for(const value of ['0','24']){
   await page.getByRole('slider',{name:'Desfoque',exact:true}).fill(value);await settle();
   const state=await page.locator('[data-window-material]').evaluate(el=>({tint:getComputedStyle(el).getPropertyValue('--appearance-tint').trim(),filter:getComputedStyle(el).backdropFilter}));
   expect(state.tint).toBe('#202020');expect(state.filter).toContain('grayscale(1)');desktop.push({blur:value,...state});
  }
  await page.getByRole('switch',{name:'Reduzir animações',exact:true}).setChecked(true);
  await expect(page.locator('html')).toHaveAttribute('data-motion','reduced');
  const duration=await page.locator('.recent-track').first().evaluate(el=>getComputedStyle(el).transitionDuration);expect(duration.split(',').every(v=>parseFloat(v)<.001)).toBe(true);
  expect(errors).toEqual([]);await writeFile('test-results/visual-220-validation.json',JSON.stringify({layouts,gradients,desktop,reducedMotion:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
