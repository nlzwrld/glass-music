import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
// @ts-expect-error pngjs exposes a CommonJS runtime without declarations.
import {PNG} from 'pngjs';
import {defaults} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';
test('themes cover the entire client area without a transparent perimeter',async()=>{
 test.setTimeout(120000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/edges-201-')),db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,reducedMotion:true,appearance:{...opticalDefaults,background:'ambient',quality:'balanced'}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9357'}});
 let browser:Browser|undefined;const errors:string[]=[],checks:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9357/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9357');const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.getByRole('button',{name:'Configurações',exact:true}).click();
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  const img=new PNG({width:8,height:8});for(let n=0;n<img.data.length;n+=4){img.data[n]=60;img.data[n+1]=150;img.data[n+2]=110;img.data[n+3]=255;}
  await page.getByRole('button',{name:'Personalizado',exact:true}).click();await page.locator('[data-background-upload]').setInputFiles({name:'ambient.png',mimeType:'image/png',buffer:PNG.sync.write(img)});await expect(page.locator('.custom-background-preview')).toBeVisible();
  for(const theme of ['Escuro','Claro']){
   await page.getByRole('button',{name:theme,exact:true}).click();
   for(const mode of ['Ambiente','Dinâmico','Cor','Personalizado']){
    await page.getByRole('button',{name:mode,exact:true}).click();await page.waitForTimeout(450);
    const geometry=await page.evaluate(()=>{const r=document.querySelector('.optical-root')!.getBoundingClientRect(),c=document.querySelector('.optical-scene')!.getBoundingClientRect();return{root:[r.left,r.top,r.right,r.bottom],canvas:[c.left,c.top,c.right,c.bottom],width:innerWidth,height:innerHeight};});
    expect(geometry.canvas[0]).toBeLessThanOrEqual(1.1);expect(geometry.canvas[1]).toBeLessThanOrEqual(1.1);expect(geometry.canvas[2]).toBeGreaterThanOrEqual(geometry.width-1.1);expect(geometry.canvas[3]).toBeGreaterThanOrEqual(geometry.height-1.1);
    for(const fallback of [false,true]){
     if(fallback)await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).setChecked(true);
     const png=PNG.sync.read(await page.screenshot({omitBackground:true})),w=png.width,h=png.height;
     const samples=[[Math.floor(w/2),4],[Math.floor(w/2),h-5],[4,Math.floor(h/2)],[w-5,Math.floor(h/2)]].map(([x,y])=>[...png.data.subarray((y*w+x)*4,(y*w+x)*4+4)]);
     expect(samples.every(p=>p[3]===255)).toBe(true);
     if(mode==='Ambiente'){const brightness=samples.map(p=>(p[0]+p[1]+p[2])/3);expect(brightness.every(v=>theme==='Claro'?v>160:v<80)).toBe(true);}
     checks.push({theme,mode,fallback,geometry,samples});if(fallback)await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).setChecked(false);
    }
    if(mode==='Ambiente'){await page.locator('.main-scroll').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(300);await page.screenshot({path:`test-results/edges-${theme==='Claro'?'light':'dark'}.png`});}
   }
   await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await page.waitForTimeout(400);await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).systemBackdrop)).toBe(1);await expect(page.locator('.optical-scene')).toHaveCSS('visibility','hidden');
   const desktop=PNG.sync.read(await page.screenshot({omitBackground:true}));expect(desktop.data[(4*desktop.width+Math.floor(desktop.width/2))*4+3]).toBeLessThan(255);
  }
  await page.getByRole('button',{name:'Ambiente',exact:true}).click();await page.getByRole('button',{name:'Escuro',exact:true}).click();
  await page.locator('.advanced-appearance').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();await expect(page.getByRole('dialog',{name:'Glass Laboratory'})).toBeVisible();await page.screenshot({path:'test-results/edges-laboratory.png'});await page.getByRole('button',{name:'Fechar laboratório',exact:true}).click();
  await page.getByRole('button',{name:'Criar playlist',exact:true}).click();await page.getByRole('textbox',{name:'Nome da playlist',exact:true}).fill('Validação de margens');await page.getByRole('dialog').getByRole('button',{name:'Criar playlist',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.playlist-row').getByRole('button',{name:'Opções de Validação de margens'}).click();await expect(page.getByRole('menu')).toBeVisible();const menu=await page.getByRole('menu').boundingBox();expect(menu!.x).toBeGreaterThanOrEqual(0);expect(menu!.x+menu!.width).toBeLessThanOrEqual(1280);await page.keyboard.press('Escape');
  expect(errors).toEqual([]);await writeFile('test-results/edges-validation.json',JSON.stringify({version:'2.0.1',checks,desktopTransparencyPreserved:true,menuAndLaboratory:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
