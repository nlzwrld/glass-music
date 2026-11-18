import { chromium, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { defaults } from '../shared/types.ts';
import { opticalDefaults } from '../src/components/glass/v3/model.ts';
const task='C:/Users/NL E FOFINHA/Documents/Codex/2026-11-15/files-pasted-by-the-user-glass';
const out=join(task,'outputs'),profile=await mkdtemp(join(task,'work/critical-'));
await mkdir(out,{recursive:true});
const db=new DatabaseSync(join(profile,'library.sqlite'));
db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
for(let i=0;i<2;i++){
 const track={id:`local:critical-${i}`,source:'local',kind:'track',sourceId:`critical-${i}`,title:`Validação de áudio ${i+1}`,artist:'Teste local',duration:24,addedAt:Date.now()-i*1000};
 db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now()-i*1000);
}
db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,volume:0,reducedMotion:true,appearance:{...opticalDefaults,background:'ambient',quality:'balanced'}}));db.close();
const exe=process.env.GLASS_EXE;if(!exe)throw new Error('GLASS_EXE is required: test the integrated executable explicitly.');
const proc=spawn(exe,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9355'}});
let browser;const result={executable:exe,errors:[],consoleErrors:[],checks:[],layouts:[]};
const pass=name=>{result.checks.push(name);console.log('PASS '+name);};
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9355/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:9355');const context=browser.contexts()[0],page=context.pages()[0];
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.consoleErrors.push(m.text());});
 await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:20000});
 await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
 await page.getByRole('button',{name:'Configurações',exact:true}).click();
 await expect(page.locator('.settings-page')).toBeVisible();
 const cdp=await context.newCDPSession(page);
 for(const [width,height] of [[1360,860],[1920,1080],[920,650]]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await page.waitForTimeout(700);
  const layout=await page.evaluate(()=>{const main=document.querySelector('.main-scroll'),footer=document.querySelector('.player').getBoundingClientRect(),sidebar=document.querySelector('.sidebar').getBoundingClientRect(),settings=document.querySelector('.settings-page').getBoundingClientRect();return{width:innerWidth,height:innerHeight,horizontalOverflow:main.scrollWidth>main.clientWidth+1,footerInside:footer.bottom<=innerHeight&&footer.left>=0&&footer.right<=innerWidth,sidebarAbovePlayer:sidebar.bottom<footer.top,settingsWidth:settings.width,settingsColumns:getComputedStyle(document.querySelector('.settings-page')).gridTemplateColumns};});
  expect(layout.horizontalOverflow).toBe(false);expect(layout.footerInside).toBe(true);expect(layout.sidebarAbovePlayer).toBe(true);expect(layout.settingsWidth).toBeLessThanOrEqual(1121);result.layouts.push(layout);
  await page.screenshot({path:join(out,`Liquid-Hub-corrigido-${width}.png`)});
 }
 pass('Responsive settings/sidebar/player: 920, 1360 and 1920 px');
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1360,height:860,deviceScaleFactor:1,mobile:false});await page.waitForTimeout(500);
 await page.getByRole('button',{name:'Claro',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.screenshot({path:join(out,'Liquid-Hub-tema-claro.png')});
 await page.getByRole('button',{name:'Escuro',exact:true}).click();await page.mouse.move(0,0);await page.waitForTimeout(600);
 // Real pixels: a high-contrast child must remain within its rounded overflow host.
 const before=PNG.sync.read(await page.screenshot());
 const clip=await page.evaluate(()=>{const host=document.createElement('div');host.id='qa-clipping';Object.assign(host.style,{position:'absolute',left:'780px',top:'100px',width:'180px',height:'130px',overflow:'hidden',borderRadius:'30px',pointerEvents:'none'});const glass=document.createElement('div');glass.dataset.optic='auto';glass.dataset.opticalOpacity='0.9';glass.dataset.opticalTint='#ff0000';Object.assign(glass.style,{position:'absolute',left:'-45px',top:'-55px',width:'270px',height:'240px',borderRadius:'5px'});host.append(glass);document.querySelector('.optical-root').append(host);return host.getBoundingClientRect().toJSON();});
 await page.waitForTimeout(600);const after=PNG.sync.read(await page.screenshot());let outside=0,inside=0,corners=0;
 for(let y=0;y<before.height;y++)for(let x=0;x<before.width;x++){
  const n=(y*before.width+x)*4,delta=Math.max(...[0,1,2].map(c=>Math.abs(before.data[n+c]-after.data[n+c])));if(delta<8)continue;
  if(x<clip.x-2||x>clip.right+2||y<clip.y-2||y>clip.bottom+2)outside++;else inside++;
  if(x>=clip.x&&x<clip.x+6&&y>=clip.y&&y<clip.y+6)corners++;
 }
 expect(inside).toBeGreaterThan(500);expect(outside).toBeLessThan(25);expect(corners).toBe(0);result.clipping={inside,outside,corners};
 await page.evaluate(()=>document.querySelector('#qa-clipping').remove());pass('Shared WebGL respects parent overflow and rounded corners');
 // Show measurable refraction on the laboratory source, with frozen motion.
 const details=page.locator('.advanced-appearance');if(await details.count())await details.locator('summary').click();
 await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();await page.waitForTimeout(600);
 const lab=page.getByRole('dialog',{name:'Glass Laboratory'});
 for(const [label,value] of [['Blur','0'],['Opacidade','0'],['Saturação','1'],['Reflexo especular','0'],['Aberração cromática','0'],['Refração','0']])await lab.getByRole('slider',{name:label,exact:true}).fill(value);
 await page.waitForTimeout(500);const lens=page.locator('[data-lab-scene=webgl] .lab-card'),flat=PNG.sync.read(await lens.screenshot());
 await lab.getByRole('slider',{name:'Refração',exact:true}).fill('10');await page.waitForTimeout(500);const bent=PNG.sync.read(await lens.screenshot());
 let edge=0,edgeTotal=0,center=0,centerTotal=0;
 for(let y=0;y<flat.height;y++)for(let x=0;x<flat.width;x++){const n=(y*flat.width+x)*4,delta=Math.max(...[0,1,2].map(c=>Math.abs(flat.data[n+c]-bent.data[n+c])));if(x<16||x>=flat.width-16||y<16||y>=flat.height-16){edgeTotal++;if(delta>10)edge++;}else if(x>35&&x<flat.width-35&&y>35&&y<flat.height-35){centerTotal++;if(delta>10)center++;}}
 result.refraction={edgeChangedRatio:edge/edgeTotal,centerChangedRatio:center/Math.max(1,centerTotal)};expect(result.refraction.edgeChangedRatio).toBeGreaterThan(.025);expect(result.refraction.centerChangedRatio).toBeLessThan(result.refraction.edgeChangedRatio*.25);
 await writeFile(join(out,'Refracao-desligada.png'),PNG.sync.write(flat));await writeFile(join(out,'Refracao-ligada.png'),PNG.sync.write(bent));
 await lab.getByRole('button',{name:'Restaurar material',exact:true}).click();await lab.getByRole('button',{name:'Fechar laboratório',exact:true}).click();pass('Refraction changes real backdrop pixels at the edge, not foreground text');
 // Local audio and transport run with the native bridge and actual HTMLAudioElement.
 await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:'Reproduzir Validação de áudio 1',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(.5);
 const player=page.locator('footer.player');await player.getByRole('button',{name:'Pausar',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.paused)).toBe(true);
 await player.getByRole('slider',{name:'Posição da música',exact:true}).fill('4');await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(3.5);
 await player.getByRole('button',{name:'Reproduzir',exact:true}).click();await player.getByRole('button',{name:'Próxima faixa',exact:true}).click();await expect(player.locator('.now-info strong')).toHaveText('Validação de áudio 2');await player.getByRole('button',{name:'Faixa anterior',exact:true}).click();await expect(player.locator('.now-info strong')).toHaveText('Validação de áudio 1');
 await player.getByRole('button',{name:'Aleatório',exact:true}).click();await expect(player.getByRole('button',{name:'Aleatório',exact:true})).toHaveAttribute('aria-pressed','true');await player.getByRole('button',{name:'Aleatório',exact:true}).click();
 await player.getByRole('button',{name:'Repetir: desligado',exact:true}).click();await expect(player.getByRole('button',{name:'Repetir: fila',exact:true})).toBeVisible();
 await player.getByRole('button',{name:'Curtir música atual',exact:true}).click();await expect(player.getByRole('button',{name:'Curtir música atual',exact:true})).toHaveAttribute('aria-pressed','true');
 await player.getByRole('button',{name:'Fila de reprodução',exact:true}).click();await expect(page.locator('.queue-panel')).toBeVisible();await page.getByRole('button',{name:'Fechar fila',exact:true}).click();
 await player.getByRole('button',{name:'Abrir player expandido',exact:true}).click();await expect(page.locator('.expanded-player')).toBeVisible();await page.getByRole('button',{name:'Fechar player expandido',exact:true}).click();
 await player.getByRole('slider',{name:'Volume',exact:true}).fill('1');await expect.poll(()=>page.locator('audio').evaluate(a=>a.volume)).toBeCloseTo(.01,2);await player.getByRole('button',{name:'Silenciar',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.volume)).toBe(0);
 pass('Local playback, pause, seek, previous/next, shuffle, repeat, favorite, queue, expanded player and volume');
 await page.getByRole('button',{name:'Configurações',exact:true}).click();
 await page.evaluate(()=>{const gl=document.querySelector('.optical-surfaces').getContext('webgl2');window.__qaLoss=gl.getExtension('WEBGL_lose_context');window.__qaLoss.loseContext();});
 await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');await expect(page.locator('.optical-surfaces')).toHaveCSS('visibility','hidden');
 let audioPosition=await page.locator('audio').evaluate(a=>a.currentTime);await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(audioPosition+.3);await page.screenshot({path:join(out,'Liquid-Hub-fallback.png')});
 await page.evaluate(()=>window.__qaLoss.restoreContext());await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
 await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).setChecked(true);await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');await expect(page.locator('.optical-surfaces')).toHaveCSS('visibility','hidden');
 await page.getByRole('switch',{name:'Modo de desempenho',exact:true}).setChecked(false);await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');pass('Context loss/restore and performance fallback preserve playing audio');
 await player.getByRole('button',{name:'Pausar',exact:true}).click();
 await page.getByRole('switch',{name:'Reduzir animações',exact:true}).setChecked(false);await page.mouse.move(0,0);await page.waitForTimeout(1200);await cdp.send('Performance.enable');
 const first=(await cdp.send('Performance.getMetrics')).metrics,draws=await page.evaluate(()=>window.__glassOptics.draws);await page.waitForTimeout(2000);const last=(await cdp.send('Performance.getMetrics')).metrics;
 const metric=(items,name)=>items.find(m=>m.name===name)?.value||0;
 result.idle={intervalMs:2000,draws:await page.evaluate(()=>window.__glassOptics.draws)-draws,rendererTaskMs:(metric(last,'TaskDuration')-metric(first,'TaskDuration'))*1000,jsHeapMB:metric(last,'JSHeapUsedSize')/1048576};expect(result.idle.draws).toBe(0);
 result.engine=await page.evaluate(()=>window.__glassOptics);pass('No continuous render loop or texture upload while idle');
 const ps=`$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.List[int]]::new();$ids.Add(${proc.pid});for($i=0;$i -lt $ids.Count;$i++){foreach($p in $all){if($p.ParentProcessId -eq $ids[$i] -and !$ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId)}}};$before=@{};Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue|ForEach-Object{$before[$_.Id]=$_.CPU};Start-Sleep -Seconds 2;$cpu=0;$working=0;Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue|ForEach-Object{$cpu+=($_.CPU-$before[$_.Id]);$working+=$_.WorkingSet64};$pattern='pid_('+($ids -join '|')+')_';$gpu=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue|Where-Object{$_.Name -match $pattern}|Select-Object Name,UtilizationPercentage);@{intervalSeconds=2;cpuOneCorePercent=$cpu/2*100;workingSetMB=$working/1MB;gpuEngines=$gpu}|ConvertTo-Json -Depth 5 -Compress`;
 try{result.nativeIdle=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',ps],{windowsHide:true,encoding:'utf8',timeout:15000}));}catch(e){result.nativeIdle={unavailable:String(e.message)};}
 await page.locator('.main-scroll').evaluate(el=>{el.scrollTop=0;});await page.waitForTimeout(500);await page.screenshot({path:join(out,'Liquid-Hub-corrigido.png')});
 expect(result.errors).toEqual([]);expect(result.consoleErrors).toEqual([]);pass('No JavaScript or console errors');
}catch(error){result.failure=String(error.stack||error);throw error;}finally{await writeFile(join(out,'Validacao-Liquid-Glass.json'),JSON.stringify(result,null,2));proc.kill();await browser?.close().catch(()=>{});}
