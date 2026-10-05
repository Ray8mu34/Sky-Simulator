import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Euler, Matrix3, PerspectiveCamera } from 'three';
import { computeSnapshot } from '../src/core/astronomy';
import { getDisplayRefractionProfile } from '../src/core/refraction';
import { cameraFrameForState } from '../src/render/CameraActions';
import { displayDirection } from '../src/render/DisplayDirection';
import { multiplyVector } from '../src/render/coordinates';
import { scienceState } from './fixtures/science-state';
import * as BeforeEndpointReuse from '../qa/m5c-spherical-arcs/screen-endpoint-baseline/SphericalArcBuffer.before';
import * as BeforeSamplerCache from '../qa/m5c-spherical-arcs/sampler-cache-baseline/SphericalArcBuffer.before';
import type { StarAstrometry } from '../src/core/stars';
import { cachedStarEpoch, STAR_FLOAT32_DIRECTION_BOUND_ARCSEC, STAR_MOTION_CACHE_BOUND_ARCSEC, writeStarDirectionBuffer } from '../src/render/StarDirectionBuffer';
import { arcAltitudeCrossings, createMinorArcSampler, createSphericalArcBuffer, minorArcAltitudeCrossings, minorArcDirectionAt,
  SphericalArcDiagnostic, updateSphericalArcBuffer, writeConstellationHighlight } from '../src/render/SphericalArcBuffer';
import type { ArcDirection, ArcScreenPoint, SphericalArcBuffer, SphericalArcFigure, SphericalArcScreenError, SphericalArcUpdateOptions } from '../src/render/SphericalArcBuffer';

const RAD = Math.PI / 180;
const close = (actual: number, expected: number, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}, tolerance ${tolerance}`);
const direction = (longitude: number, latitude = 0): [number, number, number] => [Math.cos(latitude * RAD) * Math.cos(longitude * RAD), Math.cos(latitude * RAD) * Math.sin(longitude * RAD), Math.sin(latitude * RAD)];
function dot(a: ArcDirection, b: ArcDirection): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function separation(a: ArcDirection, b: ArcDirection): number {
  return Math.atan2(Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]), dot(a, b)) / RAD;
}
function vectorAt(buffer: SphericalArcBuffer, index: number): [number, number, number] {
  return [buffer.positions[index * 3]!, buffer.positions[index * 3 + 1]!, buffer.positions[index * 3 + 2]!];
}
function simpleBuffer(a: ArcDirection = [1, 0, 0], b: ArcDirection = [0, 1, 0], capacity = 128, maxExtraKnotsPerArc = 8): SphericalArcBuffer {
  const buffer = createSphericalArcBuffer({ starCount: 2, lineIndices: [0, 1], figures: [{ id: 'Test', lineStart: 0, lineCount: 1 }], maxSegmentsPerArc: capacity, maxExtraKnotsPerArc });
  buffer.starDirections.set(a); buffer.starDirections.set(b, 3);
  return buffer;
}

function assertArcBuffersByteIdentical(actual: SphericalArcBuffer, expected: SphericalArcBuffer): void {
  for (const key of ['positions', 'ordinaryIndex', 'highlightIndex', 'arcSegmentCounts', 'arcIndexStarts', 'arcDiagnostics'] as const) {
    const a = actual[key], b = expected[key];
    assert.deepEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength), key);
  }
  assert.deepEqual(actual.result, expected.result); assert.deepEqual([...actual.figureRanges], [...expected.figureRanges]);
}

function updateAndCompareSamplerCache(actual: SphericalArcBuffer, expected: SphericalArcBuffer, options: SphericalArcUpdateOptions): { atan2: number; hypot: number } {
  const previousAtan2 = Math.atan2, previousHypot = Math.hypot, calls = { atan2: 0, hypot: 0 };
  Math.atan2 = (y, x) => { calls.atan2++; return previousAtan2(y, x); };
  Math.hypot = (...values) => { calls.hypot++; return previousHypot(...values); };
  try { updateSphericalArcBuffer(actual, options); }
  finally { Math.atan2 = previousAtan2; Math.hypot = previousHypot; }
  BeforeSamplerCache.updateSphericalArcBuffer(expected, options);
  for (const id of actual.figureRanges.keys()) {
    assert.equal(writeConstellationHighlight(actual, id), BeforeSamplerCache.writeConstellationHighlight(expected, id));
    assertArcBuffersByteIdentical(actual, expected);
  }
  return calls;
}

test('sampler reuse requires all six raw scalars and still resamples changed screen/knots controls', () => {
  const createOptions = { starCount: 3, lineIndices: [0, 1, 1, 2], figures: [{ id: 'Pair', lineStart: 0, lineCount: 2 }] };
  const actual = createSphericalArcBuffer(createOptions), expected = BeforeSamplerCache.createSphericalArcBuffer(createOptions);
  const initial = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  actual.starDirections.set(initial); expected.starDirections.set(initial);
  let scale = 100, projectionCalls = 0;
  const scratch: [number, number] = [0, 0];
  const options: SphericalArcUpdateOptions = { maxAngularStepDeg: 30, screenError: { maxErrorPx: .35, project: value => {
    projectionCalls++; scratch[0] = scale * value[0]; scratch[1] = scale * value[1]; return scratch;
  } } };
  const observations: object[] = [];
  const run = (name: string, creations: number) => {
    projectionCalls = 0;
    const calls = updateAndCompareSamplerCache(actual, expected, options);
    assert.equal(calls.atan2, creations, name); assert.ok(projectionCalls > 0, 'Screen measurements must run on every update');
    observations.push({ name, samplerAtan2Calls: calls.atan2, projectionCalls, byteIdenticalBuffersAndDiagnostics: true });
  };
  run('first update of distinct arcs', 2); run('unchanged endpoint values', 0);
  const oldSegments = actual.result.totalSegments;
  scale = 400; run('changed display mapping', 0); assert.ok(actual.result.totalSegments > oldSegments);
  options.extraKnotsByArc = [[.123], [.321]]; run('changed mandatory knots', 0);
  for (let component = 0; component < 6; component++) {
    const affectedArcs = component < 3 ? 1 : 2;
    actual.starDirections[component] = expected.starDirections[component] = initial[component]! + .125;
    run(`in-place component ${component}`, affectedArcs);
    actual.starDirections[component] = expected.starDirections[component] = initial[component]!;
    run(`restore component ${component}`, affectedArcs);
  }
  assert.deepEqual(actual.starDirections, initial);
  mkdirSync('qa/m5c-spherical-arcs', { recursive: true });
  writeFileSync('qa/m5c-spherical-arcs/sampler-cache-key-regressions.json', JSON.stringify({ observations,
    evidence: 'Actual Math.atan2 calls counted only during production update, then complete buffers/results/ranges compared byte-for-byte with the frozen pre-cache source. Projection and mandatory knots run even on sampler reuse.' }, null, 2));
});

test('sampler cache distinguishes unestablished/antipodal/invalid states and signed zero during in-place recovery', () => {
  const createOptions = { starCount: 2, lineIndices: [0, 1], figures: [{ id: 'Test', lineStart: 0, lineCount: 1 }] };
  const actual = createSphericalArcBuffer(createOptions), expected = BeforeSamplerCache.createSphericalArcBuffer(createOptions);
  const options = { maxAngularStepDeg: 30 };
  const observations: object[] = [];
  const set = (a: ArcDirection, b: ArcDirection) => {
    for (const buffer of [actual, expected]) { buffer.starDirections.set(a); buffer.starDirections.set(b, 3); }
  };
  const run = (name: string) => {
    const calls = updateAndCompareSamplerCache(actual, expected, options);
    observations.push({ name, calls, invalid: actual.result.invalidArcCount, antipodal: actual.result.antipodalArcCount,
      coincident: actual.result.coincidentArcCount, byteIdenticalBuffersAndDiagnostics: true });
    return calls;
  };
  set([0, 0, 0], [0, 1, 0]); run('initial zero vector');
  assert.equal(actual.result.invalidArcCount, 1); assert.equal(actual.result.antipodalArcCount, 0);
  set([1, 0, 0], [0, 1, 0]); assert.equal(run('recover from unestablished invalid').atan2, 1);
  assert.equal(run('reuse valid sampler').atan2, 0);
  set([1, -0, 0], [0, 1, 0]); assert.equal(run('start positive-to-negative zero').atan2, 1);
  assert.ok(Object.is(actual.starDirections[1], -0)); assert.equal(run('reuse negative zero').atan2, 0);
  set([1, 0, 0], [0, 1, -0]); assert.equal(run('end negative zero and restore start zero').atan2, 1);
  set([1, 0, 0], [0, 1, 0]); assert.equal(run('restore all positive zero').atan2, 1);
  for (const [a, b] of [
    [[NaN, 0, 0], [0, 1, 0]], [[1, Infinity, 0], [0, 1, 0]], [[0, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, NaN, 0]], [[1, 0, 0], [0, -Infinity, 0]],
  ] as readonly (readonly [ArcDirection, ArcDirection])[]) {
    const retained = actual.positions.slice(actual.starCount * 3);
    set(a, b); run('invalid replacement'); run('same invalid values again');
    assert.equal(actual.result.invalidArcCount, 1); assert.equal(actual.result.antipodalArcCount, 0);
    assert.equal(actual.result.indexCount, 0); assert.deepEqual(actual.positions.subarray(actual.starCount * 3), retained);
    set([1, 0, 0], [0, 1, 0]); assert.equal(run('recover old six values after invalid').atan2, 1);
    assert.ok(actual.result.indexCount > 0); assert.equal(actual.result.invalidArcCount, 0);
  }
  set([1, 0, 0], [-1, 0, 0]); assert.equal(run('first antipodal').hypot, 3);
  assert.equal(actual.result.antipodalArcCount, 1); assert.equal(actual.result.invalidArcCount, 0);
  assert.equal(run('reuse antipodal null').hypot, 0);
  set([NaN, 0, 0], [-1, 0, 0]); run('invalid replaces null');
  assert.equal(actual.result.invalidArcCount, 1); assert.equal(actual.result.antipodalArcCount, 0);
  set([1, 0, 0], [-1, 0, 0]); assert.equal(run('restore antipodal after invalid').hypot, 3);
  set([1, 0, 0], [2, 0, 0]); assert.equal(run('replace null with coincident sampler').atan2, 1);
  assert.equal(actual.result.coincidentArcCount, 1); assert.equal(run('reuse coincident sampler').atan2, 0);
  set([1, 0, 0], [0, 1, 0]); assert.equal(run('recover ordinary arc').atan2, 1);
  const baselineSha256 = createHash('sha256').update(readFileSync(new URL('../qa/m5c-spherical-arcs/sampler-cache-baseline/SphericalArcBuffer.before.ts', import.meta.url))).digest('hex');
  assert.equal(baselineSha256, '1ab2dca0d2088689d4a2817c0e58703d3476da58703133be328c178faac0b786');
  writeFileSync('qa/m5c-spherical-arcs/sampler-cache-state-regressions.json', JSON.stringify({ baselineSha256,
    optimizedSha256: createHash('sha256').update(readFileSync(new URL('../src/render/SphericalArcBuffer.ts', import.meta.url))).digest('hex'), observations }, null, 2));
});

test('minor arcs are unit great-circle directions across RA0 and remain reversal-consistent on long arcs', () => {
  const seam = createMinorArcSampler(direction(359), direction(1))!;
  close(seam.angleRad / RAD, 2); close(minorArcDirectionAt(seam, .5)[0], 1);
  close(minorArcDirectionAt(seam, .5)[1], 0);
  const start = direction(12, 20), end = direction(161, -11);
  const arc = createMinorArcSampler(start, end)!, reverse = createMinorArcSampler(end, start)!;
  assert.ok(arc.angleRad / RAD > 140 && arc.angleRad < Math.PI);
  const plane: [number, number, number] = [start[1] * end[2] - start[2] * end[1], start[2] * end[0] - start[0] * end[2], start[0] * end[1] - start[1] * end[0]];
  for (let step = 0; step <= 100; step++) {
    const sampled = minorArcDirectionAt(arc, step / 100), reversed = minorArcDirectionAt(reverse, 1 - step / 100);
    close(Math.hypot(...sampled), 1); close(dot(plane, sampled), 0);
    sampled.forEach((value, axis) => close(value, reversed[axis]!));
    close(separation(start, sampled), arc.angleRad / RAD * step / 100, 1e-11);
  }
});

test('same and nearly same directions are stable; exact/near antipodes are explicitly omitted', () => {
  const start = Object.freeze([4, 0, 0] as const), end = Object.freeze([8, 0, 0] as const);
  const coincident = createMinorArcSampler(start, end)!;
  assert.equal(coincident.coincident, true); close(coincident.angleRad, 0);
  const scratch: [number, number, number] = [0, 0, 0];
  assert.equal(minorArcDirectionAt(coincident, .5, scratch), scratch); assert.deepEqual(scratch, [1, 0, 0]);
  assert.deepEqual(start, [4, 0, 0]); assert.deepEqual(end, [8, 0, 0]);
  for (const offset of [1e-16, 1e-14, 1e-10]) {
    const near = createMinorArcSampler([1, 0, 0], [1, offset, 0])!;
    assert.ok(minorArcDirectionAt(near, .5).every(Number.isFinite)); close(Math.hypot(...minorArcDirectionAt(near, .5)), 1);
  }
  assert.equal(createMinorArcSampler([1, 0, 0], [-1, 0, 0]), null);
  assert.equal(createMinorArcSampler([1, 0, 0], [-1, 1e-14, 0]), null);
  const resolvable = createMinorArcSampler([1, 0, 0], [-1, 1e-10, 0])!;
  assert.ok(resolvable.angleRad < Math.PI && resolvable.angleRad > Math.PI - 1e-9);
  close(Math.hypot(...minorArcDirectionAt(resolvable, .5)), 1);
  const sameBuffer = simpleBuffer(start, end);
  const before = sameBuffer.starDirections.slice();
  const sameResult = updateSphericalArcBuffer(sameBuffer);
  assert.equal(sameResult.coincidentArcCount, 1); assert.equal(sameResult.totalSegments, 1);
  assert.deepEqual([...sameBuffer.ordinaryIndex.subarray(0, 2)], [0, 1]); assert.deepEqual(sameBuffer.starDirections, before);
  const antipodal = simpleBuffer([1, 0, 0], [-1, 0, 0]);
  assert.equal(updateSphericalArcBuffer(antipodal).indexCount, 0);
  assert.equal(antipodal.result.antipodalArcCount, 1); assert.equal(antipodal.arcDiagnostics[0], SphericalArcDiagnostic.Antipodal);
});

test('altitude intersections include both roots and tangency, exclude endpoints and whole boundary arcs', () => {
  const up: ArcDirection = [0, 0, 1];
  const above = createMinorArcSampler(direction(0, 30), direction(180, 30))!;
  assert.deepEqual(minorArcAltitudeCrossings(above, up, 60).map(value => Math.round(value * 100)), [25, 75]);
  const tangent = minorArcAltitudeCrossings(above, up, 90);
  assert.equal(tangent.length, 1); close(tangent[0]!, .5);
  const below = createMinorArcSampler(direction(0, -.5), direction(180, -.5))!;
  const twoLowRoots = minorArcAltitudeCrossings(below, up, -1);
  assert.equal(twoLowRoots.length, 2); close(twoLowRoots[0]!, .5 / 179, 1e-13); close(twoLowRoots[1]!, 1 - .5 / 179, 1e-13);
  for (const fraction of twoLowRoots) close(dot(minorArcDirectionAt(below, fraction), up), Math.sin(-RAD));
  assert.deepEqual(minorArcAltitudeCrossings(below, up, 0), []);
  const reversal = arcAltitudeCrossings(below.end, below.start, up, -1);
  reversal.forEach((value, index) => close(value, 1 - twoLowRoots[twoLowRoots.length - 1 - index]!));
  const equator = createMinorArcSampler(direction(-60), direction(60))!;
  const obliqueUp: ArcDirection = [.5, 0, Math.sqrt(.75)];
  const inclinedTangency = minorArcAltitudeCrossings(equator, obliqueUp, 30);
  assert.equal(inclinedTangency.length, 1); close(inclinedTangency[0]!, .5);
  assert.deepEqual(minorArcAltitudeCrossings(equator, up, 0), []);
  assert.deepEqual(arcAltitudeCrossings(direction(0, 30), direction(0, 60), up, 30), []);
  assert.deepEqual(arcAltitudeCrossings(direction(0, 30), direction(0, 60), up, 60), []);
  assert.deepEqual(arcAltitudeCrossings([1, 0, 0], [-1, 0, 0], up, 0), []);
  assert.deepEqual(arcAltitudeCrossings([1, 0, 0], [2, 0, 0], up, 0), []);
});

test('fixed interior slots connect original star indices and reuse selection/result/range storage', () => {
  const buffer = simpleBuffer([1, 0, 0], [0, 1, 0], 8);
  const positions = buffer.positions, ordinary = buffer.ordinaryIndex, highlight = buffer.highlightIndex, stars = buffer.starDirections;
  const result = buffer.result, range = buffer.figureRanges.get('Test')!;
  const prefixBytes = new Uint8Array(stars.buffer, stars.byteOffset, stars.byteLength).slice();
  assert.equal(stars.buffer, positions.buffer); assert.equal(stars.byteOffset, positions.byteOffset);
  assert.equal(positions.length, (2 + 7) * 3);
  assert.equal(updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 30 }), result);
  assert.equal(result.totalSegments, 3); assert.equal(result.indexCount, 6);
  assert.deepEqual([...ordinary.subarray(0, result.indexCount)], [0, 2, 2, 3, 3, 1]);
  close(vectorAt(buffer, 2)[0], Math.cos(30 * RAD), 5e-8); close(vectorAt(buffer, 2)[1], Math.sin(30 * RAD), 5e-8);
  close(vectorAt(buffer, 3)[0], Math.cos(60 * RAD), 5e-8); close(vectorAt(buffer, 3)[1], Math.sin(60 * RAD), 5e-8);
  for (let cycle = 0; cycle < 100; cycle++) {
    const step = cycle % 2 ? 45 : 30;
    updateSphericalArcBuffer(buffer, { maxAngularStepDeg: step });
    const count = writeConstellationHighlight(buffer, 'Test');
    assert.equal(count, range.indexCount); assert.deepEqual(highlight.subarray(0, count), ordinary.subarray(range.indexStart, range.indexStart + count));
    assert.equal(writeConstellationHighlight(buffer, null), 0); assert.equal(writeConstellationHighlight(buffer, 'Unknown'), 0);
    assert.equal(buffer.positions, positions); assert.equal(buffer.ordinaryIndex, ordinary); assert.equal(buffer.highlightIndex, highlight);
    assert.equal(buffer.starDirections, stars); assert.equal(buffer.result, result); assert.equal(buffer.figureRanges.get('Test'), range);
  }
  assert.deepEqual(new Uint8Array(stars.buffer, stars.byteOffset, stars.byteLength), prefixBytes);
});

test('caller-provided analytic refraction/horizon knots are preserved and deduplicated within fixed capacity', () => {
  const buffer = simpleBuffer(direction(0, -5), direction(0, 5));
  const sampler = createMinorArcSampler(vectorAt(buffer, 0), vectorAt(buffer, 1))!;
  const knots = [-1, -.566].flatMap(altitude => minorArcAltitudeCrossings(sampler, [0, 0, 1], altitude));
  assert.equal(knots.length, 2);
  const before = buffer.starDirections.slice();
  const result = updateSphericalArcBuffer(buffer, { extraKnotsByArc: [[...knots, knots[0]!, 0, 1]] });
  assert.equal(result.budgetExceededArcCount, 0); assert.equal(result.invalidArcCount, 0);
  assert.ok(result.maxActualAngularStepDeg <= .5 + 1e-12);
  for (const knot of knots) {
    const expected = minorArcDirectionAt(sampler, knot);
    assert.ok([...buffer.ordinaryIndex.subarray(0, result.indexCount)].some(index => separation(vectorAt(buffer, index), expected) < 1e-5));
  }
  assert.deepEqual(buffer.starDirections, before);
  const deduplicated = simpleBuffer([1, 0, 0], [0, 1, 0], 4);
  assert.equal(updateSphericalArcBuffer(deduplicated, { maxAngularStepDeg: 90, extraKnotsByArc: [[.25, .25, 0, 1]] }).totalSegments, 2);
});

test('capacity overflow is an explicit omitted arc; invalid endpoints/knots never contaminate indices', () => {
  const angularOverflow = simpleBuffer([1, 0, 0], [0, 1, 0], 2);
  const angular = updateSphericalArcBuffer(angularOverflow, { maxAngularStepDeg: 1 });
  assert.equal(angular.indexCount, 0); assert.equal(angular.budgetExceededArcCount, 1);
  assert.ok(angularOverflow.arcDiagnostics[0]! & SphericalArcDiagnostic.BudgetExceeded);
  const knotOverflow = updateSphericalArcBuffer(angularOverflow, { maxAngularStepDeg: 45, extraKnotsByArc: [[.25]] });
  assert.equal(knotOverflow.indexCount, 0); assert.equal(knotOverflow.budgetExceededArcCount, 1);
  const inputOverflow = simpleBuffer([1, 0, 0], [0, 1, 0], 128, 0);
  assert.equal(updateSphericalArcBuffer(inputOverflow, { extraKnotsByArc: [[.5]] }).budgetExceededArcCount, 1);
  for (const invalid of [NaN, Infinity, -.1, 1.1]) {
    const buffer = simpleBuffer();
    assert.equal(updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 30, extraKnotsByArc: [[invalid]] }).invalidArcCount, 1);
    assert.equal(buffer.result.indexCount, 0);
  }
  for (const endpoint of [[0, 0, 0], [NaN, 1, 0], [1, Infinity, 0]] as const) {
    const buffer = simpleBuffer(endpoint);
    assert.equal(updateSphericalArcBuffer(buffer).invalidArcCount, 1); assert.equal(buffer.result.indexCount, 0);
  }
  // A subsequent valid update uses the same arrays and recovers the range.
  assert.equal(updateSphericalArcBuffer(angularOverflow, { maxAngularStepDeg: 45 }).indexCount, 4);
  assert.equal(writeConstellationHighlight(angularOverflow, 'Test'), 4);
});

test('optional screen subdivisions observe midpoint chord error, and budget misses remain explicit', () => {
  const projection = (value: ArcDirection): readonly [number, number] => [100 * value[0], 100 * value[1]];
  const buffer = simpleBuffer();
  const result = updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 90, screenError: { project: projection, maxErrorPx: .1 } });
  assert.equal(result.pixelErrorStatus, 'sampled-within-tolerance'); assert.equal(result.unmeasurableArcCount, 0);
  assert.ok(result.totalSegments > 1 && result.totalSegments <= 128);
  assert.ok(result.maxObservedScreenErrorPx <= .1); assert.equal(result.screenTestedSegmentCount, result.totalSegments);
  const reusablePoint: [number, number] = [0, 0];
  const reuseBuffer = simpleBuffer();
  const reusedResult = updateSphericalArcBuffer(reuseBuffer, { maxAngularStepDeg: 90, screenError: {
    project: value => { reusablePoint[0] = 100 * value[0]; reusablePoint[1] = 100 * value[1]; return reusablePoint; }, maxErrorPx: .1,
  } });
  assert.equal(reusedResult.totalSegments, result.totalSegments); assert.ok(reusedResult.totalSegments > 1);
  close(reusedResult.maxObservedScreenErrorPx, result.maxObservedScreenErrorPx);
  assert.deepEqual(reuseBuffer.ordinaryIndex.subarray(0, reusedResult.indexCount), buffer.ordinaryIndex.subarray(0, result.indexCount));
  const overflow = simpleBuffer([1, 0, 0], [0, 1, 0], 1);
  const failed = updateSphericalArcBuffer(overflow, { maxAngularStepDeg: 90, screenError: { project: projection, maxErrorPx: .1 } });
  assert.equal(failed.indexCount, 0); assert.equal(failed.budgetExceededArcCount, 1); assert.equal(failed.pixelErrorStatus, 'budget-exceeded');
  assert.ok(failed.maxObservedScreenErrorPx > .1);
  const straight = simpleBuffer();
  assert.equal(updateSphericalArcBuffer(straight, { maxAngularStepDeg: 90, screenError: {
    project: value => [Math.atan2(value[1], value[0]) * 100, 0], maxErrorPx: .0001,
  } }).totalSegments, 1);
});

test('a later screen-cap failure leaves every old interior slot untouched after an earlier accepted leaf', () => {
  const options = { starCount: 2, lineIndices: [0, 1], figures: [{ id: 'Test', lineStart: 0, lineCount: 1 }], maxSegmentsPerArc: 2 };
  const original = BeforeEndpointReuse.createSphericalArcBuffer(options), buffer = createSphericalArcBuffer(options);
  for (const candidate of [original, buffer]) candidate.positions.set([1, 0, 0, 0, 1, 0, .123, .456, .789]);
  const oldPositions = buffer.positions.slice();
  const scratch: [number, number] = [0, 0];
  const project = (value: ArcDirection): ArcScreenPoint => {
    const t = Math.atan2(value[1], value[0]) / (Math.PI / 2);
    // The first half is straight and accepted; only the later half overflows.
    scratch[0] = t * 100; scratch[1] = (Math.max(0, t - .5) * 100) ** 2;
    return scratch;
  };
  const updateOptions = { maxAngularStepDeg: 45, screenError: { project, maxErrorPx: .35 } };
  const before = BeforeEndpointReuse.updateSphericalArcBuffer(original, updateOptions), after = updateSphericalArcBuffer(buffer, updateOptions);
  assert.equal(after.screenTestedSegmentCount, 1); assert.equal(after.budgetExceededArcCount, 1); assert.equal(after.indexCount, 0);
  assert.deepEqual(after, before); assert.deepEqual(buffer.positions, oldPositions); assert.deepEqual(buffer.positions, original.positions);
  assert.deepEqual(buffer.ordinaryIndex, original.ordinaryIndex); assert.deepEqual(buffer.arcDiagnostics, original.arcDiagnostics);
});

test('null/nonfinite screen projection retains angular segments and never reports pixel acceptance', () => {
  const buffer = simpleBuffer();
  const baseline = updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 10 }).indexCount;
  const referenceIndices = buffer.ordinaryIndex.slice(0, baseline);
  const result = updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 10, screenError: {
    project: value => value[0] < .2 || value[1] < .2 ? null : [value[0], value[1]], maxErrorPx: 100,
  } });
  assert.equal(result.indexCount, baseline); assert.deepEqual(buffer.ordinaryIndex.subarray(0, baseline), referenceIndices);
  assert.equal(result.pixelErrorStatus, 'unmeasurable'); assert.equal(result.unmeasurableArcCount, 1);
  assert.ok(result.screenUnmeasurableSegmentCount > 0); assert.ok(result.screenTestedSegmentCount > 0);
  assert.ok(buffer.arcDiagnostics[0]! & SphericalArcDiagnostic.ScreenUnmeasurable);
  const interiorVisible = simpleBuffer();
  const retained = updateSphericalArcBuffer(interiorVisible, { maxAngularStepDeg: 90, screenError: {
    project: value => value[0] < .1 || value[1] < .1 ? null : [value[0], value[1]], maxErrorPx: .01,
  } });
  assert.equal(retained.indexCount, 2); assert.equal(retained.pixelErrorStatus, 'unmeasurable');
  assert.deepEqual([...interiorVisible.ordinaryIndex.subarray(0, 2)], [0, 1]);
  const nonfinite = updateSphericalArcBuffer(buffer, { maxAngularStepDeg: 10, screenError: { project: () => [Infinity, NaN], maxErrorPx: 1 } });
  assert.ok(nonfinite.indexCount > 0); assert.equal(nonfinite.pixelErrorStatus, 'unmeasurable');
});

test('public controls and invalid pure-helper inputs fail explicitly', () => {
  for (const bad of [[0, 0, 0], [NaN, 0, 1], [0, Infinity, 1]] as const) {
    assert.throws(() => createMinorArcSampler(bad, [1, 0, 0]), RangeError);
    assert.throws(() => arcAltitudeCrossings([1, 0, 0], [0, 1, 0], bad, 0), RangeError);
  }
  const sampler = createMinorArcSampler([1, 0, 0], [0, 1, 0])!;
  for (const fraction of [-.1, 1.1, NaN, Infinity]) assert.throws(() => minorArcDirectionAt(sampler, fraction), RangeError);
  for (const altitude of [-90.1, 90.1, NaN, Infinity]) assert.throws(() => minorArcAltitudeCrossings(sampler, [0, 0, 1], altitude), RangeError);
  for (const capacity of [0, 1.5, 4097, NaN, Infinity]) assert.throws(() => simpleBuffer([1, 0, 0], [0, 1, 0], capacity), RangeError);
  for (const knots of [-1, 1.5, 65, NaN]) assert.throws(() => simpleBuffer([1, 0, 0], [0, 1, 0], 128, knots), RangeError);
  for (const step of [0, -.1, 90.1, NaN, Infinity]) assert.throws(() => updateSphericalArcBuffer(simpleBuffer(), { maxAngularStepDeg: step }), RangeError);
  for (const error of [0, -1, NaN, Infinity]) assert.throws(() => updateSphericalArcBuffer(simpleBuffer(), { screenError: { project: () => [0, 0], maxErrorPx: error } }), RangeError);
  assert.throws(() => updateSphericalArcBuffer(simpleBuffer(), { extraKnotsByArc: [[], []] }), RangeError);
  for (const indices of [[0], [0, 2], [0, -.1], [0, NaN]]) assert.throws(() => createSphericalArcBuffer({ starCount: 2, lineIndices: indices, figures: [{ id: 'Test', lineStart: 0, lineCount: 1 }] }), RangeError);
  assert.throws(() => createSphericalArcBuffer({ starCount: 2, lineIndices: [0, 1], figures: [] }), RangeError);
  assert.throws(() => createSphericalArcBuffer({ starCount: 2, lineIndices: [0, 1], figures: [{ id: 'Test', lineStart: 1, lineCount: 1 }] }), RangeError);
});

test('all676 catalog arcs at both domain endpoints/J2000 retain shared endpoints, unit interiors and88 reusable figure ranges', () => {
  // Rehydrate source scalars because Node does not implement Vite's unchanged ?raw catalog adapter.
  const metadata: unknown[][] = JSON.parse(readFileSync(new URL('../assets/runtime/star-meta.json', import.meta.url), 'utf8'));
  const source: { lineIndices: number[]; constellations: SphericalArcFigure[] } = JSON.parse(readFileSync(new URL('../assets/runtime/constellation-meta.json', import.meta.url), 'utf8'));
  const stars: StarAstrometry[] = metadata.map(record => ({ id: record[0] as StarAstrometry['id'], raHours: record[3] as number, decDeg: record[4] as number,
    pmRaCosDecMasYr: record[10] as number, pmDecMasYr: record[11] as number, qualityFlags: record[12] as number,
    distancePc: record[13] as number | null, radialVelocityKmS: record[14] as number | null }));
  assert.equal(stars.length, 8921); assert.equal(source.lineIndices.length / 2, 676); assert.equal(source.constellations.length, 88);
  const buffer = createSphericalArcBuffer({ starCount: stars.length, lineIndices: new Uint16Array(source.lineIndices), figures: source.constellations });
  const ranges = source.constellations.map(figure => buffer.figureRanges.get(figure.id)!);
  const originalBuffers = [buffer.positions, buffer.starDirections, buffer.ordinaryIndex, buffer.highlightIndex, buffer.arcSegmentCounts, buffer.arcIndexStarts, buffer.arcDiagnostics];
  const dates = [990574.5 - 2451545, 0, 3182395.5 - 2451545];
  const measurements: { ut: number; epoch: number; totalSegments: number; maximumSegments: number; maximumArcDeg: number; maxActualFloat32StepDeg: number; maximumNormError: number; maximumPlaneResidual: number; updateCpuMs: number }[] = [];
  for (const ut of dates) {
    const epoch = cachedStarEpoch(ut);
    writeStarDirectionBuffer(stars, epoch, buffer.starDirections);
    const prefixBytes = new Uint8Array(buffer.starDirections.buffer, buffer.starDirections.byteOffset, buffer.starDirections.byteLength).slice();
    const updateStart = performance.now();
    const result = updateSphericalArcBuffer(buffer);
    const updateCpuMs = performance.now() - updateStart;
    assert.equal(result.antipodalArcCount + result.coincidentArcCount + result.invalidArcCount + result.budgetExceededArcCount, 0);
    assert.equal(result.pixelErrorStatus, 'not-requested'); assert.ok(result.maxActualAngularStepDeg <= .5 + 1e-12);
    let maximumArcDeg = 0, maximumSegments = 0, maximumNormError = 0, maximumPlaneResidual = 0, maxActualFloat32StepDeg = 0;
    for (let arc = 0; arc < buffer.arcCount; arc++) {
      const count = buffer.arcSegmentCounts[arc]!, at = buffer.arcIndexStarts[arc]!, a = source.lineIndices[arc * 2]!, b = source.lineIndices[arc * 2 + 1]!;
      const sampler = createMinorArcSampler(vectorAt(buffer, a), vectorAt(buffer, b))!;
      maximumArcDeg = Math.max(maximumArcDeg, sampler.angleRad / RAD); maximumSegments = Math.max(maximumSegments, count);
      assert.ok(count > 0 && count <= 128); assert.equal(buffer.ordinaryIndex[at], a); assert.equal(buffer.ordinaryIndex[at + count * 2 - 1], b);
      const plane: ArcDirection = [sampler.start[1] * sampler.tangent[2] - sampler.start[2] * sampler.tangent[1], sampler.start[2] * sampler.tangent[0] - sampler.start[0] * sampler.tangent[2], sampler.start[0] * sampler.tangent[1] - sampler.start[1] * sampler.tangent[0]];
      for (let segment = 0; segment < count; segment++) {
        const from = buffer.ordinaryIndex[at + segment * 2]!, to = buffer.ordinaryIndex[at + segment * 2 + 1]!;
        if (segment > 0) assert.equal(from, buffer.starCount + arc * 127 + segment - 1);
        if (segment < count - 1) assert.equal(to, buffer.starCount + arc * 127 + segment);
        const first = vectorAt(buffer, from), second = vectorAt(buffer, to), actualStep = separation(first, second);
        maxActualFloat32StepDeg = Math.max(maxActualFloat32StepDeg, actualStep);
        assert.ok(actualStep <= .5 + 2 * STAR_FLOAT32_DIRECTION_BOUND_ARCSEC / 3600 + 1e-10, `Float32 arc ${arc}: ${actualStep}`);
        for (const point of [first, second]) {
          const normError = Math.abs(Math.hypot(...point) - 1), residual = Math.abs(dot(plane, point));
          maximumNormError = Math.max(maximumNormError, normError); maximumPlaneResidual = Math.max(maximumPlaneResidual, residual);
          assert.ok(normError <= 1e-7); assert.ok(residual <= 1e-7);
        }
      }
    }
    assert.ok(maximumSegments <= 44);
    for (let i = 0; i < source.constellations.length; i++) {
      const figure = source.constellations[i]!, range = buffer.figureRanges.get(figure.id)!;
      assert.equal(range, ranges[i]);
      const count = writeConstellationHighlight(buffer, figure.id);
      assert.equal(count, range.indexCount); assert.ok(count <= buffer.highlightIndex.length);
      assert.deepEqual(buffer.highlightIndex.subarray(0, count), buffer.ordinaryIndex.subarray(range.indexStart, range.indexStart + count));
      assert.equal(count, [...buffer.arcSegmentCounts.subarray(figure.lineStart, figure.lineStart + figure.lineCount)].reduce((sum, value) => sum + value * 2, 0));
    }
    assert.deepEqual(new Uint8Array(buffer.starDirections.buffer, buffer.starDirections.byteOffset, buffer.starDirections.byteLength), prefixBytes);
    const currentBuffers = [buffer.positions, buffer.starDirections, buffer.ordinaryIndex, buffer.highlightIndex, buffer.arcSegmentCounts, buffer.arcIndexStarts, buffer.arcDiagnostics];
    currentBuffers.forEach((value, index) => assert.equal(value, originalBuffers[index]));
    measurements.push({ ut, epoch, totalSegments: result.totalSegments, maximumSegments, maximumArcDeg, maxActualFloat32StepDeg, maximumNormError, maximumPlaneResidual, updateCpuMs });
  }
  const paddedMaximumDays = Math.max(...dates.map(Math.abs)) + 15;
  const endpointMotionBoundDeg = STAR_MOTION_CACHE_BOUND_ARCSEC / 3600 / 15 * paddedMaximumDays;
  const j2000ArcDeg = measurements[1]!.maximumArcDeg;
  const allTimeConservativeArcDeg = j2000ArcDeg + 2 * endpointMotionBoundDeg + 2 * STAR_FLOAT32_DIRECTION_BOUND_ARCSEC / 3600;
  const allTimeBaseSegmentBound = Math.ceil(allTimeConservativeArcDeg / .5);
  assert.ok(allTimeBaseSegmentBound <= 77 && allTimeBaseSegmentBound + 8 <= 128);
  const stressPrefix = buffer.starDirections.slice(), stressTimings: number[] = [], stressSteps = [.5, .6, .75];
  for (let cycle = 0; cycle < 96; cycle++) {
    const started = performance.now();
    updateSphericalArcBuffer(buffer, { maxAngularStepDeg: stressSteps[cycle % stressSteps.length] });
    writeConstellationHighlight(buffer, source.constellations[cycle % source.constellations.length]!.id);
    stressTimings.push(performance.now() - started);
    [buffer.positions, buffer.starDirections, buffer.ordinaryIndex, buffer.highlightIndex, buffer.arcSegmentCounts, buffer.arcIndexStarts, buffer.arcDiagnostics]
      .forEach((value, index) => assert.equal(value, originalBuffers[index]));
    source.constellations.forEach((figure, index) => assert.equal(buffer.figureRanges.get(figure.id), ranges[index]));
  }
  assert.deepEqual(buffer.starDirections, stressPrefix);
  const sortedStressTimings = [...stressTimings].sort((a, b) => a - b);
  const memory = { positionsBytes: buffer.positions.byteLength, ordinaryIndexBytes: buffer.ordinaryIndex.byteLength, highlightIndexBytes: buffer.highlightIndex.byteLength,
    arcMetadataTypedArrayBytes: buffer.arcSegmentCounts.byteLength + buffer.arcIndexStarts.byteLength + buffer.arcDiagnostics.byteLength,
    privateEndpointCopyBytes: source.lineIndices.length * 4, privateFractionScratchBytes: 129 * 8, privateSampledInteriorScratchBytes: 127 * 3 * 4,
    privateSamplerEndpointKeyBytes: buffer.arcCount * 6 * 8 };
  assert.equal(memory.positionsBytes, 1_137_276); assert.equal(memory.ordinaryIndexBytes, 692_224); assert.equal(memory.highlightIndexBytes, 27_648);
  mkdirSync('qa/m5c-spherical-arcs', { recursive: true });
  writeFileSync('qa/m5c-spherical-arcs/buffer-report.json', JSON.stringify({ schemaVersion: 1, counts: { stars: stars.length, arcs: buffer.arcCount, figures: ranges.length }, measurements,
    conservativeCapacity: { paddedMaximumDays, endpointMotionBoundDeg, allTimeConservativeArcDeg, allTimeBaseSegmentBound, fixedSegmentCapacity: 128, reservedInputKnots: 8,
      basis: 'Existing independent source-scalar audit bounds interval-global angular speed; integrate that bound from J2000 for each endpoint. Catalog/astrometry errors and display projection are excluded.' },
    memory: { ...memory, sharedGpuArrayBytes: memory.positionsBytes + memory.ordinaryIndexBytes + memory.highlightIndexBytes,
      ownedTypedArrayBytes: Object.values(memory).reduce((sum, value) => sum + value, 0), starPrefixViewAllocatesNoStorage: true,
      boundedSamplerJsRetention: { arraysOfSamplerReferences: 1, maximumReferenceSlots: buffer.arcCount, maximumSamplerObjects: buffer.arcCount,
        maximumThreeNumberTuples: buffer.arcCount * 3, numericFieldsIncludingAngles: buffer.arcCount * 10,
        exactJsBytes: null, basis: 'Object/array headers, numeric storage and reference bytes depend on the JS engine. Replacements retain no sampler history.' } },
    boundedReuseStress: { updates: stressTimings.length, figureSelections: stressTimings.length, angularStepsDeg: stressSteps,
      p50UpdateAndHighlightCpuMs: sortedStressTimings[Math.floor(sortedStressTimings.length * .5)],
      p95UpdateAndHighlightCpuMs: sortedStressTimings[Math.floor(sortedStressTimings.length * .95)], maximumCpuMs: sortedStressTimings.at(-1),
      typedArrayAndFigureRangeIdentityStable: true, starPrefixUnchanged: true, runtime: process.version,
      scope: 'Short Node CPU observation without screen projection; no frame/GPU or long-duration performance acceptance.' },
    evidence: 'Production writeStarDirectionBuffer and updateSphericalArcBuffer on all676 source arcs at three cached epochs; byte-identical prefix, endpoint index identity, unit/plane residuals, all88 highlight copies and storage identity checked.',
    limits: 'No GPU/browser/occlusion validation. Optional screen status measures displayed midpoint distance to its chord, not a rigorous full-curve pixel error bound; clip/null segments remain drawn and unmeasurable.' }, null, 2));
});

test('screen endpoint optimization preserves frozen source golden buffers and diagnostics with real frame/profile projections', () => {
  const baselineSha = '39304a9b3d8494a8a17721e39701417d318277093bdba2f884c9ed8e24ce0546';
  const baselineSource = readFileSync(new URL('../qa/m5c-spherical-arcs/screen-endpoint-baseline/SphericalArcBuffer.before.ts', import.meta.url));
  assert.equal(createHash('sha256').update(baselineSource).digest('hex'), baselineSha);
  const hashArray = (array: ArrayBufferView) => createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  interface Fixture {
    name: string; directions: Float32Array; lines: number[]; figures: SphericalArcFigure[]; capacity: number; step: number;
    knots?: readonly (ArrayLike<number> | undefined)[]; projector?: () => (value: ArcDirection) => ArcScreenPoint | null;
  }
  const pair = new Float32Array([1, 0, 0, 0, 1, 0]), figures = [{ id: 'Test', lineStart: 0, lineCount: 1 }];
  const fixtures: Fixture[] = [
    { name: 'curved-shared-screen-tuple', directions: pair, lines: [0, 1], figures, capacity: 128, step: 10, projector: () => {
      const scratch: [number, number] = [0, 0]; return value => { scratch[0] = value[0] * 100; scratch[1] = value[1] * 100; return scratch; };
    } },
    { name: 'screen-budget-overflow', directions: pair, lines: [0, 1], figures, capacity: 1, step: 90, projector: () => value => [value[0] * 100, value[1] * 100] },
    { name: 'near-clip-visible-interior', directions: pair, lines: [0, 1], figures, capacity: 128, step: 10,
      projector: () => value => value[0] < .2 || value[1] < .2 ? null : [value[0] * 100, value[1] * 100] },
    { name: 'nonfinite-screen', directions: pair, lines: [0, 1], figures, capacity: 128, step: 10, projector: () => () => [Infinity, NaN] },
    { name: 'angular-budget-without-projection', directions: pair, lines: [0, 1], figures, capacity: 128, step: .5 },
    { name: 'knots-without-projection', directions: pair, lines: [0, 1], figures, capacity: 128, step: 1, knots: [[.125, .2, .2, 0, 1]] },
  ];
  const metadata: unknown[][] = JSON.parse(readFileSync(new URL('../assets/runtime/star-meta.json', import.meta.url), 'utf8'));
  const source: { lineIndices: number[]; constellations: SphericalArcFigure[] } = JSON.parse(readFileSync(new URL('../assets/runtime/constellation-meta.json', import.meta.url), 'utf8'));
  const stars: StarAstrometry[] = metadata.map(record => ({ id: record[0] as StarAstrometry['id'], raHours: record[3] as number, decDeg: record[4] as number,
    pmRaCosDecMasYr: record[10] as number, pmDecMasYr: record[11] as number, qualityFlags: record[12] as number,
    distancePc: record[13] as number | null, radialVelocityKmS: record[14] as number | null }));
  for (const mode of ['ground', 'globe', 'horizon'] as const) for (const lowView of [false, true]) {
    const state = scienceState(); state.viewMode = mode; state.environment.refraction = 'standard';
    state.cameras.ground.azimuthDegNorthEast = lowView ? 135 : 0; state.cameras.ground.altitudeDeg = lowView ? 1 : 25;
    state.cameras.ground.verticalFovDeg = lowView ? 20 : 65;
    if (mode !== 'ground') { state.cameras[mode].distanceDisplayUnits = lowView ? 1.05 : 4; state.cameras[mode].verticalFovDeg = lowView ? 20 : 65; state.cameras[mode].referenceLock = mode === 'horizon' ? 'local-horizon' : 'inertial'; }
    const snapshot = computeSnapshot(state, 1), profile = getDisplayRefractionProfile(snapshot, mode), frame = cameraFrameForState(state, snapshot);
    const positions = new Float32Array(stars.length * 3); writeStarDirectionBuffer(stars, cachedStarEpoch(snapshot.utDaysJ2000), positions);
    const camera = new PerspectiveCamera(state.cameras[mode].verticalFovDeg, 1152 / 720, .01, 2000);
    if (mode === 'ground') camera.quaternion.setFromEuler(new Euler((lowView ? 1 : 25) * RAD, -(lowView ? 135 : 0) * RAD, 0, 'YXZ'));
    else camera.position.set(0, 0, state.cameras[mode].distanceDisplayUnits);
    camera.updateMatrixWorld(true);
    const elements = new Matrix3().setFromMatrix4(camera.matrixWorldInverse).elements;
    const rotation = [[elements[0]!, elements[3]!, elements[6]!], [elements[1]!, elements[4]!, elements[7]!], [elements[2]!, elements[5]!, elements[8]!]] as const;
    const cameraPosition = camera.position.toArray(), tanFov = Math.tan(camera.fov * RAD / 2), finite = mode !== 'ground';
    const at = (index: number): ArcDirection => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
    const knots = profile.identity ? undefined : Array.from({ length: source.lineIndices.length / 2 }, (_, arc) =>
      [-1, profile.geometricHorizonDeg].flatMap(altitude => arcAltitudeCrossings(at(source.lineIndices[arc * 2]!), at(source.lineIndices[arc * 2 + 1]!), snapshot.localZenithEqjUnit, altitude)));
    fixtures.push({ name: `${mode}-${lowView ? 'near-low' : 'wide'}-676`, directions: positions, lines: source.lineIndices, figures: source.constellations, capacity: 128, step: .5, knots,
      projector: () => { const scratch: [number, number] = [0, 0]; return value => {
        const world = displayDirection(value, frame, profile);
        const local = multiplyVector(rotation, finite ? world.map((component, axis) => component - cameraPosition[axis]!) as unknown as ArcDirection : world);
        if (local[2] >= -1e-8) return null;
        scratch[0] = (local[0] / (-local[2] * tanFov * camera.aspect) + 1) * 1152 / 2;
        scratch[1] = (1 - local[1] / (-local[2] * tanFov)) * 720 / 2; return scratch;
      }; } });
  }
  const golden: object[] = [], comparison: object[] = [];
  let callsBefore = 0, callsAfter = 0;
  for (const fixture of fixtures) {
    const createOptions = { starCount: fixture.directions.length / 3, lineIndices: fixture.lines, figures: fixture.figures, maxSegmentsPerArc: fixture.capacity };
    const original = BeforeEndpointReuse.createSphericalArcBuffer(createOptions), optimized = createSphericalArcBuffer(createOptions);
    original.starDirections.set(fixture.directions); optimized.starDirections.set(fixture.directions);
    let beforeCalls = 0, afterCalls = 0;
    const beforeProject = fixture.projector?.(), afterProject = fixture.projector?.();
    const beforeScreen: SphericalArcScreenError | undefined = beforeProject && { project: value => { beforeCalls++; return beforeProject(value); }, maxErrorPx: .35 };
    const afterScreen: SphericalArcScreenError | undefined = afterProject && { project: value => { afterCalls++; return afterProject(value); }, maxErrorPx: .35 };
    const beforeResult = BeforeEndpointReuse.updateSphericalArcBuffer(original, { maxAngularStepDeg: fixture.step, extraKnotsByArc: fixture.knots, screenError: beforeScreen });
    const afterResult = updateSphericalArcBuffer(optimized, { maxAngularStepDeg: fixture.step, extraKnotsByArc: fixture.knots, screenError: afterScreen });
    for (const key of ['positions', 'ordinaryIndex', 'arcSegmentCounts', 'arcIndexStarts', 'arcDiagnostics'] as const) assert.deepEqual(optimized[key], original[key], `${fixture.name}: ${key}`);
    assert.deepEqual(afterResult, beforeResult, `${fixture.name}: diagnostic/result`);
    assert.deepEqual([...optimized.figureRanges], [...original.figureRanges], `${fixture.name}: figure ranges`);
    for (const figure of fixture.figures) {
      const beforeCount = BeforeEndpointReuse.writeConstellationHighlight(original, figure.id), afterCount = writeConstellationHighlight(optimized, figure.id);
      assert.equal(afterCount, beforeCount); assert.deepEqual(optimized.highlightIndex, original.highlightIndex);
    }
    assert.ok(afterCalls <= beforeCalls);
    callsBefore += beforeCalls; callsAfter += afterCalls;
    golden.push({ name: fixture.name, inputDirectionSha256: hashArray(fixture.directions), positionSha256: hashArray(original.positions), ordinaryIndexSha256: hashArray(original.ordinaryIndex),
      highlightSha256: hashArray(original.highlightIndex), result: { ...beforeResult }, ranges: [...original.figureRanges].map(([id, range]) => [id, { ...range }]), beforeCalls });
    comparison.push({ name: fixture.name, beforeCalls, afterCalls, byteIdenticalPositionsAndIndices: true, identicalDiagnosticsAndRanges: true });
    // Re-run the same fixture so the sampler cache hit also covers every frozen
    // buffer byte and diagnostic. Screen measurements and knots still run.
    BeforeEndpointReuse.updateSphericalArcBuffer(original, { maxAngularStepDeg: fixture.step, extraKnotsByArc: fixture.knots, screenError: beforeScreen });
    updateSphericalArcBuffer(optimized, { maxAngularStepDeg: fixture.step, extraKnotsByArc: fixture.knots, screenError: afterScreen });
    for (const figure of fixture.figures) {
      assert.equal(writeConstellationHighlight(optimized, figure.id), BeforeEndpointReuse.writeConstellationHighlight(original, figure.id));
      assertArcBuffersByteIdentical(optimized, original);
    }
  }
  const goldenPath = new URL('../qa/m5c-spherical-arcs/screen-endpoint-baseline/golden.before.json', import.meta.url);
  const expectedGolden = { baselineSha256: baselineSha, projectErrorPx: .35, frozenFixtures: golden };
  if (!existsSync(goldenPath)) writeFileSync(goldenPath, JSON.stringify(expectedGolden, null, 2));
  else assert.deepEqual(JSON.parse(readFileSync(goldenPath, 'utf8')), expectedGolden, 'Frozen original golden output must remain unchanged');
  if (createHash('sha256').update(readFileSync(new URL('../src/render/SphericalArcBuffer.ts', import.meta.url))).digest('hex') !== baselineSha) assert.ok(callsAfter < callsBefore * .8, 'Endpoint reuse should remove repeated projection work');
  writeFileSync('qa/m5c-spherical-arcs/screen-endpoint-equivalence.json', JSON.stringify({ baselineSha256: baselineSha,
    optimizedSha256: createHash('sha256').update(readFileSync(new URL('../src/render/SphericalArcBuffer.ts', import.meta.url))).digest('hex'),
    callsBefore, callsAfter, callbackReductionFraction: 1 - callsAfter / callsBefore, fixtures: comparison,
    limits: 'CPU differential correctness and callback-count evidence only; renderer owner measures the actual serial90-step heavy scene. No error threshold, angular step, capacity, display frame or clock cache changed.' }, null, 2));
});
