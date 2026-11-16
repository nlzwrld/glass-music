import type { OpticalSettings } from './model';
import { neutralPalette, type Palette } from './ambient';

/** One environment for the background and the glass samples. Tonal separation
 * stays visible even for fully saturated colors; reflections live in shaders. */
export function drawBackground(canvas:HTMLCanvasElement,root:HTMLElement,light:boolean,s:OpticalSettings,palette:Palette,image:HTMLImageElement|undefined,time:number,lab:boolean,poster?:HTMLImageElement){
 const ctx=canvas.getContext('2d')!,w=root.clientWidth,h=root.clientHeight;
 ctx.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);
 ctx.fillStyle=light?'#e2e9eb':'#10181e';ctx.fillRect(0,0,w,h);
 if(s.background==='custom'&&image&&!lab){
  const fit=Math.max(w/image.width,h/image.height),iw=image.width*fit,ih=image.height*fit;
  const bleed=s.blur*3;ctx.save();ctx.filter=`blur(${s.blur}px)`;
  ctx.drawImage(image,(w-iw)/2-bleed,(h-ih)/2-bleed,iw+bleed*2,ih+bleed*2);ctx.restore();
  ctx.fillStyle=light?'rgba(245,249,250,.40)':'rgba(5,12,19,.40)';ctx.fillRect(0,0,w,h);return;
 }
 const chosen=[1,3,5].map(i=>parseInt(s.solidColor.slice(i,i+2),16));
 const drift=time*.000045*s.backgroundMotion;
 const solid=s.background==='solid'&&!lab;
 const focal=!light&&Math.max(...chosen)<48?mix(chosen,[78,88,100],.7):chosen;
 const colors:Palette=solid?[focal,mix(chosen,light?[255,255,255]:[120,135,150],.24),mix(chosen,[3,8,14],.8)].map(rgb=>light?rgb:readableDark(rgb)) as Palette:s.background==='ambient'||lab?neutralPalette:palette;
 if(solid){
  const amount=s.gradientIntensity;
  const base=mix(chosen,light?[249,250,251]:[6,10,15],light?.76:.64);
  const bright=mix(base,light?[255,255,255]:readableDark(focal),(light?.65:.64)*amount);
  const shade=light&&Math.min(...chosen)>220?mix(chosen,[154,165,179],.8):chosen;
  const deep=mix(base,light?shade:[3,6,10],(light?.48:.83)*amount);
  const angle=drift*.22,gradient=ctx.createLinearGradient(w*(.05+Math.sin(angle)*.12),h*.05,w*.95,h*.95);
  gradient.addColorStop(0,css(bright));gradient.addColorStop(.46,css(base));gradient.addColorStop(1,css(deep));ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
 }
 const positions=[[.08,.2,.78],[.96,.35,.85],[.52,1.18,.85]];
 colors.forEach((rgb,i)=>{const [px,py,r]=positions[i],x=px+Math.sin(drift+i*2.1)*.12,y=py+Math.cos(drift*.8+i*1.6)*.1,g=ctx.createRadialGradient(w*x,h*y,0,w*x,h*y,w*r);g.addColorStop(0,`rgba(${rgb.map(Math.round).join(',')},${(solid?(light?.28:.5):(light?.42:.68))*s.gradientIntensity})`);g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);});
 if(lab)drawLaboratory(ctx,root,time,poster);
}
function mix(a:number[],b:number[],amount:number){return a.map((value,i)=>value*(1-amount)+b[i]*amount);}
function css(rgb:number[]){return `rgb(${rgb.map(Math.round).join(',')})`;}
function readableDark(rgb:number[]){
 // Keep white type readable for white, yellow and vivid green backgrounds.
 // Scale the hue together rather than washing a saturated color with gray.
 const luminance=(values:number[])=>values.map(n=>{const v=n/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
 if(luminance(rgb)<=.16)return rgb;
 let lo=0,hi=1;for(let i=0;i<12;i++){const scale=(lo+hi)/2;if(luminance(rgb.map(v=>v*scale))>.16)hi=scale;else lo=scale;}
 return rgb.map(v=>v*lo);
}

// Deliberately detailed test images stay inside the three laboratory viewports.
// They make optical displacement measurable without decorating the application.
function drawLaboratory(ctx:CanvasRenderingContext2D,root:HTMLElement,time:number,poster?:HTMLImageElement){
 const origin=root.getBoundingClientRect();
 for(const cell of root.querySelectorAll<HTMLElement>('[data-lab-scene]')){
  const b=cell.getBoundingClientRect(),x=b.left-origin.left,y=b.top-origin.top,cw=b.width,ch=b.height;
  ctx.save();ctx.beginPath();ctx.roundRect(x,y,cw,ch,19);ctx.clip();
  const g=ctx.createLinearGradient(x,y,x+cw,y+ch);g.addColorStop(0,'#073f8b');g.addColorStop(.45,'#742b9c');g.addColorStop(1,'#173741');ctx.fillStyle=g;ctx.fillRect(x,y,cw,ch);
  // Local original image: iridescent disc with colour bands, actually sampled.
  ctx.save();ctx.translate(x+cw*.77,y+ch*.21);ctx.rotate(-.3);const image=ctx.createLinearGradient(-70,-70,70,70);image.addColorStop(0,'#36daff');image.addColorStop(.3,'#3051df');image.addColorStop(.65,'#fd78bc');image.addColorStop(1,'#f9d6a7');ctx.fillStyle=image;ctx.fillRect(-73,-70,146,140);ctx.globalAlpha=.8;ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;for(let n=1;n<8;n++){ctx.beginPath();ctx.arc(0,0,n*8,0,Math.PI*2);ctx.stroke();}ctx.restore();
  if(poster){ctx.save();ctx.translate(x+cw*.77,y+ch*.21);ctx.rotate(-.3);ctx.drawImage(poster,-73,-70,146,140);ctx.restore();}
  ctx.fillStyle='#faf5ff';ctx.font='600 38px Segoe UI';ctx.fillText('LIQUID',x+17,y+ch*.42);ctx.fillText('GLASS',x+17,y+ch*.42+42);
  ctx.strokeStyle='#f4d6ff';ctx.globalAlpha=.65;ctx.lineWidth=2;
  for(let n=0;n<8;n++){const yy=y+ch*.6+n*13;ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+cw,yy-cw*.28);ctx.stroke();}
  ctx.globalAlpha=1;const px=x+cw*(.5+.32*Math.sin(time*.001)),py=y+ch*.71;ctx.fillStyle='#ffd879';ctx.beginPath();ctx.arc(px,py,22,0,Math.PI*2);ctx.fill();ctx.restore();
 }
}
