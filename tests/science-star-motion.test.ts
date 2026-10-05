import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { StarCatalog, StarMeta } from '../src/data/types';
import type { Vec3 } from '../src/contracts';
import { deriveStarMotionModel, KM_S_TO_PC_PER_JULIAN_YEAR, LINEAR_SPACE_MODEL_VERSION, MOTION_POSITION_RELATIVE_TOLERANCE, propagateStarDirection, STAR_MOTION_POLICY_VERSION, TANGENT_MODEL_VERSION, validateStarAstrometry } from '../src/core/stars';
import type { StarAstrometry } from '../src/core/stars';
import { resolveObjectDetails } from '../src/core/object-details';
import { computeObjectDayEvents, objectDayKey, validateObjectDayTarget } from '../src/core/object-day-events';
import type { ObjectDayTarget } from '../src/core/object-day-events';
import { resolveObjectDayTarget } from '../src/data/object-day-target';
import { angularSeparationDeg, raDecToVector } from '../src/core/math';
import { computeSnapshot } from '../src/core/astronomy';
import { dateToUt } from '../src/core/time';
import { scienceState } from './fixtures/science-state';

const radiansPerMas = Math.PI / 648000000;
const close = (a: number, b: number, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} versus ${b}`);
const ordinary: StarAstrometry = { id: 'hip:1', raHours: 0, decDeg: 0, pmRaCosDecMasYr: 1000, pmDecMasYr: -2000, distancePc: 1, radialVelocityKmS: 100, qualityFlags: 0 };
const records = JSON.parse(readFileSync('assets/runtime/star-meta.json', 'utf8')) as unknown[][];
const scientific = (r: unknown[]): StarAstrometry => ({ id: r[0] as StarAstrometry['id'], raHours: r[3] as number, decDeg: r[4] as number,
  pmRaCosDecMasYr: r[10] as number, pmDecMasYr: r[11] as number, qualityFlags: r[12] as number, distancePc: r[13] as number | null, radialVelocityKmS: r[14] as number | null });

test('four-field tangent model preserves its old mathematical expectation and version', () => {
  const input = { raHours: 0, decDeg: 0, pmRaCosDecMasYr: 3600000, pmDecMasYr: 0 };
  const model = deriveStarMotionModel(input); assert.equal(model.model, 'tangent'); assert.equal(model.modelVersion, TANGENT_MODEL_VERSION);
  assert.ok(model.fallbackReasons.includes('source-identity-unavailable') && model.fallbackReasons.includes('radial-velocity-unavailable'));
  const actual = propagateStarDirection(input, 365.25), angle = Math.atan(Math.PI / 180);
  close(actual[0], Math.cos(angle)); close(actual[1], Math.sin(angle)); close(actual[2], 0);
});

test('space motion preserves t=0 and initial tangential derivative; positive RV reduces future angular motion', () => {
  const a = propagateStarDirection(ordinary, 0); close(angularSeparationDeg(a, [1, 0, 0]), 0);
  const dtYears = 0.001, small = propagateStarDirection(ordinary, dtYears * 365.25);
  close(small[1] / dtYears, ordinary.pmRaCosDecMasYr * radiansPerMas, 1e-12);
  close(small[2] / dtYears, ordinary.pmDecMasYr * radiansPerMas, 2e-12);
  const future = propagateStarDirection(ordinary, 1000 * 365.25), approaching = propagateStarDirection({ ...ordinary, radialVelocityKmS: -100 }, 1000 * 365.25);
  assert.ok(angularSeparationDeg(a, future) < angularSeparationDeg(a, approaching));
  const radialFactor = 1 + 1000 * 100 * KM_S_TO_PC_PER_JULIAN_YEAR;
  close(future[1] / future[0], 1000 * ordinary.pmRaCosDecMasYr * radiansPerMas / radialFactor);
  close(KM_S_TO_PC_PER_JULIAN_YEAR, 31557600 / 3.0856775814913673e13, 1e-21);
});

test('availability and source exceptions use one conservative policy, independent of colour and raw quantized velocity', () => {
  const model = deriveStarMotionModel(ordinary); assert.equal(model.model, 'linear-space'); assert.equal(model.modelVersion, LINEAR_SPACE_MODEL_VERSION); assert.equal(model.policyVersion, STAR_MOTION_POLICY_VERSION); assert.deepEqual(model.fallbackReasons, []);
  assert.equal(deriveStarMotionModel({ ...ordinary, qualityFlags: 1 }).model, 'linear-space');
  for (const [change, reason] of [[{ id: undefined }, 'source-identity-unavailable'], [{ qualityFlags: undefined }, 'availability-flags-unavailable'], [{ distancePc: null }, 'distance-unavailable'], [{ distancePc: 100000 }, 'distance-unavailable'], [{ distancePc: 0 }, 'distance-unavailable'], [{ radialVelocityKmS: null }, 'radial-velocity-unavailable'], [{ radialVelocityKmS: 0 }, 'radial-velocity-zero-ambiguous'], [{ qualityFlags: 2 }, 'distance-flag-unavailable'], [{ qualityFlags: 4 }, 'radial-velocity-flag-unavailable'], [{ id: 'hip:17851' }, 'source-field-inconsistent'], [{ id: 'hyg:119623' }, 'source-field-inconsistent']] as const) {
    const result = deriveStarMotionModel({ ...ordinary, ...change } as StarAstrometry); assert.equal(result.model, 'tangent'); assert.ok(result.fallbackReasons.includes(reason));
  }
  const poisonedRaw = { ...ordinary, spaceVelocityEqjPcYr: [NaN, Infinity, -1e100] };
  assert.deepEqual(propagateStarDirection(poisonedRaw, 1e5), propagateStarDirection(ordinary, 1e5));
});

test('nonfinite science fields, malformed identities and invalid flags reject at the unique entry', () => {
  for (const key of ['raHours', 'decDeg', 'pmRaCosDecMasYr', 'pmDecMasYr', 'distancePc', 'radialVelocityKmS'] as const) for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => validateStarAstrometry({ ...ordinary, [key]: value }), RangeError);
    assert.throws(() => propagateStarDirection({ ...ordinary, [key]: value }, 0), RangeError);
  }
  for (const id of ['hip:0', 'hyg:-1', 'hip:9007199254740993', 'body:Sun']) assert.throws(() => deriveStarMotionModel({ ...ordinary, id } as StarAstrometry), RangeError);
  for (const qualityFlags of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => propagateStarDirection({ ...ordinary, qualityFlags }, 0), RangeError);
  assert.throws(() => propagateStarDirection({ ...ordinary, decDeg: 90.001 }, 0), RangeError);
  assert.throws(() => propagateStarDirection(ordinary, NaN), RangeError);
});

test('near-zero space position is explicitly unresolved by a relative guard, while tiny regular distances remain valid', () => {
  const radial: StarAstrometry = { ...ordinary, pmRaCosDecMasYr: 0, pmDecMasYr: 0, radialVelocityKmS: -1 / KM_S_TO_PC_PER_JULIAN_YEAR };
  assert.throws(() => propagateStarDirection(radial, 365.25), /方向无定义/);
  assert.throws(() => propagateStarDirection(radial, 365.25 * (1 - MOTION_POSITION_RELATIVE_TOLERANCE / 4)), /方向无定义/);
  assert.deepEqual(propagateStarDirection(radial, 365.25 * (1 - 1e-10)), [1, 0, 0]);
  const tiny = { ...ordinary, distancePc: 1e-100, radialVelocityKmS: 1e-105 };
  const result = propagateStarDirection(tiny, 100 * 365.25); assert.ok(result.every(Number.isFinite)); close(Math.hypot(...result), 1);
});

test('all 8921 source records reproduce 8296 candidates / 625 fallbacks and stay resolvable over the complete product/bucket domain', () => {
  assert.equal(createHash('sha256').update(readFileSync('assets/runtime/star-meta.json')).digest('hex'), '46dd05ad8aa40b284e32efd929002d067bed89e3e39d7c885be5a7ae43af3dd1');
  const low = (dateToUt(new Date('-002000-01-01T00:00:00Z')) - 15) / 365.25, high = (dateToUt(new Date('4001-01-01T00:00:00Z')) + 15) / 365.25;
  let candidateCount = 0, tangentCount = 0;
  for (const r of records) {
    const star = scientific(r), model = deriveStarMotionModel(star); if (model.model === 'linear-space') candidateCount++; else tangentCount++;
    const alpha = star.raHours * Math.PI / 12, delta = star.decDeg * Math.PI / 180;
    const u = [Math.cos(delta) * Math.cos(alpha), Math.cos(delta) * Math.sin(alpha), Math.sin(delta)];
    const e = [-Math.sin(alpha), Math.cos(alpha), 0], n = [-Math.cos(alpha) * Math.sin(delta), -Math.sin(alpha) * Math.sin(delta), Math.cos(delta)];
    const scale = model.model === 'linear-space' ? star.distancePc! : 1;
    const radial = model.model === 'linear-space' ? star.radialVelocityKmS! * (31557600 / 3.0856775814913673e13) : 0;
    const p = u.map(value => scale * value), v = u.map((value, i) => scale * (star.pmRaCosDecMasYr * e[i]! + star.pmDecMasYr * n[i]!) * (Math.PI / 648000000) + radial * value);
    const vv = v.reduce((sum, value) => sum + value * value, 0), pv = p.reduce((sum, value, i) => sum + value * v[i]!, 0);
    const minimumAt = vv === 0 ? 0 : Math.max(low, Math.min(high, -pv / vv));
    for (const years of [low, 0, minimumAt, high]) { const direction = propagateStarDirection(star, years * 365.25); assert.ok(direction.every(Number.isFinite), star.id); close(Math.hypot(...direction), 1); }
  }
  assert.equal(records.length, 8921); assert.equal(candidateCount, 8296); assert.equal(tangentCount, 625);
});

interface SofaRow { input: { id: StarAstrometry['id']; motionModel: 'linear-space' | 'tangent'; raHours: number; decDeg: number; pmRaCosDecMasYr: number; pmDecMasYr: number; distancePc: number | null; radialVelocityKmS: number | null; motionYearsSinceJ2000: number }; motionDirectionJ2000: Vec3 }
test('58 frozen outputs from unmodified official SOFA Pmpx independently match both motion branches', () => {
  for (const [name, sha] of [['sofa-small-output.ndjson', '436f4e6eae69b52c4d88638f182586df4416aa2b493e433cd71c747bed831d3d'], ['sofa-small-report.json', '593a4df29a2158c9ce2cbe2117c568bb45e2dc62996fda37c99d089b68eea336'], ['SOFA-LICENSE.txt', '7e6f42ebacdff175083a46063cf1fb6fc5749c9d52c906e2580aeb7fb5a12ae9']]) assert.equal(createHash('sha256').update(readFileSync(new URL(`./fixtures/m5b/${name}`, import.meta.url))).digest('hex'), sha);
  const report = JSON.parse(readFileSync(new URL('./fixtures/m5b/sofa-small-report.json', import.meta.url), 'utf8'));
  assert.equal(report.driverSha256, '2fbaf84a9d83e12a3f9c7509b33e2ca10d5d829ecc518cee8b5d0fa0998ff166');
  const rows = readFileSync(new URL('./fixtures/m5b/sofa-small-output.ndjson', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line) as SofaRow);
  assert.equal(rows.length, 58);
  for (const row of rows) {
    const i = row.input, source = records.find(record => record[0] === i.id);
    // SOFA's four artificial unit rows have synthetic labels, not catalog IDs.
    // Preserve the raw fixture; supply a neutral canonical identity only for its
    // declared full-space unit input, and no identity for tangent math inputs.
    const id = source ? i.id : i.motionModel === 'linear-space' ? 'hip:999999' : undefined;
    const star: StarAstrometry = { ...i, id, qualityFlags: source ? Number(source[12]) : i.motionModel === 'linear-space' ? 0 : 6 };
    assert.equal(deriveStarMotionModel(star).model, i.motionModel);
    const result = propagateStarDirection(star, i.motionYearsSinceJ2000 * 365.25);
    assert.ok(angularSeparationDeg(result, row.motionDirectionJ2000) * 3600 <= 1e-8, String(i.id));
  }
});

test('details, single-record target and events expose the same model; every new science field fingerprints the key', () => {
  const star = JSON.parse(readFileSync('tests/fixtures/m5a/source-stars.json', 'utf8')).stars.find((s: StarMeta) => s.id === 'hip:32349') as StarMeta;
  const catalog: StarCatalog = { stars: [star], directionsEqj: new Float32Array(3), magnitudes: new Float32Array(1), colors: new Float32Array(3), colorIndices: new Float32Array(1), lineIndices: new Uint16Array(), constellations: [] };
  const state = scienceState(), resolution = resolveObjectDayTarget(catalog, star.id); assert.equal(resolution.available, true); if (!resolution.available) return;
  const target = resolution.target; assert.equal(target.kind, 'star'); if (target.kind !== 'star') return;
  const info = deriveStarMotionModel(star), details = resolveObjectDetails(catalog, star.id, computeSnapshot(state, 1))!, events = computeObjectDayEvents(state, target);
  assert.deepEqual(details.starMotion, info); assert.deepEqual(events.starMotion, info); assert.equal(events.astrometryModelVersion, info.modelVersion);
  assert.ok(info.notes.every(note => details.notes.includes(note) && events.notes.includes(note)));
  assert.ok(details.coordinateEpochLabel.includes('运动推进'));
  assert.ok(angularSeparationDeg(details.directionEqj, propagateStarDirection(target.astrometry, state.time.utDaysJ2000)) < 1e-12);
  const key = objectDayKey(state, target);
  for (const change of [{ distancePc: star.distancePc! + 0.1 }, { radialVelocityKmS: star.radialVelocityKmS! + 0.1 }, { qualityFlags: 4 }]) assert.notEqual(objectDayKey(state, { ...target, astrometry: { ...target.astrometry, ...change } }), key);
  assert.throws(() => validateObjectDayTarget({ ...target, id: 'hip:17851' } as ObjectDayTarget), /身份须一致/);
  assert.throws(() => objectDayKey(state, { ...target, astrometry: { ...target.astrometry, id: 'hip:17851' } }), /身份须一致/);
  const tangent: ObjectDayTarget = { ...target, astrometry: { raHours: star.raHours, decDeg: star.decDeg, pmRaCosDecMasYr: star.pmRaCosDecMasYr, pmDecMasYr: star.pmDecMasYr } };
  assert.notEqual(objectDayKey(state, tangent), key); assert.equal(computeObjectDayEvents(state, tangent).starMotion?.model, 'tangent');
  close(angularSeparationDeg(propagateStarDirection(star, 0), raDecToVector(star.raHours, star.decDeg)), 0);
});
