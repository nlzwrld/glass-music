import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
await mkdir('../../work/profiles',{recursive:true});const profile=await mkdtemp(resolve('../../work/profiles/installed-'));
const exe=join(process.env.LOCALAPPDATA,'Glass Music/glass-music.exe');const start=Date.now();
const proc=spawn(exe,[],{env:{...process.env,GLASS_TEST_DATA:profile,WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9338'},windowsHide:true});
let browser;
try {
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9338/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9338');const page=browser.contexts()[0].pages()[0];await expect(page.getByText('A sua primeira sessão')).toBeVisible();const startupMs=Date.now()-start;
  await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,volume:0});});await page.reload();await page.getByRole('button',{name:'Reproduzir Meu Flow'}).click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(1);await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
  await new Promise(r=>setTimeout(r,2500));
  const command=`$all = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add(${proc.pid}); for($i=0; $i -lt $ids.Count; $i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and !$ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}}; Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,WorkingSet64,CPU | ConvertTo-Json -Compress`;
  const processes=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}));const list=Array.isArray(processes)?processes:[processes];
  const result={testedAt:new Date().toISOString(),installed:true,startupMs,workingSetTotalMB:Math.round(list.reduce((n,p)=>n+p.WorkingSet64,0)/1048576),processes:list,window:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),localAudioTime:await page.locator('audio').evaluate(a=>a.currentTime),integration:await page.evaluate(()=>window.glass.integrations())};
  const session=await browser.contexts()[0].newCDPSession(page);
  const system=await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');result.graphics={devices:system.gpu.devices,features:system.gpu.featureStatus};
  result.scrollFrames=await page.evaluate(()=>new Promise(resolve=>{const target=document.querySelector('.main-scroll'),frames=[];let start=performance.now(),last=start;function tick(now){frames.push(now-last);last=now;target.scrollTop=(Math.sin((now-start)/500)+1)*Math.max(0,target.scrollHeight-target.clientHeight)/2;if(now-start<3000)requestAnimationFrame(tick);else{target.scrollTop=0;frames.sort((a,b)=>a-b);resolve({samples:frames.length,p95ms:frames[Math.floor(frames.length*.95)],over33ms:frames.filter(t=>t>33.4).length});}}requestAnimationFrame(tick);}));
  await session.send('HeapProfiler.collectGarbage');const before=await session.send('Memory.getDOMCounters');
  for(let i=0;i<20;i++){await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.locator('.settings-page')).toBeVisible();await page.getByRole('button',{name:'Início',exact:true}).click();await expect(page.locator('.home-greeting')).toBeVisible();}
  await new Promise(r=>setTimeout(r,700));await session.send('HeapProfiler.collectGarbage');result.navigationMemory={cycles:20,before,after:await session.send('Memory.getDOMCounters')};
  for(let i=0;i<2;i++){await page.locator('footer.player').getByRole('button',{name:'Próxima faixa',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(.4);}
  await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
  await page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).fill('14');
  await page.locator('footer.player').getByRole('button',{name:'Reproduzir',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(14.3);
  await session.send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,600));
  result.screenshotPlayback=await page.locator('audio').evaluate(a=>({position:a.currentTime,duration:a.duration,paused:a.paused}));
  await page.screenshot({path:'test-results/installed-home.png'});await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();await writeFile('test-results/installed-metrics.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{proc.kill();if(browser)await browser.close().catch(()=>{});}

