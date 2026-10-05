import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { computeSnapshot } from '../src/core/astronomy';
import { angularSeparationDeg, raDecToVector } from '../src/core/math';
import { compareFixedDeltaT } from '../src/core/diagnostics';
import { scienceState } from './fixtures/science-state';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/horizons-sun-moon.json', import.meta.url), 'utf8'));

test('independent fixture contains pinned Horizons settings, full raw results and verified hashes', () => {
  assert.equal(fixture.source, 'JPL Horizons observer ephemeris API');
  assert.equal(fixture.rows.length, 8);
  for (const response of fixture.responses) {
    assert.equal(response.parameters.CAL_TYPE, 'GREGORIAN');
    assert.equal(response.parameters.APPARENT, 'AIRLESS');
    assert.equal(response.parameters.CENTER, 'coord@399');
    assert.equal(response.parameters.SITE_COORD, '120.17,30.25,0.02');
    assert.equal(response.parameters.TIME_TYPE, 'UT');
    const raw = readFileSync(new URL(`./fixtures/${response.rawFile}`, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), response.sha256);
    assert.ok(raw.toString('utf8').includes('$$SOE'));
  }
});

for (const row of fixture.rows) {
  test(`independent JPL ${row.body} reference: ${row.utc}`, () => {
    const snapshot = computeSnapshot(scienceState(row.utc), 1);
    const body = snapshot.bodies.find(body => body.id === row.body)!;
    const separation = angularSeparationDeg(raDecToVector(body.raHoursOfDate, body.decDegOfDate), raDecToVector(row.raHoursOfDate, row.decDegOfDate));
    assert.ok(separation <= fixture.tolerances.directionDeg, `direction ${separation}° > ${fixture.tolerances.directionDeg}°`);
    const altitudeError = Math.abs(body.geometricAltitudeDeg - row.altitudeDeg);
    assert.ok(altitudeError <= fixture.tolerances.altitudeDeg, `airless altitude ${altitudeError}° > ${fixture.tolerances.altitudeDeg}°`);
    const azimuthError = Math.abs(((body.azimuthDeg! - row.azimuthDeg + 540) % 360) - 180);
    // At high altitude raw azimuth can be ill-conditioned; measure its angular projection.
    assert.ok(azimuthError * Math.cos(row.altitudeDeg * Math.PI / 180) <= fixture.tolerances.directionDeg, `projected azimuth ${azimuthError}°`);
    assert.ok(Math.abs(body.angularDiameterDeg - row.angularDiameterDeg) <= fixture.tolerances.diameterDeg);
    if (row.body === 'Moon') assert.ok(Math.abs(body.illuminatedFraction! - row.illuminatedFraction) <= fixture.tolerances.illuminatedFraction);
    assert.equal(snapshot.accuracyTier, 'unvalidated');
  });
}

test('initial one-arcminute future-Moon failure is explained by ΔT without changing production model', () => {
  const row = fixture.rows.find((row: { body: string; utc: string }) => row.body === 'Moon' && row.utc.startsWith('2100'));
  const state = scienceState(row.utc);
  const { production, aligned } = compareFixedDeltaT(state, 69.184);
  const reference = raDecToVector(row.raHoursOfDate, row.decDegOfDate);
  const separation = (snapshot: typeof production) => {
    const moon = snapshot.bodies.find(body => body.id === 'Moon')!;
    return angularSeparationDeg(raDecToVector(moon.raHoursOfDate, moon.decDegOfDate), reference);
  };
  assert.ok(separation(production) > 1 / 60 && separation(production) < 2 / 60);
  assert.ok(separation(aligned) < 0.1 / 60);
  assert.ok(Math.abs((production.ttDaysJ2000 - production.utDaysJ2000) * 86400 - 205.007762) < 0.001);
  assert.ok(Math.abs((aligned.ttDaysJ2000 - aligned.utDaysJ2000) * 86400 - 69.184) < 0.001);
  assert.deepEqual(computeSnapshot(state, 0), production);
});
