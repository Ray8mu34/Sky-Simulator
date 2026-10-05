import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DisplayZone, ObjectId, SimulationState } from '../src/contracts';
import type { StarCatalog, StarMeta } from '../src/data/types';
import { resolveObjectDayTarget } from '../src/data/object-day-target';
import { computeObjectDayEvents, computeObjectDayEventsCooperatively, objectDayKey, validateObjectDayTarget } from '../src/core/object-day-events';
import type { ObjectDayTarget } from '../src/core/object-day-events';
import { createDayEventService } from '../src/core/day-event-service';
import { computeSnapshot } from '../src/core/astronomy';
import { computeObserverFrame } from '../src/core/observer-frame';
import { dateToUt, localDayBounds, localDayBoundsSteps, timeCacheDiagnostics, validateDisplayZone } from '../src/core/time';
import { scienceState } from './fixtures/science-state';

const stars = (JSON.parse(readFileSync(new URL('./fixtures/m5a/source-stars.json', import.meta.url), 'utf8')) as { stars: StarMeta[] }).stars;
const catalog: StarCatalog = { stars, directionsEqj: new Float32Array(9), magnitudes: new Float32Array(3), colors: new Float32Array(9), colorIndices: new Float32Array(3), lineIndices: new Uint16Array(0), constellations: [] };
const sun: ObjectDayTarget = { kind: 'body', id: 'body:Sun' }, moon: ObjectDayTarget = { kind: 'body', id: 'body:Moon' };
const targetFor = (id: ObjectId): ObjectDayTarget => { const resolution = resolveObjectDayTarget(catalog, id); if (!resolution.available) throw Error(resolution.message); return resolution.target; };
const sirius = targetFor('hip:32349');
interface Reference { rawFile: string; metadataFile: string; sha256: string; bytes: number; sourceUrl: string; kind: string; canonicalCatalogId?: ObjectId; dateLocal: string; observer: SimulationState['observer']; expectedCrossings: { kind: 'rise' | 'set'; timeLocal: string }[]; expectedClassification?: string | null; expectedClassificationText?: string | null }
const references = (JSON.parse(readFileSync(new URL('./fixtures/m5a/reference-index.json', import.meta.url), 'utf8')) as { rows: Reference[] }).rows;
for (const reference of references) test(`frozen USNO events: ${reference.rawFile}`, () => {
  const bytes = readFileSync(reference.rawFile), metadata = JSON.parse(readFileSync(reference.metadataFile, 'utf8'));
  assert.equal(bytes.length, reference.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  assert.ok(JSON.stringify(metadata).includes(reference.sha256));
  assert.ok(reference.sourceUrl.startsWith('https://aa.usno.navy.mil/'));
  const state = scienceState(`${reference.dateLocal}T12:00:00Z`);
  state.observer = { ...reference.observer, name: 'Frozen USNO reference' };
  const target = reference.kind === 'Moon' ? moon : targetFor(reference.canonicalCatalogId!);
  const events = computeObjectDayEvents(state, target);
  assert.notEqual(events.state, 'search-incomplete');
  assert.equal(events.crossings.length, reference.expectedCrossings.length);
  const expected = reference.expectedCrossings.map(crossing => {
    assert.equal(reference.observer.displayZone.kind, 'fixed');
    const offset = reference.observer.displayZone.kind === 'fixed' ? reference.observer.displayZone.offsetMinutes : 0;
    return { kind: crossing.kind, utcMs: new Date(`${reference.dateLocal}T${crossing.timeLocal}:00Z`).getTime() - offset * 60000 };
  }).sort((a, b) => a.utcMs - b.utcMs);
  events.crossings.forEach((crossing, i) => {
    assert.equal(crossing.kind, expected[i]!.kind);
    assert.ok(Math.abs((crossing.utDaysJ2000 - dateToUt(new Date(expected[i]!.utcMs))) * 86400) <= 120);
    assert.ok(crossing.utDaysJ2000 >= events.bounds.startUtDaysJ2000 && crossing.utDaysJ2000 < events.bounds.endUtDaysJ2000);
    assert.equal(crossing.jumpAllowed, true);
  });
  const classification = reference.expectedClassification ?? (reference.expectedClassificationText?.includes('above') ? 'always-above' : null);
  if (classification) assert.equal(events.state, classification);
});

test('resolver sends one frozen canonical M5B astrometry record; unsupported and invalid targets remain explicit', () => {
  const a = targetFor('hip:11767'), b = targetFor('hyg:11734'); assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a)); assert.equal(a.kind, 'star');
  if (a.kind === 'star') { assert.ok(Object.isFrozen(a.astrometry)); assert.deepEqual(Object.keys(a.astrometry).sort(), ['decDeg', 'distancePc', 'id', 'pmDecMasYr', 'pmRaCosDecMasYr', 'qualityFlags', 'raHours', 'radialVelocityKmS']); }
  for (const [id, reason] of [[null, 'no-selection'], ['constellation:UMi', 'constellation'], ['body:Venus', 'undrawn-body'], ['hip:999999', 'unknown-object']] as const) {
    const result = resolveObjectDayTarget(catalog, id); assert.equal(result.available, false); if (!result.available) assert.equal(result.reason, reason);
  }
  const badCatalog = { ...catalog, stars: [{ ...stars[0]!, decDeg: NaN }] };
  const invalid = resolveObjectDayTarget(badCatalog, 'hip:11767'); assert.equal(invalid.available, false); if (!invalid.available) assert.equal(invalid.reason, 'invalid-astrometry');
  assert.throws(() => validateObjectDayTarget({ ...sirius, id: 'hip:9007199254740993' } as ObjectDayTarget), RangeError);
});

test('lightweight observer frame preserves full snapshot coordinate matrix at modern, BCE and polar dates', () => {
  for (const utc of ['-002000-06-21T12:00:00Z', '0000-01-01T00:00:00Z', '0099-06-21T12:00:00Z', '2026-09-14T14:00:00Z', '4000-12-31T23:00:00Z']) for (const latitude of [-90, 0, 90]) {
    const state = scienceState(utc, latitude, 123), snapshot = computeSnapshot(state, 1), frame = computeObserverFrame(state.time.utDaysJ2000, state.observer);
    assert.deepEqual(frame.eqjToHorizontalGeometric, snapshot.eqjToHorizontalGeometric);
    assert.deepEqual(frame.localZenithEqjUnit, snapshot.localZenithEqjUnit);
    assert.equal(frame.gastHours, snapshot.gastHours); assert.equal(frame.lstHours, snapshot.lstHours); assert.equal(frame.ttDaysJ2000, snapshot.ttDaysJ2000);
  }
  assert.throws(() => computeObserverFrame(NaN, scienceState().observer), RangeError);
});

test('synchronous and cooperative Sun/Moon/star outputs are identical and do not modify inputs', async () => {
  const state = scienceState(), before = structuredClone(state);
  for (const target of [sun, moon, sirius]) {
    let yields = 0; const expected = computeObjectDayEvents(state, target);
    const actual = await computeObjectDayEventsCooperatively(state, target, async () => { yields++; });
    assert.deepEqual(actual, expected); assert.ok(yields > 10);
  }
  assert.deepEqual(state, before);
});

test('one mixed LRU retains one Sun computation, stable frozen views, correct eviction and no canceled/error result', async () => {
  const state = scienceState(), service = createDayEventService({ maxEntries: 2 });
  const solar = service.computeSolar(state), selected = service.computeObject(state, sun);
  assert.equal(service.computeObject(state, sun), selected); assert.equal(service.computeSolar(state), solar);
  assert.equal(service.diagnostics().computations, 1); assert.equal(service.diagnostics().cacheEntries, 1);
  assert.ok(Object.isFrozen(selected.crossings)); assert.ok(Object.isFrozen(solar.bounds.displayZone));
  service.computeObject(state, moon); service.computeSolar(state); service.computeObject(state, sirius);
  assert.equal(service.diagnostics().cacheEntries, 2); assert.equal(service.diagnostics().cacheEvictions, 1);
  service.computeObject(state, moon); assert.equal(service.diagnostics().computations, 4);
  const fresh = createDayEventService(), sentinel = Error('cancel at yield');
  await assert.rejects(fresh.computeObjectCooperatively(state, moon, async () => { throw sentinel; }), error => error === sentinel);
  assert.equal(fresh.diagnostics().cacheEntries, 0); assert.equal(fresh.diagnostics().computations, 0);
  assert.throws(() => fresh.computeObject(state, { kind: 'body', id: 'body:Venus' } as unknown as ObjectDayTarget), RangeError);
  assert.equal(fresh.diagnostics().cacheEntries, 0);
  assert.throws(() => createDayEventService({ maxEntries: 65 }), RangeError);
});

test('event keys include physical source/observer/zone and exclude visual state, scene clock within day and display names', () => {
  const state = scienceState(), visual = structuredClone(state); visual.time.utDaysJ2000 += 1 / 24; visual.viewMode = 'space'; visual.presentation = 'observation'; visual.illustration.bodySizeScale = 35; visual.environment.refraction = 'standard'; visual.observer.name = 'Other label'; visual.layers.sunMoon = false;
  assert.equal(objectDayKey(state, sirius), objectDayKey(visual, sirius));
  for (const mutate of [(s: SimulationState) => { s.observer.heightMeters++; }, (s: SimulationState) => { s.observer.latitudeDeg++; }, (s: SimulationState) => { s.observer.longitudeDegEast++; }, (s: SimulationState) => { s.observer.displayZone = { kind: 'fixed', offsetMinutes: 420 }; }]) { const other = structuredClone(state); mutate(other); assert.notEqual(objectDayKey(state, sirius), objectDayKey(other, sirius)); }
  if (sirius.kind === 'star') {
    assert.notEqual(objectDayKey(state, sirius), objectDayKey(state, { ...sirius, astrometrySourceVersion: 'different-source' }));
    assert.notEqual(objectDayKey(state, sirius), objectDayKey(state, { ...sirius, astrometry: { ...sirius.astrometry, pmDecMasYr: sirius.astrometry.pmDecMasYr + 1 } }));
  }
});

test('identical complete local day is independent of request UTC year, including precision notes', () => {
  for (const [a, b] of [['1899-12-31T20:00:00Z', '1900-01-01T02:00:00Z'], ['2100-12-31T20:00:00Z', '2101-01-01T02:00:00Z']]) {
    const first = scienceState(a), second = scienceState(b); first.observer.displayZone = { kind: 'fixed', offsetMinutes: -840 }; second.observer = structuredClone(first.observer);
    const targets: ObjectDayTarget[] = [sun, moon, sirius];
    for (const target of targets) { assert.equal(objectDayKey(first, target), objectDayKey(second, target)); assert.deepEqual(computeObjectDayEvents(first, target), computeObjectDayEvents(second, target)); }
  }
});

test('full local-day preview preserves out-of-domain events and disables only their jumps', () => {
  const state = scienceState('4000-12-31T23:00:00Z', 0, 0); state.observer.heightMeters = 0; state.observer.displayZone = { kind: 'fixed', offsetMinutes: -840 };
  const events = computeObjectDayEvents(state, sun);
  assert.equal(events.crossings.length, 2); assert.equal(events.crossings.filter(event => !event.jumpAllowed).length, 1);
  assert.ok(events.crossings.find(event => !event.jumpAllowed)?.jumpBlockReason);
  assert.equal(events.bounds.endUtDaysJ2000 - events.bounds.startUtDaysJ2000, 1);
});

test('bounded successful-only time metadata shares one boundary algorithm without exposing mutable cache values', () => {
  const ut = scienceState('2026-03-08T16:00:00Z').time.utDaysJ2000;
  const zone: DisplayZone = { kind: 'iana', name: 'America/New_York', versionNote: 'permanent-M5A-test' };
  const steps = localDayBoundsSteps(ut, zone); let yields = 0, result: ReturnType<typeof localDayBounds>;
  for (;;) { const next = steps.next(); if (next.done) { result = next.value; break; } yields++; }
  assert.ok(yields > 5); assert.ok(Math.abs((result.endUt - result.startUt) * 24 - 23) < 1e-8);
  const before = timeCacheDiagnostics(); result.startUt = 0; const again = localDayBounds(ut, zone);
  assert.notEqual(again.startUt, 0); assert.equal(timeCacheDiagnostics().civilDayBounds.computations, before.civilDayBounds.computations);
  const creationCount = timeCacheDiagnostics().ianaFormatters.creations;
  validateDisplayZone(zone); localDayBounds(ut + 0.01, zone); assert.equal(timeCacheDiagnostics().ianaFormatters.creations, creationCount);
  assert.throws(() => validateDisplayZone({ kind: 'iana', name: 'Invalid/Not-A-Zone', versionNote: 'test' }), RangeError);
  assert.equal(timeCacheDiagnostics().ianaFormatters.creations, creationCount);
  const cancel = localDayBoundsSteps(ut, { ...zone, versionNote: 'canceled-before-retain' }); cancel.next(); cancel.return(undefined as never);
  assert.equal(timeCacheDiagnostics().civilDayBounds.computations, before.civilDayBounds.computations);
  for (let i = 0; i < 24; i++) localDayBounds(ut + i, { kind: 'fixed', offsetMinutes: 0 });
  assert.equal(timeCacheDiagnostics().civilDayBounds.entries, 16); assert.ok(timeCacheDiagnostics().ianaFormatters.entries <= 16);
});
