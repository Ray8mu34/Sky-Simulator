/** Pure short great-circle mathematics and bounded derived rendering buffers. No clock, catalog or display mapping. */
export type ArcDirection = readonly [number, number, number];
export type ArcScreenPoint = readonly [number, number];

export const MINOR_ARC_ANTIPODAL_SINE_TOLERANCE = 1e-12;
export const MINOR_ARC_COINCIDENT_ANGLE_TOLERANCE = 1e-15;
/** Numerical boundary guard only; this is not a physical altitude or visibility allowance. */
export const MINOR_ARC_BOUNDARY_TOLERANCE = 32 * Number.EPSILON;
const RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

export interface MinorArcSampler {
  readonly start: ArcDirection;
  readonly end: ArcDirection;
  readonly tangent: ArcDirection;
  readonly angleRad: number;
  readonly coincident: boolean;
}

function unitDirection(direction: ArcDirection): [number, number, number] {
  if (direction.length !== 3 || !direction.every(Number.isFinite)) throw new RangeError('球面方向须为三个有限分量。');
  const length = Math.hypot(...direction);
  if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('球面方向的范数须有限且非零。');
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

/** Normalize only private mathematical endpoints; caller storage is never modified. Null means no stable unique minor arc. */
export function createMinorArcSampler(startDirection: ArcDirection, endDirection: ArcDirection): MinorArcSampler | null {
  const start = unitDirection(startDirection), end = unitDirection(endDirection);
  const px = start[1] * end[2] - start[2] * end[1];
  const py = start[2] * end[0] - start[0] * end[2];
  const pz = start[0] * end[1] - start[1] * end[0];
  const sine = Math.hypot(px, py, pz);
  const cosine = Math.max(-1, Math.min(1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2]));
  if (cosine < 0 && sine < MINOR_ARC_ANTIPODAL_SINE_TOLERANCE) return null;
  const angleRad = Math.atan2(sine, cosine);
  if (angleRad < MINOR_ARC_COINCIDENT_ANGLE_TOLERANCE) return { start, end, tangent: [0, 0, 0], angleRad, coincident: true };
  const nx = px / sine, ny = py / sine, nz = pz / sine;
  const tangent = unitDirection([ny * start[2] - nz * start[1], nz * start[0] - nx * start[2], nx * start[1] - ny * start[0]]);
  return { start, end, tangent, angleRad, coincident: false };
}

/** Fraction t belongs to [0,1]. Optional tuple target lets callers reuse small mathematical scratch storage. */
export function minorArcDirectionAt(sampler: MinorArcSampler, t: number, target: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('短弧采样比例须在0至1之间。');
  if (t === 0 || t === 1) {
    const endpoint = t === 0 ? sampler.start : sampler.end;
    target[0] = endpoint[0]; target[1] = endpoint[1]; target[2] = endpoint[2];
    return target;
  }
  if (sampler.coincident) {
    target[0] = sampler.start[0] + (sampler.end[0] - sampler.start[0]) * t;
    target[1] = sampler.start[1] + (sampler.end[1] - sampler.start[1]) * t;
    target[2] = sampler.start[2] + (sampler.end[2] - sampler.start[2]) * t;
  } else {
    const angle = t * sampler.angleRad, cosine = Math.cos(angle), sine = Math.sin(angle);
    target[0] = sampler.start[0] * cosine + sampler.tangent[0] * sine;
    target[1] = sampler.start[1] * cosine + sampler.tangent[1] * sine;
    target[2] = sampler.start[2] * cosine + sampler.tangent[2] * sine;
  }
  const length = Math.hypot(target[0], target[1], target[2]);
  target[0] /= length; target[1] /= length; target[2] /= length;
  return target;
}

/**
 * Sorted interior roots of dot(direction(t), geometricUp) = sin(altitudeDeg).
 * An arbitrary altitude threshold can have two roots on a minor arc. Tangency
 * contributes one; endpoints and an arc lying entirely on the threshold contribute none.
 */
export function minorArcAltitudeCrossings(sampler: MinorArcSampler, geometricUp: ArcDirection, altitudeDeg: number): readonly number[] {
  if (!Number.isFinite(altitudeDeg) || Math.abs(altitudeDeg) > 90) throw new RangeError('球面高度接点须在±90°内。');
  const up = unitDirection(geometricUp);
  if (sampler.coincident) return [];
  const a = sampler.start[0] * up[0] + sampler.start[1] * up[1] + sampler.start[2] * up[2];
  const b = sampler.tangent[0] * up[0] + sampler.tangent[1] * up[1] + sampler.tangent[2] * up[2];
  const amplitude = Math.hypot(a, b), threshold = Math.sin(altitudeDeg * RAD);
  if (amplitude <= MINOR_ARC_BOUNDARY_TOLERANCE || Math.abs(threshold) > amplitude + MINOR_ARC_BOUNDARY_TOLERANCE) return [];
  let ratio = Math.max(-1, Math.min(1, threshold / amplitude));
  if (Math.abs(Math.abs(threshold) - amplitude) <= MINOR_ARC_BOUNDARY_TOLERANCE) ratio = Math.sign(threshold);
  const phase = Math.atan2(b, a), offset = Math.acos(ratio);
  const roots: number[] = [];
  for (const sign of [-1, 1]) for (let turn = -1; turn <= 1; turn++) {
    const angle = phase + sign * offset + turn * TWO_PI;
    const t = angle / sampler.angleRad;
    if (t > MINOR_ARC_BOUNDARY_TOLERANCE && t < 1 - MINOR_ARC_BOUNDARY_TOLERANCE && !roots.some(root => Math.abs(root - t) <= MINOR_ARC_BOUNDARY_TOLERANCE)) roots.push(t);
  }
  return roots.sort((left, right) => left - right);
}

export function arcAltitudeCrossings(start: ArcDirection, end: ArcDirection, geometricUp: ArcDirection, altitudeDeg: number): readonly number[] {
  const sampler = createMinorArcSampler(start, end);
  if (!sampler) {
    // Validate controls even when the endpoints have no unique arc.
    unitDirection(geometricUp);
    if (!Number.isFinite(altitudeDeg) || Math.abs(altitudeDeg) > 90) throw new RangeError('球面高度接点须在±90°内。');
    return [];
  }
  return minorArcAltitudeCrossings(sampler, geometricUp, altitudeDeg);
}

export interface SphericalArcFigure {
  readonly id: string;
  /** Source line-segment offset/count, not derived index offsets. */
  readonly lineStart: number;
  readonly lineCount: number;
}
export interface SphericalArcFigureRange {
  indexStart: number;
  indexCount: number;
}
export interface SphericalArcCreateOptions {
  starCount: number;
  lineIndices: ArrayLike<number>;
  /** Figures cover source segments exactly once, in ascending contiguous order. */
  figures: readonly SphericalArcFigure[];
  /** Integer [1,4096], default128. Interior slots per arc = maxSegmentsPerArc-1. */
  maxSegmentsPerArc?: number;
  /** Maximum input knot count per arc, integer [0,64], default8. */
  maxExtraKnotsPerArc?: number;
}

export enum SphericalArcDiagnostic {
  InvalidInput = 1,
  Antipodal = 2,
  Coincident = 4,
  BudgetExceeded = 8,
  ScreenUnmeasurable = 16,
}
export interface SphericalArcScreenError {
  /** Actual display mapping then CSS-pixel projection. Consume the borrowed direction synchronously; null/clip never omits geometry. */
  /** Projection must be deterministic within one update; endpoints may be reused only during that update. Returned 2D scratch is allowed. */
  project: (direction: ArcDirection) => ArcScreenPoint | null;
  maxErrorPx: number;
}
export interface SphericalArcUpdateOptions {
  /** Requested step (0,90]deg, default .5. Capacity overflow omits the arc instead of silently coarsening it. */
  maxAngularStepDeg?: number;
  /** Normalized interior arc fractions. Include caller-derived refraction -1deg and apparent-horizon inverse knots. */
  extraKnotsByArc?: readonly (ArrayLike<number> | undefined)[];
  screenError?: SphericalArcScreenError;
}
export interface SphericalArcUpdateResult {
  revision: number;
  indexCount: number;
  totalSegments: number;
  maxActualAngularStepDeg: number;
  antipodalArcCount: number;
  coincidentArcCount: number;
  invalidArcCount: number;
  budgetExceededArcCount: number;
  unmeasurableArcCount: number;
  screenTestedSegmentCount: number;
  screenUnmeasurableSegmentCount: number;
  /** Largest sampled midpoint-to-chord distance on final subdivisions (or the failing subdivision on overflow). */
  maxObservedScreenErrorPx: number;
  /** A midpoint observation is not a rigorous full-curve pixel bound. */
  pixelErrorStatus: 'not-requested' | 'sampled-within-tolerance' | 'unmeasurable' | 'budget-exceeded';
}
export interface SphericalArcBuffer {
  readonly starCount: number;
  readonly arcCount: number;
  readonly maxSegmentsPerArc: number;
  readonly maxExtraKnotsPerArc: number;
  /** Star prefix and fixed per-source-arc interior slots. Shared by Points, ordinary lines and highlight. */
  readonly positions: Float32Array;
  /** Caller writes its unique propagated directions here. Points drawRange must be [0,starCount]. */
  readonly starDirections: Float32Array;
  readonly ordinaryIndex: Uint32Array;
  readonly highlightIndex: Uint32Array;
  readonly figureRanges: ReadonlyMap<string, SphericalArcFigureRange>;
  readonly arcSegmentCounts: Uint16Array;
  readonly arcIndexStarts: Uint32Array;
  readonly arcDiagnostics: Uint8Array;
  /** Borrowed stable mutable result; copy its scalars if retaining a historical measurement. */
  readonly result: SphericalArcUpdateResult;
}
interface ArcWorkspace {
  endpoints: Uint32Array;
  figures: readonly SphericalArcFigure[];
  fractions: Float64Array;
  sampledInteriors: Float32Array;
  start: [number, number, number];
  end: [number, number, number];
  direction: [number, number, number];
  displayStart: [number, number, number];
  displayEnd: [number, number, number];
  displayMiddle: [number, number, number];
  screenStart: [number, number];
  screenEnd: [number, number];
  screenMiddle: [number, number];
}
const workspaces = new WeakMap<SphericalArcBuffer, ArcWorkspace>();

export function createSphericalArcBuffer(options: SphericalArcCreateOptions): SphericalArcBuffer {
  const { starCount, lineIndices, figures } = options;
  const maxSegmentsPerArc = options.maxSegmentsPerArc ?? 128, maxExtraKnotsPerArc = options.maxExtraKnotsPerArc ?? 8;
  if (!Number.isSafeInteger(starCount) || starCount < 1 || starCount > 0xffffffff) throw new RangeError('恒星容量须为有效正整数。');
  if (!Number.isSafeInteger(lineIndices.length) || lineIndices.length < 0 || lineIndices.length % 2) throw new RangeError('连线索引须由完整的端点对组成。');
  if (!Number.isInteger(maxSegmentsPerArc) || maxSegmentsPerArc < 1 || maxSegmentsPerArc > 4096) throw new RangeError('球面线固定段数容量须在1至4096之间。');
  if (!Number.isInteger(maxExtraKnotsPerArc) || maxExtraKnotsPerArc < 0 || maxExtraKnotsPerArc > 64) throw new RangeError('每弧额外接点输入容量须在0至64之间。');
  const arcCount = lineIndices.length / 2;
  const vertexCount = starCount + arcCount * (maxSegmentsPerArc - 1), indexCapacity = arcCount * maxSegmentsPerArc * 2;
  if (!Number.isSafeInteger(vertexCount) || vertexCount > 0xffffffff || !Number.isSafeInteger(indexCapacity) || indexCapacity > 0xffffffff) throw new RangeError('球面线固定容量超出Uint32索引范围。');
  const endpoints = new Uint32Array(lineIndices.length);
  for (let i = 0; i < lineIndices.length; i++) {
    const index = lineIndices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= starCount) throw new RangeError('连线端点索引超出恒星前缀。');
    endpoints[i] = index;
  }
  const figureRanges = new Map<string, SphericalArcFigureRange>();
  let nextSegment = 0, maximumFigureLines = 0;
  for (const figure of figures) {
    if (!figure.id || figureRanges.has(figure.id) || !Number.isInteger(figure.lineStart) || figure.lineStart !== nextSegment || !Number.isInteger(figure.lineCount) || figure.lineCount < 0 || figure.lineStart + figure.lineCount > arcCount) throw new RangeError('星座须以唯一ID按顺序完整覆盖源连线。');
    figureRanges.set(figure.id, { indexStart: 0, indexCount: 0 });
    nextSegment += figure.lineCount; maximumFigureLines = Math.max(maximumFigureLines, figure.lineCount);
  }
  if (nextSegment !== arcCount) throw new RangeError('星座范围未完整覆盖源连线。');
  const positions = new Float32Array(vertexCount * 3);
  const buffer: SphericalArcBuffer = {
    starCount, arcCount, maxSegmentsPerArc, maxExtraKnotsPerArc, positions,
    starDirections: positions.subarray(0, starCount * 3),
    ordinaryIndex: new Uint32Array(indexCapacity), highlightIndex: new Uint32Array(maximumFigureLines * maxSegmentsPerArc * 2), figureRanges,
    arcSegmentCounts: new Uint16Array(arcCount), arcIndexStarts: new Uint32Array(arcCount), arcDiagnostics: new Uint8Array(arcCount),
    result: { revision: 0, indexCount: 0, totalSegments: 0, maxActualAngularStepDeg: 0, antipodalArcCount: 0, coincidentArcCount: 0,
      invalidArcCount: 0, budgetExceededArcCount: 0, unmeasurableArcCount: 0, screenTestedSegmentCount: 0, screenUnmeasurableSegmentCount: 0,
      maxObservedScreenErrorPx: 0, pixelErrorStatus: 'not-requested' },
  };
  workspaces.set(buffer, { endpoints, figures: figures.map(figure => ({ id: figure.id, lineStart: figure.lineStart, lineCount: figure.lineCount })),
    fractions: new Float64Array(maxSegmentsPerArc + 1), sampledInteriors: new Float32Array((maxSegmentsPerArc - 1) * 3), start: [0, 0, 0], end: [0, 0, 0], direction: [0, 0, 0],
    displayStart: [0, 0, 0], displayEnd: [0, 0, 0], displayMiddle: [0, 0, 0], screenStart: [0, 0], screenEnd: [0, 0], screenMiddle: [0, 0] });
  return buffer;
}

function measuredPoint(point: ArcScreenPoint | null): point is ArcScreenPoint {
  return point !== null && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}
function captureScreenPoint(point: ArcScreenPoint | null, target: [number, number]): boolean {
  if (!measuredPoint(point)) return false;
  // Projection may return the same mutable 2D scratch for every call.
  target[0] = point[0]; target[1] = point[1];
  return true;
}
function midpointChordError(start: ArcScreenPoint, end: ArcScreenPoint, middle: ArcScreenPoint): number {
  const dx = end[0] - start[0], dy = end[1] - start[1], lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((middle[0] - start[0]) * dx + (middle[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(middle[0] - start[0] - t * dx, middle[1] - start[1] - t * dy);
}
function insertFraction(fractions: Float64Array, segmentCount: number, value: number): number {
  let at = 1;
  while (at <= segmentCount && fractions[at]! < value) at++;
  if (Math.abs(fractions[at - 1]! - value) <= MINOR_ARC_BOUNDARY_TOLERANCE || at <= segmentCount && Math.abs(fractions[at]! - value) <= MINOR_ARC_BOUNDARY_TOLERANCE) return segmentCount;
  if (segmentCount + 1 >= fractions.length) return -1;
  for (let index = segmentCount + 1; index > at; index--) fractions[index] = fractions[index - 1]!;
  fractions[at] = value;
  return segmentCount + 1;
}

/** Update interiors/indices/ranges in place. The unique star prefix remains byte-for-byte caller-owned. */
export function updateSphericalArcBuffer(buffer: SphericalArcBuffer, options: SphericalArcUpdateOptions = {}): SphericalArcUpdateResult {
  const workspace = workspaces.get(buffer);
  if (!workspace) throw new RangeError('球面线buffer须由createSphericalArcBuffer建立。');
  const maxAngularStepDeg = options.maxAngularStepDeg ?? .5, screen = options.screenError;
  if (!Number.isFinite(maxAngularStepDeg) || maxAngularStepDeg <= 0 || maxAngularStepDeg > 90) throw new RangeError('球面线角步长须大于0且不超过90°。');
  if (options.extraKnotsByArc && options.extraKnotsByArc.length > buffer.arcCount) throw new RangeError('额外接点列表超出源弧数量。');
  if (screen && (typeof screen.project !== 'function' || !Number.isFinite(screen.maxErrorPx) || screen.maxErrorPx <= 0)) throw new RangeError('屏幕误差控制须有投影函数及有限正容差。');
  const result = buffer.result;
  result.revision++;
  result.indexCount = result.totalSegments = result.maxActualAngularStepDeg = 0;
  result.antipodalArcCount = result.coincidentArcCount = result.invalidArcCount = result.budgetExceededArcCount = result.unmeasurableArcCount = 0;
  result.screenTestedSegmentCount = result.screenUnmeasurableSegmentCount = result.maxObservedScreenErrorPx = 0;
  result.pixelErrorStatus = screen ? 'sampled-within-tolerance' : 'not-requested';
  buffer.arcSegmentCounts.fill(0); buffer.arcDiagnostics.fill(0);
  const { fractions, endpoints, start, end } = workspace;
  let indexCursor = 0;
  for (const figure of workspace.figures) {
    const range = buffer.figureRanges.get(figure.id)!;
    range.indexStart = indexCursor;
    for (let arc = figure.lineStart; arc < figure.lineStart + figure.lineCount; arc++) {
      buffer.arcIndexStarts[arc] = indexCursor;
      const startIndex = endpoints[arc * 2]!, endIndex = endpoints[arc * 2 + 1]!;
      for (let axis = 0; axis < 3; axis++) {
        start[axis] = buffer.positions[startIndex * 3 + axis]!; end[axis] = buffer.positions[endIndex * 3 + axis]!;
      }
      let sampler: MinorArcSampler | null;
      try { sampler = createMinorArcSampler(start, end); }
      catch (error) { if (!(error instanceof RangeError)) throw error; buffer.arcDiagnostics[arc] = SphericalArcDiagnostic.InvalidInput; result.invalidArcCount++; continue; }
      if (!sampler) { buffer.arcDiagnostics[arc] = SphericalArcDiagnostic.Antipodal; result.antipodalArcCount++; continue; }
      if (sampler.coincident) { buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.Coincident; result.coincidentArcCount++; }
      let segmentCount = Math.max(1, Math.ceil(sampler.angleRad / (maxAngularStepDeg * RAD)));
      const knots = options.extraKnotsByArc?.[arc];
      if (segmentCount > buffer.maxSegmentsPerArc || knots && knots.length > buffer.maxExtraKnotsPerArc) {
        buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.BudgetExceeded; result.budgetExceededArcCount++; continue;
      }
      for (let point = 0; point <= segmentCount; point++) fractions[point] = point / segmentCount;
      let invalidKnots = false, exceeded = false;
      if (knots) {
        if (!Number.isSafeInteger(knots.length) || knots.length < 0) invalidKnots = true;
        else for (let knot = 0; knot < knots.length; knot++) {
          const value = knots[knot]!;
          if (!Number.isFinite(value) || value < 0 || value > 1) { invalidKnots = true; break; }
          if (value <= MINOR_ARC_BOUNDARY_TOLERANCE || value >= 1 - MINOR_ARC_BOUNDARY_TOLERANCE) continue;
          const next = insertFraction(fractions, segmentCount, value);
          if (next < 0) { exceeded = true; break; }
          segmentCount = next;
        }
      }
      if (invalidKnots) { buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.InvalidInput; result.invalidArcCount++; continue; }
      if (exceeded) { buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.BudgetExceeded; result.budgetExceededArcCount++; continue; }
      if (screen) {
        let unmeasurable = false;
        // Reuse adjacent endpoint observations, including null/clip outcomes, only
        // within this synchronous update's fixed display mapping. No time cache.
        let projectedFrom = NaN, projectedTo = NaN, measurableStart = false, measurableEnd = false;
        for (let segment = 0; segment < segmentCount;) {
          const from = fractions[segment]!, to = fractions[segment + 1]!, middle = (from + to) / 2;
          if (projectedFrom !== from) {
            measurableStart = captureScreenPoint(screen.project(minorArcDirectionAt(sampler, from, workspace.displayStart)), workspace.screenStart);
            projectedFrom = from;
          }
          if (projectedTo !== to) {
            measurableEnd = captureScreenPoint(screen.project(minorArcDirectionAt(sampler, to, workspace.displayEnd)), workspace.screenEnd);
            projectedTo = to;
          }
          const measurableMiddle = captureScreenPoint(screen.project(minorArcDirectionAt(sampler, middle, workspace.displayMiddle)), workspace.screenMiddle);
          if (!measurableStart || !measurableEnd || !measurableMiddle) {
            // Keep this bounded angular segment, including any potentially visible interior.
            unmeasurable = true; result.screenUnmeasurableSegmentCount++;
          } else {
            const error = midpointChordError(workspace.screenStart, workspace.screenEnd, workspace.screenMiddle);
            if (!Number.isFinite(error)) { unmeasurable = true; result.screenUnmeasurableSegmentCount++; }
            else if (error > screen.maxErrorPx) {
              const next = insertFraction(fractions, segmentCount, middle);
              if (next < 0 || next === segmentCount) { exceeded = true; result.maxObservedScreenErrorPx = Math.max(result.maxObservedScreenErrorPx, error); break; }
              segmentCount = next;
              // The old midpoint is exactly the inserted left child's endpoint.
              workspace.screenEnd[0] = workspace.screenMiddle[0]; workspace.screenEnd[1] = workspace.screenMiddle[1];
              workspace.displayEnd[0] = workspace.displayMiddle[0]; workspace.displayEnd[1] = workspace.displayMiddle[1]; workspace.displayEnd[2] = workspace.displayMiddle[2];
              projectedTo = middle; measurableEnd = true;
              continue;
            } else { result.maxObservedScreenErrorPx = Math.max(result.maxObservedScreenErrorPx, error); result.screenTestedSegmentCount++; }
          }
          if (to < 1) {
            // Accepted leaves precede every later insertion, so their slot stays
            // fixed. Stage even unmeasurable endpoints; only a successful whole
            // arc commits, preserving old slots if a later subdivision overflows.
            const at = segment * 3;
            workspace.sampledInteriors[at] = workspace.displayEnd[0]; workspace.sampledInteriors[at + 1] = workspace.displayEnd[1]; workspace.sampledInteriors[at + 2] = workspace.displayEnd[2];
          }
          workspace.screenStart[0] = workspace.screenEnd[0]; workspace.screenStart[1] = workspace.screenEnd[1];
          projectedFrom = to; measurableStart = measurableEnd; projectedTo = NaN;
          segment++;
        }
        if (unmeasurable) { buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.ScreenUnmeasurable; result.unmeasurableArcCount++; }
      }
      if (exceeded) { buffer.arcDiagnostics[arc] |= SphericalArcDiagnostic.BudgetExceeded; result.budgetExceededArcCount++; continue; }
      const interiorBase = buffer.starCount + arc * (buffer.maxSegmentsPerArc - 1);
      let previousIndex = startIndex;
      for (let point = 1; point <= segmentCount; point++) {
        const nextIndex = point === segmentCount ? endIndex : interiorBase + point - 1;
        if (point !== segmentCount) {
          if (screen) {
            const at = (point - 1) * 3;
            buffer.positions[nextIndex * 3] = workspace.sampledInteriors[at]!; buffer.positions[nextIndex * 3 + 1] = workspace.sampledInteriors[at + 1]!; buffer.positions[nextIndex * 3 + 2] = workspace.sampledInteriors[at + 2]!;
          } else {
            const direction = minorArcDirectionAt(sampler, fractions[point]!, workspace.direction);
            buffer.positions[nextIndex * 3] = direction[0]; buffer.positions[nextIndex * 3 + 1] = direction[1]; buffer.positions[nextIndex * 3 + 2] = direction[2];
          }
        }
        buffer.ordinaryIndex[indexCursor++] = previousIndex; buffer.ordinaryIndex[indexCursor++] = nextIndex;
        result.maxActualAngularStepDeg = Math.max(result.maxActualAngularStepDeg, (fractions[point]! - fractions[point - 1]!) * sampler.angleRad / RAD);
        previousIndex = nextIndex;
      }
      buffer.arcSegmentCounts[arc] = segmentCount;
      result.totalSegments += segmentCount;
    }
    range.indexCount = indexCursor - range.indexStart;
  }
  result.indexCount = indexCursor;
  if (screen) result.pixelErrorStatus = result.budgetExceededArcCount ? 'budget-exceeded' : result.unmeasurableArcCount || !result.screenTestedSegmentCount ? 'unmeasurable' : 'sampled-within-tolerance';
  return result;
}

/** Copy only already-generated ordinary indices. Selection never creates samples or geometry. Call again after any arc update. */
export function writeConstellationHighlight(buffer: SphericalArcBuffer, figureId: string | null): number {
  const range = figureId === null ? undefined : buffer.figureRanges.get(figureId);
  if (!range) return 0;
  for (let index = 0; index < range.indexCount; index++) buffer.highlightIndex[index] = buffer.ordinaryIndex[range.indexStart + index]!;
  return range.indexCount;
}
