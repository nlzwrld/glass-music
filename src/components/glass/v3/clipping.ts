/** CSS clipping must also apply to surfaces painted in the shared canvas. */
export interface ClipBox { left:number; top:number; right:number; bottom:number }
export function intersectClip(a:ClipBox,b:ClipBox):ClipBox|null {
 const box={left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)};
 return box.right>box.left&&box.bottom>box.top?box:null;
}
export function surfaceClip(el:HTMLElement,root:HTMLElement){
 let bounds:ClipBox|null=intersectClip(root.getBoundingClientRect(),el.getBoundingClientRect()),opacity=1;
 const rounded:{rect:DOMRect;radius:number}[]=[];
 for(let node:HTMLElement|null=el;node;node=node.parentElement){
  const style=getComputedStyle(node);
  if(style.display==='none'||style.visibility!=='visible')return null;
  opacity*=Number(style.opacity);
  if(opacity<.001)return null;
  if(node!==el){
   const clipX=style.overflowX!=='visible',clipY=style.overflowY!=='visible';
   if(clipX||clipY){
    const rect=node.getBoundingClientRect();
    bounds=bounds&&intersectClip(bounds,{left:clipX?rect.left:-Infinity,right:clipX?rect.right:Infinity,top:clipY?rect.top:-Infinity,bottom:clipY?rect.bottom:Infinity});
    if(!bounds)return null;
    const raw=style.borderTopLeftRadius,radius=raw.includes('%')?Math.min(rect.width,rect.height)*parseFloat(raw)/100:parseFloat(raw)||0;
    if(radius&&clipX&&clipY)rounded.push({rect,radius});
   }
  }
  if(node===root)break;
 }
 return bounds?{bounds,opacity,rounded}:null;
}
