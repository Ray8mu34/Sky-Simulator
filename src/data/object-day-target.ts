import type { ObjectId } from '../contracts';
import type { ObjectDayTargetResolution } from '../core/object-day-events';
import type { StarCatalog } from './types';
import { resolveCatalogStar } from './search';
import { validateStarAstrometry } from '../core/stars';

const sourceVersion = 'HYG4.1:c7f7f883fe678cc7680169a50ccd7dcc49b060ce:astrometry-v2';

/** Catalog-only target factory. The event worker never imports this resolver or a catalog loader. */
export function resolveObjectDayTarget(catalog: StarCatalog, id: ObjectId | null): ObjectDayTargetResolution {
  if (id === null) return { available: false, reason: 'no-selection', message: '尚未选择对象。' };
  if (id.startsWith('body:')) return { available: true, target: Object.freeze({ kind: 'body', id: id as `body:${import('../contracts').SolarBody}` }) };
  if (id.startsWith('constellation:') || id.startsWith('chinese:')) return { available: false, reason: 'constellation', message: '请选择星座或星官中的恒星查看升落时刻。' };
  if (id.startsWith('messier:')) return { available: false, reason: 'unknown-object', message: '深空目录提供中心位置；本日升落支持恒星和太阳系天体。' };
  const star = resolveCatalogStar(catalog, id);
  if (!star) return { available: false, reason: 'unknown-object', message: '未找到该天体，请重新搜索。' };
  try { validateStarAstrometry(star); }
  catch { return { available: false, reason: 'invalid-astrometry', message: '该天体的坐标数据不完整，暂时无法计算升落时刻。' }; }
  return { available: true, target: Object.freeze({ kind: 'star', id: star.id, astrometrySourceVersion: sourceVersion,
    astrometry: Object.freeze({ id: star.id, raHours: star.raHours, decDeg: star.decDeg, pmRaCosDecMasYr: star.pmRaCosDecMasYr, pmDecMasYr: star.pmDecMasYr,
      distancePc: star.distancePc, radialVelocityKmS: star.radialVelocityKmS, qualityFlags: star.qualityFlags }) }) };
}
