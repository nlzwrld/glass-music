"""Original procedural compositions and vector artwork. No third-party recordings.
Run from the project root with Python + numpy + Pillow. Generated WAV/SVG/ICO are included.
"""
import math, wave, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
root = pathlib.Path(__file__).resolve().parents[1]
audio = root / 'assets/audio'; covers = root / 'public/covers'; assets = root / 'assets'
for folder in (audio,covers,assets): folder.mkdir(parents=True,exist_ok=True)
rate=24000; length=48
def render(name, chords, seed, tempo, tint):
    rng=np.random.default_rng(seed); out=np.zeros((rate*length,2),dtype=np.float64)
    def voice(midi,start,duration,gain,kind='pad',pan=.5):
        begin=int(start*rate); count=min(int(duration*rate),len(out)-begin)
        if count<=0:return
        t=np.arange(count)/rate; f=440*2**((midi-69)/12)
        if kind=='pad':
            s=(np.sin(2*np.pi*f*t)+.25*np.sin(2*np.pi*f*1.002*t)+.16*np.sin(2*np.pi*f*2*t))
            env=np.minimum(t/1.7,1)*np.minimum((duration-t)/2.5,1)*(.92+.08*np.sin(2*np.pi*.11*t))
        else:
            s=np.sin(2*np.pi*f*t)+.18*np.sin(2*np.pi*f*2*t)+.06*np.sin(2*np.pi*f*3*t)
            env=(1-np.exp(-t*100))*np.exp(-t/1.15)*np.minimum((duration-t)/.1,1)
        signal=s*np.clip(env,0,1)*gain
        out[begin:begin+count,0]+=signal*math.sqrt(1-pan); out[begin:begin+count,1]+=signal*math.sqrt(pan)
    for bar,chord in enumerate(chords*2):
        start=bar*6
        for n in chord:voice(n,start,8,.055,'pad',float(rng.uniform(.2,.8)))
        voice(chord[0]-12,start,6,.065,'pad',.5)
        for step,n in enumerate([chord[0]+12,chord[2]+12,chord[1]+12,chord[3]+12]):
            voice(n,start+step*1.5+.25,4,.06,'bell',.25+.5*(step%2))
    # Modest stereo echoes; limiter, fade-in/out, 16-bit PCM. Original test music.
    for delay,amp in [(.31,.12),(.63,.07),(1.07,.04)]:
        d=int(delay*rate); out[d:]+=out[:-d,::-1].copy()*amp
    fade=np.minimum(np.arange(len(out))/rate/3,1)*np.minimum((len(out)-np.arange(len(out)))/rate/4,1)
    out*=fade[:,None]; out=np.tanh(out*1.5)*.67
    with wave.open(str(audio/f'{name}.wav'),'wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(rate);w.writeframes((out*32767).astype('<i2').tobytes())
render('prisma',[[48,55,59,62],[45,52,55,59],[53,57,60,64],[43,50,55,59]],10,80,'purple')
render('mare',[[50,57,60,64],[46,53,57,60],[48,55,58,62],[45,52,57,60]],20,80,'teal')
render('orbita',[[45,52,55,59],[48,55,59,62],[43,50,54,57],[41,48,52,55]],30,80,'orange')
palettes=[('prisma','PRISMA','01','#1c182e','#9c82b9','#e1c4e9'),('mare','MARÉ','02','#122727','#62978f','#c5dfc7'),('orbita','ÓRBITA','03','#301c20','#bc796a','#efc1a2')]
for name,title,num,dark,mid,light in palettes:
    shape = f'''<g transform="translate(320 290) rotate(-25)"><ellipse rx="202" ry="152" fill="url(#ring)"/><ellipse rx="126" ry="91" fill="url(#hole)"/><ellipse rx="190" ry="139" fill="none" stroke="{light}" stroke-opacity=".35" stroke-width="2"/><ellipse rx="125" ry="90" fill="none" stroke="{light}" stroke-opacity=".6" stroke-width="2"/></g>'''
    if name=='mare':
        shape=''.join(f'<path d="M -80 {205+i*37} Q 130 {80+i*33} 330 {220+i*30} T 720 {190+i*22}" fill="none" stroke="{light}" stroke-opacity="{.12+i*.055}" stroke-width="{25-i*2}"/>' for i in range(8))
    if name=='orbita':
        shape=f'<circle cx="345" cy="275" r="160" fill="url(#ring)"/><ellipse cx="330" cy="300" rx="255" ry="74" transform="rotate(-28 330 300)" fill="none" stroke="{light}" stroke-opacity=".55" stroke-width="2"/><ellipse cx="330" cy="300" rx="272" ry="85" transform="rotate(-28 330 300)" fill="none" stroke="{light}" stroke-opacity=".15"/>'
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="{dark}"/><stop offset="1" stop-color="{mid}"/></linearGradient><radialGradient id="ring" cx="28%" cy="10%" r="90%"><stop stop-color="{light}"/><stop offset=".3" stop-color="{mid}"/><stop offset=".65" stop-color="{dark}"/><stop offset=".83" stop-color="{mid}"/><stop offset="1" stop-color="{light}"/></radialGradient><linearGradient id="hole" x2=".2" y2="1"><stop stop-color="{dark}"/><stop offset="1" stop-color="{mid}"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></defs><rect width="640" height="640" fill="url(#bg)"/>{shape}<rect width="640" height="640" filter="url(#grain)" opacity=".055"/><g fill="{light}" font-family="Segoe UI, sans-serif"><text x="44" y="55" font-size="12" letter-spacing="5">GLASS SESSIONS</text><text x="594" y="55" font-size="12" text-anchor="end">{num} / 03</text><text x="42" y="553" font-size="66" font-weight="300" letter-spacing="7">{title}</text><text x="45" y="590" font-size="11" letter-spacing="4" opacity=".65">ESTUDOS EM SOM E LUZ</text></g><rect x="20" y="20" width="600" height="600" rx="3" fill="none" stroke="{light}" stroke-opacity=".12"/></svg>'''
    (covers/f'{name}.svg').write_text(svg,encoding='utf-8')
icon=Image.new('RGBA',(512,512),(0,0,0,0));d=ImageDraw.Draw(icon)
d.rounded_rectangle((12,12,500,500),radius=115,fill=(31,27,42),outline=(122,109,145),width=3)
d.rounded_rectangle((30,30,482,482),radius=101,outline=(190,171,220,55),width=2)
for x,h in [(136,120),(196,220),(256,300),(316,190),(376,90)]:
    d.rounded_rectangle((x-13,256-h//2,x+13,256+h//2),radius=13,fill=(218,204,242))
icon.save(assets/'icon.png');icon.save(assets/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
(assets/'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="12" y="12" width="488" height="488" rx="115" fill="#1f1b2a" stroke="#7a6d91" stroke-width="3"/><path d="M136 196v120m60-170v220m60-260v300m60-245v190m60-140v90" stroke="#daccf2" stroke-width="26" stroke-linecap="round"/></svg>')
print('Generated: 3 original 48-second WAVs, 3 SVG covers, application icon.')
