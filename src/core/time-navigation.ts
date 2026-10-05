import type { CivilInput, DisplayZone } from '../contracts';
import { civilToDate, dateToUt, daysInMonth, localCivilParts, localDayBounds, parseCivilInput, utToDate, validateDisplayZone } from './time';

export type TimeNavigationSpan = 'hour' | 'day' | 'month';
export type TimeAmbiguityPolicy = CivilInput['ambiguousTime'];
export interface TimeNavigationWindow {
  readonly span: TimeNavigationSpan;
  readonly anchorUtDaysJ2000: number;
  /** Both selectable endpoints are inclusive. Normal end is the next period start. */
  readonly startUtDaysJ2000: number;
  readonly endUtDaysJ2000: number;
  readonly displayZone: DisplayZone;
  /** Endpoint clipped to the explicitly supported UT / IANA navigation domain. */
  readonly rangeClippedStart: boolean;
  readonly rangeClippedEnd: boolean;
}

// A 2ms interior probe stays across a boundary even when Date's time-clip and
// floating UT round-trip move a represented millisecond by one tick near year0.
const boundaryProbeDays = 2 / 86_400_000;
const midnight = (astronomicalYear: number) => civilToDate({ astronomicalYear, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
const minimumUt = dateToUt(midnight(-2000));
const maximumUt = dateToUt(new Date(midnight(4001).getTime() - 1));

function assertUt(ut: number): void {
  if (!Number.isFinite(ut) || ut < minimumUt || ut > maximumUt) throw new RangeError('时间导航支持天文纪年 −2000 至 +4000；不自动夹年。');
}
function assertSpan(span: TimeNavigationSpan): void {
  if (!['hour', 'day', 'month'].includes(span)) throw new RangeError('时间跨度须为hour、day或month。');
}
function assertAmbiguity(policy: TimeAmbiguityPolicy): void {
  if (!['reject', 'earlier', 'later'].includes(policy)) throw new RangeError('重复时刻策略须为reject、earlier或later。');
}
function assertZoneInstant(ut: number, zone: DisplayZone): void {
  assertUt(ut); validateDisplayZone(zone);
  if (zone.kind === 'iana') {
    const year = localCivilParts(ut, zone).year;
    if (year < 1900 || year > 2100) throw new RangeError('IANA 时间导航仅支持1900–2100当地民用年；扩展年代请选固定UTC偏移。');
  }
}
function assertWindow(window: TimeNavigationWindow): void {
  assertSpan(window.span); assertZoneInstant(window.startUtDaysJ2000, window.displayZone); assertZoneInstant(window.endUtDaysJ2000, window.displayZone);
  if (window.endUtDaysJ2000 <= window.startUtDaysJ2000) throw new RangeError('时间窗口终点必须晚于起点。');
}

/** Compose the existing civil-day boundary helper, including skipped midnights/dates. */
function monthBounds(ut: number, zone: DisplayZone): { startUt: number; endUt: number } {
  const anchor = localCivilParts(ut, zone), sameMonth = (value: number): boolean => {
    const parts = localCivilParts(value, zone);
    return parts.year === anchor.year && parts.month === anchor.month;
  };
  let first = localDayBounds(ut, zone), last = first;
  for (let count = 0; count < 33 && sameMonth(first.startUt - boundaryProbeDays); count++) {
    const previous = localDayBounds(first.startUt - boundaryProbeDays, zone);
    if (previous.startUt >= first.startUt) throw new RangeError('当地月起点无法在有限日界内确定。');
    first = previous;
  }
  for (let count = 0; count < 33 && sameMonth(last.endUt + boundaryProbeDays); count++) {
    const next = localDayBounds(last.endUt + boundaryProbeDays, zone);
    if (next.endUt <= last.endUt) throw new RangeError('当地月终点无法在有限日界内确定。');
    last = next;
  }
  if (sameMonth(first.startUt - boundaryProbeDays) || sameMonth(last.endUt + boundaryProbeDays)) throw new RangeError('当地月界超出有界搜索。');
  return { startUt: first.startUt, endUt: last.endUt };
}

/**
 * Capture once per sliding session. Changing the selected fraction never moves
 * these endpoints. Hour is a whole UTC hour; day/month are real civil periods.
 */
export function createTimeNavigationWindow(ut: number, span: TimeNavigationSpan, zone: DisplayZone, ambiguity: TimeAmbiguityPolicy = 'reject'): TimeNavigationWindow {
  assertSpan(span); assertAmbiguity(ambiguity); assertZoneInstant(ut, zone);
  let start: number, end: number;
  if (span === 'hour') {
    const startDate = utToDate(ut);
    startDate.setUTCMinutes(0, 0, 0);
    start = dateToUt(startDate); end = dateToUt(new Date(startDate.getTime() + 3_600_000));
  } else {
    const bounds = span === 'day' ? localDayBounds(ut, zone) : monthBounds(ut, zone);
    start = bounds.startUt; end = bounds.endUt;
  }
  const nominalStart = start, nominalEnd = end;
  start = Math.max(start, minimumUt); end = Math.min(end, maximumUt);
  // IANA's declared civil range is narrower than the physical product range.
  // Only hour windows can extend into the previous civil year; day/month ends
  // can be the exclusive beginning of 2101. Never make that an editable input.
  if (zone.kind === 'iana') {
    if (localCivilParts(start, zone).year < 1900) start = localDayBounds(ut, zone).startUt;
    if (localCivilParts(end, zone).year > 2100) {
      const boundary = span === 'hour' ? localDayBounds(ut, zone).endUt : nominalEnd;
      end = dateToUt(new Date(utToDate(boundary).getTime() - 1));
    }
  }
  const result: TimeNavigationWindow = Object.freeze({ span, anchorUtDaysJ2000: ut, startUtDaysJ2000: start, endUtDaysJ2000: end,
    displayZone: Object.freeze({ ...zone }), rangeClippedStart: start !== nominalStart, rangeClippedEnd: end !== nominalEnd });
  assertWindow(result);
  return result;
}

/** fraction is [0,1]; f=1 may enter the next valid civil period, never year4001. */
export function sliderFractionToUt(window: TimeNavigationWindow, fraction: number): number {
  assertWindow(window);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new RangeError('滑条比例须为0至1的有限数值。');
  if (fraction === 0) return window.startUtDaysJ2000;
  if (fraction === 1) return window.endUtDaysJ2000;
  const ut = window.startUtDaysJ2000 + fraction * (window.endUtDaysJ2000 - window.startUtDaysJ2000);
  assertZoneInstant(ut, window.displayZone);
  return ut;
}

/** Outside this session returns null, not an implicitly clamped slider position. */
export function utToSliderFraction(window: TimeNavigationWindow, ut: number): number | null {
  assertWindow(window); assertZoneInstant(ut, window.displayZone);
  if (ut < window.startUtDaysJ2000 || ut > window.endUtDaysJ2000) return null;
  if (ut === window.startUtDaysJ2000) return 0;
  if (ut === window.endUtDaysJ2000) return 1;
  return (ut - window.startUtDaysJ2000) / (window.endUtDaysJ2000 - window.startUtDaysJ2000);
}

export function shiftTimeNavigationWindow(window: TimeNavigationWindow, direction: -1 | 1, ambiguity: TimeAmbiguityPolicy = 'reject'): TimeNavigationWindow {
  assertWindow(window); assertAmbiguity(ambiguity);
  if (direction !== -1 && direction !== 1) throw new RangeError('相邻窗口方向须为−1或+1。');
  if ((direction === -1 && window.rangeClippedStart) || (direction === 1 && window.rangeClippedEnd)) throw new RangeError('已到时间导航支持范围边界。');
  const anchor = direction === 1 ? window.endUtDaysJ2000 : dateToUt(new Date(utToDate(window.startUtDaysJ2000).getTime() - 2));
  return createTimeNavigationWindow(anchor, window.span, window.displayZone, ambiguity);
}

/** Hour is elapsed UTC time; day/month preserve local civil time (month-end clamps). */
export function stepTimeNavigation(ut: number, span: TimeNavigationSpan, amount: number, zone: DisplayZone, ambiguity: TimeAmbiguityPolicy = 'reject'): number {
  assertSpan(span); assertAmbiguity(ambiguity); assertZoneInstant(ut, zone);
  if (!Number.isSafeInteger(amount)) throw new RangeError('时间步进次数须为安全整数。');
  if (amount === 0) return ut;
  if (span === 'hour') {
    const result = ut + amount / 24;
    assertZoneInstant(result, zone); return result;
  }
  const parts = localCivilParts(ut, zone);
  const wall = civilToDate({ astronomicalYear: parts.year, ...parts,
    second: parts.second + utToDate(ut).getUTCMilliseconds() / 1000 });
  if (span === 'day') wall.setUTCDate(wall.getUTCDate() + amount);
  else {
    const originalDay = wall.getUTCDate();
    wall.setUTCDate(1); wall.setUTCMonth(wall.getUTCMonth() + amount);
    wall.setUTCDate(Math.min(originalDay, daysInMonth(wall.getUTCFullYear(), wall.getUTCMonth() + 1)));
  }
  // Navigation is constrained by the state UT domain. Its fixed-offset wall
  // labels may legitimately be -2001/4001 near the first/last UTC day; the
  // direct civil input parser intentionally has a narrower local-year domain.
  const result = zone.kind === 'fixed'
    ? dateToUt(new Date(wall.getTime() - zone.offsetMinutes * 60_000))
    : parseCivilInput({ astronomicalYear: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(),
      hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: wall.getUTCSeconds() + wall.getUTCMilliseconds() / 1000, zone, ambiguousTime: ambiguity });
  assertZoneInstant(result, zone); return result;
}
