import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SimulationState, Vec3 } from '../src/contracts';
import { computeSnapshot, computeSolarDayEvents } from '../src/core/astronomy';
import { angularSeparationDeg, applyMatrix, dot, horizontalToVector, mod, normalize, vectorToHorizontal } from '../src/core/math';
import { computeMoonAppearance, computeMoonQuarterSequence } from '../src/core/moon';
import { deriveSkyAppearance } from '../src/core/sky-appearance';
import { propagateStarDirection } from '../src/core/stars';
import { localCivilParts, utToDate } from '../src/core/time';
import { acceptanceScenes, createDefaultState, loadAcceptanceScene, loadSkyTeachingScene, parseState, serializeState, skyTeachingScenes } from '../src/state';
import { getPreset, loadPreset, teachingPresets, teachingPresetTopics } from '../src/teaching-presets';

// Actual runtime catalog rows, consumed through the same proper-motion model as the application.
// These checks verify pedagogical intent, not independent ephemeris accuracy.
const rows = JSON.parse(readFileSync(new URL('../assets/runtime/star-meta.json', import.meta.url), 'utf8')) as unknown[][];
function directionOfStar(id: string, ut: number): Vec3 {
  const row = rows.find(row => row[0] === id);
  assert.ok(row, `missing real catalog star ${id}`);
  return propagateStarDirection({
    raHours: row[3] as number, decDeg: row[4] as number,
    pmRaCosDecMasYr: row[10] as number, pmDecMasYr: row[11] as number,
  }, ut);
}
const body = (state: SimulationState, id: 'Sun' | 'Moon') => computeSnapshot(state, 0).bodies.find(body => body.id === id)!;

test('one preset module covers all nine teaching topics with stable, bounded, immutable metadata', () => {
  assert.equal(teachingPresets.length, 21);
  assert.equal(new Set(teachingPresets.map(preset => preset.id)).size, 21);
  assert.equal(teachingPresetTopics.length, 9);
  assert.deepEqual(new Set(teachingPresets.map(preset => preset.topic)), new Set(teachingPresetTopics.map(topic => topic.id)));
  assert.ok(Object.isFrozen(teachingPresets));
  for (const preset of teachingPresets) {
    assert.equal(getPreset(preset.id), preset);
    assert.ok(Object.isFrozen(preset) && Object.isFrozen(preset.variants));
    assert.ok(preset.description.length > 10 && preset.sourceNote.length > 10);
    assert.match(preset.timePlaceNote, /2026 年/);
    assert.match(preset.timePlaceNote, /固定UTC/);
    for (const variant of preset.variants) assert.ok(getPreset(variant), `${preset.id} invalid comparison ${variant}`);
  }
});

test('old V/S/G inputs and every camera remain exactly compatible with the original loaders', () => {
  for (const { id } of acceptanceScenes) assert.deepEqual(loadPreset(id), loadAcceptanceScene(id));
  for (const { id } of skyTeachingScenes) assert.deepEqual(loadPreset(id), loadSkyTeachingScene(id));
  assert.equal(getPreset('S09')!.moonPhaseSeedUtDaysJ2000, acceptanceScenes.find(scene => scene.id === 'S09')!.moonPhaseSeedUtDaysJ2000);
});

test('every load is a complete, validated, paused, deeply independent simulation state', () => {
  const pristineDefault = serializeState(createDefaultState());
  for (const preset of teachingPresets) {
    const state = loadPreset(preset.id), baseline = serializeState(state), another = loadPreset(preset.id);
    assert.deepEqual(parseState(baseline), state);
    assert.equal(state.time.running, false); assert.equal(state.time.mode, 'simulation');
    assert.equal(state.layers.earthDay, true);
    assert.notEqual(state.time, another.time); assert.notEqual(state.observer, another.observer);
    assert.notEqual(state.observer.displayZone, another.observer.displayZone);
    assert.notEqual(state.environment, another.environment); assert.notEqual(state.layers, another.layers);
    assert.notEqual(state.illustration, another.illustration);
    for (const mode of ['ground', 'space', 'globe', 'horizon'] as const) {
      assert.notEqual(state.cameras[mode], another.cameras[mode]);
      state.cameras[mode].verticalFovDeg = 70;
      if (mode !== 'ground') {
        assert.notEqual(state.cameras[mode].orientationQuaternion, another.cameras[mode].orientationQuaternion);
        // A JS caller can mutate an array despite its readonly TypeScript contract.
        Reflect.set(state.cameras[mode].orientationQuaternion, 0, .5);
      }
    }
    state.observer.latitudeDeg = 0; state.observer.displayZone = { kind: 'fixed', offsetMinutes: 1 };
    state.layers.earthDay = false; state.environment.artificialSkyBrightness = .9;
    state.time.running = true; state.time.utDaysJ2000 += 1; state.selected = 'body:Moon';
    assert.equal(serializeState(another), baseline);
    assert.equal(serializeState(loadPreset(preset.id)), baseline);
  }
  assert.equal(serializeState(createDefaultState()), pristineDefault);
  assert.equal(getPreset('unknown'), null);
  for (const id of ['unknown', '__proto__', 'V00', 'T09', 'v01', '']) assert.throws(() => loadPreset(id), /未知教学预设/);
});

test('diurnal preset uses actual sidereal evolution with a fixed local camera, rather than a 24-hour star loop', () => {
  const state = loadPreset('T01'), before = computeSnapshot(state, 0);
  const initialCameras = structuredClone(state.cameras);
  assert.equal(state.viewMode, 'horizon'); assert.equal(state.cameras.horizon.referenceLock, 'local-horizon');
  assert.equal(state.layers.celestialPoles, true); assert.equal(state.layers.celestialEquator, true);
  state.time.utDaysJ2000 += 1;
  const after = computeSnapshot(state, 1);
  const dailyResidualDeg = mod(after.lstHours - before.lstHours, 24) * 15;
  assert.ok(dailyResidualDeg > .9 && dailyResidualDeg < 1.1, `one solar day residual=${dailyResidualDeg}`);
  const initialStar = applyMatrix(before.eqjToHorizontalGeometric, directionOfStar('hip:91262', before.utDaysJ2000));
  const laterStar = applyMatrix(after.eqjToHorizontalGeometric, directionOfStar('hip:91262', after.utDaysJ2000));
  assert.ok(angularSeparationDeg(initialStar, laterStar) > .5);
  assert.deepEqual(state.cameras, initialCameras);
});

test('north and south latitude presets share UTC and longitude while the visible celestial pole changes', () => {
  const north = loadPreset('T02'), south = loadPreset('T03');
  assert.equal(north.time.utDaysJ2000, south.time.utDaysJ2000);
  assert.equal(north.observer.longitudeDegEast, south.observer.longitudeDegEast);
  assert.deepEqual(north.observer.displayZone, south.observer.displayZone);
  for (const [state, sign] of [[north, 1], [south, -1]] as const) {
    const snapshot = computeSnapshot(state, 0);
    // The actual of-date terrestrial axis, not an assumed unprecessed J2000 +Z.
    const pole = applyMatrix(snapshot.earthFixedToEqj, [0, 0, sign]);
    const visiblePole = vectorToHorizontal(applyMatrix(snapshot.eqjToHorizontalGeometric, pole));
    const otherPole = vectorToHorizontal(applyMatrix(snapshot.eqjToHorizontalGeometric, pole.map(value => -value) as unknown as Vec3));
    assert.ok(Math.abs(visiblePole.altitudeDeg - 30) < 1e-9);
    assert.ok(Math.abs(otherPole.altitudeDeg + 30) < 1e-9);
    assert.equal(state.layers.celestialPoles, true);
  }
});

test('reused polar scenes yield continuous daylight or no sunrise with genuine winter twilight', () => {
  const summerNorth = computeSolarDayEvents(loadPreset('S05'));
  const winterNorth = computeSolarDayEvents(loadPreset('S06'));
  const summerSouth = computeSolarDayEvents(loadPreset('S07'));
  assert.equal(summerNorth.state, 'continuous-daylight');
  assert.ok(summerNorth.minimumGeometricAltitudeDeg > 0);
  assert.equal(winterNorth.state, 'no-sunrise');
  assert.ok(winterNorth.maximumGeometricAltitudeDeg < 0 && winterNorth.maximumGeometricAltitudeDeg > -6);
  assert.equal(summerSouth.state, 'continuous-daylight');
  assert.ok(summerSouth.minimumGeometricAltitudeDeg > 0);
});

test('four seasonal night skies keep local 22:00 and the same southern field, with meaningful real stars and solar declinations', () => {
  const cases = [
    ['T04', 'hip:49669', 'T06'], // Regulus, spring
    ['T05', 'hip:80763', 'T07'], // Antares, summer
    ['T06', 'hip:113368', 'T04'], // Fomalhaut, autumn
    ['T07', 'hip:21421', 'T05'], // Aldebaran, winter
  ] as const;
  const common = loadPreset('T04'), sunDeclinations: number[] = [];
  for (const [id, starId, opposite] of cases) {
    const state = loadPreset(id), snapshot = computeSnapshot(state, 0);
    assert.deepEqual(state.observer, common.observer);
    assert.deepEqual(state.cameras, common.cameras);
    assert.equal(localCivilParts(state.time.utDaysJ2000, state.observer.displayZone).hour, 22);
    assert.equal(state.presentation, 'observation');
    assert.ok(snapshot.bodies.find(body => body.id === 'Sun')!.geometricAltitudeDeg < -18);
    const enu = applyMatrix(snapshot.eqjToHorizontalGeometric, directionOfStar(starId, snapshot.utDaysJ2000));
    assert.ok(vectorToHorizontal(enu).altitudeDeg > 25, `${id} ${starId} should be well above the horizon`);
    const camera = state.cameras.ground;
    assert.ok(angularSeparationDeg(enu, horizontalToVector(camera.altitudeDeg, camera.azimuthDegNorthEast)) < camera.verticalFovDeg / 2);
    const oppositeSnapshot = computeSnapshot(loadPreset(opposite), 0);
    assert.ok(vectorToHorizontal(applyMatrix(oppositeSnapshot.eqjToHorizontalGeometric, directionOfStar(starId, oppositeSnapshot.utDaysJ2000))).altitudeDeg < 0);
    sunDeclinations.push(snapshot.bodies.find(body => body.id === 'Sun')!.decDegOfDate);
  }
  assert.ok(Math.abs(sunDeclinations[0]!) < 1 && Math.abs(sunDeclinations[2]!) < 1);
  assert.ok(sunDeclinations[1]! > 23 && sunDeclinations[3]! < -23);
});

test('earth-sun and ecliptic presets describe actual solar geometry, without changing physical distances', () => {
  const earthSun = loadPreset('V02'), sun = body(earthSun, 'Sun');
  assert.equal(earthSun.viewMode, 'space');
  assert.equal(earthSun.illustration.bodySizeScale, 1); assert.equal(earthSun.illustration.distanceCompressed, false);
  assert.ok(Math.hypot(...sun.geocentricEqjAU) > .98 && Math.hypot(...sun.geocentricEqjAU) < 1.02);
  const ecliptic = loadPreset('T08'), winterSun = body(ecliptic, 'Sun');
  assert.equal(ecliptic.viewMode, 'globe'); assert.equal(ecliptic.selected, 'body:Sun');
  assert.equal(ecliptic.layers.ecliptic, true); assert.equal(ecliptic.layers.celestialEquator, true);
  const obliquity = 23.43928 * Math.PI / 180;
  const j2000EclipticNormal: Vec3 = [0, -Math.sin(obliquity), Math.cos(obliquity)];
  const latitudeDeg = Math.asin(dot(normalize(winterSun.geocentricEqjAU), j2000EclipticNormal)) * 180 / Math.PI;
  assert.ok(Math.abs(latitudeDeg) < .01, `Sun latitude off the fixed J2000 reference plane=${latitudeDeg}`);
  assert.ok(winterSun.decDegOfDate < -23);
});

test('S09 keeps a real quarter search seed and gives four different geometric lunar appearances', () => {
  const state = loadPreset('S09'), metadata = getPreset('S09')!;
  assert.equal(utToDate(metadata.moonPhaseSeedUtDaysJ2000!).toISOString(), '2026-09-01T00:00:00.000Z');
  const sequence = computeMoonQuarterSequence(metadata.moonPhaseSeedUtDaysJ2000!);
  assert.equal(sequence.complete, true); assert.equal(sequence.events.length, 4);
  assert.deepEqual(new Set(sequence.events.map(event => event.phaseLongitudeDeg)), new Set([0, 90, 180, 270]));
  for (const event of sequence.events) {
    state.time.utDaysJ2000 = event.utDaysJ2000;
    const appearance = computeMoonAppearance(computeSnapshot(state, 0), 'geocentric')!;
    const target = event.phaseLongitudeDeg === 0 ? 0 : event.phaseLongitudeDeg === 180 ? 1 : .5;
    assert.ok(Math.abs(appearance.illuminatedFraction - target) < .02);
  }
});

test('pollution variants retain one real dark, moon-below-horizon sky and alter only the qualitative brightness', () => {
  const baseline = loadPreset('G01'), models = [];
  for (const [index, id] of ['G01', 'G02', 'G03'].entries()) {
    const state = loadPreset(id), snapshot = computeSnapshot(state, 0);
    assert.ok(snapshot.bodies.find(body => body.id === 'Sun')!.geometricAltitudeDeg < -18);
    assert.ok(snapshot.bodies.find(body => body.id === 'Moon')!.geometricAltitudeDeg < 0);
    assert.equal(state.environment.artificialSkyBrightness, index * .5);
    const withoutBrightness = structuredClone(state); withoutBrightness.environment.artificialSkyBrightness = 0;
    assert.deepEqual(withoutBrightness, baseline);
    models.push(deriveSkyAppearance(state, snapshot));
  }
  assert.ok(models[0]!.limitingMagnitude > models[1]!.limitingMagnitude && models[1]!.limitingMagnitude > models[2]!.limitingMagnitude);
});

test('birthday is a complete, explicitly chosen example rather than inferred personal birth data', () => {
  const state = loadPreset('B01'), metadata = getPreset('B01')!;
  assert.equal(utToDate(state.time.utDaysJ2000).toISOString(), '2026-09-14T14:00:00.000Z');
  assert.deepEqual(localCivilParts(state.time.utDaysJ2000, state.observer.displayZone), { year: 2026, month: 9, day: 14, hour: 22, minute: 0, second: 0 });
  assert.equal(state.observer.name, '杭州教学预设');
  assert.match(metadata.description, /未提供时刻时，本示例采用22:00/); assert.match(metadata.description, /22:00/);
  assert.match(metadata.description, /UTC\+8/); assert.match(metadata.sourceNote, /示例/);
  assert.ok(body(state, 'Sun').geometricAltitudeDeg < -18);
});
