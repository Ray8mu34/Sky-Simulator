import type { Vec3 } from '../contracts';
import { DEG_TO_RAD, normalize, raDecToVector } from './math';
/** Consumer/key version: the unchanged tangent model and optional linear-space policy. */
export const ASTROMETRY_MODEL_VERSION = 'j2000-motion-linear-or-tangent-ut-v2';
export const TANGENT_MODEL_VERSION = 'j2000-tangent-pm-cosdec-v1';
export const LINEAR_SPACE_MODEL_VERSION = 'j2000-linear-space-pm-cosdec-ut-v1';
export const STAR_MOTION_POLICY_VERSION = 'hyg4.1-motion-availability-exceptions-v1';
/** 31557600 seconds/Julian year divided by 3.0856775814913673e13 km/IAU parsec. */
export const KM_S_TO_PC_PER_JULIAN_YEAR = 1.022712165045695e-6;
const masToRadians = DEG_TO_RAD / 3_600_000;
/** Relative cancellation guard, not a minimum physical distance in parsecs. */
export const MOTION_POSITION_RELATIVE_TOLERANCE = 64 * Number.EPSILON;

export interface StarAstrometry {
  raHours: number;
  decDeg: number;
  /** Tangential eastward motion μ_α* = (dα/dt) cosδ, in mas per Julian year. */
  pmRaCosDecMasYr: number;
  pmDecMasYr: number;
  /** Optional source identity and availability: four-field mathematical inputs stay tangent. */
  id?: `hip:${number}` | `hyg:${number}`;
  distancePc?: number | null;
  /** Positive is receding. Source 0 is ambiguous (unknown versus measured zero). */
  radialVelocityKmS?: number | null;
  /** HYG-derived availability, not measurement accuracy: bit1 distance, bit2 RV. */
  qualityFlags?: number;
}

export type StarMotionFallbackReason = 'source-identity-unavailable' | 'availability-flags-unavailable' | 'distance-unavailable'
  | 'radial-velocity-unavailable' | 'radial-velocity-zero-ambiguous' | 'distance-flag-unavailable' | 'radial-velocity-flag-unavailable' | 'source-field-inconsistent';
export interface StarMotionModelInfo {
  readonly model: 'linear-space' | 'tangent';
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly fallbackReasons: readonly StarMotionFallbackReason[];
  readonly notes: readonly string[];
}
const reasons: readonly [StarMotionFallbackReason, string][] = [
  ['source-identity-unavailable', '缺少canonical源身份，无法核对固定源异常政策。'],
  ['availability-flags-unavailable', '未提供距离/RV可用性标记。'],
  ['distance-unavailable', '距离缺失、非正或达到100000pc占位值。'],
  ['radial-velocity-unavailable', '未提供可用径向速度。'],
  ['radial-velocity-zero-ambiguous', '源RV=0无法区分未知与已测零，保守回退。'],
  ['distance-flag-unavailable', '源可用性位标记距离不可用。'],
  ['radial-velocity-flag-unavailable', '源可用性位标记径向速度不可用。'],
  ['source-field-inconsistent', '固定HYG记录的空间速度/自行字段相互矛盾，未猜测修正。'],
];

/** Single lightweight policy for propagation and formatted diagnostics; no per-step notes. */
function motionFallbackMask(star: StarAstrometry): number {
  if (!star || !Number.isFinite(star.raHours) || !Number.isFinite(star.decDeg) || Math.abs(star.decDeg) > 90 || !Number.isFinite(star.pmRaCosDecMasYr) || !Number.isFinite(star.pmDecMasYr)) throw new RangeError('恒星方向和自行须有限，赤纬须在±90°内。');
  if (star.id !== undefined && (typeof star.id !== 'string' || !/^(?:hip|hyg):[1-9]\d*$/.test(star.id) || !Number.isSafeInteger(Number(star.id.split(':')[1])))) throw new RangeError('恒星源身份须为canonical正整数HIP/HYG编号。');
  if (star.qualityFlags !== undefined && (!Number.isSafeInteger(star.qualityFlags) || star.qualityFlags < 0)) throw new RangeError('恒星可用性位须为非负安全整数。');
  if (star.distancePc != null && !Number.isFinite(star.distancePc) || star.radialVelocityKmS != null && !Number.isFinite(star.radialVelocityKmS)) throw new RangeError('已提供的恒星距离和径向速度须有限。');
  let mask = 0;
  if (star.id === undefined) mask |= 1;
  if (star.qualityFlags === undefined) mask |= 2;
  if (star.distancePc == null || star.distancePc <= 0 || star.distancePc >= 100000) mask |= 4;
  if (star.radialVelocityKmS == null) mask |= 8;
  else if (star.radialVelocityKmS === 0) mask |= 16;
  if (star.qualityFlags !== undefined) {
    if (star.qualityFlags % 4 >= 2) mask |= 32;
    if (star.qualityFlags % 8 >= 4) mask |= 64;
  }
  if (star.id === 'hip:17851' || star.id === 'hyg:119623') mask |= 128;
  return mask;
}

export function validateStarAstrometry(star: StarAstrometry): void { motionFallbackMask(star); }

/** Format only when UI/details/diagnostics need it, never inside propagation. */
export function deriveStarMotionModel(star: StarAstrometry): StarMotionModelInfo {
  const mask = motionFallbackMask(star), fallbackReasons = reasons.filter((_, i) => mask & (1 << i)).map(([reason]) => reason);
  const notes = mask ? ['切面角自行近似；距离/RV不满足本版源可用性政策，保持旧角运动模型。', ...reasons.filter((_, i) => mask & (1 << i)).map(([, text]) => text)]
    : ['来源字段一致候选：有条件线性空间运动（6D输入）含距离/RV透视变化；候选可用性不是观测测量可靠性认证。'];
  notes.push('运动年沿用UTC标记UT日数/365.25；未加入年度光行差、年度/站心恒星视差、双星轨道或加速度，扩展年代仅作探索。');
  return { model: mask ? 'tangent' : 'linear-space', modelVersion: mask ? TANGENT_MODEL_VERSION : LINEAR_SPACE_MODEL_VERSION,
    policyVersion: STAR_MOTION_POLICY_VERSION, fallbackReasons, notes };
}

/** One EQJ direction source. Rebuild velocity from scalar data, never quantized HYG vx/vy/vz. */
export function propagateStarDirection(star: StarAstrometry, utDaysJ2000: number): Vec3 {
  if (!Number.isFinite(utDaysJ2000)) throw new RangeError('恒星运动历元须有限。');
  const fallback = motionFallbackMask(star);
  const ra = star.raHours * 15 * DEG_TO_RAD;
  const dec = star.decDeg * DEG_TO_RAD;
  const original = raDecToVector(star.raHours, star.decDeg);
  const east: Vec3 = [-Math.sin(ra), Math.cos(ra), 0];
  const north: Vec3 = [-Math.cos(ra) * Math.sin(dec), -Math.sin(ra) * Math.sin(dec), Math.cos(dec)];
  const years = utDaysJ2000 / 365.25;
  if (!fallback) {
    const distance = star.distancePc!, radial = star.radialVelocityKmS! * KM_S_TO_PC_PER_JULIAN_YEAR;
    const velocity: Vec3 = original.map((u, axis) => distance * masToRadians * (star.pmRaCosDecMasYr * east[axis]! + star.pmDecMasYr * north[axis]!) + radial * u) as unknown as Vec3;
    const displacement: Vec3 = velocity.map(v => years * v) as unknown as Vec3;
    const position: Vec3 = original.map((u, axis) => distance * u + displacement[axis]!) as unknown as Vec3;
    const length = Math.hypot(...position), operationScale = Math.max(distance, Math.hypot(...displacement));
    // Cancellation relative to operands makes a direction numerically unresolved.
    // A small distance alone is valid; no arbitrary fixed-pc cutoff is applied.
    if (!Number.isFinite(length) || !Number.isFinite(operationScale) || length === 0 || length <= MOTION_POSITION_RELATIVE_TOLERANCE * operationScale) throw new RangeError('线性空间位置近零或超出浮点可分辨范围，方向无定义；没有静默切面回退。');
    return [position[0] / length, position[1] / length, position[2] / length];
  }
  const a = years * masToRadians * star.pmRaCosDecMasYr;
  const d = years * masToRadians * star.pmDecMasYr;
  return normalize([original[0] + a * east[0] + d * north[0], original[1] + a * east[1] + d * north[1], original[2] + a * east[2] + d * north[2]]);
}
