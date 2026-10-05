import * as Engine from 'astronomy-engine';
import type { SimulationState, SolarDayEvents, SolarTwilightEvents } from '../contracts';
import { RAD_TO_DEG } from './math';
import { makeObserver } from './observer';
import { localDayBoundsSteps, utToDate } from './time';
import { analyseDayTrackSteps, TOUCHING_TOLERANCE_DEG } from './day-event-solver';
import { precisionNoteForDay } from './day-event-time';

export const SOLAR_EVENT_DEFINITION_VERSION = 'upper-limb-density-34arcmin-extrema-v4';
const touchingToleranceDeg = TOUCHING_TOLERANCE_DEG;

/** Same finite generator is drained synchronously by adapter or cooperatively by fallback. */
export function* solarDaySteps(state: SimulationState): Generator<void, SolarDayEvents> {
  const year = utToDate(state.time.utDaysJ2000).getUTCFullYear();
  if (year < -2000 || year > 4000) throw new RangeError('日事件支持天文纪年 −2000 至 +4000。');
  const observer = makeObserver(state.observer);
  yield;
  const { startUt, endUt, dateLocal } = yield* localDayBoundsSteps(state.time.utDaysJ2000, state.observer.displayZone);
  const displayZone = { ...state.observer.displayZone };
  const density = Engine.Atmosphere(observer.height).density;
  const refraction = (34 / 60) * density;
  const evaluate = (ut: number): { altitude: number; clearance: number } => {
    const equatorial = Engine.Equator(Engine.Body.Sun, ut, observer, true, true);
    const altitude = Engine.Horizon(ut, observer, equatorial.ra, equatorial.dec).altitude;
    const radius = Math.asin(695700 / (equatorial.dist * Engine.KM_PER_AU)) * RAD_TO_DEG;
    return { altitude, clearance: altitude + radius + refraction };
  };
  const knots = new Set([startUt, endUt]);
  const segments = Math.max(12, Math.ceil((endUt - startUt) * 24));
  // Hourly knots seed/refine extrema only. They never decide whether an event exists.
  for (let index = 1; index < segments; index++) knots.add(startUt + (endUt - startUt) * index / segments);
  for (const hourAngle of [0, 12]) {
    let cursor = startUt;
    for (let index = 0; index < 4; index++) {
      const event = Engine.SearchHourAngle(Engine.Body.Sun, observer, hourAngle, cursor);
      yield;
      if (event.time.ut >= endUt) break;
      if (event.time.ut >= startUt) knots.add(event.time.ut);
      cursor = event.time.ut + 1 / 86400;
    }
    yield;
  }
  const analysis = yield* analyseDayTrackSteps(ut => {
    const sample = evaluate(ut);
    return { geometricAltitudeDeg: sample.altitude, clearanceDeg: sample.clearance };
  }, { startUtDaysJ2000: startUt, endUtDaysJ2000: endUt }, [...knots]);
  const legacyRange = (range: typeof analysis.geometricAltitude) => ({ minimum: { altitude: range.minimum.valueDeg, ut: range.minimum.utDaysJ2000 }, maximum: { altitude: range.maximum.valueDeg, ut: range.maximum.utDaysJ2000 } });
  const altitudeRange = legacyRange(analysis.geometricAltitude), clearanceRange = legacyRange(analysis.clearance);
  function* collect(search: (direction: number, cursor: number, length: number) => Engine.AstroTime | null, direction: number): Generator<void, number[]> {
    const results: number[] = [];
    let cursor = startUt;
    for (let count = 0; count < 8; count++) {
      const result = search(direction, cursor, endUt - cursor);
      if (!result || result.ut >= endUt) break;
      if (result.ut >= startUt) results.push(result.ut);
      cursor = result.ut + 1 / 86400;
      yield;
      if (cursor >= endUt) break;
    }
    return results;
  }
  const rises = yield* collect((direction, cursor, length) => Engine.SearchRiseSet(Engine.Body.Sun, observer, direction, cursor, length, 0), 1);
  yield;
  const sets = yield* collect((direction, cursor, length) => Engine.SearchRiseSet(Engine.Body.Sun, observer, direction, cursor, length, 0), -1);
  yield;
  let status: SolarDayEvents['state'] = 'normal', noEventReason: string | null = null;
  if (!analysis.complete || rises.length + sets.length > 0 && (clearanceRange.minimum.altitude > touchingToleranceDeg || clearanceRange.maximum.altitude < -touchingToleranceDeg)) {
    status = 'search-incomplete'; noEventReason = analysis.incompleteReason ?? '升落穿越与同一clearance连续范围矛盾。';
  } else if (rises.length + sets.length === 0) {
    if (clearanceRange.minimum.altitude > touchingToleranceDeg) { status = 'continuous-daylight'; noEventReason = '太阳上边缘按同一标准折射口径全天在当地水平地平线上方；此日没有升落穿越。'; }
    else if (clearanceRange.maximum.altitude < -touchingToleranceDeg) { status = 'no-sunrise'; noEventReason = '太阳上边缘按同一标准折射口径全天低于当地水平地平；可能仍有晨昏光，不代表全天漆黑。'; }
    else if (Math.min(Math.abs(clearanceRange.minimum.altitude), Math.abs(clearanceRange.maximum.altitude)) <= touchingToleranceDeg) { status = 'grazing'; noEventReason = '日面上边缘接近地平相切；微小折射变化可能改变是否升落，不能保证事件。'; }
    else { status = 'search-incomplete'; noEventReason = '连续极值与事件搜索不一致；此日结果不能用于判断极昼或极夜。'; }
  } else if (rises.length === 0 || sets.length === 0) noEventReason = '该当地民用日仅包含一个方向的升落穿越；另一个事件可能在相邻民用日。';
  const twilight = {} as SolarDayEvents['twilight'];
  for (const [name, threshold] of [['civil', -6], ['nautical', -12], ['astronomical', -18]] as const) {
    const dawns = yield* collect((direction, cursor, length) => Engine.SearchAltitude(Engine.Body.Sun, observer, direction, cursor, length, threshold), 1);
    yield;
    const dusks = yield* collect((direction, cursor, length) => Engine.SearchAltitude(Engine.Body.Sun, observer, direction, cursor, length, threshold), -1);
    yield;
    let state: SolarTwilightEvents['state'] = 'events', reason: string | null = null;
    if (!analysis.complete || dawns.length + dusks.length > 0 && (altitudeRange.minimum.altitude > threshold + touchingToleranceDeg || altitudeRange.maximum.altitude < threshold - touchingToleranceDeg)) {
      state = 'search-incomplete'; reason = analysis.incompleteReason ?? '晨昏根与连续高度范围矛盾。';
    } else if (dawns.length + dusks.length === 0) {
      if (altitudeRange.minimum.altitude > threshold + touchingToleranceDeg) { state = 'always-above'; reason = `太阳中心全天高于${threshold}°，此日没有该级晨昏阈值穿越。`; }
      else if (altitudeRange.maximum.altitude < threshold - touchingToleranceDeg) { state = 'always-below'; reason = `太阳中心全天低于${threshold}°，此日没有该级晨昏阈值穿越。`; }
      else if (Math.min(Math.abs(altitudeRange.minimum.altitude - threshold), Math.abs(altitudeRange.maximum.altitude - threshold)) <= touchingToleranceDeg) { state = 'grazing'; reason = '太阳中心接近该晨昏阈值相切。'; }
      else { state = 'search-incomplete'; reason = '晨昏事件搜索与连续极值不一致。'; }
    } else if (!dawns.length || !dusks.length) reason = '该当地民用日只包含一次晨昏穿越，另一方向在日界之外。';
    twilight[name] = { thresholdGeometricAltitudeDeg: threshold, dawnUtDaysJ2000: dawns[0] ?? null, duskUtDaysJ2000: dusks[0] ?? null,
      crossings: [...dawns.map(utDaysJ2000 => ({ kind: 'dawn' as const, utDaysJ2000 })), ...dusks.map(utDaysJ2000 => ({ kind: 'dusk' as const, utDaysJ2000 }))].sort((a, b) => a.utDaysJ2000 - b.utDaysJ2000), state, noEventReason: reason };
  }
  const min = altitudeRange.minimum.altitude, max = altitudeRange.maximum.altitude;
  const twilightSummary = min >= -6 ? '全天未进入民用暮光以下。' : min >= -12 ? '可进入民用暮光，未进入航海暮光以下。' : min >= -18 ? '可进入航海暮光，未达到天文黑夜。' : max < -18 ? '全天太阳中心低于−18°。' : '此民用日包含太阳中心低于−18°的天文黑夜。';
  return { dateLocal, definition: `${SOLAR_EVENT_DEFINITION_VERSION}：太阳上边缘、34′标准折射按当地海拔大气密度缩放、当地水平地平、眼高相对地面0m；晨昏用中心几何−6/−12/−18°。`,
    riseUtDaysJ2000: rises[0] ?? null, setUtDaysJ2000: sets[0] ?? null, minimumGeometricAltitudeDeg: min, maximumGeometricAltitudeDeg: max, state: status, twilightSummary,
    bounds: { startUtDaysJ2000: startUt, endUtDaysJ2000: endUt, displayZone },
    extremaTimes: { minimumUtDaysJ2000: altitudeRange.minimum.ut, maximumUtDaysJ2000: altitudeRange.maximum.ut },
    riseSetClearanceRangeDeg: { minimum: clearanceRange.minimum.altitude, maximum: clearanceRange.maximum.altitude },
    riseSetCrossings: [...rises.map(utDaysJ2000 => ({ kind: 'rise' as const, utDaysJ2000 })), ...sets.map(utDaysJ2000 => ({ kind: 'set' as const, utDaysJ2000 }))].sort((a, b) => a.utDaysJ2000 - b.utDaysJ2000),
    twilight, noEventReason, notes: ['升落预报的标准折射口径独立于画面折射开关与用户气压/温度；不模拟真实地形或当天大气。', '日界端点纳入高度范围；本批缓变轨迹每个区间连续细化至0.1ms，不从离散采样直接判断无事件；有限预算或范围/根矛盾明确未完成。',
      precisionNoteForDay(startUt, endUt)] };
}

export function computeSolarDayEvents(state: SimulationState): SolarDayEvents {
  const steps = solarDaySteps(state);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
export async function computeSolarDayEventsCooperatively(state: SimulationState, yieldFn: () => Promise<void>): Promise<SolarDayEvents> {
  const steps = solarDaySteps(state);
  for (;;) { const next = steps.next(); if (next.done) return next.value; await yieldFn(); }
}
