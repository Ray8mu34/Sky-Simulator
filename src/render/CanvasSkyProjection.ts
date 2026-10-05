import type { ScienceSnapshot, Vec3 } from '../contracts';
import { angularSeparationDeg, applyMatrix, DEG_TO_RAD, normalize, RAD_TO_DEG } from '../core/math';
import { refractEnuDirection } from '../core/refraction';
import type { RefractionProfile } from '../core/refraction';
import { clipSampleSkyArcEnu, inverseSkyDiskToEnu, projectEnuToSkyDisk, projectEqjToSkyDisk } from '../core/sky-map-projection';
import type { SkyArcSamplingOptions, SkyDiskPoint } from '../core/sky-map-projection';
import { createMinorArcSampler, minorArcAltitudeCrossings, minorArcDirectionAt } from './SphericalArcBuffer';

export interface CanvasArcProjection {
  readonly paths: readonly (readonly SkyDiskPoint[])[];
  readonly sampling: {
    readonly requestedSegments: number;
    readonly actualSegments: number;
    readonly actualMaxAngularStepDeg: number;
    readonly capLimited: boolean;
    readonly ambiguousMinorArc: boolean;
    readonly mandatoryKnotSegments: number;
    readonly knotBudgetExceeded: boolean;
  };
}

/** Map the actual observer's geometric ENU direction before upper-disk clipping. */
export function projectCanvasEnuToSkyDisk(direction: Vec3, profile: RefractionProfile): SkyDiskPoint | null {
  return profile.identity ? projectEnuToSkyDisk(direction) : projectEnuToSkyDisk(refractEnuDirection(direction, profile));
}

/** Identity deliberately delegates to the original geometric projection. */
export function projectCanvasEqjToSkyDisk(direction: Vec3, snapshot: ScienceSnapshot, profile: RefractionProfile): SkyDiskPoint | null {
  return profile.identity ? projectEqjToSkyDisk(direction, snapshot)
    : projectCanvasEnuToSkyDisk(applyMatrix(snapshot.eqjToHorizontalGeometric, normalize(direction)), profile);
}

const empty = (ambiguousMinorArc = false): CanvasArcProjection => ({ paths: [],
  sampling: { requestedSegments: 0, actualSegments: 0, actualMaxAngularStepDeg: 0, capLimited: false, ambiguousMinorArc, mandatoryKnotSegments: 0, knotBudgetExceeded: false } });

/**
 * Samples geometric minor-arc directions, maps each through the sole core
 * profile, and clips at apparent altitude zero. No atmospheric formula lives
 * here. The expanded visible region can have two separate intervals.
 *
 * Standard mapping requires maxSegments [2,256], shared across both intervals.
 * Identity retains the old core helper verbatim, including its [1,256] range.
 * Default desired angular steps are standard 1deg and identity 3deg. Required
 * -1deg join knots stay in one path; an insufficient knot budget omits the arc
 * with an explicit diagnostic rather than removing a join or exceeding the cap.
 * The cap is an angular sampling budget, not a bound on screen-pixel error.
 */
export function clipSampleCanvasSkyArcEnu(start: Vec3, end: Vec3, profile: RefractionProfile, options: SkyArcSamplingOptions = {}): CanvasArcProjection {
  const desiredStep = options.maxAngularStepDeg ?? (profile.identity ? 3 : 1), maxSegments = options.maxSegments ?? 64;
  if (profile.identity) {
    const paths = clipSampleSkyArcEnu(start, end, options);
    let actualSegments = 0, actualMaxAngularStepDeg = 0, visibleAngleDeg = 0;
    for (const path of paths) for (let index = 1; index < path.length; index++) {
      const step = angularSeparationDeg(inverseSkyDiskToEnu(path[index - 1]!.x, path[index - 1]!.y)!, inverseSkyDiskToEnu(path[index]!.x, path[index]!.y)!);
      actualSegments++; actualMaxAngularStepDeg = Math.max(actualMaxAngularStepDeg, step); visibleAngleDeg += step;
    }
    return { paths, sampling: { requestedSegments: actualSegments ? Math.max(1, Math.ceil(visibleAngleDeg / desiredStep - 1e-12)) : 0,
      actualSegments, actualMaxAngularStepDeg, capLimited: actualMaxAngularStepDeg > desiredStep * (1 + 1e-12), ambiguousMinorArc: false,
      mandatoryKnotSegments: paths.filter(path => path.length > 1).length, knotBudgetExceeded: false } };
  }
  if (!Number.isFinite(desiredStep) || desiredStep <= 0 || desiredStep > 90)
    throw new RangeError('球面线采样步长须大于0且不超过90°。');
  if (!Number.isInteger(maxSegments) || maxSegments < 2 || maxSegments > 256)
    throw new RangeError('标准折射球面线采样总段数须为2至256的整数。');
  const sampler = createMinorArcSampler(start, end);
  if (!sampler) return empty(true);
  if (sampler.coincident) {
    const point = projectCanvasEnuToSkyDisk(sampler.start, profile);
    return { ...empty(), paths: point ? [[point]] : [] };
  }
  const horizonGeometricAltitude = profile.geometricHorizonDeg;
  const thresholdUp = Math.sin(horizonGeometricAltitude * DEG_TO_RAD);
  const roots = minorArcAltitudeCrossings(sampler, [0, 0, 1], horizonGeometricAltitude);
  const cuts = [0, ...roots, 1];
  const intervals: { from: number; to: number }[] = [];
  for (let index = 1; index < cuts.length; index++) {
    const from = cuts[index - 1]!, to = cuts[index]!;
    if (minorArcDirectionAt(sampler, (from + to) / 2)[2] < thresholdUp) continue;
    const previous = intervals.at(-1);
    if (previous?.to === from) previous.to = to; // A visible tangent does not split the path.
    else intervals.push({ from, to });
  }
  const isBoundary = (t: number, direction: Vec3): boolean => roots.includes(t) || Math.abs(direction[2] - thresholdUp) <= 64 * Number.EPSILON;
  const at = (t: number): SkyDiskPoint | null => {
    const direction = minorArcDirectionAt(sampler, t), apparent = refractEnuDirection(direction, profile);
    // Only an analytically established intersection is snapped to U=0.
    // Unclipped below-horizon point inputs never receive this tolerance.
    return projectEnuToSkyDisk(isBoundary(t, direction) ? [apparent[0], apparent[1], 0] : apparent);
  };
  // Keep the empirical-policy derivative join as an interior sample, including
  // extreme P/T where geometric -1deg lies above the apparent horizon.
  const joins = minorArcAltitudeCrossings(sampler, [0, 0, 1], -1);
  const spans: { from: number; to: number; intervalIndex: number }[] = [];
  intervals.forEach((interval, intervalIndex) => {
    const knots = [interval.from, ...joins.filter(t => t > interval.from && t < interval.to), interval.to];
    for (let index = 1; index < knots.length; index++) spans.push({ from: knots[index - 1]!, to: knots[index]!, intervalIndex });
  });
  const lengths = spans.map(span => (span.to - span.from) * sampler.angleRad * RAD_TO_DEG);
  const requested = lengths.map(length => Math.max(1, Math.ceil(length / desiredStep)));
  const requestedSegments = requested.reduce((sum, count) => sum + count, 0);
  if (spans.length > maxSegments) return { ...empty(), sampling: { ...empty().sampling,
    requestedSegments, mandatoryKnotSegments: spans.length, capLimited: true, knotBudgetExceeded: true } };
  let counts = requested;
  if (requestedSegments > maxSegments) {
    counts = spans.map(() => 1);
    for (let remaining = maxSegments - counts.length; remaining > 0; remaining--) {
      let index = 0;
      for (let candidate = 1; candidate < counts.length; candidate++)
        if (lengths[candidate]! / counts[candidate]! > lengths[index]! / counts[index]!) index = candidate;
      counts[index]!++;
    }
  }
  const paths: SkyDiskPoint[][] = intervals.map(() => []);
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
    const span = spans[spanIndex]!, count = counts[spanIndex]!, path = paths[span.intervalIndex]!;
    for (let index = path.length ? 1 : 0; index <= count; index++) {
      const point = at(index === count ? span.to : span.from + (span.to - span.from) * index / count);
      if (point) path.push(point);
    }
  }
  // Preserve a tangent-only or boundary-only contact as a singleton, which the
  // renderer intentionally does not turn into an invented line segment.
  for (const t of cuts) if (!intervals.some(interval => t >= interval.from && t <= interval.to)) {
    const direction = minorArcDirectionAt(sampler, t);
    if (isBoundary(t, direction)) { const point = at(t); if (point) paths.push([point]); }
  }
  return { paths: paths.filter(path => path.length), sampling: { requestedSegments, actualSegments: counts.reduce((sum, count) => sum + count, 0),
    actualMaxAngularStepDeg: Math.max(0, ...lengths.map((length, index) => length / counts[index]!)),
    capLimited: requestedSegments > maxSegments, ambiguousMinorArc: false, mandatoryKnotSegments: spans.length, knotBudgetExceeded: false } };
}
