import { VERTEX_SHADER, FRAGMENT_SHADER } from './vendor/shaders';
import { crystals, type Crystal, type OpticalSettings } from './model';
import { surfaceClip } from './clipping';

/** A single context for all persistent surfaces. The source is the live scene
 * canvas, never a stale DOM screenshot. Foreground DOM never enters the texture. */
export class CrystalRenderer {
  readonly gl:WebGL2RenderingContext;
  private program:WebGLProgram;private vao:WebGLVertexArrayObject;private buffer:WebGLBuffer;private texture:WebGLTexture;
  private uniforms=new Map<string,WebGLUniformLocation|null>();private texWidth=0;private texHeight=0;
  draws=0;uploads=0;lastDrawMs=0;
  constructor(readonly canvas:HTMLCanvasElement){
    const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,powerPreference:'low-power'});
    if(!gl)throw new Error('WebGL2 indisponível');this.gl=gl;
    const shader=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(message||'Falha no shader');}return s;};
    const vs=shader(gl.VERTEX_SHADER,VERTEX_SHADER),fs=shader(gl.FRAGMENT_SHADER,FRAGMENT_SHADER);
    this.program=gl.createProgram()!;gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program)||'Falha no programa');
    this.vao=gl.createVertexArray()!;gl.bindVertexArray(this.vao);this.buffer=gl.createBuffer()!;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(this.program,'a_pos');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    this.texture=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  private u(name:string){if(!this.uniforms.has(name))this.uniforms.set(name,this.gl.getUniformLocation(this.program,name));return this.uniforms.get(name)!;}
  draw(source:HTMLCanvasElement,root:HTMLElement,settings:OpticalSettings,light:[number,number],upload:boolean,lab:boolean){
    const started=performance.now(),gl=this.gl,dpr=source.width/root.clientWidth;
    if(this.canvas.width!==source.width||this.canvas.height!==source.height){this.canvas.width=source.width;this.canvas.height=source.height;}
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);gl.bindVertexArray(this.vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    if(upload||this.texWidth!==source.width||this.texHeight!==source.height){
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      if(this.texWidth===source.width&&this.texHeight===source.height)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
      else{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);this.texWidth=source.width;this.texHeight=source.height;}
      gl.generateMipmap(gl.TEXTURE_2D);this.uploads++;
    }
    gl.uniform1i(this.u('u_bg'),0);gl.uniform2f(this.u('u_canvasSize'),source.width,source.height);gl.uniform1f(this.u('u_dpr'),dpr);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    const origin=root.getBoundingClientRect();
    const surfaces=Array.from(root.querySelectorAll<HTMLElement>('[data-optic="webgl"],[data-optic="auto"]'));
    gl.enable(gl.SCISSOR_TEST);
    for(const el of surfaces){
      if(lab!==!!el.closest('.glass-laboratory'))continue;
      const rect=el.getBoundingClientRect();if(rect.width<1||rect.height<1)continue;
      const clip=surfaceClip(el,root);if(!clip)continue;
      const left=Math.max(0,Math.floor((clip.bounds.left-origin.left)*dpr)),top=Math.max(0,Math.floor((clip.bounds.top-origin.top)*dpr));
      const right=Math.min(source.width,Math.ceil((clip.bounds.right-origin.left)*dpr)),bottom=Math.min(source.height,Math.ceil((clip.bounds.bottom-origin.top)*dpr));
      gl.scissor(left,source.height-bottom,Math.max(0,right-left),Math.max(0,bottom-top));
      gl.uniform1f(this.u('u_surfaceOpacity'),clip.opacity);
      // Current component hierarchy has at most four rounded clipping ancestors.
      gl.uniform1i(this.u('u_clipCount'),Math.min(8,clip.rounded.length));
      clip.rounded.slice(0,8).forEach(({rect:r,radius},i)=>{
        gl.uniform4f(this.u(`u_clipRects[${i}]`),(r.left-origin.left)*dpr,(r.top-origin.top)*dpr,r.width*dpr,r.height*dpr);
        gl.uniform1f(this.u(`u_clipRadii[${i}]`),radius*dpr);
      });
      const style=getComputedStyle(el),variant=(el.dataset.crystal||'regular') as Crystal,preset=crystals[variant]||crystals.regular;
      const value=(name:string,fallback:number)=>{const raw=el.dataset[name];return raw!==undefined&&Number.isFinite(Number(raw))?Number(raw):fallback;};
      const refraction=value('opticalRefraction',settings.refraction)*preset.refraction*(value('opticalIor',settings.ior)-1)/.42;
      const x=rect.left-origin.left,y=rect.top-origin.top,w=rect.width,h=rect.height,scale=Math.max(1,Math.min(w,h));
      const f=(name:string,value:number)=>gl.uniform1f(this.u(name),value);
      f('u_windowMaterial',el.hasAttribute('data-window-material')?1:0);
      gl.uniform4f(this.u('u_rect'),x*dpr,y*dpr,w*dpr,h*dpr);f('u_radius',(parseFloat(style.borderTopLeftRadius)||20)*dpr);
      f('u_ior',value('opticalIor',settings.ior));f('u_fresnel',value('opticalFresnel',settings.fresnel)*preset.fresnel);f('u_edge',value('opticalEdge',settings.edge)*preset.edge);
      f('u_refraction',refraction/scale);f('u_rimIntensity',refraction*.23/scale);
      f('u_edgeDistance',3/(value('opticalThickness',settings.thickness)*preset.thickness*dpr));f('u_rimDistance',1.2/dpr);
      f('u_baseIntensity',0);f('u_baseDistance',0);f('u_cornerBoost',0);f('u_ripple',0);
      f('u_blur',value('opticalBlur',settings.blur)*preset.blur*dpr);f('u_chromatic',settings.quality==='economy'?0:settings.chromatic);
      f('u_tintOpacity',Math.min(1,value('opticalOpacity',settings.opacity)));f('u_ambientTint',0);f('u_specular',value('opticalSpecular',settings.specular)*preset.specular);
      f('u_cursor',value('opticalCursor',preset.cursor));
      f('u_saturation',value('opticalSaturation',settings.saturation*100)/100);gl.uniform2f(this.u('u_lightDir'),light[0],light[1]);
      const tint=el.dataset.opticalTint||settings.tint;
      const rgb=[1,3,5].map(offset=>parseInt(tint.slice(offset,offset+2),16)/255);gl.uniform3f(this.u('u_tint'),rgb[0],rgb[1],rgb[2]);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.draws++;this.lastDrawMs=performance.now()-started;
  }
  dispose(){const gl=this.gl;gl.deleteTexture(this.texture);gl.deleteBuffer(this.buffer);gl.deleteVertexArray(this.vao);gl.deleteProgram(this.program);}
}
