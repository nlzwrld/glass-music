import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
await mkdir('../../work/profiles',{recursive:true});
const profile=await mkdtemp(resolve('../../work/profiles/lab-v3-'));
const out=process.env.GLASS_LAB_OUTPUT||'test-results';await mkdir(out,{recursive:true});
const proc=spawn(process.env.GLASS_EXE,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9345'}});
let browser;const errors=[];
try{
 for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9345/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:9345');const page=browser.contexts()[0].pages()[0];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.getByRole('button',{name:'Agora não',exact:true}).click({timeout:15000});
 await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('button',{name:'Glass Laboratory',exact:true}).click();
 await page.waitForTimeout(1600);await page.screenshot({path:join(out,'laboratory-prototype.png')});
 await writeFile(join(out,'laboratory-prototype.json'),JSON.stringify(await page.evaluate(errors=>({errors,engine:window.__glassOptics,html:document.documentElement.dataset,canvases:document.querySelectorAll('canvas').length,methods:[...document.querySelectorAll('.lab-demo')].map(el=>({method:el.dataset.labScene,rect:el.getBoundingClientRect().toJSON()}))}),errors),null,2));
 console.log(JSON.stringify({errors,engine:await page.evaluate(()=>window.__glassOptics)}));
}finally{proc.kill();await browser?.close().catch(()=>{});}
