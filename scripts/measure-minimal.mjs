import { chromium, expect } from '@playwright/test';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
const profile=await mkdtemp(resolve('../../work/profiles/minimal-metrics-'));
const proc=spawn(join(process.env.LOCALAPPDATA,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9338'}});
const start=Date.now();let browser;
try{
 for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9338/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:9338');const page=browser.contexts()[0].pages()[0];
 await expect(page.getByRole('button',{name:'Aceitar e continuar'})).toBeVisible({timeout:15000});
 const interactiveMs=Date.now()-start;
 await page.getByRole('button',{name:'Aceitar e continuar'}).click();
 await expect(page.getByRole('heading',{name:'Descobertas no YouTube',exact:true})).toBeVisible({timeout:45000});
 await expect(page.getByRole('heading',{name:'Eletrônica no SoundCloud',exact:true})).toBeVisible({timeout:45000});
 await expect(page.locator('.track-card')).toHaveCount(10);
 await page.waitForTimeout(1500);
 const cdp=await browser.contexts()[0].newCDPSession(page);
 const frames=await page.evaluate(()=>new Promise(resolve=>{const el=document.querySelector('.main-scroll'),values=[];let start=performance.now(),last=start;const tick=now=>{values.push(now-last);last=now;el.scrollTop=(Math.sin((now-start)/400)+1)*Math.max(0,el.scrollHeight-el.clientHeight)/2;if(now-start<2500)requestAnimationFrame(tick);else{el.scrollTop=0;values.sort((a,b)=>a-b);resolve({samples:values.length,p95ms:values[Math.floor(values.length*.95)],over33ms:values.filter(t=>t>33.4).length});}};requestAnimationFrame(tick);}));
 await cdp.send('HeapProfiler.collectGarbage');const before=await cdp.send('Memory.getDOMCounters');
 for(let i=0;i<12;i++){await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.locator('.settings-page')).toBeVisible();await page.getByRole('button',{name:'Início',exact:true}).click();await expect(page.locator('.home-page')).toBeVisible();}
 await page.waitForTimeout(3000);await cdp.send('HeapProfiler.collectGarbage');await page.waitForTimeout(500);await cdp.send('HeapProfiler.collectGarbage');const after=await cdp.send('Memory.getDOMCounters');
 const command=`$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.List[int]]::new();$ids.Add(${proc.pid});for($i=0;$i -lt $ids.Count;$i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and !$ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}};Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue | Select-Object ProcessName,WorkingSet64 | ConvertTo-Json -Compress`;
 const processes=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8'}));
 const result={version:'1.6.0',interactiveMsIncludesGreeting:interactiveMs,scroll:frames,processes,workingSetMB:Math.round(processes.reduce((n,p)=>n+p.WorkingSet64,0)/1048576),navigation:{cycles:12,before,after},layout:await page.evaluate(()=>({svgFilters:document.querySelectorAll('filter').length,canvas:document.querySelectorAll('canvas').length,images:Array.from(document.querySelectorAll('.card-cover .cover')).map(el=>{const b=el.getBoundingClientRect();return{width:b.width,height:b.height};}),bodyBackground:getComputedStyle(document.body).backgroundColor,appBackground:getComputedStyle(document.querySelector('.app')).backgroundColor})),integration:await page.evaluate(()=>window.glass.integrations())};
 expect(result.layout.svgFilters).toBe(0);expect(result.layout.canvas).toBe(0);expect(result.layout.images.every(b=>Math.abs(b.width-b.height)<1)).toBe(true);
 await page.screenshot({path:'test-results/minimal-live-home.png'});await page.screenshot({path:'test-results/minimal-transparent.png',omitBackground:true});
 await writeFile('test-results/minimal-metrics.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{proc.kill();if(browser)await browser.close().catch(()=>{});}
