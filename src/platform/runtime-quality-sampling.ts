import type { QualityConfig, QualityPressure, QualityWindow } from './runtime-quality-contract';

export const QUALITY_SAMPLE_CAPACITY = 600;
export const QUALITY_EXCLUSIONS = ['paused', 'hidden', 'unavailable', 'settle', 'transition',
  'science-wait', 'science-fallback', 'event-compute', 'not-adjacent', 'unpaired'] as const;
export type QualityExclusion = typeof QUALITY_EXCLUSIONS[number];
export interface FrameWorkSample {
  generation: number;
  nowMs: number;
  rafIntervalMs: number | null;
  rendererSubmitMs: number | null;
  appWorkMs: number;
  exclusion: QualityExclusion | null;
}
const percentile95 = (values: number[]): number | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * .95) - 1];
};
/** A single bounded diagnostic ring; no timer, RAF, astronomy or quality decisions. */
export class RuntimeQualitySampler {
  private readonly times = new Float64Array(QUALITY_SAMPLE_CAPACITY);
  private readonly intervals = new Float64Array(QUALITY_SAMPLE_CAPACITY);
  private readonly renderer = new Float64Array(QUALITY_SAMPLE_CAPACITY);
  private readonly app = new Float64Array(QUALITY_SAMPLE_CAPACITY);
  private readonly eligible = new Uint8Array(QUALITY_SAMPLE_CAPACITY);
  private writeIndex = 0;
  private count = 0;
  private windowStartMs: number;
  private generation: number;
  private windowEligibleSamples = 0;
  private windowEligibleActiveMs = 0;
  private readonly excluded = new Uint32Array(QUALITY_EXCLUSIONS.length);
  private readonly excludedTotal = new Uint32Array(QUALITY_EXCLUSIONS.length);
  private recorded = 0;
  private lastWindow: QualityWindow | null = null;
  private lastWindowExcluded: Record<QualityExclusion, number> | null = null;
  constructor(generation: number, nowMs: number) { this.generation = generation; this.windowStartMs = nowMs; }
  reset(generation: number, nowMs: number): void {
    this.generation = generation; this.windowStartMs = nowMs;
    this.count = 0; this.writeIndex = 0; this.windowEligibleSamples = 0; this.windowEligibleActiveMs = 0;
    this.excluded.fill(0);
  }
  record(sample: FrameWorkSample): void {
    if (sample.generation !== this.generation) return;
    const valid = sample.exclusion === null && sample.rafIntervalMs !== null && sample.rendererSubmitMs !== null
      && Number.isFinite(sample.nowMs) && Number.isFinite(sample.rafIntervalMs) && Number.isFinite(sample.rendererSubmitMs)
      && Number.isFinite(sample.appWorkMs) && sample.rafIntervalMs >= 0 && sample.rendererSubmitMs >= 0 && sample.appWorkMs >= 0;
    const i = this.writeIndex;
    this.times[i] = sample.nowMs;
    this.intervals[i] = sample.rafIntervalMs ?? NaN;
    this.renderer[i] = sample.rendererSubmitMs ?? NaN;
    this.app[i] = sample.appWorkMs;
    this.eligible[i] = Number(valid);
    this.writeIndex = (i + 1) % QUALITY_SAMPLE_CAPACITY;
    this.count = Math.min(this.count + 1, QUALITY_SAMPLE_CAPACITY);
    this.recorded++;
    if (valid) {
      this.windowEligibleSamples++;
      this.windowEligibleActiveMs += Math.min(sample.rafIntervalMs!, Math.max(0, sample.nowMs - this.windowStartMs));
    } else {
      const reason = QUALITY_EXCLUSIONS.indexOf(sample.exclusion ?? 'unpaired');
      this.excluded[reason]++; this.excludedTotal[reason]++;
    }
  }
  /** Include the bounded bookkeeping/evaluation work in the same callback's CPU value. */
  finishLastAppWork(appWorkMs: number): void {
    if (this.count) this.app[(this.writeIndex + QUALITY_SAMPLE_CAPACITY - 1) % QUALITY_SAMPLE_CAPACITY] = appWorkMs;
  }
  takeWindow(nowMs: number, config: QualityConfig): QualityWindow | null {
    if (nowMs - this.windowStartMs < config.windowMs) return null;
    const raf: number[] = [], renderer: number[] = [], app: number[] = [];
    for (let n = 0; n < this.count; n++) {
      const i = (this.writeIndex - 1 - n + QUALITY_SAMPLE_CAPACITY) % QUALITY_SAMPLE_CAPACITY;
      if (this.times[i] < this.windowStartMs || !this.eligible[i]) continue;
      raf.push(this.intervals[i]); renderer.push(this.renderer[i]); app.push(this.app[i]);
    }
    const completeRing = raf.length === this.windowEligibleSamples;
    const rafP95Ms = completeRing ? percentile95(raf) : null;
    const rendererSubmitP95Ms = completeRing ? percentile95(renderer) : null;
    const appWorkP95Ms = completeRing ? percentile95(app) : null;
    let pressure: QualityPressure = 'unknown';
    if (rafP95Ms !== null && rendererSubmitP95Ms !== null && appWorkP95Ms !== null) {
      if (rendererSubmitP95Ms > config.badRendererSubmitP95Ms) pressure = 'render';
      else if (appWorkP95Ms > config.badRendererSubmitP95Ms) pressure = 'compute';
      else if (rafP95Ms > config.badRafP95Ms || rendererSubmitP95Ms > config.goodRendererSubmitP95Ms) pressure = 'render';
      else pressure = 'none';
    }
    const window: QualityWindow = { generation: this.generation, startMs: this.windowStartMs, endMs: nowMs,
      eligibleActiveMs: this.windowEligibleActiveMs, eligibleSamples: this.windowEligibleSamples,
      rafP95Ms, rendererSubmitP95Ms, appWorkP95Ms, pressure };
    this.lastWindowExcluded = Object.fromEntries(QUALITY_EXCLUSIONS.map((reason, i) => [reason, this.excluded[i]])) as Record<QualityExclusion, number>;
    this.lastWindow = window;
    this.windowStartMs = nowMs; this.windowEligibleSamples = 0; this.windowEligibleActiveMs = 0; this.excluded.fill(0);
    return window;
  }
  get diagnostics() {
    return { capacity: QUALITY_SAMPLE_CAPACITY, sampleCount: this.count, recordedCount: this.recorded,
      generation: this.generation, windowStartMs: this.windowStartMs,
      pendingEligibleSamples: this.windowEligibleSamples, pendingEligibleActiveMs: this.windowEligibleActiveMs,
      lastWindow: this.lastWindow ? { ...this.lastWindow } : null,
      lastWindowExcluded: this.lastWindowExcluded ? { ...this.lastWindowExcluded } : null,
      excluded: Object.fromEntries(QUALITY_EXCLUSIONS.map((reason, i) => [reason, this.excluded[i]])),
      excludedTotal: Object.fromEntries(QUALITY_EXCLUSIONS.map((reason, i) => [reason, this.excludedTotal[i]])),
      scope: 'Whole main RAF callback CPU and renderer submission CPU; eligible adjacent draws only; neither is GPU completion FPS.' };
  }
}
