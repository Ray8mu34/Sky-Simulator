import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CivilInput, Mat3, Vec3 } from '../src/contracts';
import { astronomyAdapter, computeSnapshot, computeSolarDayEvents, refractionCorrectionDeg, refractHorizontalDirection } from '../src/core/astronomy';
import { angularSeparationDeg, applyMatrix, cross, DEG_TO_RAD, dot, normalize, raDecToVector, transposeMatrix, vectorToHorizontal } from '../src/core/math';
import { civilToDate, dateToUt, formatEraYear, localDayBounds, parseCivilInput, utToDate } from '../src/core/time';
import { propagateStarDirection } from '../src/core/stars';
import { scienceState } from './fixtures/science-state';

const close = (actual: number, expected: number, tolerance = 1e-10): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} ± ${tolerance}`);
function vecClose(actual: Vec3, expected: Vec3, tolerance = 1e-10): void { actual.forEach((value, i) => close(value, expected[i]!, tolerance)); }
const determinant = (m: Mat3): number => dot(m[0], cross(m[1], m[2]));
const civil = (year: number, month = 1, day = 1): CivilInput => ({ astronomicalYear: year, month, day, hour: 12, minute: 0, second: 0, zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject' });

test('RA hours map to the three independent right-handed EQJ basis vectors', () => {
  vecClose(raDecToVector(0, 0), [1, 0, 0]); vecClose(raDecToVector(6, 0), [0, 1, 0]); vecClose(raDecToVector(0, 90), [0, 0, 1]);
  vecClose(cross(raDecToVector(0, 0), raDecToVector(6, 0)), [0, 0, 1]);
  vecClose(raDecToVector(30, 0), raDecToVector(6, 0));
  assert.throws(() => raDecToVector(0, 91), RangeError); assert.throws(() => normalize([0, 0, 0]), RangeError);
});

test('row-major multiplication and transpose cannot silently use engine column-major storage', () => {
  const matrix: Mat3 = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
  vecClose(applyMatrix(matrix, [1, 0, 0]), [0, 1, 0]);
  vecClose(applyMatrix(transposeMatrix(matrix), [0, 1, 0]), [1, 0, 0]);
  close(determinant(matrix), 1);
});

test('E,N,U azimuth is north-zero east-positive; zenith/nadir has no azimuth', () => {
  for (const [vector, azimuth] of [[[0, 1, 0], 0], [[1, 0, 0], 90], [[0, -1, 0], 180], [[-1, 0, 0], 270]] as const) close(vectorToHorizontal(vector).azimuthDeg!, azimuth);
  assert.equal(vectorToHorizontal([0, 0, 1]).azimuthDeg, null);
  assert.equal(vectorToHorizontal([0, 0, -1]).azimuthDeg, null);
  close(vectorToHorizontal([0, 0, -1]).altitudeDeg, -90);
});

test('J2000 UT epoch is UTC noon and civil fixed offsets preserve absolute time', () => {
  close(dateToUt(new Date('2000-01-01T12:00:00Z')), 0);
  assert.equal(utToDate(0).toISOString(), '2000-01-01T12:00:00.000Z');
  const local = { ...civil(2026, 9, 14), hour: 22, zone: { kind: 'fixed' as const, offsetMinutes: 480 } };
  close(parseCivilInput(local), dateToUt(new Date('2026-09-14T14:00:00Z')));
  for (const year of [-2000, -1, 0, 1, 4, 99, 100, 1900, 2000, 2100, 4000]) {
    const ut = parseCivilInput(civil(year));
    assert.equal(utToDate(ut).getUTCFullYear(), year);
    close(dateToUt(utToDate(ut)), ut, 2e-8);
  }
});

test('astronomical years -1/0/1 are continuous and have correct BCE labels', () => {
  assert.equal(formatEraYear(-1), '公元前 2 年'); assert.equal(formatEraYear(0), '公元前 1 年'); assert.equal(formatEraYear(1), '公元 1 年');
  close(parseCivilInput(civil(0)) - parseCivilInput(civil(-1)), 365);
  close(parseCivilInput(civil(1)) - parseCivilInput(civil(0)), 366);
  assert.equal(civilToDate(civil(99)).getUTCFullYear(), 99);
});

test('Gregorian leap centuries, invalid dates, leap seconds and unsupported ranges are rejected', () => {
  assert.throws(() => parseCivilInput(civil(1900, 2, 29)), RangeError);
  assert.throws(() => parseCivilInput(civil(2100, 2, 29)), RangeError);
  assert.equal(utToDate(parseCivilInput(civil(2000, 2, 29))).getUTCDate(), 29);
  assert.throws(() => parseCivilInput(civil(2026, 4, 31)), RangeError);
  assert.throws(() => parseCivilInput({ ...civil(2026), second: 60 }), RangeError);
  assert.throws(() => parseCivilInput(civil(-2001)), RangeError);
  assert.throws(() => parseCivilInput(civil(4001)), RangeError);
  assert.throws(() => computeSnapshot(scienceState('4001-01-01T00:00:00Z'), 0), RangeError);
});

test('IANA duplicate and missing hours are explicit and host rule source is required', () => {
  const input: CivilInput = { ...civil(2026, 11, 1), hour: 1, minute: 30, zone: { kind: 'iana', name: 'America/New_York', versionNote: 'host Intl/ICU; exact Node runtime logged by test runner' } };
  assert.throws(() => parseCivilInput(input), /重复/);
  const earlier = parseCivilInput({ ...input, ambiguousTime: 'earlier' });
  const later = parseCivilInput({ ...input, ambiguousTime: 'later' });
  close((later - earlier) * 24, 1, 1e-9);
  assert.equal(utToDate(earlier).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(utToDate(later).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.throws(() => parseCivilInput({ ...input, month: 3, day: 8, hour: 2 }), /不存在/);
  assert.throws(() => parseCivilInput({ ...input, astronomicalYear: 0 }), /固定 UTC/);
  assert.throws(() => parseCivilInput({ ...input, zone: { kind: 'iana', name: 'America/New_York', versionNote: '' } }), /来源/);
});

test('TT is a separate modeled timescale; the J2000 UT1≈UTC approximation stays within 0.5s of TT−UTC=64.184s', () => {
  const snapshot = computeSnapshot(scienceState('2000-01-01T12:00:00Z'), 19);
  assert.equal(astronomyAdapter.engineVersion, '2.1.19'); assert.equal(snapshot.requestId, 19);
  close(snapshot.utDaysJ2000, 0); close((snapshot.ttDaysJ2000 - snapshot.utDaysJ2000) * 86400, 64.184, 0.5);
  assert.ok(snapshot.gastHours > 18.69 && snapshot.gastHours < 18.70);
});

test('Earth geographic basis, horizontal basis and local geographic zenith agree at all latitudes', () => {
  for (const [latitude, longitude] of [[0, 0], [30.25, 120.17], [-33.9, 151.2], [89.99, -90], [90, 45], [-90, -45], [0, 180]]) {
    const state = scienceState('2026-09-14T14:00:00Z', latitude!, longitude!);
    const snapshot = computeSnapshot(state, 1);
    const h = snapshot.eqjToHorizontalGeometric, earth = snapshot.earthFixedToEqj;
    for (const m of [h, earth]) {
      close(determinant(m), 1, 1e-12);
      m.forEach((row, i) => m.forEach((other, j) => close(dot(row, other), i === j ? 1 : 0, 1e-12)));
      const original: Vec3 = normalize([0.4, 0.7, -0.3]);
      vecClose(applyMatrix(transposeMatrix(m), applyMatrix(m, original)), original, 1e-12);
    }
    const lat = latitude! * DEG_TO_RAD, lon = longitude! * DEG_TO_RAD;
    const geographicNormal: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
    const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    vecClose(applyMatrix(earth, geographicNormal), snapshot.localZenithEqjUnit, 1e-12);
    vecClose(applyMatrix(h, applyMatrix(earth, geographicNormal)), [0, 0, 1], 1e-12);
    vecClose(applyMatrix(h, applyMatrix(earth, east)), [1, 0, 0], 1e-12);
    vecClose(applyMatrix(h, applyMatrix(earth, north)), [0, 1, 0], 1e-12);
    vecClose(cross(h[0], h[1]), h[2], 1e-12);
  }
});

test('snapshot horizontal angles obey the independent hour-angle equations with east longitude', () => {
  const state = scienceState(), s = computeSnapshot(state, 2);
  close(s.lstHours, ((s.gastHours + state.observer.longitudeDegEast / 15) % 24 + 24) % 24);
  for (const body of s.bodies) {
    const hour = (s.lstHours - body.raHoursOfDate) * 15 * DEG_TO_RAD;
    const dec = body.decDegOfDate * DEG_TO_RAD, lat = state.observer.latitudeDeg * DEG_TO_RAD;
    const analytic: Vec3 = [-Math.cos(dec) * Math.sin(hour), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hour), Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hour)];
    vecClose(applyMatrix(s.eqjToHorizontalGeometric, body.topocentricDirectionEqj), analytic, 1e-12);
    close(body.geometricAltitudeDeg, vectorToHorizontal(analytic).altitudeDeg, 1e-10);
    close(body.apparentAltitudeDeg, body.geometricAltitudeDeg);
  }
});

test('solar illumination at the geographic marker agrees with the topocentric Sun altitude within solar parallax', () => {
  const s = computeSnapshot(scienceState(), 1), sun = s.bodies.find(body => body.id === 'Sun')!;
  const fromEarth = Math.asin(dot(s.localZenithEqjUnit, normalize(sun.geocentricEqjAU))) / DEG_TO_RAD;
  close(fromEarth, sun.geometricAltitudeDeg, 0.003);
});

test('Moon phase uses consistent Sun and observer directions; texture basis remains right-handed', () => {
  for (const utc of ['2026-09-11T03:30:00Z', '2026-09-26T17:00:00Z']) {
    const moon = computeSnapshot(scienceState(utc), 1).bodies.find(body => body.id === 'Moon')!;
    close(moon.illuminatedFraction!, (1 + dot(moon.bodyToSunEqjUnit!, moon.bodyToObserverEqjUnit)) / 2);
    vecClose(moon.bodyToObserverEqjUnit, moon.topocentricDirectionEqj.map(x => -x) as unknown as Vec3);
    close(determinant(moon.bodyFixedToEqj!), 1, 1e-12);
    if (utc.includes('09-11')) assert.ok(moon.illuminatedFraction! < 0.01);
    else assert.ok(moon.illuminatedFraction! > 0.99);
  }
});

test('refraction applies as a shared direction correction and responds to atmosphere parameters', () => {
  const env = { ...scienceState().environment, refraction: 'standard' as const };
  const input: Vec3 = [0, 1, 0];
  const corrected = vectorToHorizontal(refractHorizontalDirection(input, env));
  close(corrected.altitudeDeg, refractionCorrectionDeg(0, env));
  close(corrected.azimuthDeg!, 0);
  assert.ok(corrected.altitudeDeg > 0.4 && corrected.altitudeDeg < 0.7);
  close(refractionCorrectionDeg(0, { ...env, pressureHpa: 0 }), 0);
  vecClose(refractHorizontalDirection(input, { ...env, refraction: 'none' }), input);
});

test('display zone, views and illustration scaling do not change scientific truth', () => {
  const state = scienceState('2026-09-14T18:30:00Z', 0, 180), baseline = computeSnapshot(state, 1);
  const other = structuredClone(state);
  other.observer.longitudeDegEast = -180; other.observer.displayZone = { kind: 'fixed', offsetMinutes: -720 };
  other.viewMode = 'space'; other.illustration = { bodySizeScale: 100, distanceCompressed: true };
  const comparison = computeSnapshot(other, 1);
  assert.deepEqual(comparison, baseline);
});

test('modern boundaries and extension years have finite coherent outputs without claiming full validation', () => {
  for (const year of [-2000, -1, 0, 1, 99, 1900, 2000, 2100, 4000]) {
    const state = scienceState(); state.time.utDaysJ2000 = parseCivilInput(civil(year, 6, 21));
    const snapshot = computeSnapshot(state, year);
    for (const body of snapshot.bodies) {
      for (const value of [body.raHoursOfDate, body.decDegOfDate, body.geometricAltitudeDeg, body.apparentAltitudeDeg, body.angularDiameterDeg, ...body.topocentricDirectionEqj, ...body.geocentricEqjAU]) assert.ok(Number.isFinite(value));
      close(Math.hypot(...body.topocentricDirectionEqj), 1);
      assert.ok(body.angularDiameterDeg > 0);
    }
    assert.equal(snapshot.accuracyTier, year >= 1900 && year <= 2100 ? 'unvalidated' : 'extended-exploration');
    assert.notEqual(snapshot.accuracyTier, 'modern-validated');
  }
});

test('proper motion uses μRA*cosδ tangents without polar division or distance placeholders', () => {
  const equatorial = { raHours: 0, decDeg: 0, pmRaCosDecMasYr: 1000, pmDecMasYr: 0 };
  const high = { ...equatorial, decDeg: 80 };
  const years = 100, ut = years * 365.25;
  close(angularSeparationDeg(propagateStarDirection(equatorial, ut), raDecToVector(0, 0)), Math.atan(100000 * DEG_TO_RAD / 3600000) / DEG_TO_RAD);
  close(angularSeparationDeg(propagateStarDirection(high, ut), raDecToVector(0, 80)), angularSeparationDeg(propagateStarDirection(equatorial, ut), raDecToVector(0, 0)));
  for (const declination of [-90, 90]) assert.ok(propagateStarDirection({ ...equatorial, decDeg: declination }, 6000 * 365.25).every(Number.isFinite));
  vecClose(propagateStarDirection(high, 0), raDecToVector(0, 80));
});

test('civil day bounds handle 23/25h days, skipped midnight, and exclusive year-4001 end', () => {
  const ny = { kind: 'iana' as const, name: 'America/New_York', versionNote: 'host Intl/ICU' };
  close((localDayBounds(dateToUt(new Date('2026-03-08T12:00:00Z')), ny).endUt - localDayBounds(dateToUt(new Date('2026-03-08T12:00:00Z')), ny).startUt) * 24, 23, 1e-8);
  close((localDayBounds(dateToUt(new Date('2026-11-01T12:00:00Z')), ny).endUt - localDayBounds(dateToUt(new Date('2026-11-01T12:00:00Z')), ny).startUt) * 24, 25, 1e-8);
  const brazil = localDayBounds(dateToUt(new Date('2018-11-04T12:00:00Z')), { kind: 'iana', name: 'America/Sao_Paulo', versionNote: 'host Intl/ICU' });
  assert.equal(utToDate(brazil.startUt).toISOString(), '2018-11-04T03:00:00.000Z');
  const boundary = localDayBounds(parseCivilInput(civil(4000, 12, 31)), { kind: 'fixed', offsetMinutes: 0 });
  assert.equal(utToDate(boundary.endUt).toISOString(), '4001-01-01T00:00:00.000Z');
});

test('solar day events classify specific polar dates using event search and refined daily extrema', () => {
  const summer = computeSolarDayEvents(scienceState('2026-06-21T12:00:00Z', 69.65, 18.96));
  assert.equal(summer.state, 'continuous-daylight'); assert.equal(summer.riseUtDaysJ2000, null); assert.equal(summer.setUtDaysJ2000, null);
  assert.ok(summer.minimumGeometricAltitudeDeg > 2);
  const winter = computeSolarDayEvents(scienceState('2026-12-21T12:00:00Z', 69.65, 18.96));
  assert.equal(winter.state, 'no-sunrise'); assert.ok(winter.maximumGeometricAltitudeDeg < -2);
  const equator = computeSolarDayEvents(scienceState('2026-03-20T12:00:00Z', 0, 0));
  assert.equal(equator.state, 'normal'); assert.ok(equator.riseUtDaysJ2000 !== null && equator.setUtDaysJ2000 !== null);
  const end = scienceState(); end.time.utDaysJ2000 = parseCivilInput(civil(4000, 12, 31)); end.observer.displayZone = { kind: 'fixed', offsetMinutes: 0 };
  assert.ok(Number.isFinite(computeSolarDayEvents(end).maximumGeometricAltitudeDeg));
});
