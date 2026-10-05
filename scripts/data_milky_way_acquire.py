"""Acquire NASA2020 celestial background-only map, with actual locked source bytes."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from data_acquire import ROOT, DEST, fetch
from data_build import atomic_write

BASE='https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/'
FILES=[
  ('deep-star-maps-4851.html','https://svs.gsfc.nasa.gov/4851/'),
  ('milkyway_2020_4k.exr',BASE+'milkyway_2020_4k.exr'),
  ('milkyway_2020_4k_print.jpg',BASE+'milkyway_2020_4k_print.jpg'),
  ('hiptyc_2020_4k_print.jpg',BASE+'hiptyc_2020_4k_print.jpg'),
  ('starmap_2020_4k_print.jpg',BASE+'starmap_2020_4k_print.jpg'),
  ('chandra-sgra-j2000.html','https://www.chandra.harvard.edu/photo/2010/sgra/index.html'),
  ('gaia-dr2-credit.html','https://gea.esac.esa.int/archive/documentation/GDR2/Miscellaneous/sec_credit_and_citation_instructions/'),
]

def main():
    acquisition=json.loads((DEST/'acquisition.json').read_text(encoding='utf-8'))
    known={record['id']:record for record in acquisition['files']}
    def acquire(spec):
        filename,url=spec; key='nasa/'+filename; target=DEST/key
        if key in known and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==known[key]['sourceSha256']: return known[key]
        data=fetch(url); digest=hashlib.sha256(data).hexdigest()
        if key in known and digest!=known[key]['sourceSha256']: raise ValueError(f'Upstream fixed snapshot changed: {key}')
        atomic_write(target,data)
        return {'id':key,'sourceUrl':url,'revision':'Deep Star Maps2020 celestial; official page/file snapshot, no galactic2021 layer',
          'path':target.relative_to(ROOT).as_posix(),'retrievedAt':datetime.now(timezone.utc).isoformat(),'sourceSha256':digest,'bytes':len(data)}
    errors=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(acquire,item):item[0] for item in FILES}
        for future in as_completed(futures):
            try: record=future.result(); known[record['id']]=record; print(f'Locked {record["id"]}: {record["bytes"]:,} bytes',flush=True)
            except Exception as error: errors.append({'id':futures[future],'error':str(error)})
    acquisition['files']=sorted(known.values(),key=lambda record:record['id'])
    data=(json.dumps(acquisition,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    atomic_write(DEST/'acquisition.json',data); atomic_write(ROOT/'assets/source-lock.json',data)
    if errors: print(json.dumps(errors,indent=2)); raise SystemExit('Acquisition incomplete; successful fixed snapshots retained.')
    print('NASA celestial Milky Way source acquired; raw EXR stays outside runtime.')

if __name__=='__main__': main()
