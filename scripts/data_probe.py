"""Inspect actual HYG conventions and source completeness before generation."""
import csv
import json
import math
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
rows = list(csv.DictReader((ROOT/'assets/source/hyg/hyg/CURRENT/hygdata_v41.csv').open(encoding='utf-8')))
western = json.loads((ROOT/'assets/source/cultures/western/index.json').read_text(encoding='utf-8'))
hips = {int(r['hip']):r for r in rows if r['hip']}
endpoints = {h for c in western['constellations'] for line in c['lines'] for h in line if isinstance(h,int)}
print('HYG rows',len(rows),'stars <=6.5 excluding Sun',sum(float(r['mag'])<=6.5 and r['id']!='0' for r in rows))
print('Constellations',len(western['constellations']),'segments',sum(len([h for h in line if isinstance(h,int)])-1 for c in western['constellations'] for line in c['lines']),
      'unique endpoints',len(endpoints),'unresolved', sorted(endpoints-set(hips)))
legacy_path=ROOT/'assets/source/stellarium244/modern/constellationship.fab'
if legacy_path.exists():
    legacy={}; current={}
    for text in legacy_path.read_text(encoding='utf-8').splitlines():
        if not text.strip() or text.lstrip().startswith('#'): continue
        fields=text.split(); points=[int(x) for x in fields[2:]]
        legacy[fields[0].lower()]={tuple(points[i:i+2]) for i in range(0,len(points),2)}
    for c in western['constellations']:
        lines=[[h for h in line if isinstance(h,int)] for line in c['lines']]
        current[c['iau']]={(a,b) for line in lines for a,b in zip(line,line[1:])}
    changed=[key for key in current if {tuple(sorted(x)) for x in current[key]}!={tuple(sorted(x)) for x in legacy[key.lower()]}]
    print('Explicitly CC-BY-SA4.0 v24.4 Modern figure lineage:',len(legacy),'figures',sum(len(lines) for lines in legacy.values()),
          'segments; current changed figures:',changed)
mas = 180/math.pi*3600*1000
for hip in [87937,11767,32349,91262]:
    r=hips[hip]; a=float(r['rarad']); d=float(r['decrad']); distance=float(r['dist'])
    projected=(-math.sin(a)*float(r['vx'])+math.cos(a)*float(r['vy']))/distance*mas
    print('HIP',hip,'dec',r['dec'],'pmra',r['pmra'],'pmrarad*mas',float(r['pmrarad'])*mas,
          'from Cartesian east projection',projected,'if pmra were dRA/dt:',float(r['pmra'])*math.cos(d))
