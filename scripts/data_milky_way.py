"""Fixed linear NASA celestial background-only EXR -> matched sRGB2K/1K offline.

Uses existing dl_env OpenCV4.12/Pillow/numpy. The OPENCV flag enables the already
installed EXR codec only for this build process. No dependency or global env change.
"""
from __future__ import annotations
import os
os.environ['OPENCV_IO_ENABLE_OPENEXR']='1'
import cv2
from PIL import Image
import numpy as np
import hashlib
import json
import math
from data_build import ROOT, SOURCE, OUT, atomic_write

EXPOSURE=1.0
REGIONS=[('cygnus-deneb','天鹅座／天津四','hip:102098'),
         ('crux-acrux','南十字座／十字架二','hip:60718'),
         ('orion-betelgeuse','猎户座／参宿四','hip:27989')]

def image_uv(ra,dec): return [(0.5-ra/24)%1,0.5-dec/180]
def direction(ra,dec):
    a=ra*math.pi/12; d=dec*math.pi/180
    return [math.cos(d)*math.cos(a),math.cos(d)*math.sin(a),math.sin(d)]

def preview_peak(image,uv,radius=3):
    x=int(uv[0]*image.width)%image.width; y=min(image.height-1,int(uv[1]*image.height))
    values=[image.getpixel(((x+dx)%image.width,min(image.height-1,max(0,y+dy))))
            for dx in range(-radius,radius+1) for dy in range(-radius,radius+1)]
    return max(values)

def main():
    source=SOURCE/'nasa/milkyway_2020_4k.exr'
    # OpenCV's Windows filename API cannot reliably open native Unicode paths.
    # Decode verified upstream bytes instead of silently treating that as no image.
    input_bgr=cv2.imdecode(np.frombuffer(source.read_bytes(),dtype=np.uint8),cv2.IMREAD_UNCHANGED)
    assert input_bgr is not None and input_bgr.shape==(2048,4096,3) and input_bgr.dtype==np.float32
    rgb=input_bgr[...,::-1].copy()
    assert np.isfinite(rgb).all() and (rgb>=0).all()
    linear=EXPOSURE*rgb
    mapped=linear/(1.0+linear)
    srgb=np.where(mapped<=0.0031308,12.92*mapped,1.055*np.power(mapped,1/2.4)-0.055)
    image=Image.fromarray(np.rint(np.clip(srgb,0,1)*255).astype(np.uint8),'RGB')
    outputs=[]
    for width,quality in [(2048,88),(1024,85)]:
        resized=image.resize((width,width//2),Image.Resampling.LANCZOS)
        name=f'milky-way-{width//1024}k.webp'; target=OUT/name; temporary=target.with_name(target.stem+'.tmp.webp')
        resized.save(temporary,format='WEBP',quality=quality,method=6)
        temporary.replace(target)
        outputs.append({'path':target.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
          'bytes':target.stat().st_size,'dimensions':[width,width//2]})
    stars={row[0]:row for row in json.loads((OUT/'star-meta.json').read_text(encoding='utf-8'))}
    galactic_center_ra=17+45/60+40/3600; galactic_center_dec=-(29+28/3600)
    anchors=[{'id':'galactic-center-sgra','nameZh':'银心／人马座A*','raHours':galactic_center_ra,'decDeg':galactic_center_dec,
      'source':'https://www.chandra.harvard.edu/photo/2010/sgra/index.html','sourceCoordinateText':'J2000 RA17h45m40s Dec-29°00′28.00″; rounded reference direction, not subarcsecond astrometry'}]
    for region_id,name,star_id in REGIONS:
        row=stars[star_id]
        anchors.append({'id':region_id,'nameZh':name,'starId':star_id,'raHours':row[3],'decDeg':row[4],
            'source':'HYG4.1 locked star metadata / HIP identifier','sourcePath':'assets/source/hyg/hyg/CURRENT/hygdata_v41.csv'})
    for ra,name in [(0,'RA0中央'),(6,'RA6左四分点'),(12,'RA12接缝'),(18,'RA18右四分点')]:
        anchors.append({'id':f'ra-axis-{ra}','nameZh':name,'raHours':ra,'decDeg':0,
          'source':'NASA SVS4851 coordinate-map description; mathematical coordinate axis'})
    foreground=Image.open(SOURCE/'nasa/hiptyc_2020_4k_print.jpg').convert('L')
    background=Image.open(SOURCE/'nasa/milkyway_2020_4k_print.jpg').convert('L')
    removal=[]
    for anchor in anchors:
        anchor['directionEqj']=direction(anchor['raHours'],anchor['decDeg'])
        anchor['imageUv']=image_uv(anchor['raHours'],anchor['decDeg'])
        anchor['threeFlipYSamplerUv']=[anchor['imageUv'][0],1-anchor['imageUv'][1]]
        anchor['pixel2k']=[anchor['imageUv'][0]*2048-.5,anchor['imageUv'][1]*1024-.5]
        anchor['pixelCoordinateConvention']='pixel centers at integer coordinates; continuous x=u*width-.5,y=v*height-.5'
        if 'starId' in anchor:
            removal.append({'starId':anchor['starId'],'imageUv':anchor['imageUv'],
              'officialForegroundPreviewPeak':preview_peak(foreground,anchor['imageUv']),
              'officialBackgroundPreviewPeak':preview_peak(background,anchor['imageUv']),
              'note':'7x7 source-preview maxgray demonstrates foreground separation near a known bright star; previews have different tone mappings, so ratio is display evidence, not calibrated photometry.'})
    metadata={'schemaVersion':1,'id':'milky-way','source':'https://svs.gsfc.nasa.gov/4851/',
      'revision':'Deep Star Maps2020 celestial Milky Way background; official EXR snapshot',
      'sourceFile':source.relative_to(ROOT).as_posix(),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
      'sourceDimensions':[4096,2048],'sourceEncoding':'OpenEXR half-float RGB, linear color',
      'coordinateFrame':'ICRF/J2000 geocentric RA/Dec; approximate EQJ frame shared with star catalog',
      'epoch':'static catalog-derived background, approximateJ2000; not a simulated date observation',
      'projection':'plate carrée / equirectangular equatorial, not galactic',
      'rightAscensionIncreasesLeft':True,'rightAscensionHoursAtU':[12,6,0,18,12],
      'uSamples':[0,.25,.5,.75,1],'northAtImageTop':True,'seamRaHours':12,
      'uvFormula':{'u':'fract(0.5-raHours/24)','imageRowV':'0.5-decDeg/180',
          'threeDefaultFlipYSamplerV':'0.5+decDeg/180','shaderEqjU':'fract(0.5-atan(y,x)/(2*pi))',
          'shaderEqjImageV':'0.5-asin(z/length(direction))/pi'},
      'colorSpace':'sRGB','toneMapping':{'exposure':EXPOSURE,'operator':'componentwise Reinhard c=(exposure*linear)/(1+exposure*linear)',
          'encoding':'IEC61966-2-1 standard linear-to-sRGB transfer; nearest integer8bit',
          'resampling':'Tone-map source once, then common LDR master Lanczos downsample to2K/1K; no per-resolution normalization'},
      'brightStarSeparation':{'selectedLayer':'milkyway_2020_4k.exr celestial background only',
          'omittedForegroundCatalogs':['Hipparcos-2','Tycho-2'],
          'hipparcosUseVmagLessThan':8.0,'tychoUseVmagRange':[8.0,11.5],
          'backgroundContains':'GaiaDR2 unresolved faint stars, supporting faint UCAC3 replacements, stellar clusters and Magellanic Clouds; no added nebulosity photography',
          'photometricGap':'Runtime selectable catalog mostlyV<=6.5; omitted NASA foreground extends toV11.5. Integrated contribution from much of6.5..11.5 is therefore absent, except required catalog endpoints. This is not complete Milky Way luminosity or calibrated total sky brightness.',
          'limitation':'Catalog/pipeline separation, not a custom6.5mag raster cutoff. V/G passband differences, blends/variables and supplemental stars prevent claiming mathematically zero residual bright-star contribution.'},
      'directionAnchors':anchors,'brightStarPreviewChecks':removal,'outputs':outputs,
      'processingCommand':'conda run -n dl_env python scripts/data_milky_way.py',
      'tools':{'OpenCV':cv2.__version__,'Pillow':__import__('PIL').__version__,'numpy':np.__version__},
      'limitations':'Static catalog-density visualization, not photometrically calibrated sky radiance or a current weather/airglow model; global renderer intensity/saturation are explicit qualitative display parameters.'}
    data=(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    atomic_write(ROOT/'assets/milky-way-report.json',data)
    atomic_write(OUT/'milky-way-meta.json',data)
    notice='''# NASA Deep Star Maps2020: celestial Milky Way background

Source: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps2020, SVS4851, released2020-09-09. https://svs.gsfc.nasa.gov/4851/
Selected original: milkyway_2020_4k.exr, celestial background-only layer. It omits the bright Hipparcos/Tycho foreground. The full starmap and hiptyc foreground images are separate files retained only as QA previews, not included in runtime. The galactic-coordinate maps are not selected.
Original source SHA256: 2eb802d6e68d170b410f766c7fec07f7518619f6b6708fdc81e9302d93e74fdb (36,436,668 bytes,4096×2048).

Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio; Ernie Wright (USRA), animator; GaiaDR2: ESA/Gaia/DPAC. Supporting faint-star catalog data include UCAC3. The NASA constellation figure overlays credited to the IAU/Alan MacRobert are not used in this background asset.

NASA Images and Media Usage Guidelines apply: https://www.nasa.gov/nasa-brand-center/images-and-media/ . NASA content is generally not subject to copyright in the United States and may be used for educational/informational material with acknowledgment, subject to the guidelines. Do not imply NASA endorsement. No NASA logo, person or separately marked third-party illustration is included. ESA/Gaia data credits are preserved separately below; this does not label all third-party observational data as US government work or claim CC0.

Gaia official data credit/citation and usage source (hash-locked):
https://gea.esac.esa.int/archive/documentation/GDR2/Miscellaneous/sec_credit_and_citation_instructions/

The Gaia data are open and free to use, provided credit is given to ESA/Gaia/DPAC. The required research acknowledgment is reproduced here to retain the underlying data provenance:
"This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement."
Data references: Gaia Collaboration, Prusti et al.(2016), The Gaia mission, Astronomy & Astrophysics595,A1, doi:10.1051/0004-6361/201629272; Gaia Collaboration, Brown et al.(2018), Gaia Data Release2: Summary of the contents and survey properties, Astronomy & Astrophysics616,A1, doi:10.1051/0004-6361/201833051.

Processing: existing OpenCV4.12 EXR decoder, fixed linear exposure1, componentwise Reinhard x/(1+x), standard linear-to-sRGB transfer, round8bit, then Lanczos downsample of the same LDR master to2K/1K and WebPquality88/85. No per-image/per-resolution normalization, added stars, nebulosity painting, longitude shift or flip. Runtime never loads the large EXR. All outputs are written fully to temporary files then atomically replaced.

Coordinates: source ICRF/J2000 geocentric RA/Dec plate-carrée, approximate EQJ. RA0 at image center, RA increases left, north at top. u=fract(.5-RAhours/24); image row v=.5-Dec/180. Texture.flipY=true sampler v=.5+Dec/180. RA12 is the horizontal wrap seam. The map must use the same direction/frame transform as the star catalog; it is not attached to the screen or Earth's geographic rotation.

Direction-anchor metadata: the three HIP star-region numeric coordinates are derived from HYG4.1 (CC-BY-SA4.0), with confirmed Chinese labels from Stellariumv24.4 (CC-BY-SA4.0). Those metadata components retain that attribution/share-alike license separately from the NASA image pixels. The complete HYG/STELLARIUM notices and CC-BY-SA4.0 text accompany this notice. Galactic-centre numeric reference is cited to NASA/CXC Chandra2010, and the independent SIMBAD records remain QA references.

Limits: static catalog-derived density visualization, not calibrated sky radiance, current airglow, weather, dust-emission photometry, or a recovered complete Milky Way luminosity map. NASA uses HIP stars brighter thanV8, TychoV8..11.5 and Gaia faint stars. Since runtime selectable stars mostly stop atV6.5, the integrated6.5..11.5 foreground contribution is largely absent. Catalog blends/variables and V/G passband differences also prevent promising absolutely zero residual overlap. No second full star map or invented stars were added to fill this gap. Light-pollution response and renderer intensity/saturation are qualitative display controls, not measured Bortle/SQM/flux calibration.
'''
    atomic_write(ROOT/'assets/licenses/NASA-MILKY-WAY-NOTICE.md',notice.encode('utf-8'))
    print(json.dumps({'outputs':outputs,'brightStarPreviewChecks':removal},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
