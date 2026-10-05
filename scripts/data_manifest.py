"""Build the audit manifest from actual downloaded files and generated outputs."""
from pathlib import Path
import hashlib
import json
import shutil
import sys
import PIL
from data_build import ROOT, SOURCE, OUT, atomic_write

def main():
    acquisition=json.loads((SOURCE/'acquisition.json').read_text(encoding='utf-8'))
    records={r['id']:r for r in acquisition['files']}
    revisions=acquisition['revisions']
    report=json.loads((ROOT/'assets/build-report.json').read_text(encoding='utf-8'))
    textures=json.loads((ROOT/'assets/texture-report.json').read_text(encoding='utf-8'))
    lock=ROOT/'assets/source-lock.json'
    atomic_write(lock,(json.dumps(acquisition,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    def sources(ids): return [{key:value for key,value in records[source_id].items() if key!='bytes'} for source_id in ids]
    def outputs(names): return [{'path':'assets/runtime/'+name,'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest(),
                                'bytes':(OUT/name).stat().st_size} for name in names]
    assets=[{
        'id':'bright-stars','source':'https://github.com/astronexus/HYG-Database',
        'revision':revisions['hyg'],'license':'CC-BY-SA-4.0','licenseUrl':'https://creativecommons.org/licenses/by-sa/4.0/',
        'credit':'David Nash / Astronexus HYG 4.1; Hipparcos, Yale Bright Star and Gliese catalogs',
        'sourceFiles':sources(['hyg/hyg/CURRENT/hygdata_v41.csv','hyg/hyg/README.md','hyg/LICENSE']),
        'outputs':outputs(['stars.bin','stars.b64.txt','star-meta.json']),
        'coordinateFrame':'right-handed J2000 equatorial (ICRS approximation), X=RA0h Y=RA6h Z=north',
        'epoch':'J2000.0','equinox':'J2000.0','units':{'ra':'hours','dec':'degrees','magnitude':'V mag','pmra':'mu_alpha*cos(dec), mas/year',
                 'pmdec':'mas/year','dist':'parsec; invalid >=100000 excluded','velocity':'parsec/year','rv':'km/s'},
        'selection':'mag<=6.5 plus all western figure endpoints and required pedagogical named stars; exclude Sun',
        'count':report['selectedStars'],'processing':'32-byte little-endian GPU records; double precision RA/Dec/PM and source quality retained in compact metadata; color mapping is restrained display approximation',
        'processingCommand':'conda run -n dl_env python scripts/data_build.py',
    },{
        'id':'western-constellations','source':'https://github.com/Stellarium/stellarium/tree/v24.4/skycultures/modern',
        'revision':revisions['stellarium244'],'license':'CC-BY-SA-4.0',
        'licenseUrl':'https://creativecommons.org/licenses/by-sa/4.0/',
        'licenseEvidence':'Selected v24.4 modern/info.ini explicitly lists CC BY-SA 4.0. Newer version-omitting Western sources are development reference only and not selected for distribution.',
        'credit':"Stellarium's team; Chinese labels: Stellarium zh_CN translation team",
        'sourceFiles':sources(['stellarium244/modern/info.ini','stellarium244/modern/constellationship.fab',
                             'stellarium244/modern/constellation_names.eng.fab','stellarium244/po/stellarium-skycultures/zh_CN.po']),
        'outputs':outputs(['constellations.bin','constellation-meta.json']),
        'coordinateFrame':'J2000 through HIP star endpoints; mean endpoint direction is a label anchor, not an IAU boundary centre',
        'epoch':'J2000.0','units':'Uint16 star indexes; lineStart and lineCount are segment units',
        'constellations':report['constellations'],'segments':report['lineSegments'],'uniqueEndpoints':report['uniqueEndpointHips'],'missingEndpoints':0,
        'processing':'Flatten the complete v24.4 Modern segment list; resolve all HIP endpoints; exact Latin constellation name localized with matching zh_CN.po. No artwork or boundaries included.',
        'processingCommand':'conda run -n dl_env python scripts/data_build.py',
    },{
        'id':'chinese-star-aliases','source':'https://github.com/Stellarium/stellarium/tree/v24.4/skycultures/chinese',
        'revision':revisions['stellarium244'],'localizationRevision':revisions['stellarium244'],
        'license':'CC-BY-SA-4.0',
        'licenseUrl':'https://creativecommons.org/licenses/by-sa/4.0/',
        'credit':"Karrie Berglund / Digitalis Education Solutions, Hong Kong Space Museum star-map basis; Sun Shuwei; Yi Shitong star-chart basis; Stellarium team and zh_CN translators",
        'sourceFiles':sources(['stellarium244/chinese/star_names.fab','stellarium244/chinese/info.ini',
                             'stellarium244/po/stellarium-skycultures/zh_CN.po']),
        'outputs':outputs(['star-meta.json']),
        'evidenceFile':'assets/names-zh-evidence.json','constellationLabelEvidenceFile':'assets/constellation-name-evidence.json',
        'namedStars':176,'namesAndAliases':198,'coordinateFrame':'stable HIP identifiers','epoch':None,
        'units':'text','processing':'Only confirmed confidence-1 individual HIP star names; exact full English-to-Chinese lookup from matching v24.4 zh_CN.po. Skip uncertain confidence-2 mappings and untranslated strings; no Roman-name inference.',
        'processingCommand':'conda run -n dl_env python scripts/data_build.py',
    }]
    texture_specs=[('earth-day','land_ocean_ice_2048.png',['earth-day-2k.webp','earth-day-1k.webp'],
        'https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/',
        'Blue Marble 2002 (land observations June–September 2001)',
        'NASA Goddard Space Flight Center / NASA Earth Observatory; Reto Stöckli (land surface, shallow water), Robert Simmon (ocean color, compositing); MODIS teams; USGS/NOAA supporting data',
        'RGB conversion, WebP quality87 2K, Lanczos downsample+quality85 1K; no geography/longitude change',
        'sRGB'),
        ('earth-night','dnb_land_ocean_ice.2012.3600x1800.jpg',['earth-night-1k.webp'],
        'https://science.nasa.gov/earth/earth-observatory/night-lights-2012-map-79765/',
        'Night Lights 2012 Map, published2012-11-27; observations2012-04-18 to2012-10-23',
        'NASA Earth Observatory / Robert Simmon; Suomi NPP VIIRS data courtesy Chris Elvidge, NOAA National Geophysical Data Center',
        'Lanczos downsample1K; subtract0.72*blue +0.015 and multiply1.8 to suppress blue backdrop and retain measured light locations; display emission texture, not quantitative radiance. Composite also contains gas flares/wildfires and is not a current city census.',
        'sRGB'),
        ('earth-clouds','cloud_combined_2048.jpg',['earth-clouds-1k.webp'],
        'https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/',
        'Blue Marble 2002 static cloud composite, EO57747; two visible days and a thermal day for poles',
        'NASA Goddard Space Flight Center / NASA Earth Observatory; Reto Stöckli (clouds), Robert Simmon (compositing); MODIS Atmosphere Group',
        'ConvertL; Lanczos downsample1K; replicate gray toRGB.r; losslessWebP; shader uses linear cloud-opacity mask; not current weather',
        'NoColorSpace linear mask')]
    for asset_id,filename,names,page,revision,credit,processing,color_space in texture_specs:
        assets.append({'id':asset_id,'source':page,'revision':revision,
            'license':'NASA Images and Media Usage Guidelines; US Government imagery generally not subject to US copyright; educational/informational use with acknowledgment, no endorsement',
            'licenseUrl':'https://www.nasa.gov/nasa-brand-center/images-and-media/','credit':credit,
            'sourceFiles':sources(['nasa/'+filename,'nasa/media-usage.html']),
            'outputs':[{**output,'dimensions':textures['files'][output['path']]['dimensions']} for output in outputs(names)],
            'coordinateFrame':textures['coordinateFrame'],'epoch':'static source composite; unrelated to simulated date',
            'units':'8bit color' if asset_id!='earth-clouds' else '8bit grayscale opacity mask',
            'colorSpace':color_space,'processing':processing,
            'processingCommand':'conda run -n dl_env python scripts/data_textures.py'})
    moon_path=ROOT/'assets/moon-report.json'
    if moon_path.exists():
        moon=json.loads(moon_path.read_text(encoding='utf-8'))
        assets.append({**moon,'license':'NASA Images and Media Usage Guidelines; US Government imagery generally not subject to US copyright; educational/informational use with acknowledgment, no endorsement',
          'licenseUrl':'https://www.nasa.gov/nasa-brand-center/images-and-media/',
          'credit':"NASA Scientific Visualization Studio / Ernie Wright (USRA); Noah Petro (NASA/GSFC); LROC WAC camera team (Arizona State University), LOLA team",
          'sourceFiles':sources(['nasa/lroc_color_poles_1k.jpg','nasa/cgi-moon-kit-4720.html','nasa/WAC_HAPKE_README.TXT','nasa/usgs-mare-crisium.html','nasa/usgs-tycho.html','nasa/media-usage.html'])})
    lunar_path=ROOT/'assets/lunar-audit-report.json'
    if lunar_path.exists():
        lunar=json.loads(lunar_path.read_text(encoding='utf-8'))
        assets.append({'id':'lunar-calendar','source':'https://github.com/6tail/lunar-typescript',
          'revision':lunar['generatorRevision'],'generator':lunar['generator'],'license':'MIT',
          'licenseUrl':f'https://github.com/6tail/lunar-typescript/blob/{lunar["generatorRevision"]}/LICENSE',
          'credit':'6tail; lunar-typescript1.8.6. Independent QA comparison: Hong Kong Observatory, HKSAR Government.',
          'sourceFiles':sources(['lunar-typescript/lunar-typescript-1.8.6.tgz','lunar-typescript/npm-1.8.6.json','lunar-typescript/LICENSE']),
          'outputs':outputs(['lunar-months.bin','lunar-months.b64.txt','lunar-meta.json']),
          'units':'UTC+08 civil Unix day / lunar year, month, leap flag, day count',
          'supportedGregorianYears':[1901,2100],'months':lunar['months'],'recordBytes':8,
          'hkoComparison':lunar['hkoComparison'],
          'qaSources':{'files':200,'pdfSupplement':'2069e.pdf','sourceLockPrefix':'hko/',
            'rights':'HKO yearly TXT/PDF and extracted checked rows are independent QA materials with HKSAR rights; excluded from runtime releases; not CC0 or MIT.',
            'conditions':'assets/licenses/HKO-QA-NOTICE.md'},
          'processing':'Fixed MIT generator only, compact month starts including Gregorian boundary coverage and exclusive terminal sentinel. All HKO mismatches retained; no HKO data substituted into runtime.',
          'processingCommand':'node scripts/data_lunar_generate.mjs; conda run -n dl_env python scripts/data_lunar.py'})
    galaxy_path=ROOT/'assets/milky-way-report.json'
    if galaxy_path.exists():
        galaxy=json.loads(galaxy_path.read_text(encoding='utf-8'))
        assets.append({**galaxy,'license':'NASA Images and Media Usage Guidelines; source acknowledgment including ESA/Gaia/DPAC; no endorsement',
          'licenseUrl':'https://www.nasa.gov/nasa-brand-center/images-and-media/',
          'credit':'NASA/Goddard Space Flight Center Scientific Visualization Studio; Ernie Wright (USRA); GaiaDR2: ESA/Gaia/DPAC; supporting faint UCAC3 data',
          'directionAnchorMetadataLicense':'The three HIP star-region coordinates are derived from HYG4.1 (CC-BY-SA4.0), with confirmed Chinese labels from Stellariumv24.4 (CC-BY-SA4.0); these metadata terms are separate from the NASA image. Corresponding HYG/STELLARIUM notices and CC-BY-SA4.0 text are included.',
          'sourceFiles':sources(['nasa/milkyway_2020_4k.exr','nasa/deep-star-maps-4851.html','nasa/milkyway_2020_4k_print.jpg',
            'nasa/hiptyc_2020_4k_print.jpg','nasa/starmap_2020_4k_print.jpg','nasa/chandra-sgra-j2000.html','nasa/gaia-dr2-credit.html','nasa/media-usage.html']),
          'outputFiles':'2K or1K selected by renderer; exactly one texture resolution resident at a time',
          'independentDirectionReference':'qa/m3b-review/fixtures/coordinate-directions.json (CDS/SIMBAD J2000 external numeric references)'})
    manifest={'schemaVersion':1,'status':'actual files acquired and processed; selected HYG and Stellarium data licenses explicitly versioned; official NASA media conditions recorded; fixed MIT lunar generator with complete independent HKO audit and retained differences; NASA2020 celestial background-only Milky Way with fixed tone map',
              'buildTools':{'python':sys.version.split()[0]+' (dl_env)','Pillow':PIL.__version__,'numpy':__import__('numpy').__version__},
              'sourceLock':'assets/source-lock.json','runtimeAssetsAreStaticImports':True,'runtimeExternalDownloads':False,
              'excluded':'assets/source/** including raw EXR/source previews/download ranges, raw CSV, source JPEG/PNG/TIF, generator source package, HKO raw TXT/PDF and extracted checked rows, repo trees, upstream PO source, reference screenshots, illustrations',
              'assets':assets}
    atomic_write(ROOT/'assets/assets-manifest.json',(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    licenses=ROOT/'assets/licenses'; licenses.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(SOURCE/'creativecommons/CC-BY-SA-4.0.txt',licenses/'CC-BY-SA-4.0.txt')
    print(f'{len(assets)} assets; {len(acquisition["files"])} pinned source snapshots; actual output SHA256 recorded')

if __name__=='__main__': main()
