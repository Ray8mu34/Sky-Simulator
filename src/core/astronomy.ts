import * as Engine from 'astronomy-engine';
import type { AstronomyAdapter, BodySnapshot, EnvironmentState, Mat3, ObserverState, ScienceSnapshot, SimulationState, SolarBody, SolarDayEvents, Vec3 } from '../contracts';
import { applyMatrix, cross, DEG_TO_RAD, dot, horizontalToVector, mod, multiplyMatrices, negate, normalize, raDecToVector, RAD_TO_DEG, transposeMatrix, vectorToHorizontal } from './math';
import { parseCivilInput, utToDate } from './time';
import { makeObserver } from './observer';
import { moonFixedToEqj } from './moon';
import { computeSolarDayEvents } from './solar-events';
import { frameFromEngineTime, fromEngineRotation } from './observer-frame';
import { createRefractionDescriptor, deriveRefractionProfile, refractEnuDirection } from './refraction';
import type { RefractionProfile } from './refraction';

export { applyMatrix, dot, normalize, raDecToVector, transposeMatrix, vectorToHorizontal } from './math';
export { parseCivilInput } from './time';
export { validateObserver } from './observer';
export { computeSolarDayEvents } from './solar-events';
export { fromEngineRotation } from './observer-frame';
export const ENGINE_VERSION = '2.1.19';
const bodies: readonly SolarBody[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
/** Nominal/mean spherical radii for angular-size illustrations, km; rings excluded. */
const radiusKm: Record<SolarBody, number> = { Sun: 695700, Moon: 1737.4, Mercury: 2439.7, Venus: 6051.8, Mars: 3389.5, Jupiter: 69911, Saturn: 58232 };
const toTuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const engineBody = (id: SolarBody): Engine.Body => Engine.Body[id];

function assertTimeRange(ut: number): number {
  const year = utToDate(ut).getUTCFullYear();
  if (year < -2000 || year > 4000) throw new RangeError('星历支持的天文纪年为 −2000 至 +4000；不自动夹年。');
  return year;
}

/** Earth-fixed input: X=(lat0,lon0), Y=(lat0,lon90E), Z=north pole. */
function earthMatrix(time: Engine.AstroTime, gast: number): Mat3 {
  const angle = gast * 15 * DEG_TO_RAD;
  const earthToEqd: Mat3 = [[Math.cos(angle), -Math.sin(angle), 0], [Math.sin(angle), Math.cos(angle), 0], [0, 0, 1]];
  return multiplyMatrices(fromEngineRotation(Engine.Rotation_EQD_EQJ(time)), earthToEqd);
}

export function refractionCorrectionDeg(altitudeDeg: number, environment: EnvironmentState): number {
  return deriveRefractionProfile(createRefractionDescriptor(environment)).apparentAltitudeDeg(altitudeDeg) - altitudeDeg;
}

/** Rendering and labels can share this directional correction; refraction is not a rotation. */
export function refractHorizontalDirection(directionEnu: Vec3, environment: EnvironmentState): Vec3 {
  return refractEnuDirection(directionEnu, deriveRefractionProfile(createRefractionDescriptor(environment)));
}

function bodySnapshot(id: SolarBody, time: Engine.AstroTime, observer: Engine.Observer, eqjToEnu: Mat3, profile: RefractionProfile): BodySnapshot {
  const body = engineBody(id);
  const eqj = Engine.Equator(body, time, observer, false, true);
  // Rotate the same topocentric vector once. No second precession/nutation.
  const eqd = Engine.EquatorFromVector(Engine.RotateVector(Engine.Rotation_EQJ_EQD(time), eqj.vec));
  const direction = normalize(toTuple(eqj.vec));
  const horizontal = vectorToHorizontal(applyMatrix(eqjToEnu, direction));
  const illumination = Engine.Illumination(body, time);
  const toObserver = negate(direction);
  const toSun = id === 'Sun' ? null : normalize(negate(toTuple(illumination.hc)));
  const phase = toSun === null ? null : Math.max(0, Math.min(1, (1 + dot(toSun, toObserver)) / 2));
  return {
    id, geocentricEqjAU: toTuple(Engine.GeoVector(body, time, true)), topocentricDirectionEqj: direction,
    raHoursOfDate: eqd.ra, decDegOfDate: eqd.dec,
    geometricAltitudeDeg: horizontal.altitudeDeg,
    apparentAltitudeDeg: profile.apparentAltitudeDeg(horizontal.altitudeDeg),
    azimuthDeg: horizontal.azimuthDeg,
    angularDiameterDeg: 2 * Math.asin(radiusKm[id] / (eqj.dist * Engine.KM_PER_AU)) * RAD_TO_DEG,
    visualMagnitude: illumination.mag, illuminatedFraction: phase, bodyToSunEqjUnit: toSun,
    bodyToObserverEqjUnit: toObserver,
    // IAU 2015 axis and prime-meridian model. A spherical Moon has a defined texture orientation.
    bodyFixedToEqj: id === 'Moon' ? moonFixedToEqj(time.ut) : null,
  };
}

export function computeSnapshot(state: SimulationState, requestId: number): ScienceSnapshot {
  const ut = state.time.utDaysJ2000;
  const year = assertTimeRange(ut);
  const time = new Engine.AstroTime(ut); // Numeric input is UT; AE computes model TT exactly once.
  const observer = makeObserver(state.observer);
  const frame = frameFromEngineTime(time, observer);
  const gast = frame.gastHours;
  const eqjToEnu = frame.eqjToHorizontalGeometric;
  const observerRefraction = createRefractionDescriptor(state.environment), profile = deriveRefractionProfile(observerRefraction);
  const warnings = [
    'UT1≈UTC；TT 采用 Astronomy Engine 的 Espenak–Meeus ΔT 模型，未接入实时地球定向参数。',
    '日月局部独立夹具已纳入测试；1900–2100 全范围及行星、折射、月面姿态尚未完成发布级独立验证。',
    '恒星采用J2000参考系下的有条件线性空间运动/切面回退；缺失距离或径向速度、零义不明及源异常保守回退。候选不代表测量可靠认证，未纳入年度光行差、年度/站心恒星视差、双星轨道或加速度。',
  ];
  if (Math.abs(state.observer.latitudeDeg) === 90) warnings.push('地理极点的北向由输入经度所选子午线约定；天顶与天底的方位角不定义。');
  if (year < 1900 || year > 2100) warnings.push('扩展探索：前推格里高利历；长期 ΔT、岁差、自行与静态银河均有限制，不承诺现代精度。');
  if (state.environment.refraction === 'standard') warnings.push('标准折射按气压与温度修正视高度；近天顶改正不取负值，−1°以下仅作连续延拓，不能替代现场大气测量。升落预报仍用独立34′密度口径。');
  return {
    requestId, utDaysJ2000: time.ut, ttDaysJ2000: time.tt, gastHours: gast,
    lstHours: mod(gast + observer.longitude / 15, 24), eqjToHorizontalGeometric: eqjToEnu,
    eclipticOfDateToEqj: fromEngineRotation(Engine.Rotation_ECT_EQJ(time)), observerRefraction,
    earthFixedToEqj: earthMatrix(time, gast), localZenithEqjUnit: eqjToEnu[2],
    bodies: bodies.map(id => bodySnapshot(id, time, observer, eqjToEnu, profile)), warnings,
    accuracyTier: year >= 1900 && year <= 2100 ? 'unvalidated' : 'extended-exploration',
  };
}

export const astronomyAdapter: AstronomyAdapter = Object.freeze({ engineVersion: ENGINE_VERSION, computeSnapshot, computeSolarDayEvents, parseCivilInput });
