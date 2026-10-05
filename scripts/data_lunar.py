"""Compact MIT-generated lunar month starts and independently audit every HKO civil day.

Run node scripts/data_lunar_generate.mjs first. HKO raw tables are QA-only, never
substituted into runtime data. Civil days and year bounds are always UTC+08:00.
"""
from __future__ import annotations
import base64
from bisect import bisect_right
from datetime import date, timedelta
import hashlib
import json
import re
import struct
from data_build import ROOT, SOURCE, OUT, atomic_write

EPOCH=date(1970,1,1)
START=date(1901,1,1); END=date(2101,1,1)
WARNED=['2057-09-28','2089-09-04','2097-08-07']

def save(path,value):
    atomic_write(path,(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))

def hko_rows():
    # First snapshot starts at lunar1900 month11 day11; its first heading is month12
    # on1901-01-20. Repeated numbered month headings unambiguously mark leap months
    # in HKO plain text (the PDF explicitly labels them as leap).
    lunar_year=1900; month=11; leap=False; previous_date=START-timedelta(days=1)
    row_pattern=re.compile(r'^(\d{4})/(\d{1,2})/(\d{1,2})\s+(.+?)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b')
    heading=re.compile(r'^(\d{1,2})(?:st|nd|rd|th)\s+Lunar\s+month$',re.I)
    for year in range(1901,2101):
        raw=(SOURCE/f'hko/T{year}e.txt').read_bytes()
        count=0
        for source_line,line in enumerate(raw.decode('cp1252',errors='replace').splitlines(),1):
            match=row_pattern.match(line)
            if not match: continue
            y,m,d=map(int,match.group(1,2,3)); civil=date(y,m,d)
            if civil==date(2069,12,31) and previous_date==date(2069,12,29):
                # The original official TXT really omits Dec30. Keep the omission
                # separate; PDF evidence is independently checked in the audit report.
                yield {'civilDate':'2069-12-30','civilDay':(date(2069,12,30)-EPOCH).days,
                    'year':lunar_year,'month':month,'day':17,'isLeapMonth':leap,
                    'sourceFile':'assets/source/hko/2069e.pdf','sourceLine':None,
                    'sourceLunarField':'17; missing from TXT; PDF comparison row'}
                count+=1; previous_date=date(2069,12,30)
            assert civil==previous_date+timedelta(days=1),f'HKO date gap: {civil}'
            previous_date=civil
            lunar_field=match.group(4).strip(); new_month=heading.match(lunar_field)
            if new_month:
                number=int(new_month.group(1)); leap=number==month
                if number==1 and not leap: lunar_year+=1
                month=number; day=1
            else: day=int(lunar_field)
            assert 1<=month<=12 and 1<=day<=30
            count+=1
            yield {'civilDate':civil.isoformat(),'civilDay':(civil-EPOCH).days,'year':lunar_year,
                'month':month,'day':day,'isLeapMonth':leap,
                'sourceFile':f'assets/source/hko/T{year}e.txt','sourceLine':source_line,'sourceLunarField':lunar_field}
        assert count==(date(year+1,1,1)-date(year,1,1)).days,(year,count)
    assert previous_date==END-timedelta(days=1)

def main():
    # An independent reviewer rendered the official PDF and checked the omitted
    # TXT date. Do not accept an inferred row without that actual source evidence.
    pdf_proof=json.loads((ROOT/'qa/m3-review/fixtures/hko-2069e.metadata.json').read_text(encoding='utf-8'))
    assert pdf_proof['verifiedRow']=={'lunarDay':17,'gregorianDate':'2069-12-30','isLeapMonth':False,'lunarMonth':11}
    assert hashlib.sha256((SOURCE/'hko/2069e.pdf').read_bytes()).hexdigest()==pdf_proof['sha256']
    generated=json.loads((SOURCE/'lunar-typescript/generated-months.json').read_text())['months']
    months=[m for m in generated if m['civilDay']<(END-EPOCH).days and m['civilDay']+m['monthLengthDays']>(START-EPOCH).days]
    # Include one exclusive terminal month start even if it lies in Gregorian2101.
    months.append(next(m for m in generated if m['civilDay']>=months[-1]['civilDay']+months[-1]['monthLengthDays']))
    assert len({m['civilDay'] for m in months})==len(months)
    for previous,current in zip(months,months[1:]): assert current['civilDay']-previous['civilDay']==previous['monthLengthDays']
    starts=[m['civilDay'] for m in months]
    binary=b''.join(struct.pack('<iHBB',m['civilDay'],m['year'],m['month']|(128 if m['isLeapMonth'] else 0),m['monthLengthDays']) for m in months)
    atomic_write(OUT/'lunar-months.bin',binary)
    atomic_write(OUT/'lunar-months.b64.txt',base64.b64encode(binary)+b'\n')
    mismatches=[]; checked=[]; by_year={}; total=0
    for hko in hko_rows():
        total+=1; month=months[bisect_right(starts,hko['civilDay'])-1]
        runtime={k:month[k] for k in ['year','month','isLeapMonth']}; runtime['day']=hko['civilDay']-month['civilDay']+1
        expected={k:hko[k] for k in ['year','month','day','isLeapMonth']}
        y=int(hko['civilDate'][:4]); stats=by_year.setdefault(y,{'checkedDays':0,'mismatchDays':0,'monthStartRows':0})
        stats['checkedDays']+=1
        if hko['day']==1: stats['monthStartRows']+=1; checked.append(hko)
        if runtime!=expected:
            stats['mismatchDays']+=1
            mismatches.append({**hko,'generator':runtime})
    assert total==(END-START).days
    # Save complete checked month-start rows and ALL failures, not selected successes.
    save(ROOT/'assets/lunar-hko-checked-rows.json',{'source':'HKO official yearly text files; QA only','monthStarts':checked,
       'boundaryRows':[next(hko_rows()),list(hko_rows())[-1]]})
    save(ROOT/'assets/lunar-hko-mismatches.json',{'generator':'lunar-typescript@1.8.6','checkedDays':total,'mismatches':mismatches})
    mismatch_ranges=[]
    for row in mismatches:
        if mismatch_ranges and row['civilDay']==mismatch_ranges[-1]['lastCivilDay']+1:
            mismatch_ranges[-1]['end']=row['civilDate']; mismatch_ranges[-1]['lastCivilDay']=row['civilDay']; mismatch_ranges[-1]['days']+=1
        else: mismatch_ranges.append({'start':row['civilDate'],'end':row['civilDate'],'days':1,'lastCivilDay':row['civilDay']})
    for span in mismatch_ranges: del span['lastCivilDay']
    uncertain_years=sorted({2057,2089,2097}|{int(row['civilDate'][:4]) for row in mismatches})
    metadata={'schemaVersion':1,'generator':'lunar-typescript@1.8.6','generatorRevision':'a376ec2b8fd1b3069e24c92801bab8707fccd49d',
      'calendarZone':'UTC+08:00','gregorianStartInclusive':START.isoformat(),'gregorianEndExclusive':END.isoformat(),
      'verifiedGregorianYears':[1901,2100],'months':len(months),'recordBytes':8,
      'recordLayout':'int32LE civilUnixDay, uint16LE lunarYear, uint8 month|leapBit128, uint8 length29or30',
      'hkoComparison':{'checkedDays':total,'matchingDays':total-len(mismatches),'mismatchDays':len(mismatches),'mismatchRanges':mismatch_ranges,
        'textTableMissingDates':['2069-12-30'],'pdfSupplementDates':['2069-12-30'],
        'pdfSupplementProof':'qa/m3-review/fixtures/hko-2069e.metadata.json','pdfSupplementSha256':pdf_proof['sha256'],
        'warnedNewMoonDates':WARNED,'uncertainGregorianYears':uncertain_years,
        'policy':'Runtime retains the fixed MIT generator convention. HKO tables are independent QA only; all mismatches retained. Flag every day of warned/differing Gregorian years as uncertain.'},
      'recordFirst':months[0],'recordLast':months[-1]}
    save(OUT/'lunar-meta.json',metadata)
    save(ROOT/'assets/lunar-audit-report.json',{**metadata,'yearlyChecks':by_year,'outputs':[{'path':f'assets/runtime/{name}',
        'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest(),'bytes':(OUT/name).stat().st_size} for name in ['lunar-months.bin','lunar-months.b64.txt','lunar-meta.json']]})
    print(f'{len(months)} months, {len(binary)} bytes; HKO {total} days checked, {len(mismatches)} differences; uncertain years {uncertain_years}')
    print(json.dumps(mismatch_ranges))

if __name__=='__main__': main()
