import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/state';
import { scienceInputSignature } from '../src/platform/snapshot-provenance';

test('observer snapshots cannot be reused for a changed location or geometric environment', () => {
  const baseline = createDefaultState();
  const key = scienceInputSignature(baseline);
  for (const [scope, field, value] of [
    ['observer', 'latitudeDeg', -30], ['observer', 'longitudeDegEast', -120], ['observer', 'heightMeters', 800],
    ['environment', 'pressureHpa', 700], ['environment', 'temperatureC', -10], ['environment', 'refraction', 'standard'],
  ] as const) {
    const changed = structuredClone(baseline);
    Object.assign(changed[scope], { [field]: value });
    assert.notEqual(scienceInputSignature(changed), key, `${scope}.${field}`);
  }
});
test('selection, view, camera and display time do not invalidate observer provenance', () => {
  const state = createDefaultState(), key = scienceInputSignature(state);
  state.selected = 'hip:11767'; state.viewMode = 'horizon'; state.cameras.horizon.referenceLock = 'inertial';
  state.time.utDaysJ2000 += 1; state.observer.name = '同地点新名称'; state.observer.displayZone = { kind: 'fixed', offsetMinutes: 0 };
  assert.equal(scienceInputSignature(state), key);
});
