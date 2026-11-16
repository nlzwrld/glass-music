import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
const port = process.argv[2] || '9340';
const folder = 'test-results/liquid-v2'; await mkdir(folder, { recursive:true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
try {
  await expect(page.locator('.sidebar>.glass-optics')).toHaveAttribute('data-optics','svg');
  await page.mouse.move(1000, 30); await page.waitForTimeout(500);
  const session = await browser.contexts()[0].newCDPSession(page);
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false});
  await page.waitForTimeout(250);
  const result = {testedAt:new Date().toISOString(), version:await page.evaluate(async()=> (await window.glass.integrations()).version), viewport:[1672,941], materials:await page.locator('.glass-material').evaluateAll(es=>es.map(e=>({class:e.className,variant:e.dataset.glass,optics:e.querySelector('.glass-optics')?.dataset.optics}))), errors:[]};
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.screenshot({path:`${folder}/native-v2.png`});
  const scales = await page.locator('.glass-filter-defs feDisplacementMap').evaluateAll(es=>es.map(e=>e.getAttribute('scale')));
  const setScales = values => page.locator('.glass-filter-defs feDisplacementMap').evaluateAll((es,vs)=>es.forEach((e,i)=>e.setAttribute('scale',vs[i])),values);
  await setScales(scales.map(()=> '0')); await page.waitForTimeout(150);
  await page.screenshot({path:`${folder}/refraction-off.png`});
  await setScales(scales); await page.waitForTimeout(150);
  // Controlled background isolates displacement from blur, tint, art and highlights.
  const diagnostic = await page.addStyleTag({content:'.liquid-backdrop>div,.liquid-backdrop>svg{visibility:hidden!important}.liquid-backdrop{background:repeating-linear-gradient(90deg,#071a31 0 10px,#8fd6ff 10px 20px)!important}'});
  await page.waitForTimeout(200);
  const clip = await page.locator('.sidebar').boundingBox();
  const on = await page.screenshot({path:`${folder}/bevel-grid-on.png`,clip});
  await setScales(scales.map(()=> '0')); await page.waitForTimeout(150);
  const off = await page.screenshot({path:`${folder}/bevel-grid-off.png`,clip});
  const a=PNG.sync.read(on),b=PNG.sync.read(off); let edgeChanged=0,interiorChanged=0,maxDelta=0;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
    const i=(y*a.width+x)*4,delta=Math.max(...[0,1,2].map(c=>Math.abs(a.data[i+c]-b.data[i+c])));
    maxDelta=Math.max(maxDelta,delta);
    if(delta>3){if(x<28||x>=a.width-28||y<28||y>=a.height-28)edgeChanged++;else interiorChanged++;}
  }
  result.displacement={edgeChanged,interiorChanged,maxDelta};
  await setScales(scales); await diagnostic.evaluate(e=>e.remove());
  expect(edgeChanged).toBeGreaterThan(100); expect(interiorChanged).toBeLessThan(10);
  // Capture the actual no-shader fallback and confirm the native player stays usable.
  const prefs=await page.evaluate(async()=> (await window.glass.bootstrap()).preferences);
  await page.evaluate(async p=>window.glass.preferences({...p,performance:true}),prefs); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-performance','true');
  await expect(page.locator('.glass-optics[data-optics="svg"]')).toHaveCount(0);
  result.fallback=await page.locator('.sidebar>.glass-optics').evaluate(e=>({filter:getComputedStyle(e).backdropFilter,mode:e.dataset.optics}));
  await page.screenshot({path:`${folder}/fallback.png`});
  await page.evaluate(async p=>window.glass.preferences(p),prefs); await page.reload();
  await expect(page.locator('.sidebar>.glass-optics')).toHaveAttribute('data-optics','svg');
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await expect(page.locator('.liquid-lens')).toHaveCount(0);
  result.reducedMotion=await page.locator('.sidebar').evaluate(e=>getComputedStyle(e,'::before').transitionDuration);
  await session.send('Emulation.setEmulatedMedia',{features:[]});
  // Simulate lack of URL backdrop filters while retaining normal CSS blur support.
  const unsupported = await session.send('Page.addScriptToEvaluateOnNewDocument', {source:`const originalSupports=CSS.supports.bind(CSS);CSS.supports=(...args)=>args[0]==='backdrop-filter'&&String(args[1]).includes('url(')?false:originalSupports(...args);`});
  await page.reload();
  await expect(page.locator('.glass-optics[data-optics="svg"]')).toHaveCount(0);
  result.cssFallback=await page.locator('.sidebar>.glass-optics').evaluate(e=>({filter:getComputedStyle(e).backdropFilter,mode:e.dataset.optics}));
  expect(result.cssFallback.filter).toContain('blur(');
  await page.screenshot({path:`${folder}/fallback-css.png`});
  await session.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:unsupported.identifier});
  await page.reload();
  await expect(page.locator('.sidebar>.glass-optics')).toHaveAttribute('data-optics','svg');
  const search=page.locator('.global-search');
  const idleSpecular=await search.evaluate(e=>Number(getComputedStyle(e,'::before').opacity));
  await search.locator('input').focus(); await page.waitForTimeout(250);
  const focusedSpecular=await search.evaluate(e=>Number(getComputedStyle(e,'::before').opacity));
  expect(focusedSpecular).toBeGreaterThan(idleSpecular);
  result.specular={idle:idleSpecular,focused:focusedSpecular};
  result.geometry=await page.evaluate(()=>Object.fromEntries(['.glass-window','.sidebar','.main-shell','.side-player','footer.player'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return[s,{x:r.x,y:r.y,width:r.width,height:r.height}]})));
  result.graphics=(await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu.featureStatus;
  await writeFile(`${folder}/optics.json`,JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
