import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFinalSceneManifest, sphereFitDistance, sphereSilhouetteRatio } from '../scripts/qa-final-scenes';
import { createDefaultState, parseState, serializeState } from '../src/state';

test('all25 original inputs/76 untouched intentions are consumed, with canonical defaults for omitted fields', () => {
  const source = JSON.parse(readFileSync('tests/fixtures/acceptance-scenes.json', 'utf8'));
  const m = createFinalSceneManifest();
  assert.equal(m.source.sceneCount, 25); assert.equal(m.source.assertionCount, 76);
  assert.deepEqual(m.scenes.map(s => s.source), source.scenes);
  assert.deepEqual(m.defaults.state, createDefaultState());
  assert.equal(m.defaults.serializedSha256, createHash('sha256').update(serializeState(createDefaultState())).digest('hex'));
  for (const scene of m.scenes) {
    assert.deepEqual(parseState(scene.state), scene.state);
    assert.deepEqual(scene.state.observer, scene.source.inputs.observer);
    assert.deepEqual(scene.state.cameras.ground, scene.source.inputs.groundCamera);
    assert.deepEqual(scene.state.environment, m.defaults.state.environment);
    assert.deepEqual(scene.state.layers, m.defaults.state.layers);
    for (const mode of ['space', 'globe', 'horizon'] as const) assert.deepEqual(scene.state.cameras[mode], m.defaults.state.cameras[mode]);
    assert.equal(scene.state.time.running, false);
  }
});

test('cross-scene/default/comparison/additional-camera mutation never leaks through shared objects', () => {
  const m = createFinalSceneManifest(['V01', 'S03', 'S11']);
  const before = serializeState(m.scenes[0]!.state), defaults = serializeState(m.defaults.state);
  m.scenes[1]!.comparisons[0]!.state.cameras.space.orientationQuaternion = [.5, .5, .5, .5];
  m.scenes[1]!.state.layers.earthDay = false;
  m.scenes[2]!.additionalTimes[0]!.state!.observer.latitudeDeg = -90;
  assert.equal(serializeState(m.scenes[0]!.state), before); assert.equal(serializeState(m.defaults.state), defaults);
  assert.deepEqual(m.scenes[1]!.comparisons[1]!.state.cameras.space, m.defaults.state.cameras.space);
  assert.equal(m.scenes[2]!.state.observer.latitudeDeg, 30.25);
});

test('civil rejection and unresolved selectors stay explicit; original observer zone is separate from parsing zone', () => {
  const m = createFinalSceneManifest(['S08', 'S09', 'S12', 'S13', 'S15']);
  const year0 = m.scenes.find(s => s.id === 'S12')!, fold = m.scenes.find(s => s.id === 'S15')!;
  assert.equal(year0.state.observer.displayZone.kind, 'fixed');
  assert.deepEqual(year0.state.observer.displayZone, { kind: 'fixed', offsetMinutes: 480 });
  assert.equal(fold.timeResolution.kind, 'expected-native-rejection');
  assert.equal(fold.source.inputs.time.kind, 'civil'); assert.equal(fold.additionalTimes[0]!.state, null);
  assert.equal(fold.state.time.utDaysJ2000, createDefaultState().time.utDaysJ2000);
  assert.deepEqual(m.scenes.find(s => s.id === 'S08')!.source.timeSelection, { kind: 'derive-from-geometric-solar-altitude', anglesDeg: [0, -6, -12, -18], seedUtc: '2026-09-14T00:00:00Z', derivedTimesMustBeSaved: true });
  assert.throws(() => createFinalSceneManifest(['made-up-id']));
  assert.throws(() => createFinalSceneManifest([]), /Zero scenes/);
});

test('S10 is fixed by external raw at exact original station, with low-altitude gate explicitly diagnostic', () => {
  const scene = createFinalSceneManifest(['S10']).scenes[0]!;
  assert.equal(scene.state.time.utDaysJ2000, 2461299 - 2451545);
  assert.deepEqual([scene.state.observer.latitudeDeg, scene.state.observer.longitudeDegEast, scene.state.observer.heightMeters], [30.25, 120.17, 20]);
  assert.equal(scene.independentReference!.row.airlessAltitudeDeg, 1.822635608);
  assert.match(scene.independentReference!.scoring, /diagnostic/);
  assert.ok(scene.independentReference!.paths.every(p => createHash('sha256').update(readFileSync(p.path)).digest('hex') === p.sha256));
});

test('sphere fit is an analytic proposal; independent45° tangent cone known result is one viewport height', () => {
  assert.ok(Math.abs(sphereSilhouetteRatio(1, Math.SQRT2, 90) - 1) < 1e-12);
  const m = createFinalSceneManifest(['V02', 'V03']);
  for (const scene of m.scenes) {
    const fit = scene.calibrationProposal!, mode = scene.id === 'V02' ? 'space' : 'globe';
    assert.ok(Math.abs(sphereSilhouetteRatio(1, fit.distance, scene.state.cameras[mode].verticalFovDeg) - fit.targetRatio) < 1e-12);
    assert.match(fit.scope, /actual GPU silhouette.*separate review/);
  }
  assert.throws(() => sphereFitDistance(1, 0, 45)); assert.throws(() => sphereSilhouetteRatio(1, 1, 45));
});
