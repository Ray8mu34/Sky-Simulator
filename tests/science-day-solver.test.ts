import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyseDayTrackSteps, solvePointThresholdSteps, TOUCHING_TOLERANCE_DEG } from '../src/core/day-event-solver';
import type { DayTrackAnalysis } from '../src/core/day-event-solver';

function drain<T>(steps: Generator<void, T>): T { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
const close = (a: number, b: number, tolerance: number, label: string) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} versus ${b}`);
type Case = { input: { name: string; latitudeDeg: number; declinationDeg: number; hourAngleAtStartRad: number; periodSeconds: number; durationSeconds: number; refractionDeg: number }; expected: { state: string; crossings: { kind: 'rise' | 'set'; seconds: number }[]; minimumGeometricAltitudeDeg: number; maximumGeometricAltitudeDeg: number; clearanceRangeDeg: { minimum: number; maximum: number } } };
const cases = (JSON.parse(readFileSync(new URL('./fixtures/m5a/analytic-cases.json', import.meta.url), 'utf8')) as { rows: Case[] }).rows;
const axis = (value: number): number => Math.abs(value) < 4 * Number.EPSILON ? 0 : Math.abs(value - 1) < 4 * Number.EPSILON ? 1 : Math.abs(value + 1) < 4 * Number.EPSILON ? -1 : value;

for (const { input, expected } of cases) test(`continuous track: ${input.name}`, () => {
  const phi = input.latitudeDeg * Math.PI / 180, delta = input.declinationDeg * Math.PI / 180;
  const sp = axis(Math.sin(phi)), cp = axis(Math.cos(phi)), sd = axis(Math.sin(delta)), cd = axis(Math.cos(delta));
  const evaluate = (ut: number) => {
    const h = input.hourAngleAtStartRad + ut * 86400 * 2 * Math.PI / input.periodSeconds;
    const sh = axis(Math.sin(h)), ch = axis(Math.cos(h));
    const east = -cd * sh, north = cp * sd - sp * cd * ch, up = sp * sd + cp * cd * ch;
    const geometricAltitudeDeg = Math.atan2(up, Math.hypot(east, north)) * 180 / Math.PI;
    return { geometricAltitudeDeg, clearanceDeg: geometricAltitudeDeg + input.refractionDeg };
  };
  const bounds = { startUtDaysJ2000: 0, endUtDaysJ2000: input.durationSeconds / 86400 };
  const analysis = drain(analyseDayTrackSteps(evaluate, bounds));
  assert.equal(analysis.complete, true, analysis.incompleteReason ?? '');
  close(analysis.geometricAltitude.minimum.valueDeg, expected.minimumGeometricAltitudeDeg, 1e-6, 'minimum');
  close(analysis.geometricAltitude.maximum.valueDeg, expected.maximumGeometricAltitudeDeg, 1e-6, 'maximum');
  close(analysis.clearance.minimum.valueDeg, expected.clearanceRangeDeg.minimum, 1e-6, 'clearance minimum');
  close(analysis.clearance.maximum.valueDeg, expected.clearanceRangeDeg.maximum, 1e-6, 'clearance maximum');
  const solved = drain(solvePointThresholdSteps(ut => evaluate(ut).clearanceDeg, bounds, analysis));
  assert.equal(solved.complete, true, solved.incompleteReason ?? '');
  assert.equal(solved.crossings.length, expected.crossings.length);
  solved.crossings.forEach((crossing, index) => { assert.equal(crossing.kind, expected.crossings[index]!.kind); close(crossing.utDaysJ2000 * 86400, expected.crossings[index]!.seconds, 0.2, 'root seconds'); });
  const status = solved.crossings.length ? 'events' : analysis.clearance.minimum.valueDeg > TOUCHING_TOLERANCE_DEG ? 'always-above' : analysis.clearance.maximum.valueDeg < -TOUCHING_TOLERANCE_DEG ? 'always-below' : 'grazing';
  assert.equal(status, expected.state);
});

test('flat zero candidates are grazing, not a crossing-budget failure', () => {
  const bounds = { startUtDaysJ2000: 0, endUtDaysJ2000: 1 };
  const analysis = drain(analyseDayTrackSteps(() => ({ geometricAltitudeDeg: 0, clearanceDeg: 0 }), bounds));
  const roots = drain(solvePointThresholdSteps(() => 0, bounds, analysis));
  assert.equal(roots.complete, true); assert.deepEqual(roots.crossings, []);
});

test('invalid evaluations/bounds reject and finite-budget exhaustion is explicitly incomplete', () => {
  const evaluate = () => ({ geometricAltitudeDeg: 1, clearanceDeg: 1 });
  for (const end of [0, -1, 4, NaN, Infinity]) assert.throws(() => drain(analyseDayTrackSteps(evaluate, { startUtDaysJ2000: 0, endUtDaysJ2000: end })), RangeError);
  assert.throws(() => drain(analyseDayTrackSteps(() => ({ geometricAltitudeDeg: NaN, clearanceDeg: 1 }), { startUtDaysJ2000: 0, endUtDaysJ2000: 1 })), RangeError);
  const incomplete = drain(analyseDayTrackSteps(evaluate, { startUtDaysJ2000: 0, endUtDaysJ2000: 1 }, Array.from({ length: 65 }, (_, i) => i / 65)));
  assert.equal(incomplete.complete, false);
  assert.equal(drain(solvePointThresholdSteps(() => 1, { startUtDaysJ2000: 0, endUtDaysJ2000: 1 }, incomplete)).complete, false);
  const bad = { ...incomplete, complete: true, stationaryCandidatesUt: [NaN] } as DayTrackAnalysis;
  assert.throws(() => drain(solvePointThresholdSteps(() => 1, { startUtDaysJ2000: 0, endUtDaysJ2000: 1 }, bad)), RangeError);
});
