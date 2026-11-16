from pathlib import Path
import sys, json
import numpy as np
from PIL import Image, ImageDraw

reference=Path(sys.argv[1]).resolve()
candidate=Path(sys.argv[2]).resolve()
root=Path(sys.argv[3]).resolve();root.mkdir(parents=True,exist_ok=True)
name=candidate.stem
ref=Image.open(reference).convert('RGB')
actual=Image.open(candidate).convert('RGB')
assert actual.size==ref.size, 'Use the same viewport, do not stretch the app.'
a=np.array(ref,dtype=float); b=np.array(actual,dtype=float)
w,h=ref.size
mask=np.ones((h,w),dtype=bool)
# Exclude content, not material edges. These rectangles are shared by every cycle.
excluded=[(365,217,1174,403),(372,456,1173,634),(372,691,1173,800),(1241,132,1566,446),(1215,451,1591,545),(78,503,310,715),(90,810,375,899),(1217,580,1590,603),(1063,836,1384,875)]
for x1,y1,x2,y2 in excluded: mask[y1:y2,x1:x2]=False
def window_mean(v,n=11):
    p=np.pad(v,((n//2,n//2),(n//2,n//2)),mode='reflect')
    c=np.pad(p,((1,0),(1,0))).cumsum(0).cumsum(1)
    return (c[n:,n:]-c[:-n,n:]-c[n:,:-n]+c[:-n,:-n])/(n*n)
def ssim_map(x,y):
    mx,my=window_mean(x),window_mean(y)
    vx=np.maximum(0,window_mean(x*x)-mx*mx); vy=np.maximum(0,window_mean(y*y)-my*my)
    cov=window_mean(x*y)-mx*my
    return ((2*mx*my+6.5025)*(2*cov+58.5225))/((mx*mx+my*my+6.5025)*(vx+vy+58.5225))
lum=np.array([.2126,.7152,.0722]); s=ssim_map(a@lum,b@lum)
Image.blend(ref,actual,.5).save(root/f'{name}-overlay.png')
masked_ref=np.array(ref); masked_actual=np.array(actual)
masked_ref[~mask]=[35,38,55]; masked_actual[~mask]=[35,38,55]
Image.fromarray(masked_ref).save(root/'concept-masked.png');Image.fromarray(masked_actual).save(root/f'{name}-masked.png')
maskimg=Image.fromarray((~mask*255).astype('uint8'));maskimg.save(root/'excluded-mask.png')
zones={'top':(650,104,1165,207),'sidebar':(65,166,311,465),'center':(848,416,1173,452),'player':(1209,608,1595,752),'bar':(470,810,1055,897)}
report={'candidate':str(candidate),'dimensions':[w,h],'excludedRectangles':excluded,'comparedPixels':int(mask.sum()),'ssimLuminance11x11':round(float(s[mask].mean()),4),'meanAbsoluteRGBError':round(float(np.abs(a-b)[mask].mean()),2),'zones':{k:{'referenceRGB':np.round(a[y1:y2,x1:x2].mean((0,1)),1).tolist(),'actualRGB':np.round(b[y1:y2,x1:x2].mean((0,1)),1).tolist()} for k,(x1,y1,x2,y2) in zones.items()},'note':'Diagnostic only. Masks omit dynamic content; font differences, raster art and geometry need visual review. SSIM is uniform-window luminance, not a claim of pixel-perfect fidelity.'}
(root/f'{name}.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report))
