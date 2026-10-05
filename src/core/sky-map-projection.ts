import type { ScienceSnapshot, Vec3 } from '../contracts';
import { applyMatrix, cross, DEG_TO_RAD, dot, mod, normalize, RAD_TO_DEG } from './math';

export interface SkyDiskPoint {
  /** Unit disk, x right and y down: north (0,-1), east (-1,0). */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly altitudeDeg: number;
  readonly azimuthDeg: number | null;
}
export interface SkyArcSamplingOptions {
  /** Desired spherical angular step, (0,90] degrees. Cap may make it coarser. */
  maxAngularStepDeg?: number;
  /** Hard per-arc segment count, integer [1,256]; default 64. */
  maxSegments?: number;
}
const boundaryRoundoff = 32 * Number.EPSILON;

/** Geometric upper hemisphere only; a negative input U is never made visible. */
export function projectEnuToSkyDisk(directionEnu: Vec3): SkyDiskPoint | null {
  const [east, north, up] = normalize(directionEnu);
  if (up < 0) return null;
  const horizontal = Math.hypot(east, north);
  // Equivalent to (90-altitude)/90, but stable arbitrarily close to zenith.
  const radius = (2 / Math.PI) * Math.atan2(horizontal, up);
  return { x: horizontal === 0 ? 0 : -radius * east / horizontal,
    y: horizontal === 0 ? 0 : -radius * north / horizontal, radius,
    altitudeDeg: Math.atan2(up, horizontal) * RAD_TO_DEG,
    azimuthDeg: horizontal < 1e-12 ? null : mod(Math.atan2(east, north) * RAD_TO_DEG, 360) };
}

/** Applies the sole science snapshot's row-major EQJ→E,N,U matrix once. */
export function projectEqjToSkyDisk(directionEqj: Vec3, snapshot: ScienceSnapshot): SkyDiskPoint | null {
  return projectEnuToSkyDisk(applyMatrix(snapshot.eqjToHorizontalGeometric, normalize(directionEqj)));
}

/** Inverse of the normalized disk; outside has no sky direction. Not a pixel API. */
export function inverseSkyDiskToEnu(x: number, y: number): Vec3 | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('全天图坐标必须有限。');
  const radius = Math.hypot(x, y);
  if (radius > 1 + boundaryRoundoff) return null;
  if (radius === 0) return [0, 0, 1];
  const boundedRadius = Math.min(1, radius);
  const angularDistance = boundedRadius * Math.PI / 2;
  const horizontal = Math.sin(angularDistance);
  return [-x / radius * horizontal, -y / radius * horizontal, boundedRadius === 1 ? 0 : Math.cos(angularDistance)];
}

/**
 * Clip the unique minor great-circle arc to U>=0 before sampling/projecting.
 * A hemisphere is geodesically convex: a minor arc has at most one horizon
 * crossing unless both endpoints lie on the horizon. Exact/near antipodes have
 * no stable unique minor arc and are omitted instead of choosing a false route.
 */
export function clipSampleSkyArcEnu(startEnu: Vec3, endEnu: Vec3, options: SkyArcSamplingOptions = {}): readonly (readonly SkyDiskPoint[])[] {
  const maxAngularStepDeg = options.maxAngularStepDeg ?? 3;
  const maxSegments = options.maxSegments ?? 64;
  if (!Number.isFinite(maxAngularStepDeg) || maxAngularStepDeg <= 0 || maxAngularStepDeg > 90)
    throw new RangeError('球面线采样步长须大于0且不超过90°。');
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 256)
    throw new RangeError('球面线采样段数须为1至256的整数。');
  const start = normalize(startEnu), end = normalize(endEnu);
  const plane = cross(start, end), sine = Math.hypot(...plane), cosine = Math.max(-1, Math.min(1, dot(start, end)));
  if (cosine < 0 && sine < 1e-12) return [];
  const angle = Math.atan2(sine, cosine);
  if (angle < 1e-15) {
    const point = projectEnuToSkyDisk(start) ?? projectEnuToSkyDisk(end);
    return point ? [[point]] : [];
  }
  if (start[2] < 0 && end[2] < 0) return [];
  const tangent = normalize(cross(normalize(plane), start));
  const directionAt = (value: number): Vec3 => [
    start[0] * Math.cos(value) + tangent[0] * Math.sin(value),
    start[1] * Math.cos(value) + tangent[1] * Math.sin(value),
    start[2] * Math.cos(value) + tangent[2] * Math.sin(value),
  ];
  let from = 0, to = angle;
  const clippedStart = start[2] < 0, clippedEnd = end[2] < 0;
  if (clippedStart || clippedEnd) {
    // U(s)=start.U*cos(s)+tangent.U*sin(s). The minor-arc zero is unique.
    let crossing = Math.atan2(-start[2], tangent[2]);
    if (crossing < 0) crossing += Math.PI;
    crossing = Math.max(0, Math.min(angle, crossing));
    if (clippedStart) from = crossing;
    else to = crossing;
  }
  if (to - from < 1e-15) {
    const direction = directionAt(from);
    const point = projectEnuToSkyDisk([direction[0], direction[1], 0]);
    return point ? [[point]] : [];
  }
  const segments = Math.min(maxSegments, Math.max(1, Math.ceil((to - from) / (maxAngularStepDeg * DEG_TO_RAD))));
  const paths: SkyDiskPoint[][] = [];
  let path: SkyDiskPoint[] = [];
  for (let index = 0; index <= segments; index++) {
    const value = from + (to - from) * index / segments;
    let direction = index === 0 && !clippedStart ? start : index === segments && !clippedEnd ? end : directionAt(value);
    if ((index === 0 && clippedStart) || (index === segments && clippedEnd) || (direction[2] < 0 && direction[2] >= -boundaryRoundoff)) {
      // An analytically clipped intersection, or roundoff on a known inside arc,
      // is exactly on U=0. This tolerance does not expose below-horizon inputs.
      direction = [direction[0], direction[1], 0];
    }
    const point = projectEnuToSkyDisk(direction);
    if (point) path.push(point);
    else if (path.length) { paths.push(path); path = []; }
  }
  if (path.length) paths.push(path);
  return paths;
}
