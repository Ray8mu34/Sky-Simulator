import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScienceSnapshot, SimulationState } from '../src/contracts';
import { computeSnapshot } from '../src/core/astronomy';
import { dateToUt } from '../src/core/time';
import { deriveSkyAppearance, type SkyAppearance } from '../src/core/sky-appearance';
import { scienceState } from './fixtures/science-state';

const baselineState = scienceState();
const baselineSnapshot = computeSnapshot(baselineState, 100);
function fixture(sunAltitude = -30, moonAltitude = -10, illuminated = 1): { state: SimulationState; snapshot: ScienceSnapshot } {
  const state = structuredClone(baselineState);
  state.presentation = 'observation'; state.layers.atmosphere = true;
  const snapshot = { ...baselineSnapshot, bodies: baselineSnapshot.bodies.map(body => body.id === 'Sun'
    ? { ...body, geometricAltitudeDeg: sunAltitude } : body.id === 'Moon' ? { ...body, geometricAltitudeDeg: moonAltitude, illuminatedFraction: illuminated } : body) };
  return { state, snapshot };
}
function effective(appearance: SkyAppearance) {
  const { limitingMagnitude, starVisibility, milkyWayContrast, skyBrightness, daylightStrength, moonlightStrength, artificialLightStrength,
    backgroundLinearRgb, horizonGlowLinearRgb } = appearance;
  return { limitingMagnitude, starVisibility, milkyWayContrast, skyBrightness, daylightStrength, moonlightStrength, artificialLightStrength,
    backgroundLinearRgb, horizonGlowLinearRgb };
}
function assertNoSuppression(appearance: SkyAppearance, base: number) {
  assert.equal(appearance.visibilityApplied, false);
  assert.equal(appearance.limitingMagnitude, base);
  assert.equal(appearance.starVisibility, 1);
  assert.equal(appearance.milkyWayContrast, 1);
  assert.equal(appearance.artificialLightStrength, 0);
  assert.equal(appearance.moonlightStrength, 0);
}

test('unlit night preserves star baseline, while pollution monotonically changes stars, galaxy and floor', () => {
  const { state, snapshot } = fixture();
  const first = deriveSkyAppearance(state, snapshot);
  assert.equal(first.limitingMagnitude, 6.5); assert.equal(first.starVisibility, 1); assert.equal(first.milkyWayContrast, 1);
  assert.equal(first.skyBrightness, 0); assert.equal(first.scope, 'local-observer'); assert.equal(first.reason, 'ground-observation');
  let previous = first;
  for (let index = 1; index <= 100; index++) {
    state.environment.artificialSkyBrightness = index / 100;
    const current = deriveSkyAppearance(state, snapshot);
    assert.ok(current.limitingMagnitude < previous.limitingMagnitude);
    assert.ok(current.milkyWayContrast < previous.milkyWayContrast);
    assert.ok(current.skyBrightness > previous.skyBrightness);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(current.backgroundLinearRgb[axis]! > previous.backgroundLinearRgb[axis]!);
      assert.ok(current.horizonGlowLinearRgb[axis]! > previous.horizonGlowLinearRgb[axis]!);
    }
    previous = current;
  }
  assert.ok(previous.limitingMagnitude < 4); assert.ok(previous.milkyWayContrast < 0.02);
});

test('sunrise and twilight drive continuous monotone visibility, without jumps at -18/-12/-6/0 degrees', () => {
  const dark = fixture(-30);
  let previous = deriveSkyAppearance(dark.state, dark.snapshot);
  for (let altitude = -30; altitude <= 60; altitude += 0.5) {
    const { state, snapshot } = fixture(altitude);
    const current = deriveSkyAppearance(state, snapshot);
    assert.ok(current.limitingMagnitude <= previous.limitingMagnitude + 1e-12);
    assert.ok(current.starVisibility <= previous.starVisibility + 1e-12);
    assert.ok(current.milkyWayContrast <= previous.milkyWayContrast + 1e-12);
    assert.ok(current.skyBrightness >= previous.skyBrightness - 1e-12);
    previous = current;
  }
  assert.equal(previous.starVisibility, 0); assert.equal(previous.milkyWayContrast, 0);
  for (const altitude of [-18, -12, -6, 0]) {
    const left = fixture(altitude - 1e-6), right = fixture(altitude + 1e-6);
    const a = deriveSkyAppearance(left.state, left.snapshot), b = deriveSkyAppearance(right.state, right.snapshot);
    for (const key of ['daylightStrength', 'starVisibility', 'milkyWayContrast', 'skyBrightness', 'limitingMagnitude'] as const) {
      assert.ok(Math.abs(a[key] - b[key]) < 2e-6, `${key} continuous at ${altitude}`);
    }
  }
});

test('daylight dominates background and horizon RGB instead of retaining full artificial and moon colour', () => {
  for (const sunAltitude of [0, 15, 45, 90]) {
    const unlit = fixture(sunAltitude, 45, 0), lit = fixture(sunAltitude, 45, 1);
    lit.state.environment.artificialSkyBrightness = 1;
    const natural = deriveSkyAppearance(unlit.state, unlit.snapshot), allSources = deriveSkyAppearance(lit.state, lit.snapshot);
    assert.deepEqual(allSources.backgroundLinearRgb, natural.backgroundLinearRgb);
    assert.deepEqual(allSources.horizonGlowLinearRgb, natural.horizonGlowLinearRgb);
    assert.equal(allSources.starVisibility, 0); assert.equal(allSources.milkyWayContrast, 0); assert.equal(allSources.skyBrightness, 1);
  }
  const night = fixture(-30, 45, 0);
  const darkFloor = deriveSkyAppearance(night.state, night.snapshot);
  for (const sunAltitude of [-6, -3, -0.001]) {
    const unlit = fixture(sunAltitude, 45, 0), lit = fixture(sunAltitude, 45, 1);
    lit.state.environment.artificialSkyBrightness = 1;
    const natural = deriveSkyAppearance(unlit.state, unlit.snapshot), allSources = deriveSkyAppearance(lit.state, lit.snapshot);
    for (const key of ['backgroundLinearRgb', 'horizonGlowLinearRgb'] as const) for (let axis = 0; axis < 3; axis++) {
      const solarColour = natural[key][axis]! - darkFloor[key][axis]!;
      const otherColour = allSources[key][axis]! - natural[key][axis]!;
      assert.ok(otherColour >= 0 && otherColour < solarColour, `${key}[${axis}] dominated by sunlight at ${sunAltitude}`);
    }
  }
});

test('artificial and moon colour fade continuously through twilight while night colour differences remain present', () => {
  let previous: number[] | null = null;
  for (let sunAltitude = -30; sunAltitude <= 15; sunAltitude += 0.5) {
    const unlit = fixture(sunAltitude, 45, 0), lit = fixture(sunAltitude, 45, 1);
    lit.state.environment.artificialSkyBrightness = 1;
    const natural = deriveSkyAppearance(unlit.state, unlit.snapshot), allSources = deriveSkyAppearance(lit.state, lit.snapshot);
    const excess = [...allSources.backgroundLinearRgb, ...allSources.horizonGlowLinearRgb].map((component, index) =>
      component - [...natural.backgroundLinearRgb, ...natural.horizonGlowLinearRgb][index]!);
    if (previous) for (let axis = 0; axis < excess.length; axis++) assert.ok(excess[axis]! <= previous[axis]! + 1e-15);
    if (sunAltitude <= -18) assert.ok(excess.every(component => component > 0));
    if (sunAltitude >= 0) assert.ok(excess.every(component => component === 0));
    previous = excess;
  }
  for (const boundary of [-18, -12, -6, 0]) {
    const left = fixture(boundary - 1e-7, 45, 1), right = fixture(boundary + 1e-7, 45, 1);
    left.state.environment.artificialSkyBrightness = 1; right.state.environment.artificialSkyBrightness = 1;
    const a = deriveSkyAppearance(left.state, left.snapshot), b = deriveSkyAppearance(right.state, right.snapshot);
    for (const key of ['backgroundLinearRgb', 'horizonGlowLinearRgb'] as const) for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs(a[key][axis]! - b[key][axis]!) < 1e-7, `${key} continuous at ${boundary}`);
  }
});

test('moonlight is strictly zero at/below centre horizon, continuous above it, and grows with altitude and phase', () => {
  for (const altitude of [-90, -0.001, 0]) {
    const { state, snapshot } = fixture(-30, altitude, 1);
    assert.equal(deriveSkyAppearance(state, snapshot).moonlightStrength, 0);
  }
  const edge = fixture(-30, 0.001, 1);
  const edgeAppearance = deriveSkyAppearance(edge.state, edge.snapshot);
  assert.ok(edgeAppearance.moonlightStrength > 0 && edgeAppearance.moonlightStrength < 1e-7);
  let previous = 0;
  for (let altitude = 0; altitude <= 90; altitude++) {
    const { state, snapshot } = fixture(-30, altitude, 1);
    const current = deriveSkyAppearance(state, snapshot).moonlightStrength;
    assert.ok(current >= previous); previous = current;
  }
  const newMoon = fixture(-30, 45, 0);
  let phasePrevious = deriveSkyAppearance(newMoon.state, newMoon.snapshot);
  assert.equal(phasePrevious.moonlightStrength, 0);
  for (let illuminated = 0.01; illuminated <= 1.000001; illuminated += 0.01) {
    const { state, snapshot } = fixture(-30, 45, Math.min(1, illuminated));
    const appearance = deriveSkyAppearance(state, snapshot);
    assert.ok(appearance.moonlightStrength > phasePrevious.moonlightStrength);
    assert.ok(appearance.limitingMagnitude < phasePrevious.limitingMagnitude);
    assert.ok(appearance.milkyWayContrast < phasePrevious.milkyWayContrast);
    assert.ok(appearance.skyBrightness > phasePrevious.skyBrightness);
    phasePrevious = appearance;
  }
});

test('moonlight switch alone changes lunar scattering; body layers and teaching scales cannot change it', () => {
  const { state, snapshot } = fixture(-30, 45, 1);
  const withMoon = deriveSkyAppearance(state, snapshot);
  assert.ok(withMoon.moonlightStrength > 0);
  state.layers.sunMoon = false; state.illustration.bodySizeScale = 100; state.illustration.distanceCompressed = true;
  state.cameras.space.distanceDisplayUnits = 0.2; state.layers.terrain = false;
  assert.deepEqual(deriveSkyAppearance(state, snapshot), withMoon);
  state.environment.moonlightEnabled = false;
  const without = deriveSkyAppearance(state, snapshot);
  assert.equal(without.moonlightStrength, 0);
  assert.ok(without.limitingMagnitude > withMoon.limitingMagnitude);
  assert.ok(without.milkyWayContrast > withMoon.milkyWayContrast);
  assert.ok(without.skyBrightness < withMoon.skyBrightness);
  const day = fixture(30, 45, 1);
  const visibleBodies = deriveSkyAppearance(day.state, day.snapshot);
  day.state.layers.sunMoon = false;
  assert.deepEqual(deriveSkyAppearance(day.state, day.snapshot), visibleBodies);
});

test('explanation keeps baseline star chart and may retain natural daytime background only on ground', () => {
  for (const viewMode of ['ground', 'space', 'globe', 'horizon'] as const) {
    const { state, snapshot } = fixture(45, 45, 1);
    state.presentation = 'explanation'; state.viewMode = viewMode;
    const before = deriveSkyAppearance(state, snapshot);
    state.environment.artificialSkyBrightness = 1; state.environment.moonlightEnabled = false;
    assert.deepEqual(deriveSkyAppearance(state, snapshot), before);
    assertNoSuppression(before, state.environment.darkSkyLimitingMagnitude);
    assert.equal(before.daylightStrength, viewMode === 'ground' ? 1 : 0);
    assert.equal(before.skyBrightness, viewMode === 'ground' ? 1 : 0);
    assert.equal(before.scope, viewMode === 'ground' ? 'local-observer' : 'direction-diagram');
  }
});

test('all external observation modes are direction diagrams with no terrestrial pollution', () => {
  for (const viewMode of ['space', 'globe', 'horizon'] as const) {
    const { state, snapshot } = fixture(45, 45, 1);
    state.viewMode = viewMode;
    const before = deriveSkyAppearance(state, snapshot);
    state.environment.artificialSkyBrightness = 1;
    const after = deriveSkyAppearance(state, snapshot);
    assert.deepEqual(after, before); assertNoSuppression(after, 6.5);
    assert.equal(after.reason, 'external-diagram'); assert.equal(after.daylightStrength, 0); assert.equal(after.skyBrightness, 0);
    assert.ok(after.notes.some(note => note.includes('返回地表')));
  }
});

test('atmosphere disabled removes scattering and all visibility suppression consistently', () => {
  for (const presentation of ['observation', 'explanation'] as const) {
    const { state, snapshot } = fixture(45, 45, 1);
    state.presentation = presentation; state.layers.atmosphere = false;
    const before = deriveSkyAppearance(state, snapshot);
    state.environment.artificialSkyBrightness = 1;
    assert.deepEqual(deriveSkyAppearance(state, snapshot), before); assertNoSuppression(before, 6.5);
    assert.equal(before.reason, 'atmosphere-disabled'); assert.equal(before.daylightStrength, 0); assert.equal(before.skyBrightness, 0);
  }
});

test('model parameters remain finite and bounded across valid environment and astronomical extremes', () => {
  for (const base of [-2, 6.5, 12]) for (const sun of [-90, -18, -6, 0, 90]) for (const moon of [-90, 0, 30, 90])
    for (const phase of [0, 0.5, 1]) for (const artificial of [0, 0.5, 1]) {
      const { state, snapshot } = fixture(sun, moon, phase);
      state.environment.darkSkyLimitingMagnitude = base; state.environment.artificialSkyBrightness = artificial;
      const result = deriveSkyAppearance(state, snapshot);
      assert.ok(Number.isFinite(result.limitingMagnitude) && result.limitingMagnitude >= -2 && result.limitingMagnitude <= base);
      for (const key of ['starVisibility', 'milkyWayContrast', 'skyBrightness', 'daylightStrength', 'moonlightStrength', 'artificialLightStrength'] as const)
        assert.ok(Number.isFinite(result[key]) && result[key] >= 0 && result[key] <= 1, key);
      for (const component of [...result.backgroundLinearRgb, ...result.horizonGlowLinearRgb]) assert.ok(Number.isFinite(component) && component >= 0 && component <= 1);
    }
});

test('invalid and missing snapshot values are explicit rather than converted to fake solar daylight or lunar phase', () => {
  const { state, snapshot } = fixture();
  for (const invalid of [NaN, Infinity, -0.1, 1.1]) {
    state.environment.artificialSkyBrightness = invalid;
    assert.throws(() => deriveSkyAppearance(state, snapshot), RangeError);
  }
  state.environment.artificialSkyBrightness = 0;
  for (const invalid of [NaN, Infinity, -90.001, 90.001]) {
    const altered = { ...snapshot, bodies: snapshot.bodies.map(body => body.id === 'Sun' ? { ...body, geometricAltitudeDeg: invalid } : body) };
    assert.throws(() => deriveSkyAppearance(state, altered), RangeError);
  }
  const missing = { ...snapshot, bodies: snapshot.bodies.filter(body => body.id !== 'Sun' && body.id !== 'Moon') };
  const result = deriveSkyAppearance(state, missing);
  assert.equal(result.sunAltitudeDeg, null); assert.equal(result.moonAltitudeDeg, null); assert.equal(result.moonIlluminatedFraction, null);
  assert.equal(result.daylightStrength, 0); assert.equal(result.moonlightStrength, 0);
  assert.ok(result.notes.some(note => note.includes('不能把此结果当作已确认的夜空')));
  assert.ok(result.notes.some(note => note.includes('不能把此结果当作已确认的无月夜空')));
});

test('read-only output does not mutate time, observer, camera, state or science; extended dates disclose static background', () => {
  const { state, snapshot } = fixture(-18, 15, 0.5);
  const stateBefore = structuredClone(state), snapshotBefore = structuredClone(snapshot);
  const result = deriveSkyAppearance(state, snapshot);
  assert.deepEqual(state, stateBefore); assert.deepEqual(snapshot, snapshotBefore);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.backgroundLinearRgb)); assert.ok(Object.isFrozen(result.notes));
  const extended = { ...snapshot, utDaysJ2000: dateToUt(new Date('4000-06-21T12:00:00Z')) };
  const after = deriveSkyAppearance(state, extended);
  assert.deepEqual(effective(after), effective(result));
  assert.ok(after.notes.some(note => note.includes('扩展年代') && note.includes('静态纹理')));
  assert.ok(result.notes.some(note => note.includes('未标定SQM')));
});

test('fixed Hangzhou comparison scene isolates artificial light using a real science snapshot', () => {
  const state = scienceState('2026-08-14T14:00:00Z');
  state.presentation = 'observation'; state.layers.atmosphere = true;
  const snapshot = computeSnapshot(state, 101);
  const baseline = deriveSkyAppearance(state, snapshot);
  assert.ok(baseline.sunAltitudeDeg! < -18); assert.ok(baseline.moonAltitudeDeg! < 0);
  assert.equal(baseline.daylightStrength, 0); assert.equal(baseline.moonlightStrength, 0);
  const outputs = [0, 0.5, 1].map(artificial => {
    state.environment.artificialSkyBrightness = artificial;
    return deriveSkyAppearance(state, snapshot);
  });
  for (let index = 1; index < outputs.length; index++) {
    assert.ok(outputs[index]!.limitingMagnitude < outputs[index - 1]!.limitingMagnitude);
    assert.ok(outputs[index]!.milkyWayContrast < outputs[index - 1]!.milkyWayContrast);
    assert.ok(outputs[index]!.skyBrightness > outputs[index - 1]!.skyBrightness);
  }
});
