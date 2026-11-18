import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const task='C:/Users/NL E FOFINHA/Documents/Codex/2026-11-15/files-pasted-by-the-user-glass';
const profile=await mkdtemp(join(task,'work/baseline-'));
const proc=spawn(join(process.env.LOCALAPPDATA,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9354'}});
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9354/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:9354');
 const page=browser.contexts()[0].pages()[0];
 await page.getByRole('button',{name:'Agora não',exact:true}).click({timeout:20000});
 await page.getByRole('button',{name:'Configurações',exact:true}).click();
 await page.getByRole('button',{name:'Ambiente',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
 const cdp=await browser.contexts()[0].newCDPSession(page);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1360,height:860,deviceScaleFactor:1,mobile:false});
 await page.waitForTimeout(1000);
 await page.screenshot({path:join(task,'outputs/Liquid-Hub-antes.png')});
 await writeFile(join(task,'work/baseline.json'),JSON.stringify({engine:await page.evaluate(()=>window.__glassOptics),executable:proc.spawnfile},null,2));
 console.log('Baseline captured.');
}finally{proc.kill();await browser?.close().catch(()=>{});}
