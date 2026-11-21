import {test,expect,chromium,type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
// @ts-expect-error pngjs exposes a CommonJS runtime without declarations.
import {PNG} from 'pngjs';
import {defaults} from '../../shared/types';
import {opticalDefaults} from '../../src/components/glass/v3/model';
import {navButton} from './ui';

type Raster={width:number;height:number;data:Uint8Array};
const sides=['top','bottom','left','right'] as const;
type Side=typeof sides[number];
const luma=(p:Raster,x:number,y:number)=>{
 const i=(y*p.width+x)*4;
 return .2126*p.data[i]+.7152*p.data[i+1]+.0722*p.data[i+2];
};
function sideMean(p:Raster,side:Side,depths:number[]){
 let sum=0,count=0;
 // Sample a strip at the middle of each side, away from corners and controls.
 for(const depth of depths)for(let offset=-12;offset<=12;offset++){
  const horizontal=side==='top'||side==='bottom';
  const x=horizontal?Math.floor(p.width/2)+offset:side==='left'?depth:p.width-1-depth;
  const y=horizontal?(side==='top'?depth:p.height-1-depth):Math.floor(p.height/2)+offset;
  sum+=luma(p,x,y);count++;
 }
 return sum/count;
}

test('the full-window glass reflects on four sides without a white outline; Home has clear section spacing',async()=>{
 test.setTimeout(120000);
 expect(process.env.GLASS_EXE,'GLASS_EXE must point to the desktop executable under test').toBeTruthy();
 await mkdir('.test-data/profiles',{recursive:true});await mkdir('test-results',{recursive:true});
 const profile=await mkdtemp(resolve('.test-data/profiles/perimeter-203-'));
 const db=new DatabaseSync(join(profile,'library.sqlite')),now=Date.now();
 db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE history(track_id TEXT,played INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
 for(let i=0;i<3;i++){
  const track={id:`local:perimeter-${i}`,source:'local',kind:'track',sourceId:`perimeter-${i}`,title:`Faixa local ${i+1}`,artist:'Biblioteca isolada',artwork:'/covers/prisma.svg',duration:20,addedAt:now-i};
  db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(track.id,JSON.stringify(track),resolve('assets/audio/prisma.wav'),now-i);
  db.prepare('INSERT INTO history VALUES(?,?)').run(track.id,now-i);
 }
 db.prepare('INSERT INTO settings VALUES(?,?)').run('preferences',JSON.stringify({
  ...defaults,uiStyle:'glass',onboardingDone:true,onlineConsent:false,catalogConsent:false,theme:'dark',volume:0,glass:45,reducedMotion:true,
  appearance:{...opticalDefaults,background:'solid',solidColor:'#101820',quality:'high',material:'floating',specular:0,blur:0}
 }));db.close();
 const port=9359,endpoint=`http://127.0.0.1:${port}`;
 const proc=spawn(process.env.GLASS_EXE!,[],{windowsHide:true,env:{...process.env,GLASS_TEST_DATA:profile,GLASS_TEST_DISABLE_DIRECT:'1',WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
 let browser:Browser|undefined;
 const errors:string[]=[],checks:unknown[]=[],homeChecks:unknown[]=[];
 try{
  for(let i=0;i<100;i++){try{if((await fetch(`${endpoint}/json/version`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  browser=await chromium.connectOverCDP(endpoint);
  const context=browser.contexts()[0],page=context.pages()[0];
  page.on('pageerror',error=>errors.push(error.message));
  await expect(page.locator('.sidebar')).toBeVisible({timeout:15000});
  await expect(page.locator('.welcome-screen')).toHaveCount(0,{timeout:15000});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await navButton(page,'Configurações').click();
  await expect(page.getByRole('button',{name:'Cor',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');

  for(const quality of ['high','economy']){
   await page.getByRole('combobox',{name:'Qualidade do Liquid Glass',exact:true}).selectOption(quality);
   await expect(page.locator('html')).toHaveAttribute('data-optical-engine',quality==='high'?'webgl':'css');
   const captures:Raster[]=[];
   for(const reflection of [0,1]){
    await page.getByRole('slider',{name:'Reflexos',exact:true}).fill(String(reflection));
    await expect(page.locator('.optical-root')).toHaveCSS('--appearance-specular',String(reflection));
    // Settling time exceeds the renderer's bounded layout animation window.
    await page.waitForTimeout(450);
    captures.push(PNG.sync.read(await page.screenshot({path:`test-results/perimeter-${quality}-reflections-${reflection}.png`,omitBackground:true})));
   }
   const [off,on]=captures;
   expect([on.width,on.height]).toEqual([1280,720]);
   const measurements=sides.map(side=>{
    const before=sideMean(off,side,[4,5,6]),after=sideMean(on,side,[4,5,6]);
    const outerBefore=sideMean(off,side,[0]),outerAfter=sideMean(on,side,[0]);
    return{side,before,after,delta:after-before,outerBefore,outerAfter,outerDelta:outerAfter-outerBefore};
   });
   const baseline=measurements.map(value=>value.before);
   // Chosen colors now form a gradient; compare each side against its own baseline.
   for(const value of measurements){
    expect(value.delta,`${quality}: ${value.side} must visibly respond to reflections`).toBeGreaterThan(3);
    // A diffuse bezel may reach the outer pixel in CSS, but must never become a
    // bright opaque stroke against this deliberately uniform dark environment.
    expect(value.outerAfter,`${quality}: no white stroke on ${value.side}`).toBeLessThan(190);
    expect(value.outerDelta,`${quality}: bounded outer-pixel highlight on ${value.side}`).toBeLessThan(48);
    if(quality==='high')expect(value.outerDelta,`WebGL leaves the ${value.side} cutout edge unlit`).toBeLessThan(5);
   }
   const deltas=measurements.map(value=>value.delta),ratio=Math.max(...deltas)/Math.min(...deltas);
   expect(ratio,`${quality}: reflections must be balanced around all four sides`).toBeLessThan(1.5);
   const style=await page.locator('[data-window-material]').evaluate(el=>{
    const s=getComputedStyle(el);
    return{border:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],shadow:s.boxShadow,radius:s.borderTopLeftRadius};
   });
   expect(style.border).toEqual(['0px','0px','0px','0px']);
   if(quality==='high')expect(style.shadow).toBe('none');
   checks.push({quality,measurements,ratio,style});
  }

  await page.getByRole('button',{name:'Início',exact:true}).click();
  const home=page.locator('.home-page');await expect(home).toBeVisible();
  await expect(home.locator('.page-heading h1')).toHaveText('Início');
  await expect(home.locator('.page-heading p,.page-heading .eyebrow,.home-greeting')).toHaveCount(0);
  await expect(home).not.toContainText(/Sua música, em outra atmosfera|Feito para você|Bom dia|Boa tarde|Boa noite/i);
  await expect(home.getByRole('region',{name:'Tocadas recentemente',exact:true})).toBeVisible();
  await expect(home.locator('#home-library-title')).toHaveCount(1);
  for(const width of [1280,920]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
   await page.waitForTimeout(350);
   const layout=await home.evaluate(el=>{
    const candidates=Array.from(el.children).flatMap(node=>node.matches('.online-catalog')?Array.from(node.children):[node]);
    const sections=candidates.filter((node):node is HTMLElement=>node instanceof HTMLElement&&node.matches('section')&&!!node.textContent?.trim()&&node.getBoundingClientRect().height>0);
    const boxes=sections.map(section=>{
     const r=section.getBoundingClientRect();
     return{title:section.querySelector('h2')?.textContent,top:r.top,bottom:r.bottom,cards:section.querySelectorAll('.track-card').length};
    });
    const gaps=boxes.slice(1).map((box,index)=>box.top-boxes[index].bottom);
    const first=boxes[0],header=el.querySelector('.page-heading')!.getBoundingClientRect();
    return{boxes,gaps,headerGap:first.top-header.bottom,overflow:el.scrollWidth>el.clientWidth+1};
   });
   expect(layout.boxes.filter(section=>section.cards>0).length,'the fixture supplies at least two populated Home sections').toBeGreaterThanOrEqual(2);
   expect(layout.headerGap).toBeGreaterThanOrEqual(32);
   for(const gap of layout.gaps)expect(gap,`Home section separation at ${width}px`).toBeGreaterThanOrEqual(32);
   expect(layout.overflow).toBe(false);
   homeChecks.push({width,...layout});
   await page.screenshot({path:`test-results/perimeter-home-${width}.png`});
  }
  expect(errors).toEqual([]);
  await writeFile('test-results/perimeter-validation.json',JSON.stringify({version:'2.0.3',profile,checks,homeChecks,errors},null,2));
 }finally{proc.kill();await browser?.close().catch(()=>{});}
});
