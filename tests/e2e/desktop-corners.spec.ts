import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {navButton,selectGlass} from './ui';

test('desktop transparency survives theme changes and window states without a system backdrop outside the region',async()=>{
 test.setTimeout(90000);await mkdir('.test-data/profiles',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/desktop-corners-'));
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9365'}});
 let browser:Browser|undefined;const states:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9365/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9365');const page=browser.contexts()[0].pages()[0];
  await page.getByRole('button',{name:'Agora não',exact:true}).click();
  await navButton(page,'Configurações').click();
  await selectGlass(page);
  const check=async(label:string,desktop:boolean)=>{
   await expect.poll(()=>page.evaluate(async()=>{
    const shape=await window.glass.windowShape();
    return {clipped:shape.clippedDesktopBackdrop,backdrop:shape.systemBackdrop,corners:shape.clientCorners,region:shape.nativeRegion};
   })).toEqual({clipped:desktop,backdrop:1,corners:[false,false,false,false],region:true});
   states.push({label,...await page.evaluate(()=>window.glass.windowShape())});
  };
  for(const theme of ['Escuro','Claro']){
   await page.getByRole('button',{name:theme,exact:true}).click();
   await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await check(theme,true);
   await page.evaluate(()=>window.glass.window('maximize'));await check(theme+' maximizado',true);
   await page.evaluate(()=>window.glass.window('maximize'));await check(theme+' restaurado',true);
   await page.getByRole('button',{name:'Ambiente',exact:true}).click();await check(theme+' ambiente',false);
  }
  await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await check('desktop novamente',true);
  await page.evaluate(()=>window.glass.window('mini'));await check('mini',true);
  await page.evaluate(()=>window.glass.window('restore'));await check('tamanho restaurado',true);
  await page.evaluate(()=>window.glass.window('minimize'));await page.evaluate(()=>window.glass.window('restore'));await check('apos minimizar',true);
  await writeFile('test-results/desktop-corners.json',JSON.stringify(states,null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
