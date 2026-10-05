"""Transcode fixed NASA2019 official 1K lunar colour map; preserve geography/UV."""
import hashlib
import json
from PIL import Image
from data_build import ROOT, SOURCE, OUT, atomic_write

def main():
    source=SOURCE/'nasa/lroc_color_poles_1k.jpg'
    image=Image.open(source).convert('RGB')
    assert image.size==(1024,512)
    target=OUT/'moon-color-1k.webp'
    temporary=target.with_name('moon-color-1k.tmp.webp')
    image.save(temporary,format='WEBP',quality=88,method=6)
    temporary.replace(target)
    report={'id':'moon-color','source':'https://svs.gsfc.nasa.gov/4720/','revision':'2019 CGI Moon Kit, official1K JPG derivative',
      'sourceFile':'assets/source/nasa/lroc_color_poles_1k.jpg','sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
      'outputs':[{'path':'assets/runtime/moon-color-1k.webp','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
        'bytes':target.stat().st_size,'dimensions':[1024,512]}],
      'coordinateFrame':'equirectangular lunar body-fixed; east-positive longitude -180..180 left-to-right, north at top',
      'uvLongitudeEastDeg':[-180,-90,0,90,180],'uvSamples':[0,.25,.5,.75,1],
      'imageRowLatitudeNorthDeg':[90,0,-90],'colorSpace':'sRGB',
      'processing':'Official 2019 1K JPG retained at original resolution; RGB WebPquality88 transcoding only, no rotation, mirroring or longitude offset. 2K TIF transfer timed out; incomplete file is not selected.',
      'limitations':'NASA map is optimized for aesthetics: gamma/exposure/white-balance adjustments and filled poles; not scientific photometry or a current observation.',
      'processingCommand':'conda run -n dl_env python scripts/data_moon.py'}
    atomic_write(ROOT/'assets/moon-report.json',(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    print(f'{target.stat().st_size} bytes Moon1K; sourceSHA256 {report["sourceSha256"]}')

if __name__=='__main__': main()
