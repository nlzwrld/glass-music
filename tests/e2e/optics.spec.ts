import { test,expect,chromium,type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
// @ts-expect-error pngjs exposes a CommonJS runtime without declarations.
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

test('Liquid Glass V3: live backdrop, edge refraction, idle rendering, fallback and resize',async()=>{
 test.setTimeout(150000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/optics-v3-'));let browser:Browser|undefined;const errors:string[]=[];
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9346'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9346/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9346');const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('button',{name:'Agora não',exact:true})).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'Agora não',exact:true}).click();
  await expect(page.locator('.welcome-screen')).toBeVisible();await expect(page.locator('.welcome-screen time')).toHaveText(/\d{2}:\d{2}/);
  await page.screenshot({path:'test-results/glass-v3-startup-clock.png'});await expect(page.locator('.welcome-screen')).toHaveCount(0);
  await page.evaluate(()=>window.glass.window('restore'));await expect.poll(()=>page.evaluate(()=>window.glass.visualState())).toBe(true);
  await page.getByRole('button',{name:'Configurações',exact:true}).click();
  await page.getByRole('slider',{name:'Movimento do fundo',exact:true}).fill('0');await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');await expect(page.getByRole('button',{name:'Área de trabalho',exact:true})).toHaveClass(/selected/);const windowShape=await page.evaluate(()=>window.glass.windowShape());expect(windowShape.nativeRegion).toBe(true);expect(windowShape.clientInsets).toEqual([0,0,0,0]);expect(windowShape.corners).toEqual([false,false,false,false]);expect(windowShape.center).toBe(true);expect(windowShape.sideMidpoints.every(Boolean)).toBe(true);await page.screenshot({path:'test-results/glass-v3-desktop-transparent.png',omitBackground:true});await page.evaluate(()=>window.glass.window('mini'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).width)).toBeLessThan(windowShape.width);const miniShape=await page.evaluate(()=>window.glass.windowShape());expect(miniShape.nativeRegion).toBe(true);expect(miniShape.clientInsets).toEqual([0,0,0,0]);expect(miniShape.corners).toEqual([false,false,false,false]);await page.evaluate(()=>window.glass.window('restore'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).width)).toBeGreaterThan(miniShape.width);await page.getByRole('button',{name:'Ambiente',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  await expect(page.locator('canvas')).toHaveCount(2);
  await page.getByRole('switch',{name:'Reduzir animações',exact:true}).setChecked(true);await expect(page.getByRole('switch',{name:'Reduzir animações',exact:true})).toBeChecked();await expect(page.locator('html')).toHaveAttribute('data-motion','reduced');
  await page.locator('.advanced-appearance').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Glass Laboratory'})).toBeVisible();await page.waitForTimeout(800);
  await page.screenshot({path:'test-results/glass-v3-laboratory.png'});
  const css=PNG.sync.read(await page.locator('[data-lab-scene=css]').screenshot()),webgl=PNG.sync.read(await page.locator('[data-lab-scene=webgl]').screenshot());
  const comparison=pixelmatch(css.data,webgl.data,null,css.width,css.height,{threshold:.12})/(css.width*css.height);expect(comparison).toBeGreaterThan(.001);
  for(const [label,value] of [['Blur','0'],['Opacidade','0'],['Saturação','1'],['Reflexo especular','0'],['Aberração cromática','0'],['Refração','0']])await page.getByRole('slider',{name:label,exact:true}).fill(value);
  await page.waitForTimeout(400);const lens=page.locator('[data-lab-scene=webgl] .lab-card'),flat=PNG.sync.read(await lens.screenshot());
  await page.getByRole('slider',{name:'Refração',exact:true}).fill('10');await page.waitForTimeout(400);const bent=PNG.sync.read(await lens.screenshot());
  const diff=new PNG({width:flat.width,height:flat.height});pixelmatch(flat.data,bent.data,diff.data,flat.width,flat.height,{threshold:.04});
  await writeFile('test-results/glass-v3-refraction-diff.png',PNG.sync.write(diff));
  let edge=0,edgeTotal=0,center=0,centerTotal=0;
  for(let y=0;y<flat.height;y++)for(let x=0;x<flat.width;x++){
   const i=(y*flat.width+x)*4,delta=Math.max(...[0,1,2].map(c=>Math.abs(flat.data[i+c]-bent.data[i+c])));
   if(x<16||x>=flat.width-16||y<16||y>=flat.height-16){edgeTotal++;if(delta>10)edge++;}
   else if(x>35&&x<flat.width-35&&y>35&&y<flat.height-35){centerTotal++;if(delta>10)center++;}
  }
  await writeFile('test-results/glass-v3-flat.png',PNG.sync.write(flat));await writeFile('test-results/glass-v3-bent.png',PNG.sync.write(bent));
  expect(edge/edgeTotal).toBeGreaterThan(.025);expect(center/Math.max(1,centerTotal)).toBeLessThan(edge/edgeTotal*.25);
  await page.getByRole('button',{name:'Restaurar material',exact:true}).click();
  await page.getByRole('button',{name:'Fechar laboratório',exact:true}).click();await page.getByRole('slider',{name:'Movimento do fundo',exact:true}).fill('0');
  await page.getByRole('switch',{name:'Reduzir animações',exact:true}).setChecked(false);await expect(page.getByRole('switch',{name:'Reduzir animações',exact:true})).not.toBeChecked();await expect(page.locator('html')).toHaveAttribute('data-motion','full');
  await page.locator('.advanced-appearance').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();await page.waitForTimeout(500);
  const movingBefore=PNG.sync.read(await page.locator('[data-lab-scene=webgl]').screenshot());const fpsBefore=await page.evaluate(()=>({draws:(window as any).__glassOptics.draws,time:performance.now()}));await page.waitForTimeout(1000);const fpsAfter=await page.evaluate(()=>({draws:(window as any).__glassOptics.draws,time:performance.now()}));const labFps=(fpsAfter.draws-fpsBefore.draws)*1000/(fpsAfter.time-fpsBefore.time);expect(labFps).toBeLessThan(40);expect(labFps).toBeGreaterThan(15);const movingAfter=PNG.sync.read(await page.locator('[data-lab-scene=webgl]').screenshot());
  const movingPixels=pixelmatch(movingBefore.data,movingAfter.data,null,movingBefore.width,movingBefore.height,{threshold:.12});expect(movingPixels).toBeGreaterThan(100);
  await page.getByRole('button',{name:'Fechar laboratório',exact:true}).click();
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await page.waitForTimeout(1000);
  const beforeIdle=await page.evaluate(()=>(window as any).__glassOptics.draws);await page.waitForTimeout(1400);const afterIdle=await page.evaluate(()=>(window as any).__glassOptics.draws);expect(afterIdle-beforeIdle).toBeLessThanOrEqual(2);
  await cdp.send('HeapProfiler.collectGarbage');const beforeDom=await cdp.send('Memory.getDOMCounters');
  for(let i=0;i<8;i++){await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:'Configurações',exact:true}).click();}
  await page.waitForTimeout(3000);await cdp.send('HeapProfiler.collectGarbage');await page.waitForTimeout(500);await cdp.send('HeapProfiler.collectGarbage');const afterDom=await cdp.send('Memory.getDOMCounters');expect(afterDom.jsEventListeners-beforeDom.jsEventListeners).toBeLessThan(25);
  const glInfo=await page.evaluate(()=>{const gl=document.querySelector<HTMLCanvasElement>('.optical-surfaces')!.getContext('webgl2')!,ext=gl.getExtension('WEBGL_debug_renderer_info');return{version:gl.getParameter(gl.VERSION),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unavailable'};});
  await page.evaluate(()=>{const ext=document.querySelector<HTMLCanvasElement>('.optical-surfaces')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;(window as any).__loss=ext;ext.loseContext();});
  await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');await page.screenshot({path:'test-results/glass-v3-fallback.png'});
  await page.evaluate(()=>(window as any).__loss.restoreContext());
  await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');
  await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await expect(page.locator('.optical-scene')).toHaveCSS('visibility','hidden');await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');
  await page.getByRole('button',{name:'Ambiente',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  const layouts=[];
  for(const [width,height] of [[1672,941],[1360,860],[920,650]]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await page.waitForTimeout(450);
   const box=await page.evaluate(()=>({overflow:document.querySelector('.main-scroll')!.scrollWidth>document.querySelector('.main-scroll')!.clientWidth+1,footer:document.querySelector('.player')!.getBoundingClientRect().bottom<=innerHeight+1,source:(window as any).__glassOptics.source}));expect(box.overflow).toBe(false);expect(box.footer).toBe(true);layouts.push({width,height,...box});await page.screenshot({path:`test-results/glass-v3-${width}.png`});
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const frames=await page.evaluate(()=>new Promise(resolve=>{const el=document.querySelector('.main-scroll')!,values:number[]=[];let start=performance.now(),last=start;const tick=(now:number)=>{values.push(now-last);last=now;el.scrollTop=(Math.sin((now-start)/300)+1)*Math.max(0,el.scrollHeight-el.clientHeight)/2;if(now-start<1800)requestAnimationFrame(tick);else{el.scrollTop=0;values.sort((a,b)=>a-b);resolve({samples:values.length,p95ms:values[Math.floor(values.length*.95)],over33ms:values.filter(t=>t>33.4).length});}};requestAnimationFrame(tick);}));
  await page.locator('.advanced-appearance').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();await page.waitForTimeout(500);
  await page.evaluate(()=>window.glass.window('minimize'));await expect(page.locator('html')).toHaveAttribute('data-optical-visible','false');expect(await page.evaluate(()=>window.glass.visualState())).toBe(false);await page.waitForTimeout(200);const minimizedBefore=await page.evaluate(()=>(window as any).__glassOptics.draws);await page.waitForTimeout(500);expect(await page.evaluate(()=>(window as any).__glassOptics.draws)).toBe(minimizedBefore);await page.evaluate(()=>window.glass.window('restore'));await expect(page.locator('html')).toHaveAttribute('data-optical-visible','true');await expect.poll(()=>page.evaluate(()=>(window as any).__glassOptics.draws)).toBeGreaterThan(minimizedBefore);await page.getByRole('button',{name:'Fechar laboratório',exact:true}).click();
  await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.getByRole('button',{name:'Ambiente',exact:true})).toHaveClass(/selected/);
  expect(errors).toEqual([]);
  await writeFile('test-results/glass-v3-validation.json',JSON.stringify({version:'2.0.1',windowShape,miniShape,transparentDefault:true,oneSharedContext:true,glInfo,liveBackdrop:true,threeMethods:true,cssVsWebglDifference:comparison,refraction:{edgeChangedRatio:edge/edgeTotal,centerChangedRatio:center/Math.max(1,centerTotal)},movingPixels,labFps,idleDraws:afterIdle-beforeIdle,contextLossFallback:true,contextRestore:true,performanceFallback:true,desktopMode:true,minimizedStopsRendering:true,layouts,navigation:{cycles:8,before:beforeDom,after:afterDom},scroll:frames,performance:await cdp.send('Performance.getMetrics'),errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
