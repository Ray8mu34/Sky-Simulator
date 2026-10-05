import { propagateStarDirection } from '../core/stars';
import type { StarAstrometry } from '../core/stars';

export const STAR_CACHE_STEP_DAYS = 30;
/** Fixed HYG source/model bound, including a 15-day extension at both product endpoints. */
export const STAR_MOTION_CACHE_BOUND_ARCSEC = .301768904;
/** Unit-component Float32 rounding: asin(sqrt(3)*2^-25 / (1-sqrt(3)*2^-25)), rounded upward. */
export const STAR_FLOAT32_DIRECTION_BOUND_ARCSEC = .010647212;
export const STAR_CACHE_DIRECTION_BOUND_ARCSEC = STAR_MOTION_CACHE_BOUND_ARCSEC + STAR_FLOAT32_DIRECTION_BOUND_ARCSEC;

export function cachedStarEpoch(utDaysJ2000: number): number {
  return Math.round(utDaysJ2000 / STAR_CACHE_STEP_DAYS) * STAR_CACHE_STEP_DAYS;
}

/** Both renderer buffers consume the complete record; motion eligibility belongs only to core. */
export function writeStarDirectionBuffer(stars: readonly StarAstrometry[], utDaysJ2000: number, target: Float32Array | Float64Array): void {
  for (let index = 0; index < stars.length; index++) target.set(propagateStarDirection(stars[index]!, utDaysJ2000), index * 3);
}
