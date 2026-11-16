/** Palette work happens once per artwork. Frames only interpolate three colors. */
export type RGB = [number,number,number];
export type Palette = [RGB,RGB,RGB];
export const neutralPalette: Palette = [[62,107,121],[72,91,126],[87,112,110]];
const cache=new Map<string,Promise<Palette>>();
export const paletteStats={extractions:0,hits:0};
export function paletteFromPixels(pixels:Uint8ClampedArray):Palette {
 const bins=new Map<number,{sum:RGB;weight:number}>();
 for(let i=0;i<pixels.length;i+=4){
  const r=pixels[i],g=pixels[i+1],b=pixels[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b);
  if(pixels[i+3]<128||max<24||min>232)continue;
  const weight=.3+(max-min)/255,key=(r>>5)*64+(g>>5)*8+(b>>5);
  const bin=bins.get(key)||{sum:[0,0,0] as RGB,weight:0};
  bin.sum[0]+=r*weight;bin.sum[1]+=g*weight;bin.sum[2]+=b*weight;bin.weight+=weight;bins.set(key,bin);
 }
 const ranked=[...bins.values()].sort((a,b)=>b.weight-a.weight);if(!ranked.length)return neutralPalette;
 const selected:RGB[]=[];
 for(const bin of ranked){const raw=bin.sum.map(n=>n/bin.weight) as RGB;if(selected.some(c=>Math.hypot(...c.map((n,i)=>n-raw[i]))<45))continue;selected.push(raw);if(selected.length===3)break;}
 return [0,1,2].map(i=>{const rgb=selected[i%selected.length],luma=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;return rgb.map(n=>Math.round(Math.max(28,Math.min(176,(n*.5+luma*.5)*.65+24)))) as RGB;}) as Palette;
}
export function getPalette(url:string):Promise<Palette>{
 if(!url)return Promise.resolve(neutralPalette);const hit=cache.get(url);if(hit){paletteStats.hits++;return hit;}
 const pending=new Promise<Palette>(resolve=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(img,0,0,32,32);paletteStats.extractions++;resolve(paletteFromPixels(ctx.getImageData(0,0,32,32).data));}catch{resolve(neutralPalette);}};img.onerror=()=>resolve(neutralPalette);img.src=url;});
 cache.set(url,pending);if(cache.size>64)cache.delete(cache.keys().next().value!);return pending;
}
export function mixPalette(a:Palette,b:Palette,t:number):Palette{return a.map((c,i)=>c.map((v,j)=>v+(b[i][j]-v)*t)) as Palette;}
export async function readBackground(file:File):Promise<string>{
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024)throw new Error('Escolha uma imagem JPG, PNG ou WebP de até 12 MB.');
 const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Não foi possível ler a imagem.'));r.readAsDataURL(file);});
 const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Imagem inválida.'));i.src=data;});
 const scale=Math.min(1,1600/img.width,1000/img.height),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.87);
}
