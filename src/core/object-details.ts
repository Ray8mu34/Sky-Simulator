import type { ObjectId, ScienceSnapshot, Vec3, ViewMode } from '../contracts';
import type { StarCatalog } from '../data/types';
import { constellationLabel, drawnSolarObjects, resolveCatalogConstellation, resolveCatalogStar, starLabel } from '../data/search';
import type { ObjectKind } from '../data/search';
import { applyMatrix, mod, normalize, RAD_TO_DEG, vectorToHorizontal } from './math';
import { deriveStarMotionModel, propagateStarDirection } from './stars';
import type { StarMotionModelInfo } from './stars';
import { deriveRefractionProfile } from './refraction';

export interface ObjectDetails {
  id: ObjectId;
  label: string;
  kind: ObjectKind;
  directionEqj: Vec3;
  raHours: number | null;
  decDeg: number;
  coordinateEpochLabel: string;
  geometricAltitudeDeg: number;
  apparentAltitudeDeg: number;
  azimuthDeg: number | null;
  magnitude: number | null;
  visibilityText: string;
  notes: string[];
  starMotion?: StarMotionModelInfo;
}

const starEpochLabel = 'J2000 赤道参考系（运动推进至当前时刻）';
const horizonNotes = ['几何高度未加大气折射；视高度按当前折射设置修正，方位保持不变。', '地平上下只描述当前几何方向，不是升落预报，也不保证肉眼可见。'];
function equatorialAngles(direction: Vec3): { raHours: number | null; decDeg: number; pole: boolean } {
  const [x, y, z] = normalize(direction);
  const projection = Math.hypot(x, y);
  return { raHours: projection < 1e-12 ? null : mod(Math.atan2(y, x) * RAD_TO_DEG / 15, 24), decDeg: Math.atan2(z, projection) * RAD_TO_DEG, pole: projection < 1e-12 };
}

function finish(snapshot: ScienceSnapshot, data: Omit<ObjectDetails, 'geometricAltitudeDeg' | 'apparentAltitudeDeg' | 'azimuthDeg' | 'visibilityText'>): ObjectDetails | null {
  try {
    const horizontal = vectorToHorizontal(applyMatrix(snapshot.eqjToHorizontalGeometric, data.directionEqj));
    const altitude = horizontal.altitudeDeg;
    const visibilityText = altitude > 1e-9 ? '当前在几何地平线上方' : altitude < -1e-9 ? '当前在几何地平线下方' : '当前在几何地平线附近';
    const profile = deriveRefractionProfile(snapshot.observerRefraction);
    const refractionNote = profile.identity ? '当前折射关闭或气压为0，视高度与几何高度相同。' : '标准视高度是当地观察者读数；外部三视图仍显示几何方向。经验折射不认证真实天气，−1°以下仅作连续延拓。';
    return { ...data, geometricAltitudeDeg: altitude, apparentAltitudeDeg: profile.apparentAltitudeDeg(altitude), azimuthDeg: horizontal.azimuthDeg, visibilityText, notes: [...data.notes, ...horizonNotes, refractionNote] };
  } catch { return null; }
}

/** Detail coordinates share one snapshot and one direction model; this function performs no ephemeris search. */
export function resolveObjectDetails(catalog: StarCatalog, id: ObjectId | null, snapshot: ScienceSnapshot): ObjectDetails | null {
  if (id === null || !Number.isFinite(snapshot.utDaysJ2000)) return null;
  const drawnBody = drawnSolarObjects.find(body => body.id === id);
  if (drawnBody) {
    const body = snapshot.bodies.find(body => body.id === drawnBody.body);
    if (!body || !Number.isFinite(body.raHoursOfDate) || !Number.isFinite(body.decDegOfDate) || Math.abs(body.decDegOfDate) > 90) return null;
    try {
      return finish(snapshot, { id: drawnBody.id, label: drawnBody.label, kind: 'body', directionEqj: normalize(body.topocentricDirectionEqj),
        raHours: mod(body.raHoursOfDate, 24), decDeg: body.decDegOfDate, coordinateEpochLabel: '当日真赤道（站心视位置）',
        magnitude: Number.isFinite(body.visualMagnitude) ? body.visualMagnitude : null,
        notes: ['日月详情是当前观测地点的站心读数；太空与外部天球图形采用地心方向展示。', '日月方向包含内核的光行时与光行差处理。'] });
    } catch { return null; }
  }
  const star = resolveCatalogStar(catalog, id);
  if (star) {
    try {
      const direction = propagateStarDirection(star, snapshot.utDaysJ2000);
      const angles = equatorialAngles(direction);
      const starMotion = deriveStarMotionModel(star);
      const notes = ['赤经赤纬是 J2000 参考系中的当前运动方向，不是星表2000.0原始坐标或当日真赤道坐标。', ...starMotion.notes];
      if (angles.pole) notes.push('此方向在天极，赤经无定义。');
      if (!Number.isFinite(star.magnitude)) notes.push('此记录未提供有效视星等。');
      return finish(snapshot, { id: star.id, label: starLabel(star), kind: 'star', directionEqj: direction, raHours: angles.raHours, decDeg: angles.decDeg,
        coordinateEpochLabel: starEpochLabel, magnitude: Number.isFinite(star.magnitude) ? star.magnitude : null, starMotion, notes });
    } catch { return null; }
  }
  const figure = resolveCatalogConstellation(catalog, id);
  if (!figure || !Number.isInteger(figure.lineStart) || !Number.isInteger(figure.lineCount) || figure.lineStart < 0 || figure.lineCount <= 0) return null;
  const from = figure.lineStart * 2, to = (figure.lineStart + figure.lineCount) * 2;
  if (to > catalog.lineIndices.length) return null;
  const endpoints = new Set<number>();
  for (let i = from; i < to; i++) {
    const index = catalog.lineIndices[i]!;
    if (index >= catalog.stars.length) return null;
    endpoints.add(index);
  }
  try {
    const sum = [0, 0, 0];
    for (const endpoint of endpoints) {
      const direction = propagateStarDirection(catalog.stars[endpoint]!, snapshot.utDaysJ2000);
      for (let axis = 0; axis < 3; axis++) sum[axis]! += direction[axis]!;
    }
    // A cancelling/empty mean has no defensible direction; do not fabricate an anchor.
    if (Math.hypot(...sum) < 1e-12 * endpoints.size) return null;
    const direction = normalize(sum as unknown as Vec3);
    const angles = equatorialAngles(direction);
    const notes = ['星座方向是独立连线端点在当前自行时刻的平均标签锚点，不是单颗天体或 IAU 边界中心。', '星座整体没有物理视星等，也不提供整体升落时刻。'];
    if (angles.pole) notes.push('锚点在天极，赤经无定义。');
    return finish(snapshot, { id: `constellation:${figure.id}`, label: constellationLabel(figure), kind: 'constellation', directionEqj: direction,
      raHours: angles.raHours, decDeg: angles.decDeg, coordinateEpochLabel: starEpochLabel, magnitude: null, notes });
  } catch { return null; }
}

/** Shared observer-direction helper for details and ground focus. */
export function resolveObjectDirectionEqj(catalog: StarCatalog, id: ObjectId | null, snapshot: ScienceSnapshot): Vec3 | null {
  return resolveObjectDetails(catalog, id, snapshot)?.directionEqj ?? null;
}

/** Explicit display convention: ground Sun/Moon are topocentric; external views are geocentric. */
export function resolveDisplayDirectionEqj(catalog: StarCatalog, id: ObjectId | null, snapshot: ScienceSnapshot, viewMode: ViewMode): Vec3 | null {
  if (id === null || !Number.isFinite(snapshot.utDaysJ2000)) return null;
  if (viewMode !== 'ground' && drawnSolarObjects.some(body => body.id === id)) {
    const body = snapshot.bodies.find(body => `body:${body.id}` === id);
    if (!body) return null;
    try { return normalize(body.geocentricEqjAU); } catch { return null; }
  }
  return resolveObjectDirectionEqj(catalog, id, snapshot);
}
