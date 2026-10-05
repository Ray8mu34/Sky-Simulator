import assert from 'node:assert/strict';
import test from 'node:test';
import type { Vec3 } from '../src/contracts';
import { computeSnapshot } from '../src/core/astronomy';
import { angularSeparationDeg, applyMatrix, cross, dot, horizontalToVector, normalize, raDecToVector } from '../src/core/math';
import { clipSampleSkyArcEnu, inverseSkyDiskToEnu, projectEnuToSkyDisk, projectEqjToSkyDisk } from '../src/core/sky-map-projection';
import { scienceState } from './fixtures/science-state';

const close = (actual: number, expected: number, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
function vectorClose(actual: Vec3, expected: Vec3, tolerance = 1e-12) { actual.forEach((component, axis) => close(component, expected[axis]!, tolerance)); }

test('independent ENU bases give north-up east-left zenith-centred full-sky disk', () => {
  for (const [enu, x, y, azimuth] of [
    [[0, 1, 0], 0, -1, 0], [[1, 0, 0], -1, 0, 90], [[0, -1, 0], 0, 1, 180], [[-1, 0, 0], 1, 0, 270],
  ] as const) {
    const point = projectEnuToSkyDisk(enu)!;
    close(point.x, x); close(point.y, y); close(point.radius, 1); close(point.altitudeDeg, 0); close(point.azimuthDeg!, azimuth);
  }
  const zenith = projectEnuToSkyDisk([0, 0, 4])!;
  assert.deepEqual(zenith, { x: 0, y: 0, radius: 0, altitudeDeg: 90, azimuthDeg: null });
  vectorClose(inverseSkyDiskToEnu(0, 0)!, [0, 0, 1]);
  assert.equal(projectEnuToSkyDisk([0, 0, -1]), null);
});

test('equidistance uses zenith angular distance with genuine geometric horizon boundaries', () => {
  const halfway = projectEnuToSkyDisk([1, 0, 1])!;
  close(halfway.radius, 0.5); close(halfway.x, -0.5); close(halfway.y, 0); close(halfway.altitudeDeg, 45);
  const low = projectEnuToSkyDisk([1, 0, Number.EPSILON])!;
  assert.ok(low.radius <= 1 && low.altitudeDeg > 0);
  assert.equal(projectEnuToSkyDisk([1, 0, -Number.EPSILON]), null);
  assert.equal(projectEnuToSkyDisk(horizontalToVector(-0.001, 0)), null);
  const exact = projectEnuToSkyDisk([0, 1, 0])!;
  vectorClose(inverseSkyDiskToEnu(exact.x, exact.y)!, [0, 1, 0]);
  assert.equal(inverseSkyDiskToEnu(1.0000001, 0), null);
  assert.equal(inverseSkyDiskToEnu(1, 1), null);
  assert.equal(inverseSkyDiskToEnu(1 + Number.EPSILON, 0)![2], 0);
});

test('projection and inverse round-trip the hemisphere, azimuth wrap and arbitrarily close zenith', () => {
  for (const altitude of [0, 0.0001, 15, 45, 75, 89, 89.99999999, 90]) for (let azimuth = -360; azimuth <= 720; azimuth += 15) {
    const direction = horizontalToVector(altitude, azimuth);
    const point = projectEnuToSkyDisk(direction)!;
    close(point.radius, (90 - altitude) / 90, 1e-14);
    assert.ok(point.radius <= 1 && Number.isFinite(point.x) && Number.isFinite(point.y));
    const restored = inverseSkyDiskToEnu(point.x, point.y)!;
    assert.ok(angularSeparationDeg(restored, direction) < 1e-10);
  }
  const left = projectEnuToSkyDisk(horizontalToVector(30, -0.000001))!;
  const right = projectEnuToSkyDisk(horizontalToVector(30, 359.999999))!;
  close(left.x, right.x); close(left.y, right.y);
  const pole = projectEnuToSkyDisk([1e-14, -2e-14, 1])!;
  assert.equal(pole.azimuthDeg, null); assert.ok(pole.radius > 0); assert.ok(Math.hypot(pole.x, pole.y) < 1e-13);
});

test('EQJ projection uses the same observer snapshot at both geographic poles and longitude wrap', () => {
  for (const latitude of [-90, -45, 0, 30.25, 90]) for (const longitude of [-180, 0, 180]) {
    const state = scienceState('2026-09-14T14:00:00Z', latitude, longitude);
    const snapshot = computeSnapshot(state, 1);
    const zenith = projectEqjToSkyDisk(snapshot.localZenithEqjUnit, snapshot)!;
    assert.ok(zenith.radius < 1e-14); close(zenith.altitudeDeg, 90, 1e-11);
    const nadir: Vec3 = snapshot.localZenithEqjUnit.map(component => -component) as unknown as Vec3;
    assert.equal(projectEqjToSkyDisk(nadir, snapshot), null);
    const eqjNorthPole = applyMatrix(snapshot.earthFixedToEqj, [0, 0, 1]);
    const north = projectEqjToSkyDisk(eqjNorthPole, snapshot);
    if (latitude > 0) close(north!.altitudeDeg, latitude, 1e-8);
    if (latitude < 0) assert.equal(north, null);
    const raZero = projectEqjToSkyDisk(raDecToVector(0, 20), snapshot);
    const raWrap = projectEqjToSkyDisk(raDecToVector(24, 20), snapshot);
    if (raZero && raWrap) { close(raZero.x, raWrap.x); close(raZero.y, raWrap.y); }
    else assert.equal(raZero, raWrap);
  }
});

test('great-circle horizon clipping finds the geometric intersection before projection and is reversal-consistent', () => {
  const start: Vec3 = [0, Math.sqrt(3) / 2, 0.5], end: Vec3 = [Math.sqrt(3) / 2, 0, -0.5];
  const paths = clipSampleSkyArcEnu(start, end);
  assert.equal(paths.length, 1); assert.ok(paths[0]!.length > 2);
  const points = paths[0]!, intersection = points.at(-1)!;
  close(intersection.x, -Math.SQRT1_2); close(intersection.y, -Math.SQRT1_2); close(intersection.altitudeDeg, 0); close(intersection.radius, 1);
  const plane = normalize(cross(start, end));
  for (const point of points) {
    const enu = inverseSkyDiskToEnu(point.x, point.y)!;
    assert.ok(enu[2] >= 0); close(dot(plane, enu), 0, 1e-12);
  }
  const reversed = clipSampleSkyArcEnu(end, start)[0]!;
  assert.equal(reversed.length, points.length);
  reversed.forEach((point, index) => {
    close(point.x, points[points.length - 1 - index]!.x); close(point.y, points[points.length - 1 - index]!.y);
  });
});

test('minor arcs cannot bridge below-horizon endpoints and do not jump across the azimuth seam', () => {
  assert.deepEqual(clipSampleSkyArcEnu(horizontalToVector(-10, 0), horizontalToVector(-10, 180)), []);
  const seam = clipSampleSkyArcEnu(horizontalToVector(20, 355), horizontalToVector(20, 5));
  assert.equal(seam.length, 1);
  for (let index = 1; index < seam[0]!.length; index++) {
    const current = seam[0]![index]!, previous = seam[0]![index - 1]!;
    assert.ok(Math.hypot(current.x - previous.x, current.y - previous.y) < 0.06);
    assert.ok(current.y < 0); assert.ok(current.altitudeDeg >= 20 - 1e-12);
  }
  const zenithCrossing = clipSampleSkyArcEnu(horizontalToVector(30, 0), horizontalToVector(30, 180))[0]!;
  assert.ok(zenithCrossing.some(point => point.radius < 1e-14));
  assert.ok(zenithCrossing.every(point => point.radius <= 1));
});

test('horizon arcs, boundary-only arcs, same point and antipodal ambiguity have explicit outcomes', () => {
  const horizon = clipSampleSkyArcEnu([0, 1, 0], [-1, 0, 0])[0]!;
  assert.ok(horizon.length > 2);
  for (const point of horizon) { close(point.radius, 1); close(point.altitudeDeg, 0); }
  const boundaryOnly = clipSampleSkyArcEnu([0, 1, 0], [0, 1, -0.5]);
  assert.equal(boundaryOnly.length, 1); assert.equal(boundaryOnly[0]!.length, 1); close(boundaryOnly[0]![0]!.radius, 1);
  assert.equal(clipSampleSkyArcEnu([0, 0, 1], [0, 0, 5])[0]!.length, 1);
  assert.deepEqual(clipSampleSkyArcEnu([1, 0, 0], [-1, 0, 0]), []);
  assert.deepEqual(clipSampleSkyArcEnu([1, 0, 0], [-1, 1e-14, 0]), []);
});

test('sampling has hard resource bounds and rejects invalid controls, directions and matrices', () => {
  const start = horizontalToVector(0.1, 0), end = horizontalToVector(0.1, 179.9);
  assert.ok(clipSampleSkyArcEnu(start, end, { maxAngularStepDeg: 0.00001, maxSegments: 8 })[0]!.length <= 9);
  assert.ok(clipSampleSkyArcEnu(start, end, { maxAngularStepDeg: 0.00001, maxSegments: 256 })[0]!.length <= 257);
  for (const step of [0, -1, NaN, Infinity, 90.001]) assert.throws(() => clipSampleSkyArcEnu(start, end, { maxAngularStepDeg: step }), RangeError);
  for (const count of [0, 1.5, 257, NaN, Infinity]) assert.throws(() => clipSampleSkyArcEnu(start, end, { maxSegments: count }), RangeError);
  for (const vector of [[0, 0, 0], [NaN, 1, 0], [1, Infinity, 0]] as const) {
    assert.throws(() => projectEnuToSkyDisk(vector), RangeError); assert.throws(() => clipSampleSkyArcEnu(vector, end), RangeError);
  }
  for (const coordinate of [NaN, Infinity, -Infinity]) assert.throws(() => inverseSkyDiskToEnu(coordinate, 0), RangeError);
  const snapshot = computeSnapshot(scienceState(), 2);
  const badMatrix = { ...snapshot, eqjToHorizontalGeometric: [[NaN, 0, 0], [0, 1, 0], [0, 0, 1]] as const };
  assert.throws(() => projectEqjToSkyDisk([1, 0, 0], badMatrix), RangeError);
});

test('projection is independent of pixel layout and does not modify vectors or scientific snapshot', () => {
  const snapshot = computeSnapshot(scienceState(), 3), before = structuredClone(snapshot);
  const direction = Object.freeze([1, 2, 3] as const);
  const first = projectEqjToSkyDisk(direction, snapshot);
  assert.deepEqual(projectEqjToSkyDisk(direction, snapshot), first);
  assert.deepEqual(snapshot, before); assert.deepEqual(direction, [1, 2, 3]);
  const start = Object.freeze([1, 1, 1] as const), end = Object.freeze([-1, 1, -1] as const);
  clipSampleSkyArcEnu(start, end);
  assert.deepEqual(start, [1, 1, 1]); assert.deepEqual(end, [-1, 1, -1]);
});
