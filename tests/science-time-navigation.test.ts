import assert from 'node:assert/strict';
import test from 'node:test';
import type { CivilInput, DisplayZone } from '../src/contracts';
import { civilToDate, dateToUt, localCivilParts, parseCivilInput, utToDate } from '../src/core/time';
import { createTimeNavigationWindow, shiftTimeNavigationWindow, sliderFractionToUt, stepTimeNavigation, utToSliderFraction } from '../src/core/time-navigation';

const utcZone: DisplayZone = { kind: 'fixed', offsetMinutes: 0 };
const nyZone: DisplayZone = { kind: 'iana', name: 'America/New_York', versionNote: 'host Intl rules, explicitly declared by fixture' };
const ut = (iso: string) => dateToUt(new Date(iso));
const iso = (value: number) => utToDate(value).toISOString();
const close = (actual: number, expected: number, tolerance = 2e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
function civil(year: number, month: number, day: number, hour = 12, minute = 0, zone: DisplayZone = utcZone): CivilInput {
  return { astronomicalYear: year, month, day, hour, minute, second: 0, zone, ambiguousTime: 'reject' };
}

test('hour window is a whole UTC hour, while day boundaries use the chosen display zone', () => {
  const anchor = ut('2026-09-14T14:05:00Z'), zone: DisplayZone = { kind: 'fixed', offsetMinutes: 345 };
  const hour = createTimeNavigationWindow(anchor, 'hour', zone);
  assert.equal(iso(hour.startUtDaysJ2000), '2026-09-14T14:00:00.000Z');
  assert.equal(iso(hour.endUtDaysJ2000), '2026-09-14T15:00:00.000Z');
  close((hour.endUtDaysJ2000 - hour.startUtDaysJ2000) * 24, 1);
  const day = createTimeNavigationWindow(anchor, 'day', { kind: 'fixed', offsetMinutes: -180 });
  assert.equal(iso(day.startUtDaysJ2000), '2026-09-14T03:00:00.000Z');
  assert.equal(iso(day.endUtDaysJ2000), '2026-09-15T03:00:00.000Z');
});

test('sliding session endpoints stay fixed with inclusive reversible endpoints and explicit outside-null', () => {
  const zone = { kind: 'fixed' as const, offsetMinutes: 480 };
  const anchor = ut('2026-09-14T14:00:00Z'), window = createTimeNavigationWindow(anchor, 'day', zone), before = structuredClone(window);
  assert.ok(Object.isFrozen(window)); assert.ok(Object.isFrozen(window.displayZone));
  for (const fraction of [0, 0.01, 0.25, 0.5, 0.75, 0.999, 1]) {
    const selected = sliderFractionToUt(window, fraction);
    close(utToSliderFraction(window, selected)!, fraction, 1e-10);
    assert.deepEqual(window, before);
  }
  assert.equal(sliderFractionToUt(window, 0), window.startUtDaysJ2000);
  assert.equal(sliderFractionToUt(window, 1), window.endUtDaysJ2000);
  assert.equal(utToSliderFraction(window, window.startUtDaysJ2000), 0);
  assert.equal(utToSliderFraction(window, window.endUtDaysJ2000), 1);
  assert.equal(localCivilParts(sliderFractionToUt(window, 1), zone).day, 15);
  assert.equal(utToSliderFraction(window, window.startUtDaysJ2000 - 1 / 86400), null);
  assert.equal(utToSliderFraction(window, window.endUtDaysJ2000 + 1 / 86400), null);
  zone.offsetMinutes = -180;
  assert.deepEqual(window, before); assert.equal((window.displayZone as { offsetMinutes: number }).offsetMinutes, 480);
});

test('adjacent hour/day/month windows join at the same absolute instant without midnight reset', () => {
  for (const span of ['hour', 'day', 'month'] as const) {
    const window = createTimeNavigationWindow(ut('2026-01-31T23:30:00Z'), span, utcZone), before = structuredClone(window);
    const next = shiftTimeNavigationWindow(window, 1), previous = shiftTimeNavigationWindow(window, -1);
    assert.equal(next.startUtDaysJ2000, window.endUtDaysJ2000);
    assert.equal(previous.endUtDaysJ2000, window.startUtDaysJ2000);
    assert.deepEqual(window, before);
  }
});

test('civil day sliders cover real 23/25 hour days and skip no UTC interval during DST', () => {
  const spring = createTimeNavigationWindow(ut('2026-03-08T16:00:00Z'), 'day', nyZone);
  assert.equal(iso(spring.startUtDaysJ2000), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(spring.endUtDaysJ2000), '2026-03-09T04:00:00.000Z');
  close((spring.endUtDaysJ2000 - spring.startUtDaysJ2000) * 24, 23);
  const autumn = createTimeNavigationWindow(ut('2026-11-01T17:00:00Z'), 'day', nyZone);
  assert.equal(iso(autumn.startUtDaysJ2000), '2026-11-01T04:00:00.000Z');
  assert.equal(iso(autumn.endUtDaysJ2000), '2026-11-02T05:00:00.000Z');
  close((autumn.endUtDaysJ2000 - autumn.startUtDaysJ2000) * 24, 25);
  assert.equal(shiftTimeNavigationWindow(spring, 1).startUtDaysJ2000, spring.endUtDaysJ2000);
  const earlier = ut('2026-11-01T05:30:00Z'), later = ut('2026-11-01T06:30:00Z');
  assert.ok(utToSliderFraction(autumn, earlier)! < utToSliderFraction(autumn, later)!);
});

test('day/month boundaries reuse the established zone policy for skipped midnight and a missing civil date', () => {
  const brazil: DisplayZone = { kind: 'iana', name: 'America/Sao_Paulo', versionNote: 'host Intl declared' };
  const day = createTimeNavigationWindow(ut('2018-11-04T12:00:00Z'), 'day', brazil);
  assert.equal(iso(day.startUtDaysJ2000), '2018-11-04T03:00:00.000Z');
  assert.equal(iso(day.endUtDaysJ2000), '2018-11-05T02:00:00.000Z');
  const apia: DisplayZone = { kind: 'iana', name: 'Pacific/Apia', versionNote: 'host Intl declared' };
  const month = createTimeNavigationWindow(ut('2011-12-20T12:00:00Z'), 'month', apia);
  assert.equal(iso(month.startUtDaysJ2000), '2011-12-01T10:00:00.000Z');
  assert.equal(iso(month.endUtDaysJ2000), '2011-12-31T10:00:00.000Z');
  close(month.endUtDaysJ2000 - month.startUtDaysJ2000, 30);
});

test('real calendar months preserve astronomical year zero and Gregorian leap-century lengths', () => {
  for (const [year, length] of [[0, 29], [99, 28], [1900, 28], [2000, 29], [2100, 28]] as const) {
    const anchor = parseCivilInput(civil(year, 2, 15));
    const month = createTimeNavigationWindow(anchor, 'month', utcZone);
    close(month.endUtDaysJ2000 - month.startUtDaysJ2000, length);
    assert.equal(localCivilParts(month.startUtDaysJ2000, utcZone).year, year);
    assert.equal(localCivilParts(month.startUtDaysJ2000, utcZone).day, 1);
    assert.equal(localCivilParts(month.endUtDaysJ2000, utcZone).month, 3);
  }
  const previousYear = parseCivilInput(civil(-1, 12, 31));
  assert.equal(localCivilParts(stepTimeNavigation(previousYear, 'month', 1, utcZone), utcZone).year, 0);
  assert.equal(localCivilParts(stepTimeNavigation(previousYear, 'day', 1, utcZone), utcZone).year, 0);
});

test('month steps clamp only the requested target month and preserve local clock including milliseconds', () => {
  const zone: DisplayZone = { kind: 'fixed', offsetMinutes: 345 };
  const january = ut('2026-01-31T17:00:06.789Z');
  assert.equal(iso(stepTimeNavigation(january, 'month', 1, zone)), '2026-02-28T17:00:06.789Z');
  assert.equal(iso(stepTimeNavigation(january, 'month', 2, zone)), '2026-03-31T17:00:06.789Z');
  assert.equal(iso(stepTimeNavigation(ut('2024-01-31T17:00:06.789Z'), 'month', 1, zone)), '2024-02-29T17:00:06.789Z');
  assert.equal(iso(stepTimeNavigation(ut('2026-03-31T17:00:06.789Z'), 'month', -1, zone)), '2026-02-28T17:00:06.789Z');
  assert.equal(stepTimeNavigation(january, 'month', 0, zone), january);
});

test('hours are elapsed UTC while civil days keep wall-clock time across 23/25-hour transitions', () => {
  assert.equal(iso(stepTimeNavigation(ut('2026-03-08T06:30:00Z'), 'hour', 1, nyZone)), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(stepTimeNavigation(ut('2026-03-07T17:00:00Z'), 'day', 1, nyZone)), '2026-03-08T16:00:00.000Z');
  assert.equal(iso(stepTimeNavigation(ut('2026-10-31T16:00:00Z'), 'day', 1, nyZone)), '2026-11-01T17:00:00.000Z');
});

test('calendar steps into missing time always reject and repeated time requires explicit earlier/later', () => {
  const beforeGap = ut('2026-03-07T07:30:00Z'); // local02:30
  for (const policy of ['reject', 'earlier', 'later'] as const) assert.throws(() => stepTimeNavigation(beforeGap, 'day', 1, nyZone, policy), /不存在/);
  assert.throws(() => stepTimeNavigation(ut('2026-01-08T07:30:00Z'), 'month', 2, nyZone), /不存在/);
  const beforeFold = ut('2026-10-31T05:30:00Z'); // local01:30
  assert.throws(() => stepTimeNavigation(beforeFold, 'day', 1, nyZone), /重复/);
  assert.equal(iso(stepTimeNavigation(beforeFold, 'day', 1, nyZone, 'earlier')), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(stepTimeNavigation(beforeFold, 'day', 1, nyZone, 'later')), '2026-11-01T06:30:00.000Z');
});

test('changing display zone reconstructs labels/windows but never writes or reinterprets the same UT', () => {
  const instant = ut('2026-09-14T14:00:00Z'), zones: DisplayZone[] = [utcZone, { kind: 'fixed', offsetMinutes: 480 }, nyZone];
  for (const zone of zones) {
    const before = structuredClone(zone);
    const window = createTimeNavigationWindow(instant, 'day', zone);
    assert.equal(window.anchorUtDaysJ2000, instant);
    close(sliderFractionToUt(window, utToSliderFraction(window, instant)!), instant, 1e-10);
    assert.deepEqual(zone, before);
  }
});

test('UTC supported endpoints with ±14h retain finite clipped windows even when local year is -2001/4001', () => {
  const first = ut('-002000-01-01T00:00:00Z'), last = ut('4000-12-31T23:59:59.999Z');
  for (const span of ['hour', 'day', 'month'] as const) {
    const low = createTimeNavigationWindow(first, span, { kind: 'fixed', offsetMinutes: -840 });
    const high = createTimeNavigationWindow(last, span, { kind: 'fixed', offsetMinutes: 840 });
    assert.equal(low.startUtDaysJ2000, first);
    assert.equal(high.endUtDaysJ2000, last);
    assert.ok(Number.isFinite(low.endUtDaysJ2000) && low.endUtDaysJ2000 > low.startUtDaysJ2000);
    assert.ok(Number.isFinite(high.startUtDaysJ2000) && high.startUtDaysJ2000 < high.endUtDaysJ2000);
    assert.equal(high.rangeClippedEnd, true);
    assert.equal(sliderFractionToUt(high, 1), last); assert.equal(utToSliderFraction(high, last), 1);
    assert.equal(utToDate(sliderFractionToUt(high, 1)).getUTCFullYear(), 4000);
    assert.equal(localCivilParts(sliderFractionToUt(high, 1), high.displayZone).year, 4001);
    assert.equal(localCivilParts(first, low.displayZone).year, -2001);
    assert.throws(() => shiftTimeNavigationWindow(high, 1), RangeError);
    assert.throws(() => shiftTimeNavigationWindow(low, -1), RangeError);
  }
  assert.throws(() => stepTimeNavigation(first, 'hour', -1, utcZone), RangeError);
  assert.throws(() => stepTimeNavigation(last, 'hour', 1, utcZone), RangeError);
  assert.throws(() => stepTimeNavigation(last, 'month', 1, utcZone), RangeError);
  assert.throws(() => createTimeNavigationWindow(ut('4001-01-01T00:00:00Z'), 'month', utcZone), RangeError);
});

test('IANA navigation respects its declared 1900–2100 local domain including clipped selectable endpoints', () => {
  const zone: DisplayZone = { kind: 'iana', name: 'Etc/UTC', versionNote: 'host Intl declared' };
  const window = createTimeNavigationWindow(ut('2100-12-15T12:00:00Z'), 'month', zone);
  assert.equal(window.rangeClippedEnd, true);
  assert.equal(iso(sliderFractionToUt(window, 1)), '2100-12-31T23:59:59.999Z');
  assert.equal(utToSliderFraction(window, sliderFractionToUt(window, 1)), 1);
  assert.throws(() => shiftTimeNavigationWindow(window, 1), RangeError);
  assert.throws(() => createTimeNavigationWindow(ut('1899-12-31T12:00:00Z'), 'hour', zone), RangeError);
  assert.throws(() => stepTimeNavigation(ut('2100-12-31T12:00:00Z'), 'day', 1, zone), RangeError);
});

test('fixed-offset civil steps accept edge local years only when the resulting UTC year remains supported', () => {
  const west: DisplayZone = { kind: 'fixed', offsetMinutes: -840 };
  const east: DisplayZone = { kind: 'fixed', offsetMinutes: 840 };
  const lowSource = parseCivilInput({ ...civil(-1999, 1, 31, 12, 23, west), second: 17 });
  const lowTarget = stepTimeNavigation(lowSource, 'month', -13, west);
  assert.equal(iso(lowTarget), '-002000-01-01T02:23:17.000Z');
  assert.deepEqual(localCivilParts(lowTarget, west), { year: -2001, month: 12, day: 31, hour: 12, minute: 23, second: 17 });
  assert.equal(iso(stepTimeNavigation(lowTarget, 'day', 1, west)), '-002000-01-02T02:23:17.000Z');
  assert.throws(() => stepTimeNavigation(lowTarget, 'day', -1, west), RangeError);
  const highSource = parseCivilInput({ ...civil(4000, 1, 1, 11, 23, east), second: 17 });
  const highTarget = stepTimeNavigation(highSource, 'month', 12, east);
  assert.equal(iso(highTarget), '4000-12-31T21:23:17.000Z');
  assert.equal(localCivilParts(highTarget, east).year, 4001);
  assert.equal(iso(stepTimeNavigation(highTarget, 'day', -1, east)), '4000-12-30T21:23:17.000Z');
  assert.throws(() => stepTimeNavigation(highTarget, 'day', 1, east), RangeError);
  // Direct civil entry remains deliberately restricted; navigation does not
  // widen its policy or accept a physically out-of-range result.
  assert.throws(() => parseCivilInput(civil(-2001, 12, 31, 12, 23, west)), RangeError);
  assert.throws(() => parseCivilInput(civil(4001, 1, 1, 11, 23, east)), RangeError);
});

test('canonical civil milliseconds and midnight labels survive UT conversion without a 1ms step drift', () => {
  for (const year of [-2000, 0, 99, 1898, 1900, 1940, 1970, 2000, 2026, 2100, 4000]) {
    for (const offsetMinutes of [-840, -45, 0, 345, 840]) {
      const zone: DisplayZone = { kind: 'fixed', offsetMinutes };
      for (const [hour, minute, second] of [[0, 0, 0], [12, 23, 17], [12, 23, 17.789]]) {
        const input = { astronomicalYear: year, month: 1, day: 31, hour: hour!, minute: minute!, second: second! };
        const expectedMilliseconds = civilToDate(input).getTime() - offsetMinutes * 60_000;
        const instant = dateToUt(new Date(expectedMilliseconds));
        assert.equal(utToDate(instant).getTime(), expectedMilliseconds, `year${year}, offset${offsetMinutes}, second${second}`);
        assert.deepEqual(localCivilParts(instant, zone), { year, month: 1, day: 31, hour, minute, second: Math.floor(second!) });
      }
    }
  }
  const zone: DisplayZone = { kind: 'fixed', offsetMinutes: -45 };
  const source = -36493.952581018515; // independently recorded 1900-01-31 local12:23:17
  const expected = -36889.952581018515; // independently recorded 1898-12-31 local12:23:17
  close((stepTimeNavigation(source, 'month', -13, zone) - expected) * 86_400_000, 0, 0.05);
});

test('Date quantization preserves exact supported edge milliseconds and rounds sub-millisecond UT explicitly', () => {
  for (const label of ['-002000-01-01T00:00:00.000Z', '-002000-01-01T00:00:00.001Z',
    '1969-12-31T23:59:59.999Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.001Z',
    '4000-12-31T23:59:59.998Z', '4000-12-31T23:59:59.999Z']) {
    const date = new Date(label);
    assert.equal(utToDate(dateToUt(date)).getTime(), date.getTime(), label);
  }
  const epochMilliseconds = new Date('2000-01-01T12:00:00Z').getTime();
  assert.equal(utToDate(0.49 / 86_400_000).getTime(), epochMilliseconds);
  assert.equal(utToDate(0.51 / 86_400_000).getTime(), epochMilliseconds + 1);
  assert.equal(utToDate(-0.51 / 86_400_000).getTime(), epochMilliseconds - 1);
});

test('invalid fractions, strides, zones, policies and unsupported UT never silently clamp or wrap', () => {
  const anchor = ut('2026-09-14T14:00:00Z'), window = createTimeNavigationWindow(anchor, 'day', utcZone);
  for (const fraction of [-0.01, 1.01, NaN, Infinity]) assert.throws(() => sliderFractionToUt(window, fraction), RangeError);
  for (const amount of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => stepTimeNavigation(anchor, 'day', amount, utcZone), RangeError);
  for (const instant of [NaN, Infinity, ut('-002001-12-31T12:00:00Z'), ut('4001-01-01T00:00:00Z')]) {
    assert.throws(() => createTimeNavigationWindow(instant, 'day', utcZone), RangeError);
    assert.throws(() => utToSliderFraction(window, instant), RangeError);
  }
  assert.throws(() => createTimeNavigationWindow(anchor, 'day', { kind: 'fixed', offsetMinutes: 841 }), RangeError);
  assert.throws(() => createTimeNavigationWindow(anchor, 'week' as never, utcZone), RangeError);
  assert.throws(() => createTimeNavigationWindow(anchor, 'day', utcZone, 'guess' as never), RangeError);
  assert.throws(() => shiftTimeNavigationWindow(window, 0 as never), RangeError);
  assert.throws(() => sliderFractionToUt({ ...window, endUtDaysJ2000: window.startUtDaysJ2000 }, 0.5), RangeError);
});
