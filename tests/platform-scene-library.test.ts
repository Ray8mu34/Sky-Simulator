import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/state';
import { createSceneLibrary, SCENE_LIBRARY_KEY, SceneLibraryError, type SceneStorage } from '../src/platform/scene-library';
class MemoryStorage implements SceneStorage {
  text: string | null = null;
  quota = false;
  blocked = false;
  writes = 0;
  getItem() { if (this.blocked) throw new Error('blocked'); return this.text; }
  setItem(key: string, value: string) {
    assert.equal(key, SCENE_LIBRARY_KEY);
    if (this.quota) throw new DOMException('full', 'QuotaExceededError');
    if (this.blocked) throw new Error('blocked');
    this.text = value; this.writes++;
  }
}
const code = (expected: SceneLibraryError['code']) => (error: unknown) => error instanceof SceneLibraryError && error.code === expected;
test('full named scene preserves running/time/selection/zone/all cameras and owns its saved copies', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage), state = createDefaultState();
  state.time.running = true; state.viewMode = 'horizon'; state.selected = 'hip:11767';
  state.observer.displayZone = { kind: 'iana', name: 'America/New_York', versionNote: 'runtime Intl' };
  const snapshot = structuredClone(state), entry = library.save('  演示 A  ', state);
  assert.equal(entry.name, '演示 A'); assert.equal(storage.writes, 1);
  state.time.utDaysJ2000++; state.cameras.space.distanceDisplayUnits = 4;
  const loaded = library.load(entry.id); assert.deepEqual(loaded, snapshot);
  loaded.time.running = false; loaded.cameras.ground.altitudeDeg = -10;
  assert.deepEqual(library.load(entry.id), snapshot);
  library.list()[0].name = 'external mutation'; assert.equal(library.list()[0].name, '演示 A');
});
test('explicit id updates one entry; removing/unknown ids are clear and cannot overwrite another scene', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage), state = createDefaultState();
  const a = library.save('A', state), b = library.save('A', state);
  state.layers.earthDay = false; library.save('changed', state, a.id);
  assert.equal(library.list().length, 2); assert.equal(library.load(a.id).layers.earthDay, false);
  assert.equal(library.load(b.id).layers.earthDay, true);
  const before = storage.text;
  assert.throws(() => library.save('missing', state, 'unknown'), code('not-found'));
  assert.equal(storage.text, before); library.remove(a.id); assert.equal(library.list().length, 1);
  assert.throws(() => library.load(a.id), code('not-found')); assert.throws(() => library.remove(a.id), code('not-found'));
});
test('quota/denied storage writes preserve all previously saved state and startup is lazy', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage), entry = library.save('A', createDefaultState());
  const before = storage.text; storage.quota = true;
  assert.throws(() => library.save('B', createDefaultState()), code('quota'));
  assert.throws(() => library.remove(entry.id), code('quota')); assert.equal(storage.text, before);
  assert.equal(library.list().length, 1);
  storage.quota = false; storage.blocked = true;
  assert.doesNotThrow(() => createSceneLibrary(storage)); assert.throws(() => library.list(), code('unavailable'));
  assert.equal(storage.text, before);
});
test('corrupt JSON, unsupported version and invalid stored state are preserved rather than cleared', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage);
  for (const text of ['{ broken', '{"schemaVersion":99,"scenes":[]}', '{"schemaVersion":1,"scenes":[{"id":"a","name":"A","updatedAt":1,"state":{}}]}']) {
    storage.text = text;
    assert.throws(() => library.list(), code('corrupt'));
    assert.throws(() => library.save('new', createDefaultState()), code('corrupt'));
    assert.equal(storage.text, text); assert.equal(storage.writes, 0);
  }
});
test('entry/name/UTF8 byte limits reject atomically and allow eighty Unicode characters', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage, { maxEntries: 1 });
  const entry = library.save('🌌'.repeat(80), createDefaultState()), before = storage.text;
  assert.throws(() => library.save('B', createDefaultState()), code('limit'));
  assert.throws(() => library.save('🌌'.repeat(81), createDefaultState(), entry.id), code('invalid-name'));
  assert.equal(storage.text, before);
  library.save('a', createDefaultState(), entry.id);
  const ascii = storage.text!, byteLimit = new TextEncoder().encode(ascii).byteLength + 40;
  const bounded = createSceneLibrary(storage, { maxBytes: byteLimit });
  assert.throws(() => bounded.save('星'.repeat(40), createDefaultState(), entry.id), code('limit'));
  assert.equal(storage.text, ascii);
});
test('invalid incoming scenes do not commit, and legacy earthDay migration remains narrow', () => {
  const storage = new MemoryStorage(), library = createSceneLibrary(storage), state = createDefaultState();
  library.save('A', state); const before = storage.text;
  const invalid = structuredClone(state); invalid.observer.latitudeDeg = 100;
  assert.throws(() => library.save('bad', invalid), code('invalid-state')); assert.equal(storage.text, before);
  const legacy = state as unknown as { layers: Record<string, unknown> }; delete legacy.layers.earthDay;
  const entry = library.save('old', legacy); assert.equal(library.load(entry.id).layers.earthDay, true);
  assert.equal(Object.hasOwn(legacy.layers, 'earthDay'), false);
});
test('insecure-context UUID fallback is bounded and avoids twenty existing ids even with constant time/random', () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now, originalRandom = Math.random;
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    Date.now = () => 12345; Math.random = () => 0;
    const storage = new MemoryStorage(), library = createSceneLibrary(storage);
    for (let i = 0; i < 20; i++) library.save(`场景${i}`, createDefaultState());
    assert.equal(new Set(library.list().map(scene => scene.id)).size, 20);
    const before = storage.text;
    assert.throws(() => library.save('第21个', createDefaultState()), code('limit'));
    assert.equal(storage.text, before);
  } finally {
    Date.now = originalNow; Math.random = originalRandom;
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
