"""Pinned license lineage and NASA/ESA source acquisition (build-time only)."""
from data_acquire import DEST, ROOT, api, fetch
import concurrent.futures
import hashlib
import json
from datetime import datetime, timezone

def main():
    manifest_path = DEST / 'acquisition.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if 'stellarium244' not in manifest['revisions']:
        manifest['revisions']['stellarium244'] = api('Stellarium/stellarium', 'commits/v24.4')['sha']
    old_rev = manifest['revisions']['stellarium244']
    urls = {
        'stellarium244/modern/info.ini': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/modern/info.ini',
        'stellarium244/modern/constellationship.fab': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/modern/constellationship.fab',
        'stellarium244/chinese/info.ini': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/chinese/info.ini',
        'stellarium244/modern_chinese/info.ini': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/modern_chinese/info.ini',
        'stellarium244/modern/constellation_names.eng.fab': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/modern/constellation_names.eng.fab',
        'stellarium244/chinese/star_names.fab': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/chinese/star_names.fab',
        'stellarium244/chinese/constellation_names.eng.fab': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/skycultures/chinese/constellation_names.eng.fab',
        'stellarium244/po/stellarium-skycultures/zh_CN.po': f'https://raw.githubusercontent.com/Stellarium/stellarium/{old_rev}/po/stellarium-skycultures/zh_CN.po',
        'nasa/land_ocean_ice_2048.png': 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57730/land_ocean_ice_2048.png',
        'nasa/dnb_land_ocean_ice.2012.3600x1800.jpg': 'https://eoimages.gsfc.nasa.gov/images/imagerecords/79000/79765/dnb_land_ocean_ice.2012.3600x1800.jpg',
        'nasa/cloud_combined_2048.jpg': 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg',
        'nasa/earth-day-page.html': 'https://earthobservatory.nasa.gov/features/BlueMarble',
        'nasa/earth-night-page.html': 'https://earthobservatory.nasa.gov/images/79765/night-lights-2012-the-black-marble',
        'nasa/earth-day-2002-credits.html': 'https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/',
        'nasa/earth-night-2012-credits.html': 'https://science.nasa.gov/earth/earth-observatory/night-lights-2012-map-79765/',
        'nasa/media-usage.html': 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
        'esa/hipparcos-ReadMe.html': 'https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/I/239?format=html&tex=true',
        'creativecommons/CC-BY-SA-4.0.txt': 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt',
    }
    records = {r['id']: r for r in manifest['files']}
    def download(item):
        key, url = item
        target = DEST / key
        if target.exists() and key in records:
            assert hashlib.sha256(target.read_bytes()).hexdigest() == records[key]['sourceSha256']
            return records[key]
        target.parent.mkdir(parents=True, exist_ok=True)
        data = target.read_bytes() if target.exists() else fetch(url)
        if not target.exists(): target.write_bytes(data)
        print(f'{key}: {len(data):,} bytes', flush=True)
        return {'id': key, 'sourceUrl': url, 'revision': old_rev if key.startswith('stellarium244/') else
                ('EO57730-BlueMarble2002' if 'land_ocean_ice_2048' in key or 'day' in key else
                 'EO79765-BlackMarble2012' if '2012' in key or 'night' in key else 'snapshot'),
                'path': str(target.relative_to(ROOT)).replace('\\', '/'),
                'retrievedAt': datetime.fromtimestamp(target.stat().st_mtime, timezone.utc).isoformat(),
                'sourceSha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for r in pool.map(download, urls.items()):
            records[r['id']] = r
    manifest['files'] = sorted(records.values(), key=lambda x: x['id'])
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
