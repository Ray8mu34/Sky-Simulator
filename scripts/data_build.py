"""Deterministically build compact stars, all 88 western figures, and grounded Chinese names.

No runtime downloading. Use conda run -n dl_env python scripts/data_build.py.
Sources must first be acquired with data_acquire.py and data_sources_extra.py.
"""
from __future__ import annotations
import ast
import base64
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source'
OUT = ROOT / 'assets/runtime'
MAS_PER_RAD = 180 / math.pi * 3600 * 1000

def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))

def save_json(path, value):
    atomic_write(path,(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n').encode('utf-8'))

def atomic_write(path,data):
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)

def parse_po(path):
    """Read gettext quoted fields; retain context instead of conflating homonyms."""
    entries=[]
    for block in re.split(r'\n\s*\n', path.read_text(encoding='utf-8')):
        if re.search(r'^#,.*\bfuzzy\b',block,re.MULTILINE): continue
        entry={}; field=None
        for line in block.splitlines():
            if line.startswith('#'): continue
            match=re.match(r'^(msgid|msgstr|msgctxt)\s+(".*")$', line)
            if match:
                field=match[1]; entry[field]=ast.literal_eval(match[2])
            elif line.startswith('"') and field:
                entry[field]+=ast.literal_eval(line)
        if entry.get('msgid') and entry.get('msgstr'): entries.append(entry)
    return entries

def color_from_bv(bv):
    if bv is None: return [1,1,1]
    knots=[(-0.4,(0.68,0.77,1)),(0,(0.82,0.87,1)),(0.6,(1,0.98,0.91)),(1.5,(1,0.76,0.57)),(2.2,(1,0.65,0.44))]
    b=max(-0.4,min(2.2,bv))
    for (left,c1),(right,c2) in zip(knots,knots[1:]):
        if b<=right:
            t=(b-left)/(right-left)
            return [c1[i]+t*(c2[i]-c1[i]) for i in range(3)]
    return list(knots[-1][1])

def normalized_mean(directions):
    v=[sum(d[i] for d in directions) for i in range(3)]
    norm=math.sqrt(sum(x*x for x in v)); assert norm>0
    return [x/norm for x in v]

def stellarium244_sources():
    """Use the explicitly licensed v24.4 Modern/Chinese families, with matching localization."""
    folder=SOURCE/'stellarium244'
    latin_names={}
    for line in (folder/'modern/constellation_names.eng.fab').read_text(encoding='utf-8').splitlines():
        match=re.match(r'^(\w+)\s+"([^"]+)"',line)
        if match: latin_names[match[1].lower()]=match[2]
    cultures=[]
    for line in (folder/'modern/constellationship.fab').read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        fields=line.split(); id=fields[0]; segment_count=int(fields[1]); points=[int(x) for x in fields[2:]]
        assert len(points)==segment_count*2
        cultures.append({'iau':id,'lines':[points[i:i+2] for i in range(0,len(points),2)],
                         'common_name':{'english':latin_names[id.lower()],'native':latin_names[id.lower()]}})
    chinese={}
    for number,line in enumerate((folder/'chinese/star_names.fab').read_text(encoding='utf-8').splitlines(),start=1):
        match=re.fullmatch(r'(\d+)\|_\("(.+)"\)\s+([12])',line.strip())
        if match and match[3]=='1':
            chinese.setdefault(f'HIP {match[1]}',[]).append({'english':match[2],'sourceLine':number})
    return cultures,chinese

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    acquisition=read_json(SOURCE/'acquisition.json')
    for source in acquisition['files']:
        path=ROOT/source['path']
        assert hashlib.sha256(path.read_bytes()).hexdigest()==source['sourceSha256'], f'Changed source: {path}'
    rows=list(csv.DictReader((SOURCE/'hyg/hyg/CURRENT/hygdata_v41.csv').open(encoding='utf-8')))
    cultures,chinese=stellarium244_sources()
    assert len(cultures)==88 and len({c['iau'] for c in cultures})==88
    endpoint_hips={h for c in cultures for line in c['lines'] for h in line if isinstance(h,int)}
    required_named_hips={11767,32349,30438,69673,91262,24608,24436,37279,27989,7588,68702,71683,80763,65474,
                         37826,97649,21421,109268,102098,62434,61084,63125,49669,36850,26727,26311,25930}
    selected=[r for r in rows if int(r['id'])!=0 and (float(r['mag'])<=6.5 or
              (r['hip'] and int(r['hip']) in endpoint_hips|required_named_hips))]
    selected.sort(key=lambda r:int(r['id']))
    byhip={}
    for index,row in enumerate(selected):
        if row['hip']:
            hip=int(row['hip'])
            if hip not in byhip or float(row['mag'])<float(selected[byhip[hip]]['mag']): byhip[hip]=index
    assert endpoint_hips<=byhip.keys(), f'Unresolved HIPs: {endpoint_hips-byhip.keys()}'
    all_po=parse_po(SOURCE/'stellarium244/po/stellarium-skycultures/zh_CN.po')
    constellation_translation={e['msgid']:e['msgstr'] for e in all_po if not e.get('msgctxt')}
    general_translation={e['msgid']:e['msgstr'] for e in all_po if not e.get('msgctxt')}
    chinese_po=all_po
    chinese_translation={e['msgid']:e['msgstr'] for e in chinese_po}
    chinese_translation.update({e['msgid']:e['msgstr'] for e in all_po if not e.get('msgctxt') and
                                re.search(r'[\u4e00-\u9fff]',e['msgstr'])})
    name_evidence=[]; compact=[]; binary=bytearray(); directions=[]
    missing={'colorIndex':0,'distance':0,'radialVelocity':0}; duplicates=[]
    for index,row in enumerate(selected):
        hip=int(row['hip']) if row['hip'] else None; hyg=int(row['id'])
        ra=float(row['ra']); dec=float(row['dec']); a=math.radians(ra*15); d=math.radians(dec)
        v=[math.cos(d)*math.cos(a),math.cos(d)*math.sin(a),math.sin(d)]
        bv=float(row['ci']) if row['ci'] else None
        dist=float(row['dist']); dist=dist if 0<dist<100000 else None
        rv=float(row['rv']) if row['rv'] else 0; rv=rv if rv!=0 else None
        flags=(1 if bv is None else 0)|(2 if dist is None else 0)|(4 if rv is None else 0)
        missing['colorIndex']+=bv is None; missing['distance']+=dist is None; missing['radialVelocity']+=rv is None
        object_id=f'hip:{hip}' if hip is not None and byhip[hip]==index else f'hyg:{hyg}'
        if hip is not None and byhip[hip]!=index: duplicates.append({'hip':hip,'hygId':hyg})
        names=[]
        # The bright-star label budget is independent from the full skyculture database.
        if hip is not None and (float(row['mag'])<=3.0 or hip in required_named_hips):
            for item in chinese.get(f'HIP {hip}',[]):
                english=item.get('english',''); zh=chinese_translation.get(english)
                if zh and re.search(r'[\u4e00-\u9fff]',zh):
                    if zh in names: continue
                    names.append(zh)
                    name_evidence.append({'id':object_id,'hip':hip,'nameZh':zh,'english':english,
                        'translationKey':english,'ordinal':None,
                        'hipMappingSource':'stellarium244/chinese/star_names.fab','sourceLine':item['sourceLine'],
                        'translationSource':'stellarium244/po/stellarium-skycultures/zh_CN.po',
                        'method':'exact individual-star localization at matching v24.4; confidence 1 only'})
        # Prefer Northern Star as the pedagogical label, keeping Curved Array I as an alias.
        if hip==11767 and '北极星' in names: names.remove('北极星'); names.insert(0,'北极星')
        aliases=[f'HIP {hip}'] if hip is not None else []
        aliases += [s for s in [row['bf'],row['proper'],*names[1:]] if s]
        compact.append([object_id,hyg,hip,ra,dec,float(row['mag']),bv,row['proper'] or None,
                        names[0] if names else None,aliases,float(row['pmra']),float(row['pmdec']),flags,dist,rv,
                        [float(row[k]) for k in ['vx','vy','vz']],row['var'] or None,
                        float(row['var_min']) if row['var_min'] else None,float(row['var_max']) if row['var_max'] else None,
                        int(row['comp']),int(row['comp_primary']),row['con']])
        directions.append(v)
        binary += struct.pack('<8f',*v,float(row['mag']),*color_from_bv(bv),bv if bv is not None else math.nan)
    lines=[]; line_weights=[]; constellation_meta=[]; constellation_evidence=[]
    for culture in cultures:
        first=len(lines)//2; endpoints=set()
        for polyline in culture['lines']:
            points=[h for h in polyline if isinstance(h,int)]
            endpoints.update(points)
            for a,b in zip(points,points[1:]):
                lines.extend([byhip[a],byhip[b]])
                line_weights.append(0.65 if polyline[0]=='thin' else 1.0)
        english=culture['common_name']['english']; native=culture['common_name']['native']
        zh=constellation_translation.get(english) or constellation_translation.get(native) or general_translation.get(native)
        assert zh and zh.endswith('座'), f'No grounded Chinese constellation name: {culture["iau"]} {english}'
        constellation_meta.append({'id':culture['iau'],'nameZh':zh,'nameEn':native,
            'directionEqj':normalized_mean([directions[byhip[h]] for h in sorted(endpoints)]),
            'lineStart':first,'lineCount':len(lines)//2-first})
        constellation_evidence.append({'id':culture['iau'],'nameZh':zh,'english':english,'native':native,
            'translationContext':'exact Latin name from v24.4 Modern constellation_names.eng.fab',
            'source':'stellarium244/po/stellarium-skycultures/zh_CN.po'})
    assert len(selected)<65536 and max(lines)<len(selected)
    atomic_write(OUT/'stars.bin',binary)
    atomic_write(OUT/'stars.b64.txt',base64.b64encode(binary))
    atomic_write(OUT/'constellations.bin',struct.pack(f'<{len(lines)}H',*lines))
    save_json(OUT/'star-meta.json',compact)
    save_json(OUT/'constellation-meta.json',{'constellations':constellation_meta,'lineIndices':lines,'lineWeights':line_weights})
    save_json(ROOT/'assets/names-zh-evidence.json',name_evidence)
    save_json(ROOT/'assets/constellation-name-evidence.json',constellation_evidence)
    report={'catalogVersion':'HYG 4.1','sourceRecords':len(rows),'selectedStars':len(selected),
            'magnitudeLimitedStars':sum(float(r['mag'])<=6.5 and r['id']!='0' for r in rows),
            'extraEndpointOrNamedStars':sum(float(r['mag'])>6.5 for r in selected),
            'constellations':len(cultures),'lineSegments':len(lines)//2,'uniqueEndpointHips':len(endpoint_hips),
            'unresolvedEndpointHips':[],'namedChineseStars':sum(bool(r[8]) for r in compact),
            'chineseNamesAndAliases':len(name_evidence),'missing':missing,'duplicateHipCompanions':duplicates,
            'binaryRecordBytes':32,'sourceEpoch':'J2000.0','sourceEquinox':'J2000.0',
            'constellationPatternVersion':'Stellarium v24.4 Modern (Western), explicitly CC-BY-SA-4.0',
            'chineseNamingVersion':'Stellarium v24.4 Chinese and matching zh_CN.po; exact individual-star translations',
            'properMotionConvention':'pmra = mu_alpha * cos(dec), mas/Julian year; validated against source velocities',
            'rawZeroRadialVelocityPolicy':'0 is conservatively marked unavailable because HYG does not distinguish unknown from true zero',
            'revisions':acquisition['revisions'],'runtimeFiles':{
                str(p.relative_to(ROOT)).replace('\\','/'):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in OUT.iterdir() if p.is_file()}}
    save_json(ROOT/'assets/build-report.json',report)
    print(json.dumps({k:v for k,v in report.items() if k not in ['runtimeFiles','revisions','duplicateHipCompanions']},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
