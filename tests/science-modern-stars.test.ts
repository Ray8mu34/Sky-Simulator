import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { computeObserverFrame } from '../src/core/observer-frame';
import { propagateStarDirection } from '../src/core/stars';
import type { StarAstrometry } from '../src/core/stars';
import { applyMatrix, angularSeparationDeg } from '../src/core/math';
import { dateToUt } from '../src/core/time';

test('58 mapped stars / 132 Hc>5° samples retain the original 1 arcminute absolute USNO direction gate', () => {
  const records = JSON.parse(readFileSync('assets/runtime/star-meta.json', 'utf8')) as unknown[][];
  const byId = new Map(records.map(r => [r[0], { id: r[0], raHours: r[3], decDeg: r[4], pmRaCosDecMasYr: r[10], pmDecMasYr: r[11], qualityFlags: r[12], distancePc: r[13], radialVelocityKmS: r[14] } as StarAstrometry]));
  const idBytes = readFileSync(new URL('./fixtures/m5b/usno/usno-star-id-map.json', import.meta.url));
  assert.equal(createHash('sha256').update(idBytes).digest('hex'), '43a097ab5fc25bc39ebec5829e177ae3badf9977a4557894aa592e36d7c4333d');
  const mapping = JSON.parse(idBytes.toString()) as { usnoName: string; objectId: string; catalogSha256: string }[];
  const byName = new Map(mapping.map(row => [row.usnoName, row.objectId]));
  for (const row of mapping) assert.equal(row.catalogSha256, '46dd05ad8aa40b284e32efd929002d067bed89e3e39d7c885be5a7ae43af3dd1');
  let all = 0, eligible = 0; const ids = new Set<string>();
  for (const sample of ['1900-equator', '1950-hangzhou', '2000-south', '2026-west', '2050-equator']) {
    const rawBytes = readFileSync(new URL(`./fixtures/m5b/usno/usno-celnav-${sample}.raw`, import.meta.url));
    const meta = JSON.parse(readFileSync(new URL(`./fixtures/m5b/usno/usno-celnav-${sample}.metadata.json`, import.meta.url), 'utf8'));
    assert.equal(createHash('sha256').update(rawBytes).digest('hex'), meta.sha256); assert.equal(meta.httpStatus, 200); assert.ok(meta.sourceUrl.startsWith('https://aa.usno.navy.mil/api/celnav?'));
    const raw = JSON.parse(rawBytes.toString()); assert.equal(raw.apiversion, '4.0.1');
    const p = raw.properties, [longitude, latitude] = raw.geometry.coordinates;
    assert.equal(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, meta.requestParameters.date);
    assert.equal(p.time, meta.requestParameters.time); assert.equal(p.tz, 0);
    const ut = dateToUt(new Date(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${p.time}Z`));
    const frame = computeObserverFrame(ut, { name: 'USNO reference', longitudeDegEast: longitude, latitudeDeg: latitude, heightMeters: 0, displayZone: { kind: 'fixed', offsetMinutes: 0 } });
    for (const datum of p.data) {
      const id = byName.get(datum.object); if (!id) continue;
      const star = byId.get(id); assert.ok(star, id); all++; ids.add(id);
      // Hc/Zn are the uncorrected geometric almanac direction. Never add Refr,
      // semidiameter or parallax from the separately returned correction block.
      const h = datum.almanac_data.hc * Math.PI / 180, az = datum.almanac_data.zn * Math.PI / 180;
      const expected = [Math.cos(h) * Math.sin(az), Math.cos(h) * Math.cos(az), Math.sin(h)] as const;
      const direction = applyMatrix(frame.eqjToHorizontalGeometric, propagateStarDirection(star, ut));
      const error = angularSeparationDeg(direction, expected) * 60;
      if (datum.almanac_data.hc > 5) { eligible++; assert.ok(error <= 1, `${sample} ${id}: ${error} arcminutes`); }
    }
  }
  assert.equal(all, 140); assert.equal(eligible, 132); assert.equal(ids.size, 58);
});
