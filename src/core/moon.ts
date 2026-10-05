import * as Engine from 'astronomy-engine';
import type { Mat3, MoonAppearance, MoonPhaseSequence, ScienceSnapshot, Vec3, ViewMode } from '../contracts';
import { applyMatrix, cross, DEG_TO_RAD, dot, mod, negate, normalize, RAD_TO_DEG, transposeMatrix } from './math';
import { utToDate } from './time';

const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const quarterLabels = ['新月', '上弦月', '满月', '下弦月'] as const;
type AppearanceCache = { topocentric?: MoonAppearance | null; geocentric?: MoonAppearance | null; phaseLongitudeDeg?: number; libration?: Engine.LibrationInfo };
/** Snapshot identity is immutable; entries disappear when that snapshot is no longer referenced. */
const appearanceCache = new WeakMap<ScienceSnapshot, AppearanceCache>();
export function moonPhaseNameZh(phaseLongitudeDeg: number): string {
  if (!Number.isFinite(phaseLongitudeDeg)) throw new RangeError('月相黄经差须有限。');
  const phase = mod(phaseLongitudeDeg, 360);
  for (let quarter = 0; quarter < 4; quarter++) {
    if (Math.abs(mod(phase - quarter * 90 + 180, 360) - 180) <= 1) return `${quarterLabels[quarter]}附近`;
  }
  return ['蛾眉月', '盈凸月', '亏凸月', '残月'][Math.floor(phase / 90)]!;
}

/** IAU 2015 body-fixed basis: X=longitude0/equator, Y=90°E/equator, Z=north pole. Mathematical rows. */
export function moonFixedToEqj(utDaysJ2000: number): Mat3 {
  const axis = Engine.RotationAxis(Engine.Body.Moon, utDaysJ2000);
  const z = normalize(tuple(axis.north)), ra = axis.ra * 15 * DEG_TO_RAD;
  const x0: Vec3 = [-Math.sin(ra), Math.cos(ra), 0], y0 = cross(z, x0), w = axis.spin * DEG_TO_RAD;
  const x: Vec3 = [x0[0] * Math.cos(w) + y0[0] * Math.sin(w), x0[1] * Math.cos(w) + y0[1] * Math.sin(w), x0[2] * Math.cos(w) + y0[2] * Math.sin(w)];
  const y: Vec3 = [-x0[0] * Math.sin(w) + y0[0] * Math.cos(w), -x0[1] * Math.sin(w) + y0[1] * Math.cos(w), -x0[2] * Math.sin(w) + y0[2] * Math.cos(w)];
  return transposeMatrix([x, y, z]);
}

/** Sky position angle from EQJ north toward EQJ east, independent of a virtual render camera. */
export function brightLimbPositionAngle(directionToMoon: Vec3, moonToSun: Vec3): number | null {
  const direction = normalize(directionToMoon), sun = normalize(moonToSun), pole: Vec3 = [0, 0, 1];
  const northProjection: Vec3 = [pole[0] - dot(pole, direction) * direction[0], pole[1] - dot(pole, direction) * direction[1], pole[2] - dot(pole, direction) * direction[2]];
  const solarProjection: Vec3 = [sun[0] - dot(sun, direction) * direction[0], sun[1] - dot(sun, direction) * direction[1], sun[2] - dot(sun, direction) * direction[2]];
  if (Math.hypot(...northProjection) < 1e-12 || Math.hypot(...solarProjection) < 1e-12) return null;
  const north = normalize(northProjection), east = cross(north, direction);
  return mod(Math.atan2(dot(solarProjection, east), dot(solarProjection, north)) * RAD_TO_DEG, 360);
}

function lunarLonLat(frame: Mat3, direction: Vec3): { longitudeDegEast: number; latitudeDeg: number } {
  const [x, y, z] = normalize(applyMatrix(transposeMatrix(frame), direction));
  return { longitudeDegEast: mod(Math.atan2(y, x) * RAD_TO_DEG + 180, 360) - 180, latitudeDeg: Math.atan2(z, Math.hypot(x, y)) * RAD_TO_DEG };
}

export function computeMoonAppearance(snapshot: ScienceSnapshot, perspective: 'topocentric' | 'geocentric' = 'topocentric'): MoonAppearance | null {
  const cached = appearanceCache.get(snapshot) ?? {};
  if (Object.prototype.hasOwnProperty.call(cached, perspective)) return cached[perspective]!;
  appearanceCache.set(snapshot, cached);
  const result = computeAppearance(snapshot, perspective, cached);
  cached[perspective] = result;
  return result;
}

function computeAppearance(snapshot: ScienceSnapshot, perspective: 'topocentric' | 'geocentric', cache: AppearanceCache): MoonAppearance | null {
  const moon = snapshot.bodies.find(body => body.id === 'Moon');
  if (!moon?.bodyToSunEqjUnit || !Number.isFinite(snapshot.utDaysJ2000)) return null;
  try {
    const time = new Engine.AstroTime(snapshot.utDaysJ2000);
    const direction = perspective === 'topocentric' ? normalize(moon.topocentricDirectionEqj) : normalize(moon.geocentricEqjAU);
    const observer = negate(direction), sun = normalize(moon.bodyToSunEqjUnit);
    const cosine = Math.max(-1, Math.min(1, dot(sun, observer))), phaseAngleDeg = Math.acos(cosine) * RAD_TO_DEG;
    const phaseLongitudeDeg = cache.phaseLongitudeDeg ??= Engine.MoonPhase(time), libration = cache.libration ??= Engine.Libration(time);
    const frame = moon.bodyFixedToEqj ?? moonFixedToEqj(time.ut);
    return { utDaysJ2000: time.ut, perspective, phaseNameZh: moonPhaseNameZh(phaseLongitudeDeg),
      phaseLongitudeDeg, phaseAngleDeg, phaseNameDefinition: '四个关键黄经差±1°称“附近”；其余按0–90°蛾眉、90–180°盈凸、180–270°亏凸、270–360°残月；名称不定义精确照亮比例。',
      illuminatedFraction: (1 + cosine) / 2,
      angularDiameterDeg: perspective === 'topocentric' ? moon.angularDiameterDeg : 2 * Math.asin(1737.4 / (Math.hypot(...moon.geocentricEqjAU) * Engine.KM_PER_AU)) * RAD_TO_DEG,
      bodyFixedToEqj: frame, northEqjUnit: normalize(applyMatrix(frame, [0, 0, 1])), observerDirectionEqjUnit: observer, sunDirectionEqjUnit: sun,
      brightLimbPositionAngleDeg: brightLimbPositionAngle(direction, sun), brightLimbReference: 'J2000天北为0°，朝天东为正；不是屏幕角度。',
      libration: { longitudeDeg: libration.elon, latitudeDeg: libration.elat, perspective: 'geocentric' },
      subObserver: lunarLonLat(frame, observer), subSolar: lunarLonLat(frame, sun),
      notes: ['月面朝向采用 IAU 2015 极轴/本初子午线模型；天平动字段为独立地心近似，不额外叠加旋转。',
        '黄经月相事件角与月球处相位角不同；照亮比例由当前观察口径的太阳—月球—观察者几何求得。',
        '标准图形相位由物理观察者方向定义，虚拟外部相机的位置不改变科学相位。'] };
  } catch { return null; }
}

export function resolveLunarAppearance(snapshot: ScienceSnapshot, viewMode: ViewMode): MoonAppearance | null {
  return computeMoonAppearance(snapshot, viewMode === 'ground' ? 'topocentric' : 'geocentric');
}

/** Four adjacent quarter events after the explicit seed. This is an on-demand search, not a clock. */
export function computeMoonQuarterSequence(seedUtDaysJ2000: number): MoonPhaseSequence {
  if (!Number.isFinite(seedUtDaysJ2000)) throw new RangeError('月相搜索种子UT须有限。');
  const year = utToDate(seedUtDaysJ2000).getUTCFullYear();
  if (year < -2000 || year > 4000) throw new RangeError('月相搜索种子支持天文纪年 −2000 至 +4000。');
  let quarter = Engine.SearchMoonQuarter(seedUtDaysJ2000);
  const events: MoonPhaseSequence['events'][number][] = [];
  for (let index = 0; index < 4; index++) {
    const eventYear = quarter.time.date.getUTCFullYear();
    if (eventYear >= -2000 && eventYear <= 4000) events.push({ phaseLongitudeDeg: (quarter.quarter * 90) as 0 | 90 | 180 | 270, utDaysJ2000: quarter.time.ut, labelZh: quarterLabels[quarter.quarter]! });
    if (index < 3) quarter = Engine.NextMoonQuarter(quarter);
  }
  return { seedUtDaysJ2000, events, complete: events.length === 4, definition: '从明确种子UT起搜索四个相邻地心黄经差事件：0°新月、90°上弦、180°满月、270°下弦。',
    notes: ['事件时刻由星历搜索；不由照亮比例线性推算日期或农历。', '事件可保存为派生UT时刻；高倍播放或切换视图不会生成另一个时钟。', ...(events.length < 4 ? ['部分后续事件超出支持范围−2000至+4000，未提供可跳转时刻。'] : [])] };
}
