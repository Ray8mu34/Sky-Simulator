import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SimulationState, Vec3 } from '../src/contracts';
import { computeSnapshot } from '../src/core/astronomy';
import { brightLimbPositionAngle, computeMoonAppearance, computeMoonQuarterSequence, moonPhaseNameZh, resolveLunarAppearance } from '../src/core/moon';
import { computeSolarDayEvents, computeSolarDayEventsCooperatively } from '../src/core/solar-events';
import { createSolarDayService, solarDayKey } from '../src/core/teaching';
import { angularSeparationDeg, applyMatrix, cross, dot, normalize, transposeMatrix } from '../src/core/math';
import { civilToDate, dateToUt, parseCivilInput, utToDate } from '../src/core/time';
import { scienceState } from './fixtures/science-state';

const close = (a: number, b: number, tolerance = 1e-10): void => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b} ±${tolerance}`);
const angleClose = (a: number, b: number, tolerance: number): void => close(((a - b + 540) % 360) - 180, 0, tolerance);
const json = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const stateAt = (utc: string, latitude = 30.25, longitude = 120.17): SimulationState => {
  const state = scienceState(utc, latitude, longitude); state.observer.heightMeters = 0; state.observer.displayZone = { kind: 'fixed', offsetMinutes: latitude === 30.25 ? 480 : 0 }; return state;
};

test('M3 independent raw references and explicit web capture retain their exact byte hashes and acquisition metadata', () => {
  for (const name of ['nasa-moon-2026-09-01', 'usno-solar70n-summer', 'usno-solar70n-winter', 'usno-phase-2026-09-web-capture', 'usno-hangzhou-2026-09-14']) {
    const metadata = json(`${name}.metadata.json`), raw = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), metadata.sha256);
    assert.ok(metadata.sourceUrl.startsWith('https://'));
    assert.ok(metadata.retrievedAt || metadata.retrievedAtUtc || metadata.capturedAt);
  }
  assert.ok(json('usno-phase-2026-09-web-capture.metadata.json').acquisition.includes('not original HTTP bytes'));
});

test('geocentric Moon orientation and phase match NASA Dial-a-Moon at the returned reference hour', () => {
  const reference = json('nasa-moon-2026-09-01.json');
  assert.equal(reference.time, '2026-09-01T00:00');
  const snapshot = computeSnapshot(stateAt(`${reference.time}:00Z`), 0), appearance = computeMoonAppearance(snapshot, 'geocentric')!;
  close(appearance.illuminatedFraction, reference.phase / 100, 0.0002);
  close(appearance.angularDiameterDeg, reference.diameter / 3600, 0.0001);
  angleClose(appearance.subObserver.longitudeDegEast, reference.subearth_lon, 0.01);
  close(appearance.subObserver.latitudeDeg, reference.subearth_lat, 0.01);
  angleClose(appearance.subSolar.longitudeDegEast, reference.subsolar_lon, 0.01);
  close(appearance.subSolar.latitudeDeg, reference.subsolar_lat, 0.01);
  const moon = snapshot.bodies.find(body => body.id === 'Moon')!;
  angleClose(brightLimbPositionAngle(normalize(moon.geocentricEqjAU), appearance.northEqjUnit)!, reference.posangle, 0.01);
  // This is an independent-body-coordinate derivation from NASA subearth/subsolar and pole PA.
  // Sky east points opposite the Moon's surface east when viewed from outside its Earth-facing hemisphere.
  const rad = Math.PI / 180, obsLat = reference.subearth_lat * rad, solarLat = reference.subsolar_lat * rad;
  const deltaLon = (reference.subsolar_lon - reference.subearth_lon) * rad;
  const relativeBrightLimb = Math.atan2(-Math.cos(solarLat) * Math.sin(deltaLon), Math.cos(obsLat) * Math.sin(solarLat) - Math.sin(obsLat) * Math.cos(solarLat) * Math.cos(deltaLon)) / rad;
  angleClose(appearance.brightLimbPositionAngleDeg!, reference.posangle + relativeBrightLimb, 0.01);
});

test('Moon fixed basis is right-handed, retains its physical north, and does not apply libration twice', () => {
  const snapshot = computeSnapshot(stateAt('2026-09-01T00:00:00Z'), 0), appearance = computeMoonAppearance(snapshot)!;
  const matrix = appearance.bodyFixedToEqj;
  close(dot(matrix[0], cross(matrix[1], matrix[2])), 1, 1e-12);
  for (const basis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) close(Math.hypot(...applyMatrix(matrix, basis)), 1);
  close(angularSeparationDeg(applyMatrix(matrix, [0, 0, 1]), appearance.northEqjUnit), 0);
  const sub = applyMatrix(transposeMatrix(matrix), appearance.observerDirectionEqjUnit);
  close(appearance.subObserver.latitudeDeg, Math.atan2(sub[2], Math.hypot(sub[0], sub[1])) * 180 / Math.PI);
  assert.equal(appearance.libration.perspective, 'geocentric');
  assert.equal(matrix, snapshot.bodies.find(body => body.id === 'Moon')!.bodyFixedToEqj);
});

test('Moon physical observer geometry remains coherent across topocentric/geocentric modes and cached consumers', () => {
  const snapshot = computeSnapshot(stateAt('2026-09-14T14:00:00Z'), 0), topo = resolveLunarAppearance(snapshot, 'ground')!, geo = resolveLunarAppearance(snapshot, 'space')!;
  assert.equal(resolveLunarAppearance(snapshot, 'ground'), topo);
  assert.equal(resolveLunarAppearance(snapshot, 'globe'), geo);
  assert.equal(resolveLunarAppearance(snapshot, 'horizon'), geo);
  close(topo.illuminatedFraction, (1 + dot(topo.sunDirectionEqjUnit, topo.observerDirectionEqjUnit)) / 2);
  close(topo.illuminatedFraction, (1 + Math.cos(topo.phaseAngleDeg * Math.PI / 180)) / 2);
  close(topo.illuminatedFraction, snapshot.bodies.find(body => body.id === 'Moon')!.illuminatedFraction!);
  assert.ok(angularSeparationDeg(topo.observerDirectionEqjUnit, geo.observerDirectionEqjUnit) > 0.1);
  assert.notEqual(topo.angularDiameterDeg, geo.angularDiameterDeg);
  const noMoon = { ...snapshot, bodies: [] }; assert.equal(computeMoonAppearance(noMoon), null); assert.equal(computeMoonAppearance(noMoon), null);
});

test('bright limb angle is north-zero east-positive and becomes undefined at aligned new/full geometry', () => {
  const moonDirection: Vec3 = [1, 0, 0];
  close(brightLimbPositionAngle(moonDirection, [0, 0, 1])!, 0);
  close(brightLimbPositionAngle(moonDirection, [0, 1, 0])!, 90);
  close(brightLimbPositionAngle(moonDirection, [0, 0, -1])!, 180);
  close(brightLimbPositionAngle(moonDirection, [0, -1, 0])!, 270);
  assert.equal(brightLimbPositionAngle(moonDirection, [1, 0, 0]), null);
  assert.equal(brightLimbPositionAngle(moonDirection, [-1, 0, 0]), null);
  assert.equal(brightLimbPositionAngle([0, 0, 1], [1, 0, 0]), null);
});

test('phase teaching labels use narrow named-quarter neighborhoods instead of calling 31% illumination a quarter', () => {
  assert.equal(moonPhaseNameZh(0), '新月附近'); assert.equal(moonPhaseNameZh(90), '上弦月附近');
  assert.equal(moonPhaseNameZh(180), '满月附近'); assert.equal(moonPhaseNameZh(270), '下弦月附近');
  assert.equal(moonPhaseNameZh(70), '蛾眉月'); assert.equal(moonPhaseNameZh(110), '盈凸月');
  assert.equal(moonPhaseNameZh(210), '亏凸月'); assert.equal(moonPhaseNameZh(320), '残月');
  assert.throws(() => moonPhaseNameZh(NaN), RangeError);
});

test('four adjacent lunar quarter events from S09 seed match independent USNO minute-rounded Universal Time', () => {
  const reference = json('usno-phase-2026-09-web-capture.json'), sequence = computeMoonQuarterSequence(dateToUt(new Date('2026-09-01T00:00:00Z')));
  assert.equal(sequence.complete, true); assert.equal(sequence.events.length, 4);
  assert.deepEqual(sequence.events.map(event => event.phaseLongitudeDeg), [270, 0, 90, 180]);
  reference.phasedata.forEach((row: { year: number; month: number; day: number; time: string }, index: number) => {
    const [hour, minute] = row.time.split(':').map(Number);
    const expected = dateToUt(civilToDate({ astronomicalYear: row.year, month: row.month, day: row.day, hour: hour!, minute: minute!, second: 0 }));
    close((sequence.events[index]!.utDaysJ2000 - expected) * 86400, 0, 120);
    if (index > 0) assert.ok(sequence.events[index]!.utDaysJ2000 > sequence.events[index - 1]!.utDaysJ2000);
    const appearance = computeMoonAppearance(computeSnapshot(stateAt(utToDate(sequence.events[index]!.utDaysJ2000).toISOString()), 0), 'geocentric')!;
    angleClose(appearance.phaseLongitudeDeg, sequence.events[index]!.phaseLongitudeDeg, 0.001);
  });
});

test('lunar quarter search rejects invalid seeds and filters future year-4001 jump targets', () => {
  assert.throws(() => computeMoonQuarterSequence(NaN), RangeError);
  assert.throws(() => computeMoonQuarterSequence(Infinity), RangeError);
  const sequence = computeMoonQuarterSequence(dateToUt(new Date('4000-12-31T23:59:59Z')));
  assert.equal(sequence.complete, false); assert.ok(sequence.events.every(event => utToDate(event.utDaysJ2000).getUTCFullYear() <= 4000));
  assert.ok(sequence.notes.some(note => note.includes('超出支持范围')));
});

test('ordinary solar upper-limb rise/set and civil twilight agree with independent sea-level USNO within two minutes', () => {
  const raw = json('usno-hangzhou-2026-09-14.json'), events = computeSolarDayEvents(stateAt('2026-09-14T14:00:00Z'));
  const expectedFields = { 'Rise': events.riseUtDaysJ2000, 'Set': events.setUtDaysJ2000, 'Begin Civil Twilight': events.twilight.civil.dawnUtDaysJ2000, 'End Civil Twilight': events.twilight.civil.duskUtDaysJ2000 };
  for (const row of raw.properties.data.sundata as { phen: string; time: string }[]) {
    if (!(row.phen in expectedFields)) continue;
    const [hour, minute] = row.time.split(':').map(Number), expected = parseCivilInput({ astronomicalYear: 2026, month: 9, day: 14, hour: hour!, minute: minute!, second: 0, zone: { kind: 'fixed', offsetMinutes: 480 }, ambiguousTime: 'reject' });
    close((expectedFields[row.phen as keyof typeof expectedFields]! - expected) * 86400, 0, 120);
  }
  assert.equal(events.state, 'normal'); assert.ok(events.definition.includes('34′') && events.definition.includes('当地水平地平') && events.definition.includes('0m'));
});

test('USNO high-latitude no-sunrise still has civil twilight and summer has no twilight threshold crossings', () => {
  const winterRaw = json('usno-solar70n-winter.json'), summerRaw = json('usno-solar70n-summer.json');
  assert.ok(winterRaw.properties.data.sundata.some((row: { phen: string }) => row.phen.includes('below')));
  assert.ok(summerRaw.properties.data.sundata.some((row: { phen: string }) => row.phen.includes('above')));
  const winter = computeSolarDayEvents(stateAt('2026-12-21T12:00:00Z', 70, 0)), summer = computeSolarDayEvents(stateAt('2026-06-21T12:00:00Z', 70, 0));
  assert.equal(winter.state, 'no-sunrise'); assert.ok(winter.noEventReason!.includes('不代表全天漆黑'));
  for (const [phen, actual] of [['Begin Civil Twilight', winter.twilight.civil.dawnUtDaysJ2000], ['End Civil Twilight', winter.twilight.civil.duskUtDaysJ2000]] as const) {
    const row = winterRaw.properties.data.sundata.find((row: { phen: string }) => row.phen === phen), expected = dateToUt(new Date(`2026-12-21T${row.time}:00Z`));
    close((actual! - expected) * 86400, 0, 120);
  }
  assert.equal(summer.state, 'continuous-daylight');
  for (const twilight of Object.values(summer.twilight)) { assert.equal(twilight.state, 'always-above'); assert.equal(twilight.dawnUtDaysJ2000, null); assert.ok(twilight.noEventReason); }
});

test('no-event classification uses the same upper-limb radius/density threshold even inside the old empirical gap', () => {
  const event = computeSolarDayEvents(stateAt('2026-12-21T12:00:00Z', 67.45, 0));
  assert.ok(event.maximumGeometricAltitudeDeg > -1 && event.maximumGeometricAltitudeDeg < -0.7);
  assert.equal(event.state, 'no-sunrise'); assert.ok(event.riseSetClearanceRangeDeg.maximum < 0);
  const high = stateAt('2026-12-21T12:00:00Z', 67.45, 0); high.observer.heightMeters = 3000;
  const highEvent = computeSolarDayEvents(high);
  assert.notEqual(highEvent.riseSetClearanceRangeDeg.maximum, event.riseSetClearanceRangeDeg.maximum);
});

test('twilight events are centre geometric thresholds and extrema times represent refined stationary values', () => {
  const state = stateAt('2026-09-14T14:00:00Z'), events = computeSolarDayEvents(state);
  for (const twilight of Object.values(events.twilight)) {
    for (const crossing of twilight.crossings) {
      const at = structuredClone(state); at.time.utDaysJ2000 = crossing.utDaysJ2000;
      const sun = computeSnapshot(at, 0).bodies.find(body => body.id === 'Sun')!;
      // AE's altitude search stops at 0.1s. A conservative 15°/hour angular
      // slope converts that time tolerance to <0.00042°, not an exact zero.
      close(sun.geometricAltitudeDeg, twilight.thresholdGeometricAltitudeDeg, 0.0005);
      assert.ok(crossing.utDaysJ2000 >= events.bounds.startUtDaysJ2000 && crossing.utDaysJ2000 < events.bounds.endUtDaysJ2000);
    }
  }
  for (const kind of ['minimum', 'maximum'] as const) {
    const time = events.extremaTimes[`${kind}UtDaysJ2000`], altitude = events[`${kind}GeometricAltitudeDeg`];
    const at = structuredClone(state); at.time.utDaysJ2000 = time;
    close(computeSnapshot(at, 0).bodies.find(body => body.id === 'Sun')!.geometricAltitudeDeg, altitude, 1e-7);
    for (const offset of [-60, 60]) { at.time.utDaysJ2000 = time + offset / 86400; const nearby = computeSnapshot(at, 0).bodies.find(body => body.id === 'Sun')!.geometricAltitudeDeg;
      assert.ok(kind === 'minimum' ? nearby > altitude : nearby < altitude); }
  }
});

test('solar cache keys include civil boundaries, observer height, zone and model but exclude visual environment and observer name', () => {
  const state = stateAt('2026-09-14T14:00:00Z'), key = solarDayKey(state), changed = structuredClone(state);
  changed.environment.pressureHpa = 900; changed.environment.refraction = 'standard'; changed.observer.name = '另一个标签'; changed.time.utDaysJ2000 += 1 / 24;
  assert.equal(solarDayKey(changed), key);
  changed.observer.heightMeters = 100; assert.notEqual(solarDayKey(changed), key);
  changed.observer.heightMeters = 0; changed.observer.displayZone = { kind: 'fixed', offsetMinutes: 0 }; assert.notEqual(solarDayKey(changed), key);
  changed.observer.displayZone = { offsetMinutes: 480, kind: 'fixed' }; assert.equal(solarDayKey(changed), key);
  changed.time.utDaysJ2000 += 1; assert.notEqual(solarDayKey(changed), key);
});

test('bounded LRU returns immutable same-key results and evicts instead of accumulating event history', () => {
  const service = createSolarDayService({ maxEntries: 2 }), state = stateAt('2026-09-14T14:00:00Z'), original = service.compute(state);
  assert.equal(service.compute(state), original); assert.ok(Object.isFrozen(original) && Object.isFrozen(original.twilight.civil));
  for (const offset of [1, 2, 3]) { const next = structuredClone(state); next.time.utDaysJ2000 += offset; service.compute(next); }
  assert.deepEqual(service.diagnostics(), { cacheEntries: 2, maxEntries: 2, computations: 4, cacheHits: 1, cacheEvictions: 2 });
  service.clear(); assert.equal(service.diagnostics().cacheEntries, 0);
  assert.throws(() => createSolarDayService({ maxEntries: 0 }), RangeError);
});

test('cooperative fallback and synchronous worker solver share exact results with real yield points', async () => {
  const state = stateAt('2026-09-14T14:00:00Z'), expected = computeSolarDayEvents(state); let yields = 0;
  const actual = await computeSolarDayEventsCooperatively(state, async () => { yields++; });
  assert.deepEqual(actual, expected); assert.ok(yields >= 10 && yields < 300);
  const service = createSolarDayService({ maxEntries: 2 });
  assert.deepEqual(await service.computeCooperatively(state, async () => {}), expected);
  assert.equal(service.diagnostics().computations, 1);
});

test('solar events respect 23/25-hour civil days, skipped midnight, exact poles and year-4000 exclusive endpoint', () => {
  const ny = stateAt('2026-03-08T12:00:00Z', 40.7, -74); ny.observer.displayZone = { kind: 'iana', name: 'America/New_York', versionNote: 'host Intl/ICU' };
  let report = computeSolarDayEvents(ny); close((report.bounds.endUtDaysJ2000 - report.bounds.startUtDaysJ2000) * 24, 23, 1e-8);
  ny.time.utDaysJ2000 = dateToUt(new Date('2026-11-01T12:00:00Z')); report = computeSolarDayEvents(ny); close((report.bounds.endUtDaysJ2000 - report.bounds.startUtDaysJ2000) * 24, 25, 1e-8);
  const brazil = stateAt('2018-11-04T12:00:00Z', -23.5, -46.6); brazil.observer.displayZone = { kind: 'iana', name: 'America/Sao_Paulo', versionNote: 'host Intl/ICU' };
  assert.equal(utToDate(computeSolarDayEvents(brazil).bounds.startUtDaysJ2000).toISOString(), '2018-11-04T03:00:00.000Z');
  for (const pole of [-90, 90]) assert.ok(Number.isFinite(computeSolarDayEvents(stateAt('2026-06-21T12:00:00Z', pole, 0)).maximumGeometricAltitudeDeg));
  const final = computeSolarDayEvents(stateAt('4000-12-31T12:00:00Z', 30, 0));
  assert.equal(utToDate(final.bounds.endUtDaysJ2000).toISOString(), '4001-01-01T00:00:00.000Z');
});

test('independent edge-peak regressions retain internal extrema between civil-day edges and hour-angle knots', () => {
  const oracle = json('solar-oracle-initial-failures.json');
  const failed = oracle.rows.filter((row: { failures: string[] }) => row.failures.length > 0);
  assert.equal(failed.length, 4);
  for (const row of failed) {
    const state = stateAt(row.input.utc, row.input.observer.latitudeDeg, row.input.observer.longitudeDegEast);
    state.observer = row.input.observer;
    const actual = computeSolarDayEvents(state);
    close(actual.minimumGeometricAltitudeDeg, row.expected.minimum.value, 1e-6);
    close(actual.maximumGeometricAltitudeDeg, row.expected.maximum.value, 1e-6);
    close((actual.extremaTimes.maximumUtDaysJ2000 - row.expected.maximum.ut) * 86400, 0, 1);
    close((actual.extremaTimes.minimumUtDaysJ2000 - row.expected.minimum.ut) * 86400, 0, 1);
    if (row.name === 'rise-set-short-positive-peak-near-start') {
      assert.ok(actual.riseSetClearanceRangeDeg.maximum > 0, 'narrow peak really clears the same rise/set threshold');
      assert.equal(actual.riseSetCrossings.length, 2);
      const minutes = (actual.setUtDaysJ2000! - actual.riseUtDaysJ2000!) * 1440;
      assert.ok(minutes > 5 && minutes < 6, 'five-minute visible interval must survive a ten-minute sampling gap');
    }
  }
});
