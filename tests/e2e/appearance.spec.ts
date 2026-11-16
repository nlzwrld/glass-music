import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaults} from '../../shared/types';
test('2.0 appearance: five desktop sizes, materials, palettes, custom background and persistence',async()=>{
 test.setTimeout(180000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/appearance-200-')),db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 for(const [i,art] of ['prisma','orbita','mare'].entries()){const t={id:`local:visual-${i}`,source:'local',kind:'track',sourceId:`visual-${i}`,title:`Faixa de validação ${i+1}`,artist:'Biblioteca isolada de testes',artwork:`/covers/${art}.svg`,duration:20,addedAt:Date.now()};db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(t.id,JSON.stringify(t),resolve('assets/audio/prisma.wav'),Date.now());}
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,volume:0,reducedMotion:true}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9356'}});
 let browser:Browser|undefined;const errors:string[]=[],layouts:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9356/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9356');const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await expect(page.locator('.sidebar')).toBeVisible();
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.getByRole('button',{name:'Dinâmico',exact:true})).toHaveAttribute('aria-pressed','true');
  const cdp=await context.newCDPSession(page);
  for(const [width,height] of [[1280,720],[1366,768],[1600,900],[1920,1080],[2560,1440]]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await page.waitForTimeout(450);
   for(const where of ['Configurações','Início']){
    await page.getByRole('button',{name:where,exact:true}).click();await page.waitForTimeout(350);
    const layout=await page.evaluate(()=>{const main=document.querySelector('.main-scroll')!,player=document.querySelector('.player')!.getBoundingClientRect();const boxes=['.now-playing','.player-center','.player-tools'].map(s=>document.querySelector(s)!.getBoundingClientRect());return{overflow:main.scrollWidth>main.clientWidth+1,footerInside:player.bottom<=innerHeight+1,overlap:boxes[0].right>boxes[1].left||boxes[1].right>boxes[2].left,columns:getComputedStyle(document.querySelector('.catalog-grid')||main).gridTemplateColumns};});
    expect(layout.overflow).toBe(false);expect(layout.footerInside).toBe(true);expect(layout.overlap).toBe(false);layouts.push({width,height,where,...layout});
    await page.screenshot({path:`test-results/appearance-${where==='Início'?'home':'settings'}-${width}.png`});
   }
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await page.getByRole('button',{name:'Recolher sidebar',exact:true}).click();await expect(page.locator('.app')).toHaveClass(/sidebar-collapsed/);await expect(page.getByRole('button',{name:'Importar playlist',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('combobox',{name:'Escala da interface'}).selectOption('125');
  expect(await page.locator('.main-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.getByRole('combobox',{name:'Escala da interface'}).selectOption('100');await page.getByRole('button',{name:'Expandir sidebar',exact:true}).click();
  await page.getByRole('button',{name:'Claro',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.screenshot({path:'test-results/appearance-light.png'});
  await page.getByRole('button',{name:'Cor',exact:true}).click();await page.getByRole('textbox',{name:'Cor do fundo'}).count();
  await page.locator('input[type=color]').fill('#ffffff');await page.screenshot({path:'test-results/appearance-solid-light.png'});
  await page.getByRole('button',{name:'Escuro',exact:true}).click();await page.locator('input[type=color]').fill('#000000');
  await page.getByRole('button',{name:'Personalizado',exact:true}).click();
  const png=await page.locator('.brand-mark').screenshot();await page.locator('[data-background-upload]').setInputFiles({name:'background.png',mimeType:'image/png',buffer:png});await expect(page.locator('.custom-background-preview')).toBeVisible();
  // The preview is optimistic; verify the queued native write has completed.
  await expect.poll(()=>page.evaluate(async()=>String((await window.glass.bootstrap()).preferences.appearance?.customImage))).toMatch(/^data:image\/jpeg;base64,/);
  const custom=await page.evaluate(async()=>String((await window.glass.bootstrap()).preferences.appearance?.customImage));
  await page.getByRole('button',{name:'Área de trabalho',exact:true}).click();await expect(page.locator('.optical-scene')).toHaveCSS('visibility','hidden');
  await page.getByRole('button',{name:'Dinâmico',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('button',{name:'Reproduzir Faixa de validação 1',exact:true}).click();
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.5);
  const palette1=await page.evaluate(()=>(window as any).__glassOptics.palette);await page.locator('footer').getByRole('button',{name:'Próxima faixa',exact:true}).click();await page.waitForTimeout(600);
  const palette2=await page.evaluate(()=>(window as any).__glassOptics.palette);expect(palette2).not.toEqual(palette1);
  await page.locator('footer').getByRole('button',{name:'Pausar',exact:true}).click();await page.locator('footer').getByRole('button',{name:'Curtir música atual',exact:true}).click();expect((await page.evaluate(()=>window.glass.bootstrap())).likes).toHaveLength(1);
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('combobox',{name:'Qualidade do Liquid Glass'}).selectOption('economy');await expect(page.locator('html')).toHaveAttribute('data-optical-engine','css');await expect(page.locator('.optical-surfaces')).toHaveCSS('visibility','hidden');
  await page.getByRole('combobox',{name:'Qualidade do Liquid Glass'}).selectOption('high');await expect(page.locator('html')).toHaveAttribute('data-optical-engine','webgl');
  await page.getByRole('switch',{name:'Sidebar compacta'}).setChecked(true);await page.reload();await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});await expect(page.locator('.app')).toHaveClass(/sidebar-collapsed/);await page.getByRole('button',{name:'Configurações',exact:true}).click();await expect(page.getByRole('combobox',{name:'Qualidade do Liquid Glass'})).toHaveValue('high');
  await page.getByRole('button',{name:'Restaurar padrão visual'}).click();await expect(page.getByRole('combobox',{name:'Qualidade do Liquid Glass'})).toHaveValue('auto');
  expect((await page.evaluate(()=>window.glass.bootstrap())).preferences.appearance?.customImage).toBe(custom);
  const bad=await page.evaluate(async()=>{const d=await window.glass.bootstrap();try{await window.glass.preferences({...d.preferences,appearance:{...d.preferences.appearance,customImage:'file:///C:/Windows'}});return false;}catch{return true;}});expect(bad).toBe(true);
  await page.keyboard.press('Control+k');await expect(page.getByRole('textbox',{name:'Buscar músicas, artistas e playlists'})).toBeFocused();
  expect(errors).toEqual([]);await writeFile('test-results/appearance-validation.json',JSON.stringify({version:'2.0.1',layouts,palettesDiffer:true,customImagePreserved:true,preferencesPersist:true,unsafeImageRejected:true,compactKeyboardNavigation:true,performanceFallback:true,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
