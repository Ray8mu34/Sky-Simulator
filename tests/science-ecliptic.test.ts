import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Vec3 } from '../src/contracts';
import { computeSnapshot } from '../src/core/astronomy';
import { angularSeparationDeg, applyMatrix, cross, dot } from '../src/core/math';
import { dateToUt } from '../src/core/time';
import { scienceState } from './fixtures/science-state';

interface EclipticDate { id: string; year: number; ttJd: readonly [number, number]; modernAxisGateArcsec: number | null; referenceContext?: { jdUtLabel: number }; expected: { basisColumnsEqj: Vec3[]; longitudeSamples: { longitudeDeg: number; directionEqj: Vec3 }[] } }
const bytes = readFileSync(new URL('./fixtures/m5c/true-ecliptic.fixture.json', import.meta.url));
const fixture = JSON.parse(bytes.toString()) as { dates: EclipticDate[] };
test('frozen SOFA true-ecliptic reference preserves its exact hash and predeclared modern/extended coverage', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '7de292a07dbb223bc12024f825a3b26fa1704f4aa75a804511b98a952cb0f4af');
  assert.equal(fixture.dates.length, 6); assert.equal(fixture.dates.filter(date => date.modernAxisGateArcsec === 1).length, 4);
  assert.equal(fixture.dates.filter(date => date.modernAxisGateArcsec === null).length, 2);
});
for (const date of fixture.dates) test(`snapshot true-ecliptic row-major physical axes: ${date.id}`, () => {
  const state = scienceState();
  state.time.utDaysJ2000 = date.referenceContext ? date.referenceContext.jdUtLabel - 2451545 : dateToUt(new Date(`${date.year < 0 ? '-002000' : '4000'}-03-15T00:00:00Z`));
  const snapshot = computeSnapshot(state, 1), matrix = snapshot.eclipticOfDateToEqj;
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => applyMatrix(matrix, axis as unknown as Vec3));
  for (const axis of axes) assert.ok(Math.abs(Math.hypot(...axis) - 1) < 1e-12);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(Math.abs(dot(axes[i]!, axes[j]!)) < 1e-12);
  assert.ok(dot(cross(axes[0]!, axes[1]!), axes[2]!) > 1 - 1e-12);
  assert.equal(date.expected.longitudeSamples.length, 12);
  if (date.modernAxisGateArcsec !== null) for (let i = 0; i < 3; i++) assert.ok(angularSeparationDeg(axes[i]!, date.expected.basisColumnsEqj[i]!) * 3600 <= date.modernAxisGateArcsec);
  for (const sample of date.expected.longitudeSamples) {
    const longitude = sample.longitudeDeg * Math.PI / 180, actual = applyMatrix(matrix, [Math.cos(longitude), Math.sin(longitude), 0]);
    assert.ok(Math.abs(dot(actual, axes[2]!)) < 1e-12);
    if (date.modernAxisGateArcsec !== null) assert.ok(angularSeparationDeg(actual, sample.directionEqj) * 3600 <= date.modernAxisGateArcsec);
  }
  // Extended SOFA TT is explicit; production uses model TT from its UT label.
  // Those axes are retained diagnostics, not a modern precision claim.
});
