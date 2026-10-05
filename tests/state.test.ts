import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyState, createDefaultState, loadAcceptanceScene, loadSkyTeachingScene, parseState, serializeState, skyTeachingScenes } from '../src/state';
import { parseCivilInput, computeSnapshot } from '../src/core/astronomy';
import { utToDate } from '../src/core/time';
import { deriveSkyAppearance } from '../src/core/sky-appearance';

test('the initial teaching state uses the requested UTC and observer and starts paused', () => {
  const state = createDefaultState();
  assert.equal(utToDate(state.time.utDaysJ2000).toISOString(), '2026-09-14T14:00:00.000Z');
  assert.equal(state.time.running, false);
  assert.equal(state.environment.refraction, 'none');
  assert.equal(state.layers.milkyWay, true);
  assert.deepEqual(state.observer, {
    name: '杭州教学预设', latitudeDeg: 30.25, longitudeDegEast: 120.17,
    heightMeters: 20, displayZone: { kind: 'fixed', offsetMinutes: 480 },
  });
  assert.notEqual(createDefaultState().cameras, state.cameras);
});

test('existing scene choices preserve a disabled Milky Way and qualitative environment values on import', () => {
  const state = createDefaultState();
  state.layers.milkyWay = false;
  state.environment.artificialSkyBrightness = .5;
  state.environment.moonlightEnabled = false;
  state.environment.darkSkyLimitingMagnitude = 5.8;
  state.selected = 'hip:11767';
  state.time.running = true;
  state.cameras.space.referenceLock = 'earth-fixed';
  const incoming = parseState(serializeState(state));
  const target = createDefaultState();
  applyState(target, incoming);
  assert.deepEqual(target, state);
  assert.equal(target.layers.milkyWay, false);
  const before = serializeState(target);
  for (const brightness of [-.01, 1.01, NaN, Infinity]) {
    const broken = structuredClone(target);
    broken.environment.artificialSkyBrightness = brightness;
    assert.throws(() => applyState(target, broken), /天空亮度/);
    assert.equal(serializeState(target), before);
  }
});

test('a scene round trip preserves selection, reverse clock and every view camera', () => {
  const state = createDefaultState();
  state.viewMode = 'horizon'; state.selected = 'body:Moon'; state.time.running = true;
  state.time.rateSimSecondsPerRealSecond = -86400;
  state.observer.displayZone = { kind: 'iana', name: 'America/New_York', versionNote: 'test runtime Intl rules' };
  state.layers.backHemisphere = true; state.layers.milkyWay = true;
  state.cameras.space.orientationQuaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  state.cameras.space.distanceDisplayUnits = 5;
  state.cameras.horizon.referenceLock = 'inertial';
  state.environment.artificialSkyBrightness = .64;
  state.illustration = { bodySizeScale: 3, distanceCompressed: true };
  const roundTrip = parseState(serializeState(state));
  assert.deepEqual(roundTrip, state);
  assert.notEqual(roundTrip.cameras, state.cameras);
  const target = createDefaultState(); const identity = target;
  applyState(target, roundTrip);
  assert.equal(target, identity);
  assert.deepEqual(target, state);
  roundTrip.observer.latitudeDeg = 0;
  assert.equal(target.observer.latitudeDeg, 30.25);
});

test('failed imports are atomic, including malformed version, fields, numbers and camera rotation', () => {
  const target = createDefaultState();
  const before = serializeState(target);
  const broken: unknown[] = [
    '{not-json}', { ...target, schemaVersion: 2 },
    { ...target, time: { ...target.time, utDaysJ2000: NaN } },
    { ...target, observer: { ...target.observer, latitudeDeg: 91 } },
    { ...target, observer: { ...target.observer, heightMeters: -501 } },
    { ...target, environment: { ...target.environment, temperatureC: 81 } },
    { ...target, layers: { ...target.layers, sunMoon: 'true' } },
    { ...target, cameras: { ...target.cameras, space: { ...target.cameras.space, orientationQuaternion: [0, 0, 0, 0] } } },
    { ...target, unsupportedFutureField: true },
  ];
  const missing = structuredClone(target) as unknown as Record<string, unknown>;
  delete missing.selected; broken.push(missing);
  for (const value of broken) {
    assert.throws(() => applyState(target, value));
    assert.equal(serializeState(target), before);
  }
});

test('BCE and small AD years survive full scene serialization without 1900 remapping', () => {
  for (const year of [-2000, -1, 0, 1, 99, 4000]) {
    const state = createDefaultState();
    state.time.utDaysJ2000 = parseCivilInput({
      astronomicalYear: year, month: 6, day: 21, hour: 12, minute: 0, second: 0,
      zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject',
    });
    const restored = parseState(serializeState(state));
    assert.equal(utToDate(restored.time.utDaysJ2000).getUTCFullYear(), year);
    const snapshot = computeSnapshot(restored, 42);
    assert.ok(Number.isFinite(snapshot.lstHours));
  }
});

test('supported standard-refraction scenes round trip with one observer descriptor and preserved scientific state', () => {
  const target = createDefaultState();
  const incoming = structuredClone(target);
  incoming.environment.refraction = 'standard';
  incoming.environment.pressureHpa = 950.25;
  incoming.environment.temperatureC = -25;
  incoming.selected = 'body:Moon';
  incoming.viewMode = 'space';
  applyState(target, incoming);
  assert.deepEqual(parseState(serializeState(target)), incoming);
  assert.deepEqual(target.time, createDefaultState().time);
  assert.deepEqual(target.observer, createDefaultState().observer);
  assert.deepEqual(target.cameras, createDefaultState().cameras);
  const snapshot = computeSnapshot(target, 42);
  assert.deepEqual([snapshot.observerRefraction.mode, snapshot.observerRefraction.pressureHpa, snapshot.observerRefraction.temperatureC], ['standard', 950.25, -25]);
  assert.equal(createDefaultState().environment.refraction, 'none');
});

test('pressure and temperature bounds round trip without clamping and invalid pairs reject atomically', () => {
  const target = createDefaultState();
  for (const refraction of ['none', 'standard'] as const) for (const [pressureHpa, temperatureC] of [[0, -100], [0, 80], [1200, -100], [1200, 80], [1013.25, 15]]) {
    const incoming = structuredClone(target);
    incoming.environment.refraction = refraction;
    incoming.environment.pressureHpa = pressureHpa;
    incoming.environment.temperatureC = temperatureC;
    applyState(target, incoming);
    assert.deepEqual(parseState(serializeState(target)).environment, incoming.environment);
    const snapshot = computeSnapshot(target, 1);
    assert.equal(snapshot.observerRefraction.pressureHpa, pressureHpa);
    assert.equal(snapshot.observerRefraction.temperatureC, temperatureC);
  }
  const before = serializeState(target);
  for (const [pressureHpa, temperatureC] of [[-Number.EPSILON, 15], [1200.0001, 15], [1013, -100.0001], [1013, 80.0001], [NaN, 15], [1013, Infinity]]) {
    const incoming = structuredClone(target);
    incoming.environment.pressureHpa = pressureHpa;
    incoming.environment.temperatureC = temperatureC;
    assert.throws(() => applyState(target, incoming));
    assert.equal(serializeState(target), before);
  }
});

test('external scene cameras cannot enter the physical globe or exceed supported zoom bounds', () => {
  for (const mode of ['space', 'globe', 'horizon'] as const) {
    const target = createDefaultState();
    const initial = serializeState(target);
    for (const distance of [.01, .5, 1, mode === 'space' ? 2.09 : 1.79, mode === 'space' ? 22.01 : 7.01]) {
      const incoming = structuredClone(target);
      incoming.cameras[mode].distanceDisplayUnits = distance;
      assert.throws(() => applyState(target, incoming), /distanceDisplayUnits/);
      assert.equal(serializeState(target), initial);
    }
  }
});

test('visual and M3 teaching scenes use the supplied acceptance inputs and leave the simulation paused', () => {
  const bundle = JSON.parse(readFileSync(new URL('./fixtures/acceptance-scenes.json', import.meta.url), 'utf8'));
  for (const id of ['V01', 'V02', 'V03', 'V04', 'S05', 'S06', 'S07', 'S09', 'S16'] as const) {
    const source = bundle.scenes.find((scene: { id: string }) => scene.id === id);
    const state = loadAcceptanceScene(id);
    assert.equal(utToDate(state.time.utDaysJ2000).toISOString(), new Date(source.inputs.time.value).toISOString());
    assert.deepEqual(state.observer, source.inputs.observer);
    assert.deepEqual(state.cameras.ground, source.inputs.groundCamera);
    assert.equal(state.viewMode, source.inputs.viewMode);
    assert.equal(state.presentation, source.inputs.presentation);
    assert.equal(state.density, source.inputs.density);
    assert.equal(state.time.running, false);
  }
  assert.equal(loadAcceptanceScene('V02').cameras.space.distanceDisplayUnits, 5);
});

test('new galaxy teaching scenes round trip at one fixed sky and isolate artificial brightness', () => {
  const baseline = loadSkyTeachingScene('G01');
  const commonSky = computeSnapshot(baseline, 8);
  assert.equal(utToDate(baseline.time.utDaysJ2000).toISOString(), '2026-08-14T14:00:00.000Z');
  assert.ok(commonSky.bodies.find(body => body.id === 'Moon')!.geometricAltitudeDeg < 0);
  assert.ok(commonSky.bodies.find(body => body.id === 'Sun')!.geometricAltitudeDeg < -18);
  const models = [];
  for (const [index, scene] of skyTeachingScenes.entries()) {
    assert.match(scene.title, /新增/);
    const state = loadSkyTeachingScene(scene.id);
    assert.deepEqual(parseState(serializeState(state)), state);
    assert.equal(state.time.running, false);
    assert.equal(state.presentation, 'observation');
    assert.equal(state.layers.atmosphere, true);
    assert.equal(state.layers.milkyWay, true);
    assert.equal(state.environment.moonlightEnabled, true);
    assert.equal(state.environment.artificialSkyBrightness, index * .5);
    const withoutBrightness = structuredClone(state);
    withoutBrightness.environment.artificialSkyBrightness = 0;
    assert.deepEqual(withoutBrightness, baseline);
    assert.deepEqual(computeSnapshot(state, 8).bodies, commonSky.bodies);
    const model = deriveSkyAppearance(state, commonSky);
    assert.equal(model.moonlightStrength, 0);
    assert.equal(model.daylightStrength, 0);
    models.push(model);
  }
  assert.ok(models[0]!.limitingMagnitude > models[1]!.limitingMagnitude && models[1]!.limitingMagnitude > models[2]!.limitingMagnitude);
  assert.ok(models[0]!.milkyWayContrast > models[1]!.milkyWayContrast && models[1]!.milkyWayContrast > models[2]!.milkyWayContrast);
  assert.ok(models[0]!.skyBrightness < models[1]!.skyBrightness && models[1]!.skyBrightness < models[2]!.skyBrightness);
});
