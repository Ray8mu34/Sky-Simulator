"""Append HYG 4.1 stars through V=10 without changing the base catalog.

Uses only Python's standard library. Run with:
    conda run -n dl_env python scripts/build-extended-stars.py
"""
from __future__ import annotations

import base64
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source/hyg/hyg/CURRENT/hygdata_v41.csv'
SOURCE_SHA256 = 'd9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd'
OUT = ROOT / 'assets/runtime'
LIMIT = 10.0
RECORD = struct.Struct('<Ii8f')


def save_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8', newline='\n')


def optional_float(value: str) -> float | None:
    return float(value) if value else None


def main() -> None:
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == SOURCE_SHA256, 'HYG source differs from the pinned version'
    base_path = OUT / 'star-meta.json'
    base_bytes = base_path.read_bytes()
    base = json.loads(base_bytes)
    base_ids = {record[0] for record in base}
    base_hyg_ids = {record[1] for record in base}
    assert len(base_ids) == len(base_hyg_ids) == len(base) == 8921
    with SOURCE.open(encoding='utf-8', newline='') as stream:
        rows = [row for row in csv.DictReader(stream)
                if int(row['id']) > 0 and int(row['id']) not in base_hyg_ids and float(row['mag']) <= LIMIT]
    rows.sort(key=lambda row: int(row['id']))
    canonical_hips = {record[2]: record[1] for record in base if record[2] is not None and record[0].startswith('hip:')}
    for row in sorted(rows, key=lambda row: (float(row['mag']), int(row['id']))):
        if row['hip']:
            canonical_hips.setdefault(int(row['hip']), int(row['id']))
    constellations = sorted({row['con'] for row in rows})
    constellation_codes = {name: index for index, name in enumerate(constellations)}
    binary = bytearray()
    constellation_indices = bytearray()
    details = []
    ids = set(base_ids)
    missing = {'colorIndex': 0, 'distance': 0, 'radialVelocity': 0}
    duplicates = []
    max_coordinate_rounding_arcsec = 0.0
    for index, row in enumerate(rows):
        hyg = int(row['id'])
        hip = int(row['hip']) if row['hip'] else 0
        canonical = hip != 0 and canonical_hips[hip] == hyg
        object_id = f'hip:{hip}' if canonical else f'hyg:{hyg}'
        assert object_id not in ids
        ids.add(object_id)
        if hip and not canonical:
            duplicates.append({'hip': hip, 'hygId': hyg})
        ra, dec, mag = (float(row[key]) for key in ('ra', 'dec', 'mag'))
        bv = optional_float(row['ci'])
        distance = optional_float(row['dist'])
        distance = distance if distance is not None and 0 < distance < 100000 else None
        radial = optional_float(row['rv'])
        radial = radial if radial != 0 else None
        missing['colorIndex'] += bv is None
        missing['distance'] += distance is None
        missing['radialVelocity'] += radial is None
        scalars = [ra, dec, mag, bv, float(row['pmra']), float(row['pmdec']), distance, radial]
        encoded = RECORD.pack(hyg, hip if canonical else -hip, *(value if value is not None else math.nan for value in scalars))
        binary.extend(encoded)
        decoded = RECORD.unpack(encoded)
        coordinate_rounding = math.hypot((ra - decoded[2]) * 15 * math.cos(math.radians(dec)), dec - decoded[3]) * 3600
        max_coordinate_rounding_arcsec = max(max_coordinate_rounding_arcsec, coordinate_rounding)
        constellation_indices.append(constellation_codes[row['con']])
        comp, primary = int(row['comp']), int(row['comp_primary'])
        if any(row[key] for key in ('proper', 'bf', 'var', 'var_min', 'var_max')) or comp != 1 or primary != hyg:
            details.append([index, row['proper'] or None, row['bf'] or None, row['var'] or None,
                            optional_float(row['var_min']), optional_float(row['var_max']), comp, primary])
    assert len(binary) == len(rows) * RECORD.size
    encoded_path = OUT / 'extended-stars.b64.txt'
    encoded_path.write_bytes(base64.b64encode(binary))
    meta_path = OUT / 'extended-star-meta.json'
    save_json(meta_path, {'count': len(rows), 'recordBytes': RECORD.size, 'magnitudeLimit': LIMIT,
                         'constellations': constellations,
                         'constellationIndices': base64.b64encode(constellation_indices).decode('ascii'), 'details': details})
    outputs = [{'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size,
                'gzipBytes': len(gzip.compress(path.read_bytes(), mtime=0)),
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in (encoded_path, meta_path)]
    report = {'catalogVersion': 'HYG 4.1', 'magnitudeLimit': LIMIT, 'baseStars': len(base),
              'extendedStars': len(rows), 'totalStars': len(ids), 'sourceSha256': SOURCE_SHA256,
              'baseMetadataSha256': hashlib.sha256(base_bytes).hexdigest(),
              'baseOrderPreserved': True, 'uniqueObjectIds': True, 'missing': missing,
              'duplicateHipCompanions': duplicates, 'sparseDetails': len(details),
              'binaryRecordBytes': RECORD.size, 'binaryBytes': len(binary), 'outputs': outputs,
              'coordinateFrame': 'J2000 equatorial; X=RA0h, Y=RA6h, Z=north',
              'epoch': 'J2000.0', 'equinox': 'J2000.0',
              'maxFloat32CoordinateRoundingArcsec': max_coordinate_rounding_arcsec,
              'encoding': 'little endian: uint32 HYG, int32 signed HIP (negative=noncanonical companion), float32 RA hours/Dec degrees/V magnitude/B-V/pmra cosdec mas per year/pmdec mas per year/distance pc/RV km per s; NaN denotes unavailable optional values',
              'rawZeroRadialVelocityPolicy': '0 is unavailable because HYG does not distinguish unknown from measured zero',
              'limitations': 'HYG selection through V=10, not a complete deep-sky catalog; source positions and astrometry are stored as float32 in the supplement; base catalog precision and indices remain unchanged'}
    save_json(ROOT / 'assets/extended-stars-evidence.json', report)
    manifest_path = ROOT / 'assets/assets-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    bright = next(asset for asset in manifest['assets'] if asset['id'] == 'bright-stars')
    entry = {key: bright[key] for key in ('source', 'revision', 'license', 'licenseUrl', 'credit', 'coordinateFrame', 'epoch', 'equinox', 'units')}
    entry.update({'id': 'extended-stars', 'sourceFiles': [bright['sourceFiles'][0]],
                  'outputs': [{key: output[key] for key in ('path', 'sha256', 'bytes')} for output in outputs],
                  'selection': 'V magnitude <=10 excluding Sun and every HYG id already in the 8921-star base catalog; append in ascending HYG id; existing canonical HIP ids retain priority',
                  'count': len(rows), 'combinedCount': len(ids), 'evidenceFile': 'assets/extended-stars-evidence.json',
                  'processing': report['encoding'] + '; sparse source names, variables, components and constellation retained; restrained B-V color mapping matches base catalog',
                  'processingCommand': 'conda run -n dl_env python scripts/build-extended-stars.py'})
    manifest['assets'] = [asset for asset in manifest['assets'] if asset['id'] != 'extended-stars']
    manifest['assets'].insert(1, entry)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    assert base_path.read_bytes() == base_bytes, 'Base metadata must remain byte-identical'
    print(json.dumps({key: report[key] for key in ('baseStars', 'extendedStars', 'totalStars', 'binaryBytes', 'sparseDetails', 'maxFloat32CoordinateRoundingArcsec', 'outputs')}, indent=2))


if __name__ == '__main__':
    main()
