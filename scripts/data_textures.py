"""Convert three traceable NASA geographic textures without changing projection.

This script runs in the project's dl_env environment with its existing Pillow/numpy.
It never fabricates land geography or cities. The cloud layer is a static 2002 composite.
"""
from pathlib import Path
import hashlib
import json
import math
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/source/nasa'
OUT=ROOT/'assets/runtime'

def save_texture(image,path,**kwargs):
    temporary=path.with_name(path.stem+'.tmp'+path.suffix)
    image.save(temporary,format='WEBP',**kwargs)
    temporary.replace(path)

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    day=Image.open(SOURCE/'land_ocean_ice_2048.png').convert('RGB')
    assert day.size==(2048,1024)
    save_texture(day,OUT/'earth-day-2k.webp',quality=87,method=6)
    save_texture(day.resize((1024,512),Image.Resampling.LANCZOS),OUT/'earth-day-1k.webp',quality=85,method=6)
    night=Image.open(SOURCE/'dnb_land_ocean_ice.2012.3600x1800.jpg').convert('RGB')
    assert night.size==(3600,1800)
    # Suppress the supplied blue day-map backdrop while preserving the real VIIRS light locations.
    # This is a display emission texture, not a quantitative radiance product.
    night=night.resize((1024,512),Image.Resampling.LANCZOS)
    rgb=np.asarray(night,dtype=np.float64)/255
    rgb=np.clip((rgb-rgb[:,:,2,None]*0.72-0.015)*1.8,0,1)
    save_texture(Image.fromarray(np.rint(rgb*255).astype(np.uint8)),OUT/'earth-night-1k.webp',quality=90,method=6)
    clouds=Image.open(SOURCE/'cloud_combined_2048.jpg').convert('L')
    assert clouds.size==(2048,1024)
    save_texture(clouds.resize((1024,512),Image.Resampling.LANCZOS).convert('RGB'),
                 OUT/'earth-clouds-1k.webp',lossless=True,method=6)
    report={'coordinateFrame':'geographic equirectangular; north at top, Greenwich at u=0.5, east increases right',
            'uvEquation':{'u':'(longitudeEastDegrees+180)/360','vImage':'(90-latitudeNorthDegrees)/180'},
            'dayColorSpace':'sRGB','nightColorSpace':'sRGB','cloudColorSpace':'NoColorSpace / linear mask in RGB.r',
            'cloudRole':'NASA Blue Marble 2002 static cloud composite, not current weather data',
            'textureGpuBytesRgba8WithMipmaps':sum(int(w*h*4*4/3) for w,h in [(2048,1024),(1024,512),(1024,512)]),
            'files':{str(p.relative_to(ROOT)).replace('\\','/'):{'bytes':p.stat().st_size,
                    'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'dimensions':list(Image.open(p).size)}
                     for p in OUT.glob('*.webp')}}
    (ROOT/'assets/texture-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
