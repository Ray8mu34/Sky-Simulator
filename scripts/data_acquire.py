"""Acquire official upstream source files; record actual revisions, UTC time and SHA256.

Run with: conda run -n dl_env python scripts/data_acquire.py
No dependencies beyond Python's standard library. Outputs are build-time sources only.
"""
from __future__ import annotations
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request
import urllib.parse
import subprocess
import ssl
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets' / 'source'

def fetch(url: str) -> bytes:
    if urllib.parse.urlparse(url).hostname == 'svs.gsfc.nasa.gov':
        if urllib.parse.urlparse(url).path.endswith('.exr'):
            from data_ranges import fetch as fetch_ranges
            return fetch_ranges(url)
        # This official host is reachable directly on this machine; the configured
        # proxy stalls its TLS handshake. Per-request bypass leaves system settings intact.
        return subprocess.run(['curl.exe','--silent','--show-error','--location','--fail',
            '--noproxy','svs.gsfc.nasa.gov','--connect-timeout','15','--max-time','240',url],
            capture_output=True,check=True).stdout
    req = urllib.request.Request(url, headers={'User-Agent': 'sky-teaching-asset-builder/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError, ssl.SSLError):
        # Some official NASA hosts fail in Python TLS on native Windows while curl succeeds.
        # Keep certificate verification on; do not modify proxies or system configuration.
        result = subprocess.run(['curl.exe','--silent','--show-error','--location','--fail',
                                 '--connect-timeout','15','--max-time','60',url],capture_output=True,check=True)
        return result.stdout

def api(repo: str, path: str):
    return json.loads(fetch(f'https://api.github.com/repos/{repo}/{path}'))

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    repos = {'hyg': ('astronexus/HYG-Database', 'main'),
             'cultures': ('Stellarium/stellarium-skycultures', 'master'),
             'stellarium': ('Stellarium/stellarium', 'master')}
    existing = DEST / 'acquisition.json'
    if not existing.exists() and (ROOT / 'assets/source-lock.json').exists():
        existing = ROOT / 'assets/source-lock.json'
    prior = json.loads(existing.read_text(encoding='utf-8')) if existing.exists() else None
    records_by_id = {r['id']: r for r in prior['files']} if prior else {}
    revisions = prior['revisions'] if prior else {
        key: api(repo, f'commits/{branch}')['sha'] for key, (repo, branch) in repos.items()}
    items = []
    for key in ['hyg', 'cultures']:
        repo = repos[key][0]
        tree = api(repo, f'git/trees/{revisions[key]}?recursive=1')['tree']
        (DEST / f'{key}-tree.json').write_text(json.dumps(tree, indent=2), encoding='utf-8')
        if key == 'hyg':
            paths = [x['path'] for x in tree if x['path'] in ['LICENSE', 'hyg/README.md'] or
                     ('hygdata_v41' in x['path'] and 'CURRENT' in x['path']) or
                     x['path'].endswith('.py')]
        else:
            paths = [x['path'] for x in tree if x['path'] in ['LICENSE', 'README.md', 'western/index.json',
                    'western/description.md', 'chinese/index.json', 'chinese/description.md',
                    'western/po/zh_CN.po', 'chinese/po/zh_CN.po',
                    'chinese_contemporary/index.json', 'chinese_contemporary/description.md']]
        for path in paths:
            items.append((key, path, f'https://raw.githubusercontent.com/{repo}/{revisions[key]}/{path}'))
    items += [('stellarium', 'po/stellarium-skycultures/zh_CN.po',
              f'https://raw.githubusercontent.com/{repos["stellarium"][0]}/{revisions["stellarium"]}/po/stellarium-skycultures/zh_CN.po')]
    def download(item):
        key, upstream_path, url = item
        target = DEST / key / upstream_path
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and f'{key}/{upstream_path}' in records_by_id:
            record = records_by_id[f'{key}/{upstream_path}']
            assert hashlib.sha256(target.read_bytes()).hexdigest() == record['sourceSha256']
            return record
        data = fetch(url)
        target.write_bytes(data)
        print(f'{key}/{upstream_path}: {len(data):,} bytes', flush=True)
        return {'id': f'{key}/{upstream_path}', 'sourceUrl': url, 'revision': revisions[key],
                'path': str(target.relative_to(ROOT)).replace('\\', '/'),
                'retrievedAt': datetime.now(timezone.utc).isoformat(),
                'sourceSha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(download, items))
    records_by_id.update({r['id']:r for r in records})
    (DEST / 'acquisition.json').write_text(json.dumps({'revisions': revisions, 'files': sorted(records_by_id.values(),key=lambda r:r['id'])}, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
