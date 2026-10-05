import type { ObjectId } from '../contracts';
import type { ObjectDayTargetResolution } from '../core/object-day-events';
import type { StarCatalog } from './types';
import { resolveCatalogStar } from './search';
import { validateStarAstrometry } from '../core/stars';

const sourceVersion = 'HYG4.1:c7f7f883fe678cc7680169a50ccd7dcc49b060ce:astrometry-v2';

/** Catalog-only target factory. The event worker never imports this resolver or a catalog loader. */
export function resolveObjectDayTarget(catalog: StarCatalog, id: ObjectId | null): ObjectDayTargetResolution {
  if (id === null) return { available: false, reason: 'no-selection', message: '尚未选择对象。' };
  if (id === 'body:Sun' || id === 'body:Moon') return { available: true, target: Object.freeze({ kind: 'body', id }) };
  if (id.startsWith('constellation:')) return { available: false, reason: 'constellation', message: '星座连线锚点不是单一天体，不提供整体升落。' };
  if (/^body:(?:Mercury|Venus|Mars|Jupiter|Saturn)$/.test(id)) return { available: false, reason: 'undrawn-body', message: '此版仅为已绘制太阳、月球和恒星提供事件。' };
  const star = resolveCatalogStar(catalog, id);
  if (!star) return { available: false, reason: 'unknown-object', message: '目录未能解析唯一canonical对象，不提供升落。' };
  try { validateStarAstrometry(star); }
  catch { return { available: false, reason: 'invalid-astrometry', message: '此记录没有有效方向/自行或科学可用性字段，不能求事件。' }; }
  return { available: true, target: Object.freeze({ kind: 'star', id: star.id, astrometrySourceVersion: sourceVersion,
    astrometry: Object.freeze({ id: star.id, raHours: star.raHours, decDeg: star.decDeg, pmRaCosDecMasYr: star.pmRaCosDecMasYr, pmDecMasYr: star.pmDecMasYr,
      distancePc: star.distancePc, radialVelocityKmS: star.radialVelocityKmS, qualityFlags: star.qualityFlags }) }) };
}
