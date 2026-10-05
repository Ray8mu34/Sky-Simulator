import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/state';
import { computeSnapshot } from '../src/core/astronomy';
import { REFRACTION_POLICY_VERSION, REFRACTION_PROFILE_VERSION } from '../src/core/refraction';

for (const [mode, pressureHpa, temperatureC] of [['none', 1010, 10], ['standard', 0, 80], ['standard', 1200, -100]] as const) {
  test(`snapshot transport for ${mode}/${pressureHpa}/${temperatureC} is a small cloneable descriptor and matrix, not a LUT`, () => {
    const state = createDefaultState();
    state.environment.refraction = mode; state.environment.pressureHpa = pressureHpa; state.environment.temperatureC = temperatureC;
    const snapshot = computeSnapshot(state, 7), cloned = structuredClone(snapshot);
    assert.deepEqual(cloned, snapshot);
    assert.deepEqual(snapshot.observerRefraction, { definitionVersion: REFRACTION_POLICY_VERSION, profileVersion: REFRACTION_PROFILE_VERSION,
      mode, pressureHpa, temperatureC });
    assert.equal(snapshot.eclipticOfDateToEqj.length, 3);
    assert.ok(snapshot.eclipticOfDateToEqj.every(row => row.length === 3));
    assert.ok(snapshot.eclipticOfDateToEqj.flat().every(Number.isFinite));
    const inspect = (value: unknown): void => {
      assert.equal(ArrayBuffer.isView(value), false, 'Scientific snapshot must not transfer an internal profile typed array.');
      assert.equal(value instanceof ArrayBuffer, false, 'Scientific snapshot must not transfer a profile buffer.');
      if (Array.isArray(value)) assert.ok(value.length < 512, 'Large profile/catalog array leaked into per-frame transport.');
      if (value && typeof value === 'object') for (const item of Object.values(value)) inspect(item);
      assert.notEqual(typeof value, 'function', 'Snapshot must be a DTO, not a profile closure.');
    };
    inspect(snapshot);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 16 * 1024, 'A per-frame LUT would exceed the small descriptor transport.');
  });
}
