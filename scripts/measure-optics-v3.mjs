import { chromium,expect } from '@playwright/test';
import { spawn,execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
const profile=await mkdtemp(resolve('../../work/profiles/optical-memory-'));
const proc=spawn(join(process.env.LOCALAPPDATA,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9348'}});
let browser;
try{
 for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9348/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:9348');const page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Agora não',exact:true}).click({timeout:15000});
 await page.evaluate(()=>window.glass.window('restore'));await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('button',{name:'Ambiente',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');await page.waitForTimeout(1200);
 const cdp=await browser.contexts()[0].newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');
 const command=`$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.List[int]]::new();$ids.Add(${proc.pid});for($i=0;$i -lt $ids.Count;$i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and !$ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}};Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue | Select-Object ProcessName,WorkingSet64 | ConvertTo-Json -Compress`;
 const processes=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8'}));
 await cdp.send('Performance.enable');const before=(await cdp.send('Performance.getMetrics')).metrics;const idle=await page.evaluate(()=>window.__glassOptics.draws);await page.waitForTimeout(1500);const after=(await cdp.send('Performance.getMetrics')).metrics;
 const metric=(values,key)=>values.find(v=>v.name===key)?.value||0;
 const result={version:'1.8.1',profile:'Isolated, offline, settings, no music playing',browser:browser.version(),processes,workingSetMB:Math.round(processes.reduce((total,p)=>total+p.WorkingSet64,0)/1048576),jsHeapMB:+(metric(after,'JSHeapUsedSize')/1048576).toFixed(2),idle:{intervalMs:1500,draws:(await page.evaluate(()=>window.__glassOptics.draws))-idle,rendererTaskMs:+((metric(after,'TaskDuration')-metric(before,'TaskDuration'))*1000).toFixed(2),layoutCount:metric(after,'LayoutCount')-metric(before,'LayoutCount')},engine:await page.evaluate(()=>window.__glassOptics)};
 expect(result.idle.draws).toBe(0);await writeFile('test-results/glass-v3-memory.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{proc.kill();await browser?.close().catch(()=>{});}
