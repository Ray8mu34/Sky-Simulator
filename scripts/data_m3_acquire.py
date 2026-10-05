"""Acquire fixed Moon/generator inputs and HKO independent QA snapshots (not runtime).

Existing lock records are hash checked, never silently updated. For reproduction use
data_restore.py. Python stdlib only; native curl fallback is in data_acquire.fetch.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import base64
import json
import tarfile
from pathlib import Path
from data_acquire import ROOT, DEST, fetch
from data_build import atomic_write

VERSION='1.8.6'
GIT='a376ec2b8fd1b3069e24c92801bab8707fccd49d'
MOON='https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg'

def main():
    acquisition=json.loads((DEST/'acquisition.json').read_text(encoding='utf-8'))
    known={r['id']:r for r in acquisition['files']}
    specs=[
      ('nasa/lroc_color_poles_1k.jpg',MOON,'NASA CGI Moon Kit 2019; SVS4720; official 1K derivative'),
      ('nasa/cgi-moon-kit-4720.html','https://svs.gsfc.nasa.gov/4720/','page snapshot; selected 2019 map'),
      ('nasa/WAC_HAPKE_README.TXT','https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/MDR/WAC_HAPKE/WAC_HAPKE_README.TXT','LROC WAC Hapke normalized source documentation'),
      ('nasa/usgs-mare-crisium.html','https://planetarynames.wr.usgs.gov/Feature/3671','IAU/USGS nomenclature coordinate snapshot; orientation QA'),
      ('nasa/usgs-tycho.html','https://planetarynames.wr.usgs.gov/Feature/6163','IAU/USGS nomenclature coordinate snapshot; orientation QA'),
      ('lunar-typescript/lunar-typescript-1.8.6.tgz',f'https://registry.npmjs.org/lunar-typescript/-/lunar-typescript-{VERSION}.tgz',GIT),
      ('lunar-typescript/npm-1.8.6.json',f'https://registry.npmjs.org/lunar-typescript/{VERSION}',GIT),
      ('lunar-typescript/LICENSE',f'https://raw.githubusercontent.com/6tail/lunar-typescript/{GIT}/LICENSE',GIT),
      ('hko/conversion.html','https://www.hko.gov.hk/en/gts/time/conversion.htm','1901–2100 official comparison; future new-moon warning'),
      ('hko/conversion-text.html','https://www.hko.gov.hk/en/gts/time/conversion1_text.htm','official text table index'),
      ('hko/web-use-conditions.html','https://www.hko.gov.hk/tc/appweb/applink.htm','website reuse conditions snapshot'),
      ('hko/iprightsnotice.html','https://www.hko.gov.hk/en/publica/iprightsnotice.htm','publication rights/disclaimer snapshot'),
      ('hko/non-commercialuse.html','https://www.hko.gov.hk/en/publica/non-commercialuse.htm','noncommercial publication reuse conditions snapshot'),
      ('hko/2069e.pdf','https://www.hko.gov.hk/en/gts/time/calendar/pdf/files/2069e.pdf','official PDF supplement for missing TXT2069-12-30'),
    ]+[(f'hko/T{y}e.txt',f'https://www.hko.gov.hk/en/gts/time/calendar/text/files/T{y}e.txt',f'HKO Gregorian–Lunar {y} official text snapshot') for y in range(1901,2101)]
    def acquire(spec):
        key,url,revision=spec; target=DEST/key; target.parent.mkdir(parents=True,exist_ok=True)
        if key in known:
            r=known[key]
            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==r['sourceSha256']: return r
            data=fetch(url)
            if hashlib.sha256(data).hexdigest()!=r['sourceSha256']: raise ValueError(f'Fixed source changed: {key}')
        else:
            # The first direct Moon download can be retained after checking the exact expected size.
            data=target.read_bytes() if key=='nasa/lroc_color_poles_1k.jpg' and target.exists() and target.stat().st_size==139068 else fetch(url)
        atomic_write(target,data)
        return {'id':key,'sourceUrl':url,'revision':revision,'path':target.relative_to(ROOT).as_posix(),
          'retrievedAt':datetime.now(timezone.utc).isoformat(),'sourceSha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
    errors=[]; complete=0
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures={pool.submit(acquire,s):s[0] for s in specs}
        for future in as_completed(futures):
            try: r=future.result(); known[r['id']]=r; complete+=1
            except Exception as error: errors.append({'id':futures[future],'error':str(error)})
            if complete%25==0: print(f'{complete}/{len(specs)} M3 source snapshots ready',flush=True)
    acquisition['files']=sorted(known.values(),key=lambda r:r['id'])
    acquisition['revisions']['lunarTypescript']=GIT
    encoded=(json.dumps(acquisition,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    atomic_write(DEST/'acquisition.json',encoded); atomic_write(ROOT/'assets/source-lock.json',encoded)
    if errors: print(json.dumps(errors,indent=2)); raise SystemExit('Source acquisition failed; completed snapshots retained.')
    archive=DEST/f'lunar-typescript/lunar-typescript-{VERSION}.tgz'
    package_root=DEST/'lunar-typescript'
    with tarfile.open(archive,'r:gz') as package:
        for member in package.getmembers():
            target=(package_root/member.name).resolve()
            if not target.is_relative_to(package_root.resolve()) or member.issym() or member.islnk(): raise ValueError('Unsafe archive member')
        package.extractall(package_root,filter='data')
    metadata=json.loads((package_root/'npm-1.8.6.json').read_text(encoding='utf-8'))
    assert metadata['version']==VERSION and metadata['gitHead']==GIT and metadata['license']=='MIT'
    assert hashlib.sha1(archive.read_bytes()).hexdigest()==metadata['dist']['shasum']
    assert 'sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()==metadata['dist']['integrity']
    print(f'{complete} M3 snapshots hash locked; generator {VERSION} source package extracted.')

if __name__=='__main__': main()
