import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/state';
import type { SimulationState } from '../src/contracts';
import { SimulationClock } from '../src/platform/clock';
import { requestEnvironmentSnapshot } from '../src/platform/environment-refresh';
import { scienceInputSignature } from '../src/platform/snapshot-provenance';
import { solarDayKey } from '../src/core/teaching';
import { objectDayKey, type ObjectDayTarget } from '../src/core/object-day-events';

const requester = () => {
  const requests: SimulationState[] = [];
  return { requests, request(state: SimulationState) { requests.push(structuredClone(state)); } };
};
for (const rate of [1, 600, 86400, -600]) test(`refraction apply at ${rate}x samples the original clock without losing its subsequent interval`, () => {
  const state = createDefaultState(), clock = new SimulationClock(), science = requester();
  state.time.running = true; state.time.rateSimSecondsPerRealSecond = rate;
  const originUt = state.time.utDaysJ2000;
  clock.rebase(originUt, rate, true, 1000);
  state.environment.refraction = 'standard'; state.environment.pressureHpa = 900;
  const before = structuredClone(state), expectedUt = clock.sample(1025);
  assert.equal(requestEnvironmentSnapshot(state, clock, science, 1025), expectedUt);
  assert.deepEqual(state, { ...before, time: { ...before.time, utDaysJ2000: expectedUt } });
  assert.deepEqual(science.requests, [state]); assert.equal(clock.rebaseCount, 1);
  assert.equal(clock.sample(1100), originUt + 100 * rate / 86_400_000);
  assert.equal(state.time.rateSimSecondsPerRealSecond, rate);
});

test('paused UTC stays exact while new physical signature and independent request copies carry the committed parameters', () => {
  const state = createDefaultState(), clock = new SimulationClock(), science = requester();
  state.time.running = false; const ut = state.time.utDaysJ2000, signature = scienceInputSignature(state);
  clock.rebase(ut, 86400, false, 0);
  state.environment.refraction = 'standard'; state.environment.pressureHpa = 700; state.environment.temperatureC = -20;
  requestEnvironmentSnapshot(state, clock, science, 5000);
  assert.equal(state.time.utDaysJ2000, ut); assert.notEqual(scienceInputSignature(state), signature); assert.equal(clock.rebaseCount, 1);
  state.environment.pressureHpa = 1100; requestEnvironmentSnapshot(state, clock, science, 9000);
  assert.equal(science.requests[0]!.environment.pressureHpa, 700); assert.equal(science.requests[1]!.environment.pressureHpa, 1100);
  assert.equal(science.requests[0]!.time.utDaysJ2000, science.requests[1]!.time.utDaysJ2000);
  assert.deepEqual(Object.keys(science.requests[0]!.environment).sort(), Object.keys(state.environment).sort());
});

test('none/standard and pressure/temperature do not invalidate solar, Moon or selected-star day keys', () => {
  const state = createDefaultState(), clock = new SimulationClock(), science = requester();
  const target: ObjectDayTarget = { kind: 'star', id: 'hip:57939', astrometrySourceVersion: 'fixed-test-source',
    astrometry: { id: 'hip:57939', raHours: 11.88282, decDeg: 37.718679, pmRaCosDecMasYr: 4003.69, pmDecMasYr: -5813,
      distancePc: 9.0917, radialVelocityKmS: -99.1, qualityFlags: 0 } };
  const keys = () => [solarDayKey(state), objectDayKey(state, { kind: 'body', id: 'body:Moon' }), objectDayKey(state, target)];
  const before = keys(); state.time.running = false; clock.rebase(state.time.utDaysJ2000, 1, false, 0);
  for (const [mode, pressureHpa, temperatureC] of [['standard', 1200, -100], ['standard', 0, 80], ['none', 1010, 10]] as const) {
    state.environment.refraction = mode; state.environment.pressureHpa = pressureHpa; state.environment.temperatureC = temperatureC;
    requestEnvironmentSnapshot(state, clock, science, 5000); assert.deepEqual(keys(), before);
  }
  assert.equal(clock.rebaseCount, 1);
});
