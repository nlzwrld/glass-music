import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
// @ts-expect-error CommonJS runtime without declarations.
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import {defaults} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';

test('global appearance changes every route, dialogs and menus; native corners have one clip',async()=>{
 test.setTimeout(150000);await mkdir('../../work/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('../../work/profiles/global-202-'));
 const pattern=new PNG({width:320,height:200});
 for(let y=0;y<pattern.height;y++)for(let x=0;x<pattern.width;x++){
  const i=(y*pattern.width+x)*4,v=(Math.floor(x/8)+Math.floor(y/8))%2;
  pattern.data[i]=v?220:30;pattern.data[i+1]=v?55:150;pattern.data[i+2]=v?65:210;pattern.data[i+3]=255;
 }
 const db=new DatabaseSync(join(profile,'library.sqlite'));
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 const track={id:'local:global',source:'local',kind:'track',sourceId:'global',title:'Teste de aparência',artist:'Validação local',duration:20,addedAt:Date.now()};
 db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),Date.now());
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({...defaults,onboardingDone:true,onlineConsent:false,catalogConsent:false,volume:0,glass:0,reducedMotion:true,appearance:{...opticalDefaults,background:'custom',customImage:`data:image/png;base64,${PNG.sync.write(pattern).toString('base64')}`,blur:0,specular:0,quality:'balanced'}}));db.close();
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9358'}});
 let browser:Browser|undefined;const errors:string[]=[],checks:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9358/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9358');const page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});
  const routes=['Início','Explorar','Buscar','Biblioteca','Curtidas','Histórico','Configurações'];
  const baseline=new Map<string,Buffer>();
  for(const route of routes){await page.getByRole('button',{name:route,exact:true}).click();await page.waitForTimeout(400);baseline.set(route,await page.locator('.main-shell').screenshot());}
  await page.getByRole('slider',{name:'Opacidade do vidro',exact:true}).fill('100');
  await page.getByRole('slider',{name:'Desfoque',exact:true}).fill('24');await page.getByRole('slider',{name:'Reflexos',exact:true}).fill('1');
  for(const route of routes){
   await page.getByRole('button',{name:route,exact:true}).click();await page.waitForTimeout(400);
   const before=PNG.sync.read(baseline.get(route)!),after=PNG.sync.read(await page.locator('.main-shell').screenshot());
   const changed=pixelmatch(before.data,after.data,null,before.width,before.height,{threshold:.12})/(before.width*before.height);
   expect(changed,route).toBeGreaterThan(.1);
   const vars=await page.locator('.main-shell').evaluate(el=>{const s=getComputedStyle(el);return[s.getPropertyValue('--appearance-opacity').trim(),s.getPropertyValue('--appearance-blur').trim(),s.getPropertyValue('--appearance-specular').trim()];});
   expect(vars).toEqual(['1','24px','1']);checks.push({route,changed,vars});
  }
  await expect(page.locator('[data-window-material]')).toHaveAttribute('data-optic','auto');
  await expect(page.locator('.main-shell')).not.toHaveClass(/glass-material/);
  expect(await page.locator('.settings-section').first().getAttribute('data-optic')).toBeNull();
  await page.getByRole('combobox',{name:'Material da interface inteira',exact:true}).selectOption('clear');
  await expect(page.locator('[data-window-material]')).toHaveAttribute('data-crystal','thin');
  await expect(page.locator('.player')).toHaveAttribute('data-material','clear');
  await expect(page.locator('.sidebar')).toHaveAttribute('data-material','clear');
  await page.getByRole('combobox',{name:'Material da interface inteira',exact:true}).selectOption('floating');
  await page.getByRole('button',{name:'Mini-player',exact:true}).click();await expect(page.locator('.app')).toHaveClass(/mini/);
  await expect(page.locator('[data-window-material]')).toHaveAttribute('data-material','floating');
  await expect(page.getByRole('button',{name:'Abrir biblioteca',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Sair do mini-player',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/global-202-mini.png'});
  await page.getByRole('button',{name:'Sair do mini-player',exact:true}).click();await expect(page.locator('.app')).not.toHaveClass(/mini/);
  await page.getByRole('button',{name:'Claro',exact:true}).click();await page.waitForTimeout(300);
  await page.screenshot({path:'test-results/global-202-light.png'});
  await page.getByRole('button',{name:'Escuro',exact:true}).click();
  await page.getByRole('combobox',{name:'Qualidade do Liquid Glass',exact:true}).selectOption('economy');
  const overlays:Record<string,unknown[]>={};
  const read=async(selector:string)=>page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return{background:s.backgroundColor,blur:s.backdropFilter,shadow:s.boxShadow,reflection:s.backgroundImage};});
  for(const value of ['0','100']){
   await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('slider',{name:'Opacidade do vidro',exact:true}).fill(value);
   await page.getByRole('slider',{name:'Desfoque',exact:true}).fill(value==='0'?'0':'24');await page.getByRole('slider',{name:'Reflexos',exact:true}).fill(value==='0'?'0':'1');
   const panels=[];panels.push(await read('[data-window-material]'));
   await page.getByRole('button',{name:'Criar playlist',exact:true}).click();panels.push(await read('.modal'));await page.getByRole('button',{name:'Fechar diálogo',exact:true}).click();
   await page.getByRole('button',{name:'Fila de reprodução',exact:true}).click();panels.push(await read('.queue-panel'));await page.getByRole('button',{name:'Fila de reprodução',exact:true}).click();
   await page.getByRole('button',{name:'Início',exact:true}).click();await page.getByRole('button',{name:'Opções de Teste de aparência',exact:true}).click();panels.push(await read('.glass-context-menu'));await page.keyboard.press('Escape');
   overlays[value]=panels;
  }
  for(let i=0;i<4;i++){
   const a=(overlays['0'][i] as any),b=(overlays['100'][i] as any);expect(a.background).not.toBe(b.background);expect(a.blur).toContain('0px');expect(b.blur).toContain('16.8px');expect(a.shadow).not.toBe(b.shadow);if(i>0)expect(a.reflection).not.toBe(b.reflection);
  }
  await page.getByRole('button',{name:'Configurações',exact:true}).click();await page.getByRole('combobox',{name:'Qualidade do Liquid Glass',exact:true}).selectOption('high');
  const perimeterColors=[];
  for(const quality of ['high','economy']){
   await page.getByRole('combobox',{name:'Qualidade do Liquid Glass',exact:true}).selectOption(quality);
   await page.getByRole('button',{name:'Cor',exact:true}).click();
   const samples:number[][][]=[];
   for(const color of ['#ff0000','#0000ff']){
    await page.locator('input[type=color]').fill(color);
    await expect.poll(()=>page.locator('.optical-scene').evaluate((canvas:HTMLCanvasElement)=>{const p=canvas.getContext('2d')!.getImageData(canvas.width/2,12,1,1).data;return p[0]>p[2];})).toBe(color==='#ff0000').catch(async error=>{
     console.log('color-render-diagnostic',quality,color,await page.evaluate(async()=>{const p=(await window.glass.bootstrap()).preferences,a=p.appearance!,c=document.querySelector<HTMLCanvasElement>('.optical-scene')!,v=c.getContext('2d')!.getImageData(c.width/2,12,1,1).data;return{hidden:document.hidden,nativeVisible:await window.glass.visualState(),dataset:{...document.documentElement.dataset},stats:(window as any).__glassOptics,settings:{background:a.background,solidColor:a.solidColor,quality:a.quality},canvas:[c.width,c.height],pixel:[...v]};}));
     await page.screenshot({path:'test-results/color-render-diagnostic.png'});throw error;
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const p=PNG.sync.read(await page.screenshot()),w=p.width,h=p.height;
    samples.push([[Math.floor(w/2),12],[Math.floor(w/2),h-8],[8,Math.floor(h/2)],[w-8,Math.floor(h/2)]].map(([x,y])=>[...p.data.subarray((y*w+x)*4,(y*w+x)*4+3)]));
   }
   console.log('perimeter-color',quality,JSON.stringify(samples));
   for(let side=0;side<4;side++)expect(Math.max(...samples[0][side].map((v:number,i:number)=>Math.abs(v-samples[1][side][i])))).toBeGreaterThan(20);
   perimeterColors.push({quality,samples});
  }
  await page.getByRole('combobox',{name:'Qualidade do Liquid Glass',exact:true}).selectOption('high');
  await page.getByRole('button',{name:'Ambiente',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:'test-results/global-202-dark.png'});
  const geometry=await page.evaluate(()=>{const r=document.querySelector('.optical-root')!.getBoundingClientRect(),canvas=document.querySelector('.optical-scene')!;return{rect:[r.left,r.top,r.right,r.bottom],size:[innerWidth,innerHeight],appRadius:getComputedStyle(document.querySelector('.app')!).borderRadius,canvasRadius:getComputedStyle(canvas).borderRadius};});
  expect(geometry.rect).toEqual([0,0,...geometry.size]);expect(geometry.appRadius).toBe('0px');expect(geometry.canvasRadius).toBe('0px');
  const shape=await page.evaluate(()=>window.glass.windowShape());expect(shape.clientCorners).toEqual([false,false,false,false]);expect(shape.nativeRegion).toBe(true);
  expect(errors).toEqual([]);await writeFile('test-results/global-202-validation.json',JSON.stringify({version:'2.0.2',checks,overlays,perimeterColors,geometry,shape,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
