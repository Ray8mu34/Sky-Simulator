"""Resumable official SVS range downloads; certificates remain verified, max8 sockets.

The final upstream bytes are returned unchanged. Every chunk must have the expected
Content-Range; If-Range prevents assembling different server revisions. The caller
verifies/fixes the SHA256 before publishing. This is offline acquisition only.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def curl(*args):
    return subprocess.run(['curl.exe','--silent','--show-error','--location','--fail',
       '--noproxy','svs.gsfc.nasa.gov','--connect-timeout','15',*args],capture_output=True,check=True)

def fetch(url):
    headers=curl('--head','--max-time','30',url).stdout.decode('latin1')
    total=int(re.findall(r'^Content-Length:\s*(\d+)',headers,re.M|re.I)[-1])
    etag=re.findall(r'^ETag:\s*(.+?)\s*$',headers,re.M|re.I)[-1]
    assert re.search(r'^Accept-Ranges:\s*bytes',headers,re.M|re.I)
    key=hashlib.sha256((url+'\n'+etag+'\n'+str(total)).encode()).hexdigest()[:24]
    directory=ROOT/'assets/source/.download-parts'/key; directory.mkdir(parents=True,exist_ok=True)
    block=1024*1024; ranges=[(start,min(start+block-1,total-1)) for start in range(0,total,block)]
    def part(bounds):
        start,end=bounds; target=directory/f'{start:010}.part'; proof=target.with_suffix('.json')
        expected=end-start+1
        if target.exists() and proof.exists():
            record=json.loads(proof.read_text())
            if target.stat().st_size==expected and hashlib.sha256(target.read_bytes()).hexdigest()==record['sha256']: return target
        temporary=target.with_name(target.name+'.tmp'); header=target.with_suffix('.headers')
        for attempt in range(3):
            try:
                curl('--max-time','130','--range',f'{start}-{end}','--header',f'If-Range: {etag}',
                    '--dump-header',str(header),'--output',str(temporary),url)
                actual_headers=header.read_text(encoding='latin1')
                assert re.search(rf'^Content-Range:\s*bytes {start}-{end}/{total}\s*$',actual_headers,re.M|re.I),actual_headers
                assert temporary.stat().st_size==expected
                digest=hashlib.sha256(temporary.read_bytes()).hexdigest()
                temporary.replace(target)
                proof.write_text(json.dumps({'sourceUrl':url,'etag':etag,'start':start,'end':end,'total':total,'sha256':digest}))
                return target
            except (subprocess.CalledProcessError,AssertionError):
                if attempt==2: raise
        raise AssertionError('Unreachable')
    completed=0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures={pool.submit(part,bounds):bounds for bounds in ranges}
        for future in as_completed(futures):
            future.result(); completed+=1
            print(f'Official SVS ranges: {completed}/{len(ranges)} complete',flush=True)
    data=b''.join((directory/f'{start:010}.part').read_bytes() for start,end in ranges)
    assert len(data)==total
    return data
