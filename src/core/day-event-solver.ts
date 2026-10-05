export interface DayTrackBounds { readonly startUtDaysJ2000: number; readonly endUtDaysJ2000: number }
export interface DayTrackSample { readonly geometricAltitudeDeg: number; readonly clearanceDeg: number }
export interface ScalarExtremum { readonly valueDeg: number; readonly utDaysJ2000: number }
export interface ScalarRange { readonly minimum: ScalarExtremum; readonly maximum: ScalarExtremum }
export interface DayTrackAnalysis {
  readonly geometricAltitude: ScalarRange;
  readonly clearance: ScalarRange;
  /** Candidate/partition times, including seeds/edges; not all are stationary points. */
  readonly stationaryCandidatesUt: readonly number[];
  readonly complete: boolean;
  readonly incompleteReason: string | null;
}
export interface ThresholdCrossing { readonly kind: 'rise' | 'set'; readonly utDaysJ2000: number }
export interface ThresholdCrossings { readonly crossings: readonly ThresholdCrossing[]; readonly complete: boolean; readonly incompleteReason: string | null }
export const DAY_SOLVER_VERSION = 'slow-track-continuous-extrema-0.1ms-v1';
export const TOUCHING_TOLERANCE_DEG = 1e-5;
const secondsPerDay = 86400;
const maxKnots = 64, maxEvaluations = 20000, extremaIterations = 48, maxCrossings = 16;

function validateBounds(bounds: DayTrackBounds): void {
  const { startUtDaysJ2000: start, endUtDaysJ2000: end } = bounds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3) throw new RangeError('连续日轨迹须有有限、递增且不超过3日的边界。');
}
function range(values: readonly ScalarExtremum[]): ScalarRange {
  return { minimum: values.reduce((a, b) => a.valueDeg <= b.valueDeg ? a : b), maximum: values.reduce((a, b) => a.valueDeg >= b.valueDeg ? a : b) };
}
class EvaluationBudget extends Error {}

/** Bounded slow astronomical tracks only, not a completeness proof for arbitrary functions. */
export function* analyseDayTrackSteps(evaluate: (ut: number) => DayTrackSample, bounds: DayTrackBounds, seedKnotsUt: readonly number[] = []): Generator<void, DayTrackAnalysis> {
  validateBounds(bounds);
  const start = bounds.startUtDaysJ2000, end = bounds.endUtDaysJ2000;
  const cache = new Map<number, DayTrackSample>();
  const sample = (ut: number): DayTrackSample => {
    const known = cache.get(ut); if (known) return known;
    if (cache.size >= maxEvaluations) throw new EvaluationBudget('连续求值超出有限预算。');
    const result = evaluate(ut);
    if (!Number.isFinite(result.geometricAltitudeDeg) || !Number.isFinite(result.clearanceDeg)) throw new RangeError('轨迹高度和clearance须有限。');
    cache.set(ut, result); return result;
  };
  const values = { geometricAltitudeDeg: [] as ScalarExtremum[], clearanceDeg: [] as ScalarExtremum[] };
  const candidates = new Set<number>();
  let incompleteReason: string | null = null;
  const result = (): DayTrackAnalysis => ({ geometricAltitude: range(values.geometricAltitudeDeg), clearance: range(values.clearanceDeg),
    stationaryCandidatesUt: [...candidates].sort((a, b) => a - b), complete: incompleteReason === null, incompleteReason });
  for (const ut of [start, end]) {
    const value = sample(ut); candidates.add(ut);
    for (const metric of ['geometricAltitudeDeg', 'clearanceDeg'] as const) values[metric].push({ valueDeg: value[metric], utDaysJ2000: ut });
  }
  if (seedKnotsUt.length > maxKnots) { incompleteReason = '种子节点超过有界求解预算。'; return result(); }
  const knots = new Set([start, end]);
  for (const ut of seedKnotsUt) {
    if (!Number.isFinite(ut) || ut < start || ut > end) throw new RangeError('轨迹节点须在有限日界中。');
    knots.add(ut);
  }
  const segments = Math.max(12, Math.ceil((end - start) * 24));
  for (let index = 1; index < segments; index++) knots.add(start + (end - start) * index / segments);
  if (knots.size > maxKnots) { incompleteReason = '真实民用日节点超过有界求解预算。'; return result(); }
  const points = [...knots].sort((a, b) => a - b);
  const samples: { ut: number; sample: DayTrackSample }[] = [];
  for (const ut of points) { samples.push({ ut, sample: sample(ut) }); candidates.add(ut); if (samples.length % 6 === 0) yield; }
  const refine = (left: number, right: number, maximize: boolean, metric: keyof DayTrackSample): ScalarExtremum => {
    const ratio = (Math.sqrt(5) - 1) / 2;
    let c = right - ratio * (right - left), d = left + ratio * (right - left), fc = sample(c)[metric], fd = sample(d)[metric];
    for (let index = 0; index < extremaIterations && (right - left) * secondsPerDay > 0.0001; index++) {
      const oldLeft = left, oldRight = right;
      if ((fc > fd) === maximize) { right = d; d = c; fd = fc; c = right - ratio * (right - left); fc = sample(c)[metric]; }
      else { left = c; c = d; fc = fd; d = left + ratio * (right - left); fd = sample(d)[metric]; }
      if (left === oldLeft && right === oldRight) { incompleteReason = '极值区间在浮点分辨率下不能继续收敛。'; break; }
    }
    if ((right - left) * secondsPerDay > 0.0001) incompleteReason ??= '极值细化超出有限迭代预算。';
    return (fc > fd) === maximize ? { valueDeg: fc, utDaysJ2000: c } : { valueDeg: fd, utDaysJ2000: d };
  };
  try {
    for (const metric of ['geometricAltitudeDeg', 'clearanceDeg'] as const) {
      for (const node of samples) values[metric].push({ valueDeg: node.sample[metric], utDaysJ2000: node.ut });
      // Every interval, including first/last: do not miss an internal edge peak.
      for (let index = 1; index < points.length; index++) {
        for (const maximize of [true, false]) {
          const extremum = refine(points[index - 1]!, points[index]!, maximize, metric);
          values[metric].push(extremum); candidates.add(extremum.utDaysJ2000); yield;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof EvaluationBudget)) throw error;
    incompleteReason = error.message;
  }
  return result();
}

/** Point-target roots split at continuously refined interior extrema, not a sampling verdict. */
export function* solvePointThresholdSteps(evaluateClearance: (ut: number) => number, bounds: DayTrackBounds, analysis: DayTrackAnalysis): Generator<void, ThresholdCrossings> {
  validateBounds(bounds);
  if (!analysis.complete) return { crossings: [], complete: false, incompleteReason: analysis.incompleteReason };
  const start = bounds.startUtDaysJ2000, end = bounds.endUtDaysJ2000;
  for (const ut of analysis.stationaryCandidatesUt) if (!Number.isFinite(ut) || ut < start || ut > end) throw new RangeError('阈值候选须位于有限日界中。');
  const points = [...new Set([start, end, ...analysis.stationaryCandidatesUt])].sort((a, b) => a - b);
  if (points.length > 320) return { crossings: [], complete: false, incompleteReason: '阈值分区超出有限预算。' };
  const finite = (ut: number): number => { const value = evaluateClearance(ut); if (!Number.isFinite(value)) throw new RangeError('阈值求值须有限。'); return value; };
  const roots: number[] = [];
  let incompleteReason: string | null = null;
  for (let index = 1; index < points.length; index++) {
    let left = points[index - 1]!, right = points[index]!, fl = finite(left), fr = finite(right);
    if (fl === 0 && left < end) roots.push(left);
    if (fl !== 0 && fr !== 0 && (fl < 0) !== (fr < 0)) {
      for (let iteration = 0; iteration < 64 && (right - left) * secondsPerDay > 0.1; iteration++) {
        const middle = (left + right) / 2;
        if (middle === left || middle === right) { incompleteReason = '阈值区间不能继续收敛。'; break; }
        const fm = finite(middle);
        if (fm === 0) { left = middle; right = middle; break; }
        if ((fm < 0) === (fl < 0)) { left = middle; fl = fm; } else { right = middle; fr = fm; }
        if (iteration % 8 === 7) yield;
      }
      if ((right - left) * secondsPerDay > 0.1) incompleteReason ??= '阈值根超出有限迭代预算。';
      roots.push((left + right) / 2);
    }
    if (index % 8 === 0) yield;
    // Exact-zero nodes may form a plateau. They are bounded candidates, not
    // crossings; count the budget only after verifying opposite-side signs.
  }
  const crossings: ThresholdCrossing[] = [];
  for (const utDaysJ2000 of roots.sort((a, b) => a - b)) {
    if (utDaysJ2000 < start || utDaysJ2000 >= end || crossings.some(crossing => Math.abs(crossing.utDaysJ2000 - utDaysJ2000) * secondsPerDay < 0.02)) continue;
    // A small boundary extension distinguishes a start-root from a tangent.
    const before = finite(utDaysJ2000 - 0.1 / secondsPerDay), after = finite(utDaysJ2000 + 0.1 / secondsPerDay);
    if (before < 0 && after > 0) crossings.push({ kind: 'rise', utDaysJ2000 });
    else if (before > 0 && after < 0) crossings.push({ kind: 'set', utDaysJ2000 });
    if (crossings.length > maxCrossings) { incompleteReason = '全天穿越超过有限预算。'; break; }
    yield;
  }
  if (!crossings.length && analysis.clearance.minimum.valueDeg < -TOUCHING_TOLERANCE_DEG && analysis.clearance.maximum.valueDeg > TOUCHING_TOLERANCE_DEG) incompleteReason ??= '连续范围与无阈值根结果矛盾。';
  return { crossings: crossings.slice(0, maxCrossings), complete: incompleteReason === null, incompleteReason };
}
