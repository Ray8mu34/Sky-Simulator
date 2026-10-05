import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState, parseState, serializeState } from '../src/state';
test('old schema-1 scenes migrate only a missing earthDay without mutating input', () => {
  const old = createDefaultState() as unknown as { layers: Record<string, unknown> };
  delete old.layers.earthDay;
  const before = JSON.stringify(old), parsed = parseState(old);
  assert.equal(parsed.layers.earthDay, true); assert.equal(JSON.stringify(old), before);
  assert.equal(parseState(before).layers.earthDay, true);
});
test('explicit earthDay false survives full state roundtrip; every explicit non-boolean is rejected', () => {
  const state = createDefaultState(); assert.equal(state.layers.earthDay, true);
  state.layers.earthDay = false; assert.deepEqual(parseState(serializeState(state)), state);
  for (const value of [undefined, null, 0, 1, 'true', 'false', []]) {
    const invalid = createDefaultState() as unknown as { layers: Record<string, unknown> };
    invalid.layers.earthDay = value; assert.throws(() => parseState(invalid), /earthDay.*布尔值/);
  }
});
test('earthDay migration does not repair other missing layers or accept unknown fields', () => {
  const old = createDefaultState() as unknown as { layers: Record<string, unknown> };
  delete old.layers.earthDay; delete old.layers.earthClouds;
  assert.throws(() => parseState(old), /earthClouds.*缺失/);
  const unknown = createDefaultState() as unknown as { layers: Record<string, unknown> };
  unknown.layers.earthDaylight = true; assert.throws(() => parseState(unknown), /earthDaylight.*不支持/);
});
