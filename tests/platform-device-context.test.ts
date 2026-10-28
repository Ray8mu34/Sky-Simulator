import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceLocation, deviceObserver, deviceTime, useDeviceTime, type LocationStatus } from '../src/platform/device-context';
import { createDefaultState } from '../src/state';
import { localCivilParts, utToDate } from '../src/core/time';

test('device instant is absolute, named zone handles DST and bad zone falls back to device offset', () => {
  const now = new Date('2026-07-01T12:34:56Z');
  const time = deviceTime(now, 'America/New_York');
  assert.equal(utToDate(time.utDaysJ2000).toISOString(), now.toISOString());
  assert.equal(localCivilParts(time.utDaysJ2000, time.displayZone).hour, 8);
  assert.deepEqual(deviceTime(now, 'Invalid/Timezone').displayZone, { kind: 'fixed', offsetMinutes: -now.getTimezoneOffset() });
  const old = new Date(0); old.setUTCFullYear(1200);
  assert.equal(deviceTime(old, 'America/New_York').displayZone.kind, 'fixed');
});

test('device time changes only clock and zone; does not guess observer or move cameras', () => {
  const state = createDefaultState(), before = structuredClone(state), now = new Date('2026-10-28T16:30:15Z');
  useDeviceTime(state, false, now);
  assert.equal(state.time.running, false); assert.equal(state.time.rateSimSecondsPerRealSecond, 1);
  assert.equal(utToDate(state.time.utDaysJ2000).getTime(), now.getTime());
  assert.deepEqual(state.cameras, before.cameras);
  assert.deepEqual({ ...state.observer, displayZone: before.observer.displayZone }, before.observer);
  useDeviceTime(state, true, now); assert.equal(state.time.mode, 'realtime'); assert.equal(state.time.running, true);
});

test('location validates coordinates and explicitly marks unavailable altitude instead of retaining another city altitude', () => {
  const zone = { kind: 'fixed' as const, offsetMinutes: 480 };
  const result = deviceObserver({ latitude: -33.87, longitude: 151.21, altitude: null, accuracy: 42 }, zone);
  assert.equal(result.observer.heightMeters, 0); assert.equal(result.altitudeEstimated, true);
  assert.equal(result.observer.latitudeDeg, -33.87); assert.equal(result.accuracy, 42);
  assert.throws(() => deviceObserver({ latitude: NaN, longitude: 151, altitude: 0, accuracy: 0 }, zone));
  assert.throws(() => deviceObserver({ latitude: 30, longitude: 181, altitude: 0, accuracy: 0 }, zone));
  assert.equal(deviceObserver({ latitude: 30, longitude: 120, altitude: 24, accuracy: 12 }, zone).altitudeEstimated, false);
});

function fixture() {
  const pending: Array<{ success: PositionCallback; failure?: PositionErrorCallback | null; options?: PositionOptions }> = [];
  const statuses: LocationStatus[] = [], positions: GeolocationPosition[] = [];
  const controller = createDeviceLocation({ getCurrentPosition(success, failure, options) { pending.push({ success, failure, options }); } },
    position => { positions.push(position); return '已定位'; }, status => statuses.push(status));
  const position = { coords: { latitude: 30, longitude: 120, altitude: 10, accuracy: 50 }, timestamp: 0 } as GeolocationPosition;
  return { pending, statuses, positions, controller, position };
}

test('location ignores canceled and superseded responses and prevents duplicate pending requests', () => {
  const f = fixture();
  f.controller.request(); f.controller.request(); assert.equal(f.pending.length, 1);
  assert.deepEqual(f.pending[0]!.options, { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 });
  f.controller.cancel(); f.controller.request();
  f.pending[0]!.success(f.position); assert.equal(f.positions.length, 0);
  f.pending[1]!.success(f.position); assert.equal(f.positions.length, 1);
  assert.equal(f.statuses.at(-1)!.phase, 'ready');
  f.pending[1]!.success(f.position); assert.equal(f.positions.length, 1);
  f.controller.dispose();
});

test('denied, unavailable and browser timeout errors are actionable and retryable', () => {
  const f = fixture();
  for (const code of [1, 2, 3]) {
    f.controller.request(); f.pending.at(-1)!.failure!({ code } as GeolocationPositionError);
    assert.equal(f.statuses.at(-1)!.phase, 'error'); assert.match(f.statuses.at(-1)!.message, /手动选择地点/);
  }
  f.controller.request(); f.pending.at(-1)!.success(f.position); assert.equal(f.statuses.at(-1)!.phase, 'ready'); f.controller.dispose();
});

test('whole request timeout bounds a silent permission prompt and dispose blocks future callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.controller.request(); t.mock.timers.tick(20001);
  assert.equal(f.statuses.at(-1)!.phase, 'error'); f.pending[0]!.success(f.position); assert.equal(f.positions.length, 0);
  f.controller.request(); f.controller.dispose(); const count = f.statuses.length;
  f.pending[1]!.success(f.position); f.controller.request(); t.mock.timers.tick(25000);
  assert.equal(f.positions.length, 0); assert.equal(f.statuses.length, count);
});

test('unavailable geolocation never prevents time use or invokes a position callback', () => {
  const statuses: LocationStatus[] = [];
  const controller = createDeviceLocation(undefined, () => { throw new Error('must not run'); }, status => statuses.push(status), false);
  controller.request(); assert.equal(statuses.at(-1)!.phase, 'error'); assert.match(statuses.at(-1)!.message, /HTTPS/); controller.dispose();
});
