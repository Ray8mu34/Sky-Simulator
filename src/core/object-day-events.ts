import * as Engine from 'astronomy-engine';
import type { SimulationState, SolarDayEvents } from '../contracts';
import type { StarAstrometry, StarMotionModelInfo } from './stars';
import { ASTROMETRY_MODEL_VERSION, deriveStarMotionModel, propagateStarDirection, STAR_MOTION_POLICY_VERSION, validateStarAstrometry } from './stars';
import { applyMatrix, RAD_TO_DEG, vectorToHorizontal } from './math';
import { makeObserver } from './observer';
import { frameFromEngineTime } from './observer-frame';
import { dayContextKeyParts, solarDayKey } from './day-event-key';
import { analyseDayTrackSteps, DAY_SOLVER_VERSION, solvePointThresholdSteps, TOUCHING_TOLERANCE_DEG } from './day-event-solver';
import type { DayTrackSample, ThresholdCrossing } from './day-event-solver';
import { solarDaySteps, SOLAR_EVENT_DEFINITION_VERSION } from './solar-events';
import { localCivilParts, localDayBoundsSteps, utToDate } from './time';
import { precisionNoteForDay } from './day-event-time';

export type EventStarId = `hip:${number}` | `hyg:${number}`;
export type ObjectDayTarget =
  | { readonly kind: 'body'; readonly id: 'body:Sun' | 'body:Moon' }
  | { readonly kind: 'star'; readonly id: EventStarId; readonly astrometry: Readonly<StarAstrometry>; readonly astrometrySourceVersion: string };
export type ObjectDayTargetResolution =
  | { readonly available: true; readonly target: ObjectDayTarget }
  | { readonly available: false; readonly reason: 'no-selection' | 'constellation' | 'undrawn-body' | 'unknown-object' | 'invalid-astrometry'; readonly message: string };
export interface ObjectDayCrossing {
  readonly kind: 'rise' | 'set';
  readonly utDaysJ2000: number;
  readonly jumpAllowed: boolean;
  readonly jumpBlockReason: string | null;
}
export interface ObjectDayEvents {
  readonly id: ObjectDayTarget['id'];
  readonly kind: ObjectDayTarget['kind'];
  readonly key: string;
  readonly dateLocal: string;
  readonly bounds: SolarDayEvents['bounds'];
  readonly definitionVersion: string;
  readonly definition: string;
  readonly astrometryModelVersion: string | null;
  readonly starMotion?: StarMotionModelInfo;
  readonly crossings: readonly ObjectDayCrossing[];
  readonly state: 'events' | 'always-above' | 'always-below' | 'grazing' | 'search-incomplete';
  readonly geometricAltitudeRangeDeg: { readonly minimum: number; readonly maximum: number };
  readonly clearanceRangeDeg: { readonly minimum: number; readonly maximum: number };
  readonly extremaTimes: SolarDayEvents['extremaTimes'];
  readonly noEventReason: string | null;
  readonly notes: readonly string[];
}

export const OBJECT_EVENT_DEFINITION_VERSION = 'point-or-upper-limb-density34-extrema-v1';

export function validateObjectDayTarget(target: ObjectDayTarget): void {
  if (!target || typeof target !== 'object') throw new RangeError('日事件目标须为明确的科学记录。');
  if (target.kind === 'body') {
    if (target.id !== 'body:Sun' && target.id !== 'body:Moon') throw new RangeError('本版事件仅支持已绘制Sun/Moon。');
    return;
  }
  if (target.kind !== 'star' || typeof target.id !== 'string' || !/^(?:hip|hyg):[1-9]\d*$/.test(target.id) || !Number.isSafeInteger(Number(target.id.split(':')[1]))) throw new RangeError('恒星目标须有canonical HIP/HYG编号。');
  const a = target.astrometry;
  validateStarAstrometry(a);
  if (a.id !== undefined && a.id !== target.id) throw new RangeError('事件目标与科学记录canonical身份须一致。');
  if (typeof target.astrometrySourceVersion !== 'string' || !target.astrometrySourceVersion.trim() || target.astrometrySourceVersion.length > 256) throw new RangeError('恒星目标须声明有界源版本。');
}

function validateInput(state: SimulationState): number {
  const year = utToDate(state.time.utDaysJ2000).getUTCFullYear();
  if (year < -2000 || year > 4000) throw new RangeError('日事件支持UTC天文纪年−2000至+4000。');
  makeObserver(state.observer);
  return year;
}

export function objectDayKey(state: SimulationState, target: ObjectDayTarget): string {
  validateInput(state); validateObjectDayTarget(target);
  if (target.kind === 'body' && target.id === 'body:Sun') return JSON.stringify(['selected-Sun-view-v1', solarDayKey(state)]);
  const record = target.kind === 'star' ? [target.astrometrySourceVersion, ASTROMETRY_MODEL_VERSION, STAR_MOTION_POLICY_VERSION, target.astrometry.id ?? null,
    target.astrometry.raHours, target.astrometry.decDeg, target.astrometry.pmRaCosDecMasYr, target.astrometry.pmDecMasYr,
    target.astrometry.distancePc ?? null, target.astrometry.radialVelocityKmS ?? null, target.astrometry.qualityFlags ?? null] : null;
  return JSON.stringify(['AE2.1.19', OBJECT_EVENT_DEFINITION_VERSION, DAY_SOLVER_VERSION, ...dayContextKeyParts(state), target.id, record]);
}

function annotateCrossing(state: SimulationState, crossing: ThresholdCrossing): ObjectDayCrossing {
  const year = utToDate(crossing.utDaysJ2000).getUTCFullYear();
  let jumpBlockReason: string | null = year < -2000 || year > 4000 ? '此完整民用日的事件超出产品UTC年−2000..4000，保留预报但不能跳转。' : null;
  if (jumpBlockReason === null && state.observer.displayZone.kind === 'iana') {
    const localYear = localCivilParts(crossing.utDaysJ2000, state.observer.displayZone).year;
    if (localYear < 1900 || localYear > 2100) jumpBlockReason = '事件超出IANA当地1900..2100输入范围，不能跳转。';
  }
  return { ...crossing, jumpAllowed: jumpBlockReason === null, jumpBlockReason };
}

/** Internal selected-Sun projection; the mixed service reuses its single solar entry. */
export function objectDayFromSolarEvents(state: SimulationState, solar: SolarDayEvents): ObjectDayEvents {
  return { id: 'body:Sun', kind: 'body', key: objectDayKey(state, { kind: 'body', id: 'body:Sun' }), dateLocal: solar.dateLocal,
    bounds: { ...solar.bounds, displayZone: { ...solar.bounds.displayZone } }, definitionVersion: SOLAR_EVENT_DEFINITION_VERSION, definition: solar.definition,
    astrometryModelVersion: null, crossings: solar.riseSetCrossings.map(crossing => annotateCrossing(state, crossing)),
    state: solar.state === 'normal' ? 'events' : solar.state === 'continuous-daylight' ? 'always-above' : solar.state === 'no-sunrise' ? 'always-below' : solar.state,
    geometricAltitudeRangeDeg: { minimum: solar.minimumGeometricAltitudeDeg, maximum: solar.maximumGeometricAltitudeDeg },
    clearanceRangeDeg: { ...solar.riseSetClearanceRangeDeg }, extremaTimes: { ...solar.extremaTimes }, noEventReason: solar.noEventReason,
    notes: [...solar.notes, '所选太阳与太阳教学面板复用同一次当地日求解；事件按观测地点，不按外部相机位置。'] };
}

/** The same bounded generator drives synchronous worker and cooperative fallback. */
export function* objectDaySteps(state: SimulationState, target: ObjectDayTarget): Generator<void, ObjectDayEvents> {
  validateInput(state); validateObjectDayTarget(target);
  yield;
  if (target.kind === 'body' && target.id === 'body:Sun') {
    // Delegate to the same solar generator, preserving cooperative yield points.
    return objectDayFromSolarEvents(state, yield* solarDaySteps(state));
  }
  const observer = makeObserver(state.observer), refraction = (34 / 60) * Engine.Atmosphere(observer.height).density;
  yield;
  const { startUt, endUt, dateLocal } = yield* localDayBoundsSteps(state.time.utDaysJ2000, state.observer.displayZone);
  const bounds = { startUtDaysJ2000: startUt, endUtDaysJ2000: endUt, displayZone: { ...state.observer.displayZone } };
  const evaluate = (ut: number): DayTrackSample => {
    let altitude: number, radius = 0;
    if (target.kind === 'body') {
      const equatorial = Engine.Equator(Engine.Body.Moon, ut, observer, true, true);
      altitude = Engine.Horizon(ut, observer, equatorial.ra, equatorial.dec).altitude;
      radius = Math.asin(1737.4 / (equatorial.dist * Engine.KM_PER_AU)) * RAD_TO_DEG;
    } else {
      const frame = frameFromEngineTime(new Engine.AstroTime(ut), observer);
      altitude = vectorToHorizontal(applyMatrix(frame.eqjToHorizontalGeometric, propagateStarDirection(target.astrometry, ut))).altitudeDeg;
    }
    return { geometricAltitudeDeg: altitude, clearanceDeg: altitude + radius + refraction };
  };
  const knots: number[] = [];
  if (target.kind === 'body') for (const hourAngle of [0, 12]) {
    let cursor = startUt;
    for (let index = 0; index < 4; index++) {
      const event = Engine.SearchHourAngle(Engine.Body.Moon, observer, hourAngle, cursor);
      yield;
      if (event.time.ut >= endUt) break;
      if (event.time.ut >= startUt) knots.push(event.time.ut);
      cursor = event.time.ut + 1 / 86400;
    }
    yield;
  }
  const analysis = yield* analyseDayTrackSteps(evaluate, bounds, knots);
  let crossings: readonly ThresholdCrossing[], complete = analysis.complete, incompleteReason = analysis.incompleteReason;
  if (target.kind === 'star') {
    const solved = yield* solvePointThresholdSteps(ut => evaluate(ut).clearanceDeg, bounds, analysis);
    crossings = solved.crossings; complete &&= solved.complete; incompleteReason ??= solved.incompleteReason;
  } else {
    const found: ThresholdCrossing[] = [];
    for (const direction of [1, -1]) {
      let cursor = startUt;
      for (let count = 0; count < 8; count++) {
        const time = Engine.SearchRiseSet(Engine.Body.Moon, observer, direction, cursor, endUt - cursor, 0);
        if (!time || time.ut >= endUt) break;
        if (time.ut < cursor - 0.2 / 86400) { complete = false; incompleteReason = '内核升落搜索未向前进展。'; break; }
        if (time.ut >= startUt) found.push({ kind: direction === 1 ? 'rise' : 'set', utDaysJ2000: time.ut });
        cursor = time.ut + 0.2 / 86400; yield;
        if (cursor >= endUt) break;
        if (count === 7) { complete = false; incompleteReason = '月球升落数量超出有限搜索预算。'; }
      }
      yield;
    }
    crossings = found.sort((a, b) => a.utDaysJ2000 - b.utDaysJ2000);
  }
  const minimum = analysis.clearance.minimum.valueDeg, maximum = analysis.clearance.maximum.valueDeg;
  for (const crossing of crossings) {
    const before = evaluate(crossing.utDaysJ2000 - 1 / 86400).clearanceDeg, after = evaluate(crossing.utDaysJ2000 + 1 / 86400).clearanceDeg;
    if (crossing.kind === 'rise' ? !(before < 0 && after > 0) : !(before > 0 && after < 0)) { complete = false; incompleteReason = '升落根两侧方向与连续轨迹不一致。'; }
    yield;
  }
  if (crossings.length && (minimum > TOUCHING_TOLERANCE_DEG || maximum < -TOUCHING_TOLERANCE_DEG) || !crossings.length && minimum < -TOUCHING_TOLERANCE_DEG && maximum > TOUCHING_TOLERANCE_DEG) {
    complete = false; incompleteReason = '连续clearance范围与本日穿越结果矛盾。';
  }
  let status: ObjectDayEvents['state'] = 'events', noEventReason: string | null = null;
  if (!complete) { status = 'search-incomplete'; noEventReason = incompleteReason ?? '有限求解未确认本日完整性。'; }
  else if (!crossings.length) {
    if (minimum > TOUCHING_TOLERANCE_DEG) { status = 'always-above'; noEventReason = '此完整民用日按同一标准事件地平始终在上方；不等于永久周极或肉眼可见。'; }
    else if (maximum < -TOUCHING_TOLERANCE_DEG) { status = 'always-below'; noEventReason = '此完整民用日按同一标准事件地平始终在下方，未出现升落；不是仅凭当前方向推断。'; }
    else { status = 'grazing'; noEventReason = '目标接近标准事件地平相切；微小大气变化可能改变事件，不能保证升落。'; }
  } else if (!crossings.some(crossing => crossing.kind === 'rise') || !crossings.some(crossing => crossing.kind === 'set')) noEventReason = '此当地民用日仅含一个方向的穿越；另一方向可能在相邻民用日，不补入本日。';
  const annotated = crossings.map(crossing => annotateCrossing(state, crossing));
  const starMotion = target.kind === 'star' ? deriveStarMotionModel(target.astrometry) : undefined;
  const notes = ['本地升落预报采用34′标准折射按海拔大气密度缩放、当地水平地平、相对地面眼高0m；独立于画面折射/天气/图层/可见性效果。',
    '完整当地日[start,end)保留所有升落；日界端点纳入连续高度范围。极值细化0.1ms只针对本批缓变轨迹，不证明任意振荡函数无事件。',
    target.kind === 'body' ? '月球使用站心中心与实际角半径，已含月视差；圆盘上边缘可能未被照亮，月相与教学放大不改变事件。' : '恒星按同一J2000运动策略在各求值时刻推进；点目标没有圆盘半径。',
    precisionNoteForDay(startUt, endUt)];
  if (starMotion) notes.push(...starMotion.notes);
  if (annotated.some(crossing => !crossing.jumpAllowed)) notes.push('完整民用日部分超出场景可编辑范围；相应事件保留但跳转禁用。');
  return { id: target.id, kind: target.kind, key: objectDayKey(state, target), dateLocal, bounds, definitionVersion: OBJECT_EVENT_DEFINITION_VERSION,
    definition: `${OBJECT_EVENT_DEFINITION_VERSION}：${target.kind === 'body' ? '月球站心圆盘上边缘' : '恒星点目标'}，34′海拔密度缩放标准折射，当地水平地平，眼高相对地面0m。`,
    astrometryModelVersion: starMotion?.modelVersion ?? null, ...(starMotion ? { starMotion } : {}), crossings: annotated, state: status,
    geometricAltitudeRangeDeg: { minimum: analysis.geometricAltitude.minimum.valueDeg, maximum: analysis.geometricAltitude.maximum.valueDeg },
    clearanceRangeDeg: { minimum, maximum }, extremaTimes: { minimumUtDaysJ2000: analysis.geometricAltitude.minimum.utDaysJ2000, maximumUtDaysJ2000: analysis.geometricAltitude.maximum.utDaysJ2000 },
    noEventReason, notes };
}

export function computeObjectDayEvents(state: SimulationState, target: ObjectDayTarget): ObjectDayEvents {
  const steps = objectDaySteps(state, target);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
export async function computeObjectDayEventsCooperatively(state: SimulationState, target: ObjectDayTarget, yieldFn: () => Promise<void>): Promise<ObjectDayEvents> {
  const steps = objectDaySteps(state, target);
  for (;;) { const next = steps.next(); if (next.done) return next.value; await yieldFn(); }
}
