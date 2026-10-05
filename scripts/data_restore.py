"""Restore the exact pinned build-time inputs from source-lock.json, never latest HEAD.

Every downloaded byte sequence must match the lock's SHA256 before atomic publication.
Raw sources stay in assets/source and are never imported by the browser.
Run: conda run -n dl_env python scripts/data_restore.py
"""
from __future__ import annotations
import concurrent.futures
import hashlib
import json
from pathlib import Path
from data_acquire import ROOT, DEST, fetch

def main():
    lock=json.loads((ROOT/'assets/source-lock.json').read_text(encoding='utf-8'))
    DEST.mkdir(parents=True,exist_ok=True)
    def restore(record):
        target=(ROOT/record['path']).resolve()
        if not target.is_relative_to(DEST.resolve()): raise ValueError(f'Unexpected source destination: {target}')
        expected=record['sourceSha256']
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==expected: return 'cached'
        data=fetch(record['sourceUrl'])
        actual=hashlib.sha256(data).hexdigest()
        if actual!=expected:
            raise ValueError(f'Upstream snapshot hash mismatch: {record["id"]}; expected {expected}, got {actual}')
        target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name(target.name+'.download')
        temporary.write_bytes(data)
        temporary.replace(target)
        return 'restored'
    errors=[]; results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(restore,record):record for record in lock['files']}
        for future in concurrent.futures.as_completed(futures):
            try: results.append(future.result())
            except Exception as error: errors.append({'id':futures[future]['id'],'error':str(error)})
    if errors:
        print(json.dumps(errors,ensure_ascii=False,indent=2))
        raise SystemExit('Some fixed snapshots could not be restored; no hash mismatch was accepted.')
    (DEST/'acquisition.json').write_text(json.dumps(lock,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(results)} fixed snapshots verified: {results.count("cached")} cached, {results.count("restored")} downloaded.')

if __name__=='__main__': main()
