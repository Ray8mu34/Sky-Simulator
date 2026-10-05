import type { CivilInput, DisplayZone } from '../contracts';

export const MILLISECONDS_PER_DAY = 86_400_000;
/** 2000-01-01 12:00:00 UTC. Never construct years 0–99 using Date.UTC. */
export const J2000_UTC_MILLISECONDS = 946_728_000_000;

export function dateToUt(date: Date): number {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError('无效日期。');
  return (milliseconds - J2000_UTC_MILLISECONDS) / MILLISECONDS_PER_DAY;
}

export function utToDate(utDaysJ2000: number): Date {
  if (!Number.isFinite(utDaysJ2000)) throw new RangeError('UT 日数必须有限。');
  // Date resolves integer milliseconds. Round explicitly so an exact civil
  // millisecond survives floating UT arithmetic instead of TimeClip truncating
  // a value just below/above it (including negative Unix timestamps).
  const date = new Date(Math.round(J2000_UTC_MILLISECONDS + utDaysJ2000 * MILLISECONDS_PER_DAY));
  if (!Number.isFinite(date.getTime())) throw new RangeError('时间超出 JavaScript 日期范围。');
  return date;
}

export const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function validateCivil(input: Pick<CivilInput, 'astronomicalYear' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): void {
  const { astronomicalYear: year, month, day, hour, minute, second } = input;
  for (const [name, value] of Object.entries({ year, month, day, hour, minute })) {
    if (!Number.isInteger(value)) throw new RangeError(`${name} 必须是整数。`);
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new RangeError('日期不符合前推格里高利历。');
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || !Number.isFinite(second) || second < 0 || second >= 60) {
    throw new RangeError('时间须为 00:00:00 至 23:59:59；此模型不接受闰秒 60。');
  }
}

export function civilToDate(input: Pick<CivilInput, 'astronomicalYear' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): Date {
  validateCivil(input);
  const date = new Date(0);
  date.setUTCFullYear(input.astronomicalYear, input.month - 1, input.day);
  date.setUTCHours(input.hour, input.minute, Math.floor(input.second), Math.round((input.second % 1) * 1000));
  if (!Number.isFinite(date.getTime())) throw new RangeError('年份超出 JavaScript 日期范围。');
  return date;
}

export function validateDisplayZone(zone: DisplayZone): void {
  if (zone.kind === 'fixed') {
    if (!Number.isInteger(zone.offsetMinutes) || Math.abs(zone.offsetMinutes) > 840) throw new RangeError('固定 UTC 偏移须为 ±840 分钟以内的整数。');
  } else if (zone.kind === 'iana') {
    if (typeof zone.name !== 'string' || !zone.name || typeof zone.versionNote !== 'string' || !zone.versionNote.trim()) throw new RangeError('IANA 时区须具名并声明运行时规则来源。');
    ianaFormatter(zone.name); // Constructor validates the zone; no second simplified formatter.
  } else {
    throw new RangeError('未知时区类型。');
  }
}

type CivilParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const timeCacheLimit = 16;
const formatters = new Map<string, Intl.DateTimeFormat>();
let formatterCreations = 0, formatterHits = 0;
type DayBounds = Readonly<{ startUt: number; endUt: number; dateLocal: string }>;
const dayBoundsMemo = new Map<string, DayBounds>();
let boundsComputations = 0, boundsHits = 0;

/** Diagnostics only; neither cache stores astronomical events or an independent clock. */
export function timeCacheDiagnostics() {
  return { ianaFormatters: { entries: formatters.size, maxEntries: timeCacheLimit, creations: formatterCreations, hits: formatterHits },
    civilDayBounds: { entries: dayBoundsMemo.size, maxEntries: timeCacheLimit, computations: boundsComputations, hits: boundsHits } };
}

function ianaFormatter(name: string): Intl.DateTimeFormat {
  const known = formatters.get(name);
  if (known) { formatters.delete(name); formatters.set(name, known); formatterHits++; return known; }
  const created = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: name, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23', era: 'short',
  });
  // Only successful constructions enter this bounded LRU.
  formatterCreations++; formatters.set(name, created);
  if (formatters.size > timeCacheLimit) formatters.delete(formatters.keys().next().value!);
  return created;
}

function partsAt(date: Date, formatter: Intl.DateTimeFormat): CivilParts {
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: values.era === 'BC' ? 1 - Number(values.year) : Number(values.year),
    month: Number(values.month), day: Number(values.day), hour: Number(values.hour),
    minute: Number(values.minute), second: Number(values.second),
  };
}

/** Explicit offsets work over the complete product range. IANA rules use host Intl, 1900–2100 only. */
export function parseCivilInput(input: CivilInput): number {
  validateCivil(input);
  if (input.astronomicalYear < -2000 || input.astronomicalYear > 4000) throw new RangeError('支持的天文纪年为 −2000 至 +4000。');
  if (!['reject', 'earlier', 'later'].includes(input.ambiguousTime)) throw new RangeError('重复时刻策略无效。');
  validateDisplayZone(input.zone);
  const wall = civilToDate(input).getTime();
  if (input.zone.kind === 'fixed') return dateToUt(new Date(wall - input.zone.offsetMinutes * 60_000));
  if (input.astronomicalYear < 1900 || input.astronomicalYear > 2100) {
    throw new RangeError('IANA 历史时区仅支持 1900–2100；扩展年代请明确输入固定 UTC 偏移。');
  }
  const formatter = ianaFormatter(input.zone.name);
  const offsets = new Set<number>();
  // Gather both sides of nearby transitions. Candidate instants are always round-trip checked.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = wall + hours * 3_600_000;
    const p = partsAt(new Date(instant), formatter);
    const localAsUtc = civilToDate({ astronomicalYear: p.year, ...p }).getTime();
    offsets.add(localAsUtc - Math.floor(instant / 1000) * 1000);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    const p = partsAt(new Date(instant), formatter);
    return p.year === input.astronomicalYear && p.month === input.month && p.day === input.day &&
      p.hour === input.hour && p.minute === input.minute && p.second === Math.floor(input.second);
  }).sort((a, b) => a - b);
  if (candidates.length === 0) throw new RangeError('此当地时刻在所选时区规则中不存在（夏令时缺失时刻）。');
  if (candidates.length > 1 && input.ambiguousTime === 'reject') throw new RangeError('此当地时刻重复；请明确选择 earlier 或 later。');
  return dateToUt(new Date(input.ambiguousTime === 'later' ? candidates[candidates.length - 1]! : candidates[0]!));
}

export function localCivilParts(ut: number, zone: DisplayZone): CivilParts {
  validateDisplayZone(zone);
  if (zone.kind === 'iana') return partsAt(utToDate(ut), ianaFormatter(zone.name));
  const date = new Date(utToDate(ut).getTime() + zone.offsetMinutes * 60_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

export const formatEraYear = (year: number): string => year <= 0 ? `公元前 ${1 - year} 年` : `公元 ${year} 年`;
const two = (number: number): string => String(number).padStart(2, '0');
export function formatCivil(ut: number, zone: DisplayZone): string {
  const p = localCivilParts(ut, zone);
  return `${formatEraYear(p.year)} ${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

/** One boundary algorithm, drained synchronously or at bounded cooperative yield points. */
export function* localDayBoundsSteps(ut: number, zone: DisplayZone): Generator<void, { startUt: number; endUt: number; dateLocal: string }> {
  const p = localCivilParts(ut, zone);
  yield;
  const dateLocal = `${p.year}-${two(p.month)}-${two(p.day)}`;
  if (zone.kind === 'iana' && (p.year < 1900 || p.year > 2100)) throw new RangeError('IANA 日事件仅支持 1900–2100。');
  const identity = zone.kind === 'fixed' ? ['fixed', zone.offsetMinutes] : ['iana', zone.name, zone.versionNote];
  const memoKey = JSON.stringify([identity, p.year, p.month, p.day]);
  const known = dayBoundsMemo.get(memoKey);
  if (known) { dayBoundsMemo.delete(memoKey); dayBoundsMemo.set(memoKey, known); boundsHits++; return { ...known }; }
  const retain = (value: DayBounds) => {
    const frozen = Object.freeze({ ...value });
    dayBoundsMemo.set(memoKey, frozen); boundsComputations++;
    if (dayBoundsMemo.size > timeCacheLimit) dayBoundsMemo.delete(dayBoundsMemo.keys().next().value!);
    return { ...frozen }; // Legacy callers cannot mutate the retained metadata.
  };
  if (zone.kind === 'fixed') {
    const midnight = civilToDate({ astronomicalYear: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 });
    const startUt = dateToUt(new Date(midnight.getTime() - zone.offsetMinutes * 60_000));
    // The exclusive end boundary may lie in year 4001; it is a helper boundary, not a user input.
    return retain({ startUt, endUt: startUt + 1, dateLocal });
  }
  // Civil days need not start at 00:00 or last 24h. Locate the actual first and
  // last UTC instants of the date, including skipped midnight and repeated hours.
  const formatter = ianaFormatter(zone.name);
  yield;
  const key = (parts: CivilParts): number => parts.year * 10000 + parts.month * 100 + parts.day;
  const wanted = key(p);
  const nowMs = utToDate(ut).getTime();
  const at = (milliseconds: number): number => key(partsAt(new Date(milliseconds), formatter));
  const boundary = function* (low: number, high: number, predicate: (value: number) => boolean): Generator<void, number> {
    if (predicate(at(low)) || !predicate(at(high))) throw new RangeError('时区日界无法在有限窗口内确定。');
    yield;
    let iterations = 0;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (predicate(at(middle))) high = middle; else low = middle;
      if (++iterations % 6 === 0) yield;
    }
    return dateToUt(new Date(high));
  };
  return retain({
    startUt: yield* boundary(nowMs - 3 * MILLISECONDS_PER_DAY, nowMs, value => value >= wanted),
    endUt: yield* boundary(nowMs, nowMs + 3 * MILLISECONDS_PER_DAY, value => value > wanted), dateLocal,
  });
}

export function localDayBounds(ut: number, zone: DisplayZone): { startUt: number; endUt: number; dateLocal: string } {
  const steps = localDayBoundsSteps(ut, zone);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
