import type { ScienceSnapshot, SimulationState, Vec3 } from '../contracts';
import { utToDate } from './time';

export const SKY_APPEARANCE_MODEL_VERSION = 'qualitative-ground-sky-v2';

/** Display parameters, not calibrated luminance, SQM, Bortle class, or weather. */
export interface SkyAppearance {
  modelVersion: typeof SKY_APPEARANCE_MODEL_VERSION;
  scope: 'local-observer' | 'direction-diagram';
  reason: 'ground-observation' | 'ground-explanation' | 'external-diagram' | 'atmosphere-disabled';
  visibilityApplied: boolean;
  modeLabel: string;
  sunAltitudeDeg: number | null;
  moonAltitudeDeg: number | null;
  moonIlluminatedFraction: number | null;
  /** Source weights; RGB additionally fades artificial/moon terms as daylight dominates. */
  daylightStrength: number;
  moonlightStrength: number;
  artificialLightStrength: number;
  limitingMagnitude: number;
  starVisibility: number;
  milkyWayContrast: number;
  /** A dimensionless teaching index [0,1], not physical surface brightness. */
  skyBrightness: number;
  /** Linear RGB; renderer may blend these by sky elevation, without redoing visibility. */
  backgroundLinearRgb: Vec3;
  horizonGlowLinearRgb: Vec3;
  notes: readonly string[];
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label}必须是${minimum}至${maximum}的有限数值。`);
  return value;
}
function smoothStep(start: number, end: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return x * x * (3 - 2 * x);
}
function color(day: number, artificial: number, moon: number, horizon: boolean): Vec3 {
  const night = horizon ? [0.001, 0.0015, 0.002] : [0.0005, 0.0008, 0.0015];
  const sunlight = horizon ? [0.15, 0.26, 0.42] : [0.045, 0.18, 0.42];
  const lamplight = horizon ? [0.16, 0.095, 0.045] : [0.05, 0.034, 0.02];
  const moonlight = horizon ? [0.035, 0.048, 0.07] : [0.02, 0.028, 0.045];
  // Night colours are unchanged. Smooth twilight weighting prevents city/moon
  // tint competing with sunlight; at full daylight both RGB additions are zero.
  const nightWeight = 1 - day;
  return Object.freeze(night.map((base, index) => base + day * sunlight[index]! + artificial * nightWeight * lamplight[index]! + moon * nightWeight * moonlight[index]!) as unknown as Vec3);
}

/**
 * The only visibility model consumed by UI and render. Reads the already paired
 * snapshot's geometric altitude and topocentric phase; no ephemeris, clock, DOM,
 * camera distance, angular illustration scaling, or runtime network access.
 */
export function deriveSkyAppearance(state: SimulationState, snapshot: ScienceSnapshot): SkyAppearance {
  const artificial = bounded(state.environment.artificialSkyBrightness, 0, 1, '人工天空亮度');
  const baseLimit = bounded(state.environment.darkSkyLimitingMagnitude, -2, 12, '暗空星表基准');
  const year = utToDate(snapshot.utDaysJ2000).getUTCFullYear();
  const sun = snapshot.bodies.find(body => body.id === 'Sun');
  const moon = snapshot.bodies.find(body => body.id === 'Moon');
  const sunAltitudeDeg = sun ? bounded(sun.geometricAltitudeDeg, -90, 90, '太阳几何高度') : null;
  const moonAltitudeDeg = moon ? bounded(moon.geometricAltitudeDeg, -90, 90, '月球几何高度') : null;
  const moonIlluminatedFraction = moon?.illuminatedFraction == null ? null : bounded(moon.illuminatedFraction, 0, 1, '站心月球照亮比例');
  const ground = state.viewMode === 'ground';
  const atmosphere = ground && state.layers.atmosphere;
  const visibilityApplied = atmosphere && state.presentation === 'observation';
  const reason: SkyAppearance['reason'] = !ground ? 'external-diagram' : !state.layers.atmosphere ? 'atmosphere-disabled'
    : state.presentation === 'explanation' ? 'ground-explanation' : 'ground-observation';
  // Smooth zero slope at both twilight endpoints. -18°..0° is a chosen display
  // transition, not a claim that an arbitrary star is visible at a given altitude.
  const daylightStrength = atmosphere && sunAltitudeDeg !== null ? smoothStep(-18, 0, sunAltitudeDeg) : 0;
  // Exactly zero at/below the geometric centre horizon; no refraction, body-size,
  // body layer, virtual camera, or terrain offset enters this qualitative term.
  const moonlightStrength = visibilityApplied && state.environment.moonlightEnabled && moonAltitudeDeg !== null && moonIlluminatedFraction !== null
    ? smoothStep(0, 30, moonAltitudeDeg) * moonIlluminatedFraction ** 2 : 0;
  const artificialLightStrength = visibilityApplied ? artificial : 0;
  const limitingMagnitude = visibilityApplied ? Math.max(-2, baseLimit - 9 * daylightStrength - 3.5 * artificialLightStrength - 2.3 * moonlightStrength) : baseLimit;
  const starVisibility = visibilityApplied ? (1 - daylightStrength) ** 2 : 1;
  const milkyWayContrast = visibilityApplied ? (1 - daylightStrength) ** 3 * Math.exp(-4.8 * artificialLightStrength - 2.3 * moonlightStrength) : 1;
  const skyBrightness = 1 - (1 - daylightStrength) * (1 - 0.65 * artificialLightStrength) * (1 - 0.45 * moonlightStrength);
  const notes = ['定性教学模型：参数和RGB由经验视觉系数设定，未标定SQM、Bortle等级、照度、真实散射或天气；不预测具体个人的肉眼极限。',
    '银河为静态ICRF/J2000近似背景，与恒星共用科学方向变换；不是历史银河重建，未解析暗星背景不作为可选中星表对象。'];
  if (reason === 'external-diagram') notes.push('外部视图（含地平天球）展示方向与结构，忽略地表可见性；要观察光污染、月光和昼夜影响请返回地表观察模式。');
  else if (reason === 'atmosphere-disabled') notes.push('大气关闭：不绘制日/月/人工天空散射，也不施加对应限星；这是显示口径切换，不是地点的真实无大气预报。');
  else if (reason === 'ground-explanation') notes.push('示意：忽略可见性，保留暗空星表基准与银河；天然日景背景可保留，人工亮度和月光不抑制星图。');
  else notes.push('地表观察模式：日光、地平线上方的站心月光及人工亮度共同影响星限、银河对比度与天空底亮。太阳/月球图层只隐藏图形，不关闭光照。');
  if (sunAltitudeDeg === null) notes.push('太阳高度缺失：没有施加日光项，不能把此结果当作已确认的夜空。');
  if (moonAltitudeDeg === null || moonIlluminatedFraction === null) notes.push('月球高度或照亮比例缺失：没有施加月光项，不能把此结果当作已确认的无月夜空。');
  if (year < 1900 || year > 2100) notes.push('扩展年代：银河背景仍固定在现代J2000方向，长期星表自行与银河结构演化不在该静态纹理中。');
  return Object.freeze({ modelVersion: SKY_APPEARANCE_MODEL_VERSION, scope: ground ? 'local-observer' : 'direction-diagram', reason, visibilityApplied,
    modeLabel: reason === 'ground-observation' ? '地表观察：定性可见性' : reason === 'ground-explanation' ? '示意：忽略可见性'
      : reason === 'atmosphere-disabled' ? '大气关闭：忽略散射可见性' : '方向与结构示意：忽略地表可见性',
    sunAltitudeDeg, moonAltitudeDeg, moonIlluminatedFraction, daylightStrength, moonlightStrength, artificialLightStrength,
    limitingMagnitude, starVisibility, milkyWayContrast, skyBrightness,
    backgroundLinearRgb: color(daylightStrength, artificialLightStrength, moonlightStrength, false),
    horizonGlowLinearRgb: color(daylightStrength, artificialLightStrength, moonlightStrength, true), notes: Object.freeze(notes) });
}
