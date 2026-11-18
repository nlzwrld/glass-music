import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
test('external HWND has rounded client corners and no native frame in every window state',async()=>{
 test.setTimeout(100000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/window-190-'));let browser:Browser|undefined;
 const proc=spawn(process.env.GLASS_EXE||join(process.env.LOCALAPPDATA!,'Liquid Hub/liquid-hub.exe'),[],{windowsHide:!process.env.GLASS_WINDOW_PREVIEW,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9352'}});
 try{
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9352/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9352');const page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Agora não',exact:true}).click({timeout:15000});await page.evaluate(()=>window.glass.window('restore'));
  const states:Record<string,unknown>={};
  const check=async(name:string)=>{
   await expect.poll(()=>page.evaluate(async()=>{const s=await window.glass.windowShape();return s.nativeRegion&&!s.frame.caption&&s.frame.dwmBorderSuppressed&&s.clientCorners.every(v=>!v);})).toBe(true);
   const shape=await page.evaluate(()=>window.glass.windowShape());expect(shape.center).toBe(true);expect(shape.frame.resizeStyle).toBe(true);expect(shape.corners).toEqual([false,false,false,false]);states[name]=shape;await page.screenshot({path:`test-results/window-190-${name}.png`,omitBackground:true});return shape;
  };
  const normal=await check('normal');expect(normal.systemBackdrop).not.toBe(3);expect(normal.maximized).toBe(false);expect(normal.clientInsets).toEqual([0,0,0,0]);
  await page.evaluate(()=>window.glass.window('maximize'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).maximized)).toBe(true);await check('maximized');
  if(process.env.GLASS_WINDOW_PREVIEW){console.log('Native preview ready: maximized',await page.evaluate(()=>window.glass.windowShape()));await page.waitForTimeout(45000);console.log('After focus preview',await page.evaluate(()=>window.glass.windowShape()));if(!(await page.evaluate(()=>window.glass.windowShape())).maximized){await page.evaluate(()=>window.glass.window('maximize'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).maximized)).toBe(true);}}
  await page.evaluate(()=>window.glass.window('maximize'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).maximized)).toBe(false);await check('unmaximized');
  await page.evaluate(()=>window.glass.window('mini'));await expect.poll(()=>page.evaluate(async()=>(await window.glass.windowShape()).width)).toBeLessThan(normal.width);await check('mini');
  await page.evaluate(()=>window.glass.window('restore'));await check('restored');
  await page.evaluate(()=>window.glass.window('minimize'));await expect.poll(()=>page.evaluate(()=>window.glass.visualState())).toBe(false);await page.evaluate(()=>window.glass.window('restore'));await expect.poll(()=>page.evaluate(()=>window.glass.visualState())).toBe(true);await check('after-minimize');
  await writeFile('test-results/window-190-validation.json',JSON.stringify({version:'2.0.1',nativeFrameRemoved:true,clientCornersRounded:true,maximizedCornersRounded:true,nativeResizeStylePreserved:true,states},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
