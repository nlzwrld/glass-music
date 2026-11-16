import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
await mkdir('../../work/profiles',{recursive:true});
const profile=await mkdtemp(resolve('../../work/profiles/providers-'));
const processHandle=spawn(process.env.GLASS_EXE || resolve('src-tauri/target/debug/glass-music.exe'),[],{env:{...process.env,GLASS_TEST_DATA:profile,WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9337'},windowsHide:true});
let app;const diagnostics=[];const result={testedAt:new Date().toISOString(),runtime:'Tauri + WebView2',providers:[],diagnostics};
try {
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:9337/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  app=await chromium.connectOverCDP('http://127.0.0.1:9337');const context=app.contexts()[0];const page=context.pages()[0] || await context.waitForEvent('page');
  page.on('pageerror',e=>diagnostics.push(e.message));page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text().slice(0,400));});
  await expect(page.getByText('A sua primeira sessão')).toBeVisible({timeout:20000});
  result.version=(await page.evaluate(()=>window.glass.integrations())).version;
  await page.evaluate(async()=>{const s=await window.glass.bootstrap();await window.glass.preferences({...s.preferences,onlineConsent:true,volume:0});});await page.reload();await expect(page.getByText('A sua primeira sessão')).toBeVisible();
  for(const [source,url] of [['youtube','https://www.youtube.com/watch?v=M7lc1UVf-VE'],['soundcloud','https://soundcloud.com/forss/flickermood']]) {
    await page.getByRole('button',{name:'Um link. Um novo som.',exact:false}).click();await page.getByRole('textbox',{name:'Link da música'}).fill(url);await page.getByRole('button',{name:'Adicionar e reproduzir'}).click();
    const state={source,url};
    try {
      await expect(page.getByRole('dialog')).toBeHidden({timeout:22000});
      await expect(page.locator('.official-player.visible')).toBeVisible({timeout:22000});
      await expect(page.locator('.official-player>iframe')).toHaveAttribute('src',new RegExp(`provider=${source}`),{timeout:22000});
      const position=()=>page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).inputValue().then(Number);
      try {await expect.poll(position,{timeout:25000}).toBeGreaterThan(.5);} catch {
        const box=await page.locator('.official-player>iframe').boundingBox();if(box)await page.mouse.click(box.x+(source==='youtube'?box.width/2:35),box.y+(source==='youtube'?box.height/2:35));
        try{await expect.poll(position,{timeout:20000}).toBeGreaterThan(.5);}catch{}
      }
      state.position=await position();state.played=state.position>.5;
      state.duration=Number(await page.locator('footer.player').getByRole('slider',{name:'Posição da música',exact:true}).getAttribute('max'));
      state.sideDuration=Number(await page.locator('.side-player').getByRole('slider',{name:'Posição da música',exact:true}).getAttribute('max'));
      state.durationSynchronized=state.duration>1&&state.duration===state.sideDuration;
      state.title=await page.locator('.now-info strong').textContent();state.error=await page.locator('.playback-error').count()?await page.locator('.playback-error').textContent():'';
      state.iframeSize=await page.locator('.official-player>iframe').boundingBox();
      const guest=page.frames().find(f=>f.url().includes('/embed/index.html'));state.guestNativeBridge=guest?await guest.evaluate(()=>typeof window.__TAURI_INTERNALS__):'not loaded';
      state.guestNativeAccess=guest?await guest.evaluate(()=>Promise.race([window.__TAURI_INTERNALS__.invoke('call',{action:'library',payload:{action:'create',name:'GUEST-MUST-NOT-CREATE'}}).then(()=> 'ALLOWED').catch(e=>String(e)),new Promise(r=>setTimeout(()=>r('No reply from denied origin'),2500))])):'not loaded';
      state.guestMutationBlocked=!(await page.evaluate(()=>window.glass.bootstrap())).playlists.some(p=>p.name==='GUEST-MUST-NOT-CREATE');
      state.embedText=await Promise.all(page.frames().filter(f=>/^https:\/\/(w.soundcloud.com|www.youtube.com)\//.test(f.url())).map(f=>f.locator('body').innerText({timeout:5000}).catch(()=>'')));
      await page.screenshot({path:`test-results/live-${source}.png`});
      if(await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).count())await page.locator('footer.player').getByRole('button',{name:'Pausar',exact:true}).click();
    }catch(e){state.failure=e.message;process.exitCode=1;await page.getByRole('button',{name:'Fechar diálogo'}).click().catch(()=>{});}
    result.providers.push(state);console.log(JSON.stringify(state));
  }
  await page.getByRole('button',{name:'Reproduzir Prisma',exact:true}).first().click();await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(.3);
  result.switchedBackToLocal=true;result.activeAudioElements=await page.locator('audio').count();result.externalHidden=!(await page.locator('.official-player').isVisible());
}catch(e){result.failure=e.message;process.exitCode=1;console.error(e.message);}finally{await mkdir('test-results',{recursive:true});await writeFile('test-results/live-providers.json',JSON.stringify(result,null,2));processHandle.kill();if(app)await app.close().catch(()=>{});}

