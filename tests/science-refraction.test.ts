import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as Engine from 'astronomy-engine';
import type { EnvironmentState, RefractionDescriptor, ScienceSnapshot, Vec3 } from '../src/contracts';
import { createRefractionDescriptor, deriveRefractionProfile, getDisplayRefractionProfile, getRefractionShaderChunk, refractionCacheDiagnostics, refractionPolicyCorrectionDeg, refractEnuDirection, refractEnuDirectionInto, REFRACTION_POLICY_VERSION, REFRACTION_PROFILE_VERSION, unrefractEnuDirection } from '../src/core/refraction';
import type { RefractionProfile } from '../src/core/refraction';
import { angularSeparationDeg, applyMatrix, DEG_TO_RAD, horizontalToVector, normalize, RAD_TO_DEG, transposeMatrix, vectorToHorizontal } from '../src/core/math';
import { computeSnapshot, refractionCorrectionDeg, refractHorizontalDirection } from '../src/core/astronomy';
import { resolveObjectDetails } from '../src/core/object-details';
import { computeSolarDayEvents } from '../src/core/solar-events';
import { computeObjectDayEvents } from '../src/core/object-day-events';
import type { StarCatalog, StarMeta } from '../src/data/types';
import { scienceState } from './fixtures/science-state';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/m5c/${name}`, import.meta.url), 'utf8'));
const raw = fixture('refraction-raw-policy.fixture.json');
const adapted = fixture('refraction-adapted-policy.fixture.json');
const close = (a: number, b: number, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} versus ${b}`);
const environment = (pressureHpa = 1010, temperatureC = 10, refraction: EnvironmentState['refraction'] = 'standard'): EnvironmentState => ({ ...scienceState().environment, pressureHpa, temperatureC, refraction });
/** Independently published scalar policy, using cot=cos/sin, never Engine/core as expected. */
function independentCorrection(h: number, pressure: number, temperature: number): number {
  const clamped = Math.max(-1, h), angle = (clamped + 10.3 / (clamped + 5.11)) * Math.PI / 180;
  const correction = (1.02 / 60) * Math.cos(angle) / Math.sin(angle) * (h < -1 ? (h + 90) / 89 : 1);
  return Math.max(0, correction) * (pressure / 1010) * (283 / (273 + temperature));
}

test('independent raw endpoint and new nonnegative policy stay separate frozen golden families', () => {
  for (const [name, sha] of [['refraction-raw-policy.fixture.json', 'f62a9e72c689040e6bac4cf8816ba02d07f7b66587f8681b0fdb82b174e96bc0'], ['refraction-adapted-policy.fixture.json', '6d1d1f69643b1772075e7864187179b83f66342210ac6b939a193131ddfb694c'], ['generation-report.json', '5e70ceb8bcc4f58f66b1c7d1cb47f9dec01031b6d4ae46f1112b71f1f3d2abee']]) assert.equal(createHash('sha256').update(readFileSync(new URL(`./fixtures/m5c/${name}`, import.meta.url))).digest('hex'), sha);
  assert.equal(raw.rows.length, 25); assert.equal(adapted.rows.length, 200);
  for (const row of raw.rows) close(Engine.Refraction('normal', row.geometricAltitudeDeg), row.rawCorrectionDeg);
  assert.ok(raw.rows.find((row: { geometricAltitudeDeg: number }) => row.geometricAltitudeDeg === 90).rawCorrectionDeg < 0);
  for (const row of adapted.rows) {
    const env = raw.environments.find((env: { id: string }) => env.id === row.environmentId);
    const descriptor = createRefractionDescriptor(environment(env.pressureHpa, env.temperatureC, row.mode)), profile = deriveRefractionProfile(descriptor), h = row.geometricAltitudeDeg;
    if (h < -90 || h > 90) { assert.throws(() => profile.apparentAltitudeDeg(h), RangeError); assert.throws(() => refractionPolicyCorrectionDeg(h, descriptor), RangeError); continue; }
    close(refractionPolicyCorrectionDeg(h, descriptor), row.policyCorrectionDeg);
    close(profile.apparentAltitudeDeg(h), row.policyApparentAltitudeDeg, 0.1 / 3600);
    close(refractionCorrectionDeg(h, environment(env.pressureHpa, env.temperatureC, row.mode)), profile.apparentAltitudeDeg(h) - h);
  }
});

test('Float32 forward/inverse knots and interior scans stay monotonic, finite and within the original 0.1 arcsecond target', () => {
  for (const [pressure, temperature] of [[1200, -100], [1200, 80], [1010, 10], [1013.25, 15], [1, -100]]) {
    const profile = deriveRefractionProfile(createRefractionDescriptor(environment(pressure, temperature))), l = profile.layout;
    const values = new Set([-90, -89.999999, -45, -1 - 1e-9, -1, -1 + 1e-9, 0, 5, 89.89, 89.9, 90]);
    for (let i = 0; i <= 18000; i++) values.add(-90 + i / 100);
    for (let i = 0; i < 4095; i++) for (const f of [0, 0.25, 0.5, 0.75]) values.add(-1 + (i + f) / l.forwardIndexPerDegree);
    let previousF = -Infinity, previousG = -Infinity, previousH = -Infinity;
    for (const h of [...values].sort((a, b) => a - b)) {
      const trueF = h + independentCorrection(h, pressure, temperature), f = profile.apparentAltitudeDeg(h), g = profile.geometricAltitudeDeg(h);
      assert.ok(Number.isFinite(f) && Number.isFinite(g));
      assert.ok(f >= previousF && g >= previousG, JSON.stringify({ pressure, temperature, h, previousH, f, previousF, g, previousG }));
      // A sub-ULP input separation may round a positive real slope to equal
      // outputs. Meaningfully separated samples must still increase strictly.
      if (h - previousH > 1e-9) assert.ok(f > previousF && g > previousG);
      previousF = f; previousG = g; previousH = h;
      close(f, trueF, 0.1 / 3600); close(profile.geometricAltitudeDeg(trueF), h, 0.1 / 3600); close(profile.geometricAltitudeDeg(f), h, 0.1 / 3600);
    }
    for (const a of [l.apparentJoinDeg - 1e-9, l.apparentJoinDeg, l.apparentJoinDeg + 1e-9, l.apparentSplitDeg - 1e-9, l.apparentSplitDeg, l.apparentSplitDeg + 1e-9, 90]) close(profile.apparentAltitudeDeg(profile.geometricAltitudeDeg(a)), a, 0.1 / 3600);
    assert.equal(profile.apparentAltitudeDeg(-1), l.apparentJoinDeg); assert.equal(profile.geometricAltitudeDeg(l.apparentJoinDeg), -1); assert.equal(profile.geometricAltitudeDeg(l.apparentSplitDeg), 5);
    assert.equal(profile.apparentAltitudeDeg(-90), -90); assert.equal(profile.apparentAltitudeDeg(90), 90); assert.equal(profile.geometricAltitudeDeg(-90), -90); assert.equal(profile.geometricAltitudeDeg(90), 90);
  }
});

test('none and zero-pressure scalar identity is exact without texture sampling; ENU azimuth and undefined poles are preserved', () => {
  const profiles = [deriveRefractionProfile(createRefractionDescriptor(environment(1010, 10, 'none'))), deriveRefractionProfile(createRefractionDescriptor(environment(0, -100)))];
  for (const p of profiles) { assert.equal(p.identity, true); assert.equal(p.copyTextureData().length, 0); for (const h of [-90, -1, -0.1, 0, 89.999999, 90]) { assert.equal(p.apparentAltitudeDeg(h), h); assert.equal(p.geometricAltitudeDeg(h), h); } }
  const standard = deriveRefractionProfile(createRefractionDescriptor(environment()));
  for (const p of [...profiles, standard]) for (const v of [[0, 0, 1], [0, 0, -1]] as Vec3[]) {
    assert.deepEqual(refractEnuDirection(v, p), v); assert.deepEqual(unrefractEnuDirection(v, p), v); assert.equal(vectorToHorizontal(refractEnuDirection(v, p)).azimuthDeg, null);
  }
  for (const az of [0, 90, 180, 270, 359.999999]) for (const h of [-30, -1, -0.1, 0, 5, 80]) {
    const v = horizontalToVector(h, az), mapped = refractEnuDirection(v, standard), angle = vectorToHorizontal(mapped);
    close(angle.azimuthDeg!, az, 1e-10); close(angle.altitudeDeg, standard.apparentAltitudeDeg(h), 1e-10);
    close(angularSeparationDeg(unrefractEnuDirection(mapped, standard), v) * 3600, 0, 0.1);
    assert.deepEqual(refractHorizontalDirection(v, environment()), mapped);
  }
});

test('continuous-clipping horizon uses the exact sameF inverse, with signed neighbouring values over P/T boundaries', () => {
  for (const pressure of [0, 1, 1010, 1013.25, 1200]) for (const temperature of [-100, 10, 15, 80]) for (const mode of ['none', 'standard'] as const) {
    const p = deriveRefractionProfile(createRefractionDescriptor(environment(pressure, temperature, mode))), h = p.geometricHorizonDeg;
    close(p.apparentAltitudeDeg(h), 0, 1e-12);
    assert.ok(p.apparentAltitudeDeg(h - 1e-8) < 0); assert.ok(p.apparentAltitudeDeg(h + 1e-8) > 0);
    if (p.identity) assert.equal(h, 0);
  }
});

/** Frozen pre-performance mapEnu algorithm: compatibility reference, not a physical-policy oracle. */
function prePerfMap(direction: Vec3, profile: RefractionProfile, inverse: boolean): Vec3 {
  const unit = normalize(direction), horizontal = Math.hypot(unit[0], unit[1]);
  if (profile.identity || horizontal < 1e-12) return unit;
  const h = Math.atan2(unit[2], horizontal) * RAD_TO_DEG;
  const mapped = (inverse ? profile.geometricAltitudeDeg(h) : profile.apparentAltitudeDeg(h)) * DEG_TO_RAD, factor = Math.cos(mapped) / horizontal;
  return [unit[0] * factor, unit[1] * factor, Math.sin(mapped)];
}

test('allocation-free into and both wrappers preserve each pre-perf component, including scaled inputs, alias and polar extremes', () => {
  const special: Vec3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, 1, 0], [1e308, 1e308, 1e308],
    [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE], [0, 0, Number.MIN_VALUE], [Number.MIN_VALUE, 0, 1],
    [0.9999e-12, 0, 1], [1e-12, 0, 1], [1.0001e-12, 0, 1]];
  const tuple: [number, number, number] = [0, 0, 0], doubles = new Float64Array(4); doubles[3] = 789;
  for (const env of [environment(1010, 10, 'none'), environment(0, -100), environment(1013.25, 15), environment(1200, -100), environment(1, 80)]) {
    const profile = deriveRefractionProfile(createRefractionDescriptor(env));
    const inputs = [...special];
    for (let i = 0; i <= 500; i++) {
      const unit = horizontalToVector(-90 + i * 180 / 500, (i * 137.508) % 360);
      for (const scale of [1e-200, 1e-10, 1, 5.6, 1e100, 1e300]) inputs.push(unit.map(value => value * scale) as unknown as Vec3);
    }
    for (const input of inputs) {
      const expected = prePerfMap(input, profile, false), saved = [...input];
      assert.equal(refractEnuDirectionInto(input, profile, tuple), tuple); assert.deepEqual(tuple, expected);
      assert.equal(refractEnuDirectionInto(input, profile, doubles), doubles); assert.deepEqual(Array.from(doubles).slice(0, 3), expected); assert.equal(doubles[3], 789);
      const alias = Float64Array.from([...input, 456]); assert.equal(refractEnuDirectionInto(alias, profile, alias), alias);
      assert.deepEqual(Array.from(alias).slice(0, 3), expected); assert.equal(alias[3], 456); assert.deepEqual(input, saved);
      assert.deepEqual(refractEnuDirection(input, profile), expected); assert.deepEqual(unrefractEnuDirection(input, profile), prePerfMap(input, profile, true));
    }
  }
});

test('into finite/zero/length rejection leaves caller buffers unchanged even for identity', () => {
  for (const env of [environment(1010, 10, 'none'), environment(1200, -100)]) {
    const profile = deriveRefractionProfile(createRefractionDescriptor(env));
    for (const input of [[0, 0, 0], [NaN, 0, 0], [Infinity, 1, 0], [-Infinity, 0, 0], [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], [1, 0]]) {
      const out = Float64Array.from([7, 8, 9]); assert.throws(() => refractEnuDirectionInto(input, profile, out), RangeError); assert.deepEqual(Array.from(out), [7, 8, 9]);
      const alias = [...input], original = [...input]; assert.throws(() => refractEnuDirectionInto(alias, profile, alias), RangeError); assert.deepEqual(alias, original);
    }
    for (const out of [[], [7, 8], new Float64Array(2)]) { const original = Array.from(out); assert.throws(() => refractEnuDirectionInto([1, 0, 0], profile, out), RangeError); assert.deepEqual(Array.from(out), original); }
  }
});

test('one last-key profile, private table copies and version validation prevent history or stale-policy reuse', () => {
  const d = createRefractionDescriptor(environment(992, 12)), before = refractionCacheDiagnostics(), p = deriveRefractionProfile(d);
  assert.equal(deriveRefractionProfile({ ...d }), p); assert.ok(Object.isFrozen(p) && Object.isFrozen(p.layout) && Object.isFrozen(p.descriptor));
  const original = p.apparentAltitudeDeg(0), texture = p.copyTextureData(); assert.equal(texture.byteLength, 32768); texture.fill(9000); assert.equal(p.apparentAltitudeDeg(0), original);
  for (let i = 0; i < 25; i++) deriveRefractionProfile(createRefractionDescriptor(environment(1000 + i, 10)));
  assert.equal(refractionCacheDiagnostics().entries, 1); assert.equal(refractionCacheDiagnostics().maxEntries, 1); assert.equal(refractionCacheDiagnostics().privateFloat32Bytes, 32768); assert.ok(refractionCacheDiagnostics().profileBuilds > before.profileBuilds);
  for (const change of [{ definitionVersion: 'unknown' }, { profileVersion: 'unknown' }, { mode: 'invalid' }, { pressureHpa: NaN }, { pressureHpa: -1 }, { pressureHpa: 1201 }, { temperatureC: -101 }, { temperatureC: 81 }, { temperatureC: Infinity }]) assert.throws(() => deriveRefractionProfile({ ...d, ...change } as RefractionDescriptor), RangeError);
  for (const h of [NaN, Infinity, -Infinity, -90.000001, 90.000001]) { assert.throws(() => p.apparentAltitudeDeg(h), RangeError); assert.throws(() => p.geometricAltitudeDeg(h), RangeError); }
  for (const v of [[0, 0, 0], [NaN, 0, 0], [Infinity, 1, 0]] as Vec3[]) assert.throws(() => refractEnuDirection(v, p), RangeError);
  assert.equal(d.definitionVersion, REFRACTION_POLICY_VERSION); assert.equal(d.profileVersion, REFRACTION_PROFILE_VERSION);
});

test('snapshot-paired body/stellar/constellation dual readouts agree with the same profile and external displays remain geometric', () => {
  const state = scienceState('2026-09-14T14:00:00Z'), geometric = computeSnapshot(state, 1); state.environment = environment(1200, -100);
  const snapshot = computeSnapshot(state, 2), profile = getDisplayRefractionProfile(snapshot, 'ground');
  assert.deepEqual(snapshot.eqjToHorizontalGeometric, geometric.eqjToHorizontalGeometric); assert.deepEqual(snapshot.eclipticOfDateToEqj, geometric.eclipticOfDateToEqj);
  assert.equal(snapshot.utDaysJ2000, geometric.utDaysJ2000); assert.equal(snapshot.ttDaysJ2000, geometric.ttDaysJ2000);
  assert.deepEqual(Object.keys(snapshot.observerRefraction).sort(), ['definitionVersion', 'mode', 'pressureHpa', 'profileVersion', 'temperatureC']);
  const star = JSON.parse(readFileSync('tests/fixtures/m5a/source-stars.json', 'utf8')).stars[0] as StarMeta;
  const catalog: StarCatalog = { stars: [star], directionsEqj: new Float32Array(3), magnitudes: new Float32Array(1), colors: new Float32Array(3), colorIndices: new Float32Array(1), lineIndices: Uint16Array.from([0, 0]), constellations: [{ id: 'UMi', nameEn: 'Ursa Minor', nameZh: '小熊座', directionEqj: [0, 0, 1], lineStart: 0, lineCount: 1 }] };
  for (const id of ['body:Sun', 'body:Moon', 'hip:11767', 'constellation:UMi'] as const) {
    const details = resolveObjectDetails(catalog, id, snapshot)!; assert.ok(details);
    close(details.apparentAltitudeDeg, profile.apparentAltitudeDeg(details.geometricAltitudeDeg));
    const mapped = vectorToHorizontal(refractEnuDirection(applyMatrix(snapshot.eqjToHorizontalGeometric, details.directionEqj), profile)); close(mapped.altitudeDeg, details.apparentAltitudeDeg);
    if (id.startsWith('body:')) { const body = snapshot.bodies.find(body => `body:${body.id}` === id)!; close(body.apparentAltitudeDeg, details.apparentAltitudeDeg); close(body.geometricAltitudeDeg, details.geometricAltitudeDeg); }
  }
  const savedDetails = resolveObjectDetails(catalog, star.id, snapshot); state.environment = environment(0, 80); assert.deepEqual(resolveObjectDetails(catalog, star.id, snapshot), savedDetails);
  for (const mode of ['space', 'globe', 'horizon'] as const) { const p = getDisplayRefractionProfile(snapshot, mode), v = horizontalToVector(0, 77); assert.ok(p.identity); close(angularSeparationDeg(refractEnuDirection(v, p), v), 0); }
  assert.equal(deriveRefractionProfile(snapshot.observerRefraction), profile);
  assert.equal(Object.keys(snapshot).some(key => key.toLowerCase().includes('lut')), false);
});

test('display refraction settings do not change solar or selected-object 34arcminute event definitions', () => {
  const original = scienceState(), standard = structuredClone(original); standard.environment = environment(1200, -100); standard.viewMode = 'space'; standard.layers.atmosphere = false;
  assert.deepEqual(computeSolarDayEvents(standard), computeSolarDayEvents(original));
  for (const id of ['body:Moon', 'body:Sun'] as const) assert.deepEqual(computeObjectDayEvents(standard, { kind: 'body', id }), computeObjectDayEvents(original, { kind: 'body', id }));
});

test('GLSL3 chunk declares the locked uniform/functions and uses the shared Float32 texture rather than a second empirical formula', () => {
  const chunk = getRefractionShaderChunk();
  for (const name of ['uRefractionLut', 'uRefractionEnabled', 'uRefractionForward', 'uRefractionInverseLow', 'uRefractionInverseHigh', 'skyRefractionForwardAltitudeDeg', 'skyRefractionInverseAltitudeDeg', 'skyRefractEnu', 'skyUnrefractEnu']) assert.ok(chunk.includes(name));
  assert.ok(chunk.includes('texelFetch')); assert.ok(!chunk.includes('#version') && !chunk.includes('void main'));
  assert.ok(!chunk.includes('10.3') && !chunk.includes('5.11'));
  // Actual GPU compilation, Float32 trig and pixel/pick consistency are separate renderer QA.
});
