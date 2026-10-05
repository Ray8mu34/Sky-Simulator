import { DEFAULT_RUNTIME_RENDER_QUALITY } from './runtime-quality-contract';
import type { QualityAdvanceResult, QualityConfig, QualityEvent, QualityStage, QualityState,
  RuntimeQualityCapabilities, RuntimeRenderQuality } from './runtime-quality-contract';

/** Caller owns monotonic timestamps and generations; this module owns no clock or frame samples. */
export function createQualityState(generation = 0): QualityState {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError('运行质量generation须为非负安全整数。');
  return { stage: 0, generation, badWindows: 0, goodWindows: 0, cooldownUntilMs: 0,
    settleUntilMs: 0, lastWindowEndMs: null, history: [] };
}

function effectsFor(stage: QualityStage, capabilities: RuntimeQualityCapabilities): Readonly<RuntimeRenderQuality> {
  const labels = stage >= 1 && capabilities.removableLabels;
  const decoration = stage >= 2 && capabilities.verifiedDecorationReduction;
  const pixelScale = !capabilities.pixelScaling || stage < 3 ? 1 : stage >= 5 ? .55 : stage === 4 ? .70 : .85;
  const optionalStars = stage >= 6 && capabilities.optionalInvisibleStars;
  if (!labels && !decoration && pixelScale === 1 && !optionalStars) return DEFAULT_RUNTIME_RENDER_QUALITY;
  return { hideOrdinaryBackLabels: labels, hideOrdinarySecondaryLabels: labels, ordinaryLabelBudgetScale: labels ? .5 : 1,
    reduceVerifiedDecoration: decoration, pixelScale, omitOptionalInvisibleStars: optionalStars };
}

function stageAvailable(stage: QualityStage, capabilities: RuntimeQualityCapabilities): boolean {
  if (stage === 0) return true;
  if (stage === 1) return capabilities.removableLabels;
  if (stage === 2) return capabilities.verifiedDecorationReduction;
  if (stage === 6) return capabilities.optionalInvisibleStars;
  return capabilities.pixelScaling;
}

/** Advance only runtime display state. Missing or excluded windows interrupt both streaks. */
export function advanceQuality(state: QualityState, event: QualityEvent, config: QualityConfig,
  capabilities: RuntimeQualityCapabilities): QualityAdvanceResult {
  const result = (next: QualityState, reason: string, changed = false, skippedStages: readonly QualityStage[] = []): QualityAdvanceResult =>
    ({ state: next, changed, effects: effectsFor(next.stage, capabilities), reason, skippedStages });
  const clear = (reason: string, lastWindowEndMs = state.lastWindowEndMs) =>
    result({ ...state, badWindows: 0, goodWindows: 0, lastWindowEndMs }, reason);

  if (event.kind === 'reset') {
    if (!Number.isSafeInteger(event.generation) || event.generation < 0 || !Number.isFinite(event.nowMs) || event.nowMs < 0) return clear('invalid-reset');
    if (event.generation < state.generation || state.lastWindowEndMs !== null && event.nowMs < state.lastWindowEndMs) return clear('stale-reset');
    return result({ ...state, generation: event.generation, badWindows: 0, goodWindows: 0,
      lastWindowEndMs: null, settleUntilMs: event.nowMs + config.settleMs }, `reset:${event.reason}`);
  }

  const window = event.window;
  if (window.generation !== state.generation) return clear('stale-generation');
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.startMs < 0 || window.endMs <= window.startMs) return clear('invalid-window');
  const lastWindowEndMs = Math.max(state.lastWindowEndMs ?? window.endMs, window.endMs);
  if (state.lastWindowEndMs !== null && window.startMs < state.lastWindowEndMs) return clear('overlapping-window', lastWindowEndMs);
  if (window.endMs - window.startMs < config.windowMs || !Number.isFinite(window.eligibleActiveMs)
    || window.eligibleActiveMs < config.minEligibleActiveMs || window.eligibleActiveMs > window.endMs - window.startMs
    || !Number.isSafeInteger(window.eligibleSamples) || window.eligibleSamples < config.minEligibleSamples) return clear('incomplete-window', lastWindowEndMs);
  if (window.startMs < state.settleUntilMs) return clear('settling', lastWindowEndMs);
  if (window.startMs < state.cooldownUntilMs) return clear('cooldown', lastWindowEndMs);
  if (window.rafP95Ms === null || window.rendererSubmitP95Ms === null || window.appWorkP95Ms === null) return clear('missing-metric', lastWindowEndMs);
  if (![window.rafP95Ms, window.rendererSubmitP95Ms, window.appWorkP95Ms].every(value => Number.isFinite(value) && value >= 0)) return clear('invalid-metric', lastWindowEndMs);
  if (window.pressure === 'compute' || window.pressure === 'unknown') return clear(`${window.pressure}-pressure`, lastWindowEndMs);
  if (window.pressure !== 'render' && window.pressure !== 'none') return clear('unknown-pressure', lastWindowEndMs);

  // A normal adjacent frame gap is allowed; a missing complete window breaks
  // continuity. The current complete window can then start a fresh streak.
  const missedWindow = state.lastWindowEndMs !== null && window.startMs >= state.lastWindowEndMs + config.windowMs;
  const bad = window.pressure === 'render' && (window.rafP95Ms > config.badRafP95Ms || window.rendererSubmitP95Ms > config.badRendererSubmitP95Ms);
  const good = window.rafP95Ms <= config.goodRafP95Ms && window.rendererSubmitP95Ms <= config.goodRendererSubmitP95Ms;
  if (!bad && !good) return clear('neutral', lastWindowEndMs);
  const badWindows = bad ? Math.min(config.badWindowsRequired, (missedWindow ? 0 : state.badWindows) + 1) : 0;
  const goodWindows = !bad && good ? Math.min(config.goodWindowsRequired, (missedWindow ? 0 : state.goodWindows) + 1) : 0;
  const next = { ...state, badWindows, goodWindows, lastWindowEndMs };
  if (badWindows < config.badWindowsRequired && goodWindows < config.goodWindowsRequired) return result(next, bad ? 'awaiting-bad-windows' : 'awaiting-good-windows');

  const direction = bad ? 1 : -1, skipped: QualityStage[] = [];
  let target = state.stage + direction;
  while (target >= 0 && target <= 6 && !stageAvailable(target as QualityStage, capabilities)) {
    skipped.push(target as QualityStage); target += direction;
  }
  if (target < 0 || target > 6) return result({ ...next, badWindows: 0, goodWindows: 0 }, bad ? 'residual-render-pressure' : 'full-quality', false, skipped);
  const stage = target as QualityStage, reason = bad ? 'degraded' : 'recovered';
  const change = { atMs: window.endMs, generation: state.generation, fromStage: state.stage, toStage: stage, reason, skippedStages: skipped };
  const historyLimit = Number.isFinite(config.maxHistory) ? Math.min(32, Math.max(0, Math.floor(config.maxHistory))) : 32;
  const history = historyLimit === 0 ? [] : [...state.history, change].slice(-historyLimit);
  return result({ ...next, stage, badWindows: 0, goodWindows: 0, cooldownUntilMs: window.endMs + config.cooldownMs, history }, reason, true, skipped);
}
