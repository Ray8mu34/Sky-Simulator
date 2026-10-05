import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScienceSnapshot, Vec3 } from '../src/contracts';
import { angularSeparationDeg, horizontalToVector, vectorToHorizontal } from '../src/core/math';
import { createRefractionDescriptor, deriveRefractionProfile, getDisplayRefractionProfile, refractEnuDirection, unrefractEnuDirection } from '../src/core/refraction';
import { clipSampleSkyArcEnu, inverseSkyDiskToEnu, projectEnuToSkyDisk, projectEqjToSkyDisk } from '../src/core/sky-map-projection';
import { createDefaultState } from '../src/state';
import { clipSampleCanvasSkyArcEnu, projectCanvasEnuToSkyDisk, projectCanvasEqjToSkyDisk } from '../src/render/CanvasSkyProjection';
import { createMinorArcSampler, minorArcAltitudeCrossings, minorArcDirectionAt } from '../src/render/SphericalArcBuffer';

const environment = createDefaultState().environment;
const profile = (mode: 'none' | 'standard' = 'standard', pressureHpa = 1010) => deriveRefractionProfile(createRefractionDescriptor({ ...environment, refraction: mode, pressureHpa, temperatureC: 10 }));
const snapshot = (mode: 'none' | 'standard' = 'standard', pressureHpa = 1010) => ({
  eqjToHorizontalGeometric: [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  observerRefraction: createRefractionDescriptor({ ...environment, refraction: mode, pressureHpa, temperatureC: 10 }),
} as unknown as ScienceSnapshot);
const close = (actual: number, expected: number, tolerance = 1e-11) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const pointClose = (actual: NonNullable<ReturnType<typeof projectCanvasEnuToSkyDisk>>, expected: NonNullable<ReturnType<typeof projectCanvasEnuToSkyDisk>>) => {
  for (const key of ['x', 'y', 'radius', 'altitudeDeg'] as const) close(actual[key], expected[key]);
  if (actual.azimuthDeg === null || expected.azimuthDeg === null) assert.equal(actual.azimuthDeg, expected.azimuthDeg);
  else close(actual.azimuthDeg, expected.azimuthDeg);
};

test('Canvas none/P0 keeps the exact original point and arc projection, including maxSegments=1', () => {
  const vectors = [horizontalToVector(-.2, 5), horizontalToVector(0, 71), horizontalToVector(43, 359.8), [0, 0, 4] as Vec3];
  for (const identity of [profile('none'), profile('standard', 0)]) {
    for (const vector of vectors) {
      assert.deepEqual(projectCanvasEnuToSkyDisk(vector, identity), projectEnuToSkyDisk(vector));
      assert.deepEqual(projectCanvasEqjToSkyDisk(vector, snapshot(), identity), projectEqjToSkyDisk(vector, snapshot()));
    }
    const start = horizontalToVector(-20, 355), end = horizontalToVector(35, 5), before = structuredClone([start, end]);
    for (const maxSegments of [1, 8, 64, 256]) {
      const options = { maxAngularStepDeg: .02, maxSegments };
      assert.deepEqual(clipSampleCanvasSkyArcEnu(start, end, identity, options).paths, clipSampleSkyArcEnu(start, end, options));
    }
    assert.deepEqual([start, end], before);
  }
});

test('Canvas refracts before clipping so a slightly negative geometric star is visible', () => {
  const standard = profile(), direction = horizontalToVector(-.2, 73), mapped = projectCanvasEnuToSkyDisk(direction, standard)!;
  assert.equal(projectEnuToSkyDisk(direction), null);
  assert.ok(mapped.altitudeDeg > 0 && mapped.radius < 1);
  close(mapped.altitudeDeg, standard.apparentAltitudeDeg(-.2)); close(mapped.azimuthDeg!, 73);
  assert.deepEqual(mapped, projectEnuToSkyDisk(refractEnuDirection(direction, standard)));
  assert.equal(projectCanvasEnuToSkyDisk(horizontalToVector(-2, 73), standard), null);
  assert.deepEqual(projectCanvasEnuToSkyDisk([0, 0, 5], standard), projectEnuToSkyDisk([0, 0, 5]));
});

test('Canvas uses its actual ground mapping even when an external saved view would receive identity', () => {
  const data = snapshot(), directionEqj: Vec3 = [-Math.sin(.2 * Math.PI / 180), Math.cos(.2 * Math.PI / 180), 0];
  const before = structuredClone(data);
  for (const mode of ['space', 'globe', 'horizon'] as const) {
    assert.equal(getDisplayRefractionProfile(data, mode).identity, true);
    assert.equal(projectCanvasEqjToSkyDisk(directionEqj, data, getDisplayRefractionProfile(data, mode)), null);
    const actual = projectCanvasEqjToSkyDisk(directionEqj, data, getDisplayRefractionProfile(data, 'ground'));
    assert.ok(actual && actual.altitudeDeg > 0);
  }
  assert.deepEqual(data, before);
});

test('Canvas short arc clips at the apparent horizon and preserves sampled geometric great-circle directions', () => {
  const standard = profile(), start = horizontalToVector(-2, 30), end = horizontalToVector(8, 30);
  const arc = clipSampleCanvasSkyArcEnu(start, end, standard), sampler = createMinorArcSampler(start, end)!;
  assert.equal(arc.paths.length, 1);
  const path = arc.paths[0]!, root = minorArcAltitudeCrossings(sampler, [0, 0, 1], standard.geometricHorizonDeg)[0]!;
  close(path[0]!.radius, 1); close(path[0]!.altitudeDeg, 0);
  pointClose(path.at(-1)!, projectCanvasEnuToSkyDisk(end, standard)!);
  for (let index = 1; index < path.length; index++) {
    const expectedDirection = minorArcDirectionAt(sampler, root + (1 - root) * index / (path.length - 1));
    assert.deepEqual(path[index], projectCanvasEnuToSkyDisk(expectedDirection, standard));
    const geometric = unrefractEnuDirection(inverseSkyDiskToEnu(path[index]!.x, path[index]!.y)!, standard);
    assert.ok(angularSeparationDeg(geometric, expectedDirection) * 3600 < .1);
  }
  const reversed = clipSampleCanvasSkyArcEnu(end, start, standard).paths[0]!;
  assert.equal(reversed.length, path.length);
  for (let index = 0; index < path.length; index++) { close(path[index]!.x, reversed.at(-index - 1)!.x); close(path[index]!.y, reversed.at(-index - 1)!.y); }
});

test('two apparent-visible arc intervals never bridge their below-horizon middle and share the hard cap', () => {
  const standard = profile(), start = horizontalToVector(-.1, 0), end = horizontalToVector(-.1, 170);
  const sampler = createMinorArcSampler(start, end)!, roots = minorArcAltitudeCrossings(sampler, [0, 0, 1], standard.geometricHorizonDeg);
  assert.equal(roots.length, 2);
  assert.equal(projectCanvasEnuToSkyDisk(minorArcDirectionAt(sampler, .5), standard), null);
  const arc = clipSampleCanvasSkyArcEnu(start, end, standard, { maxAngularStepDeg: .00001, maxSegments: 2 });
  assert.equal(arc.paths.length, 2); assert.deepEqual(arc.paths.map(path => path.length), [2, 2]);
  assert.equal(arc.sampling.actualSegments, 2); assert.equal(arc.sampling.capLimited, true);
  assert.ok(arc.sampling.actualMaxAngularStepDeg > .00001);
  assert.deepEqual(arc.paths[0]![0], projectCanvasEnuToSkyDisk(start, standard));
  assert.deepEqual(arc.paths[1]!.at(-1), projectCanvasEnuToSkyDisk(end, standard));
  close(arc.paths[0]!.at(-1)!.radius, 1); close(arc.paths[1]![0]!.radius, 1);
  const bounded = clipSampleCanvasSkyArcEnu(start, end, standard, { maxAngularStepDeg: .00001, maxSegments: 256 });
  assert.equal(bounded.sampling.actualSegments, 256);
  assert.ok(bounded.paths.every(path => path.every(point => point.radius <= 1 && point.altitudeDeg >= 0)));
  // Independent review's near-horizon cap fixture: both endpoint apparent
  // altitudes are positive while the 90deg azimuth-separated middle is hidden.
  const closeStart = horizontalToVector(-.55, 0), closeEnd = horizontalToVector(-.55, 90);
  const closeSampler = createMinorArcSampler(closeStart, closeEnd)!;
  assert.ok(projectCanvasEnuToSkyDisk(closeStart, standard) && projectCanvasEnuToSkyDisk(closeEnd, standard));
  assert.equal(projectCanvasEnuToSkyDisk(minorArcDirectionAt(closeSampler, .5), standard), null);
  assert.equal(clipSampleCanvasSkyArcEnu(closeStart, closeEnd, standard).paths.length, 2);
});

test('Canvas arc seam, coincident and antipodal outcomes retain their scientific meaning', () => {
  const standard = profile(), start = horizontalToVector(20, 355), end = horizontalToVector(20, 5);
  const seam = clipSampleCanvasSkyArcEnu(start, end, standard).paths[0]!;
  assert.ok(seam.every(point => Math.abs(point.x) < .1 && point.y < -.7));
  assert.equal(clipSampleCanvasSkyArcEnu([0, 0, 1], [0, 0, 5], standard).paths[0]!.length, 1);
  assert.deepEqual(clipSampleCanvasSkyArcEnu([1, 0, 0], [-1, 0, 0], standard).paths, []);
  assert.equal(clipSampleCanvasSkyArcEnu([1, 0, 0], [-1, 0, 0], standard).sampling.ambiguousMinorArc, true);
  assert.deepEqual(clipSampleCanvasSkyArcEnu(horizontalToVector(-10, 0), horizontalToVector(-10, 180), standard).paths, []);
});

test('an extreme standard profile pins the visible -1deg derivative join without splitting the visible path', () => {
  const standard = deriveRefractionProfile(createRefractionDescriptor({ ...environment, refraction: 'standard', pressureHpa: 1200, temperatureC: -100 }));
  assert.ok(standard.apparentAltitudeDeg(-1) > 0);
  const start = horizontalToVector(-2, 30), end = horizontalToVector(4, 30);
  const arc = clipSampleCanvasSkyArcEnu(start, end, standard, { maxAngularStepDeg: 3, maxSegments: 64 });
  assert.equal(arc.paths.length, 1); assert.equal(arc.sampling.mandatoryKnotSegments, 2);
  const join = projectCanvasEnuToSkyDisk(horizontalToVector(-1, 30), standard)!;
  assert.ok(arc.paths[0]!.some(point => Math.hypot(point.x - join.x, point.y - join.y) < 1e-12));
  const splitStart = horizontalToVector(-.1, 0), splitEnd = horizontalToVector(-.1, 175);
  const split = clipSampleCanvasSkyArcEnu(splitStart, splitEnd, standard, { maxSegments: 2 });
  assert.equal(split.sampling.mandatoryKnotSegments, 4);
  assert.equal(split.sampling.knotBudgetExceeded, true); assert.equal(split.sampling.actualSegments, 0);
  assert.deepEqual(split.paths, [], 'an insufficient hard cap does not discard required joins or bridge intervals');
});

test('standard arc parameters explicitly require [2,256] and invalid directions stay invalid', () => {
  const standard = profile(), start: Vec3 = [1, 0, 1], end: Vec3 = [0, 1, 1];
  for (const maxSegments of [0, 1, 1.5, 257, NaN, Infinity]) assert.throws(() => clipSampleCanvasSkyArcEnu(start, end, standard, { maxSegments }), RangeError);
  for (const maxAngularStepDeg of [0, -1, NaN, Infinity, 90.001]) assert.throws(() => clipSampleCanvasSkyArcEnu(start, end, standard, { maxAngularStepDeg }), RangeError);
  for (const direction of [[0, 0, 0], [NaN, 1, 0], [Infinity, 0, 1]] as Vec3[]) {
    assert.throws(() => clipSampleCanvasSkyArcEnu(direction, end, standard), RangeError);
    assert.throws(() => projectCanvasEnuToSkyDisk(direction, standard), RangeError);
  }
  assert.equal(vectorToHorizontal(start).altitudeDeg, 45);
});

test('strict display-profile horizon and its immediate neighbours share the point/arc visibility boundary', () => {
  for (const pressureHpa of [1, 1010, 1200]) for (const temperatureC of [-100, 10, 80]) {
    const standard = deriveRefractionProfile(createRefractionDescriptor({ ...environment, refraction: 'standard', pressureHpa, temperatureC }));
    const h = standard.geometricHorizonDeg;
    close(standard.apparentAltitudeDeg(h), 0, 5e-14);
    const below = horizontalToVector(h - 1e-9, 73), above = horizontalToVector(h + 1e-9, 73);
    assert.equal(projectCanvasEnuToSkyDisk(below, standard), null);
    assert.ok(projectCanvasEnuToSkyDisk(above, standard));
    const arc = clipSampleCanvasSkyArcEnu(below, above, standard);
    assert.equal(arc.paths.length, 1); assert.equal(arc.paths[0]!.length, 2);
    close(arc.paths[0]![0]!.radius, 1); close(arc.paths[0]![0]!.altitudeDeg, 0);
    assert.ok(arc.paths[0]![1]!.altitudeDeg > 0);
  }
});
