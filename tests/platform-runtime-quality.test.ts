import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { advanceQuality, createQualityState } from '../src/platform/runtime-quality';
import { DEFAULT_RUNTIME_RENDER_QUALITY, QUALITY_CONFIGS } from '../src/platform/runtime-quality-contract';
import type { QualityAdvanceResult, QualityConfig, QualityPressure, QualityResetReason, QualityState, QualityWindow,
  RuntimeQualityCapabilities } from '../src/platform/runtime-quality-contract';

const currentCapabilities: RuntimeQualityCapabilities = Object.freeze({ removableLabels: true, verifiedDecorationReduction: false,
  pixelScaling: true, optionalInvisibleStars: false });
const allCapabilities: RuntimeQualityCapabilities = Object.freeze({ ...currentCapabilities, verifiedDecorationReduction: true, optionalInvisibleStars: true });

function harness(config: QualityConfig = QUALITY_CONFIGS.desktop, capabilities = currentCapabilities) {
  let state = createQualityState(), time = 0;
  const feed = (patch: Partial<QualityWindow> = {}): QualityAdvanceResult => {
    const window: QualityWindow = { generation: state.generation, startMs: time, endMs: time + 2000, eligibleActiveMs: 1500,
      eligibleSamples: 8, rafP95Ms: 16.7, rendererSubmitP95Ms: 4, appWorkP95Ms: 5, pressure: 'none', ...patch };
    const output = advanceQuality(state, { kind: 'window', window }, config, capabilities);
    state = output.state; time = window.endMs; return output;
  };
  const run = (count: number, patch: Partial<QualityWindow>) => {
    let output: QualityAdvanceResult | undefined;
    for (let i = 0; i < count; i++) output = feed(patch);
    return output!;
  };
  const bad = (count = 3) => run(count, { rafP95Ms: 60, rendererSubmitP95Ms: 14, appWorkP95Ms: 15, pressure: 'render' });
  const good = (count = 6) => run(count, {});
  const unlock = () => { time = Math.max(time, state.cooldownUntilMs, state.settleUntilMs); };
  return { feed, bad, good, unlock, get state() { return state; }, get time() { return time; },
    setTime(value: number) { time = value; }, setState(value: QualityState) { state = value; } };
}

test('locked desktop/mobile thresholds distinguish strict bad and inclusive good boundaries', () => {
  assert.deepEqual([QUALITY_CONFIGS.desktop.badRafP95Ms, QUALITY_CONFIGS.desktop.goodRafP95Ms,
    QUALITY_CONFIGS.desktop.badRendererSubmitP95Ms, QUALITY_CONFIGS.desktop.goodRendererSubmitP95Ms], [22, 19, 6.6, 5.4]);
  assert.deepEqual([QUALITY_CONFIGS.mobile.badRafP95Ms, QUALITY_CONFIGS.mobile.goodRafP95Ms,
    QUALITY_CONFIGS.mobile.badRendererSubmitP95Ms, QUALITY_CONFIGS.mobile.goodRendererSubmitP95Ms], [40.37, 34.865, 11, 9]);
  for (const config of Object.values(QUALITY_CONFIGS)) {
    const h = harness(config);
    for (let i = 0; i < 9; i++) h.feed({ rafP95Ms: config.badRafP95Ms, rendererSubmitP95Ms: config.badRendererSubmitP95Ms, pressure: 'render' });
    assert.equal(h.state.stage, 0); assert.equal(h.state.badWindows, 0);
    for (let i = 0; i < 3; i++) h.feed({ rafP95Ms: config.goodRafP95Ms, rendererSubmitP95Ms: config.badRendererSubmitP95Ms + 1e-9, pressure: 'render' });
    assert.equal(h.state.stage, 1, 'Attributable renderer CPU alone can cause sustained pressure');
    h.unlock();
    for (let i = 0; i < 5; i++) h.feed({ rafP95Ms: config.goodRafP95Ms, rendererSubmitP95Ms: config.goodRendererSubmitP95Ms });
    assert.equal(h.state.stage, 1);
    h.feed({ rafP95Ms: config.goodRafP95Ms, rendererSubmitP95Ms: config.goodRendererSubmitP95Ms });
    assert.equal(h.state.stage, 0);
    const raf = harness(config);
    for (let i = 0; i < 3; i++) raf.feed({ rafP95Ms: config.badRafP95Ms + 1e-9, rendererSubmitP95Ms: config.goodRendererSubmitP95Ms, pressure: 'render' });
    assert.equal(raf.state.stage, 1, 'Continuous draw RAF pressure alone also requires three windows');
  }
});

test('actual capabilities enforce labels then pixel .85/.70/.55 and recover in reverse without N/A delays', () => {
  const h = harness(), down: number[] = [], skips: number[][] = [];
  for (let i = 0; i < 4; i++) { h.unlock(); const output = h.bad(); down.push(output.state.stage); skips.push([...output.skippedStages]); }
  assert.deepEqual(down, [1, 3, 4, 5]); assert.deepEqual(skips, [[], [2], [], []]);
  const pixels = h.state.history.map(change => advanceQuality({ ...h.state, stage: change.toStage },
    { kind: 'reset', generation: h.state.generation, nowMs: h.time, reason: 'resize' }, QUALITY_CONFIGS.desktop, currentCapabilities).effects.pixelScale);
  assert.deepEqual(pixels, [1, .85, .70, .55]);
  h.unlock(); const residual = h.bad();
  assert.equal(residual.reason, 'residual-render-pressure'); assert.equal(residual.changed, false); assert.deepEqual(residual.skippedStages, [6]);
  assert.equal(residual.effects.omitOptionalInvisibleStars, false); assert.equal(residual.effects.reduceVerifiedDecoration, false);
  const up: number[] = [];
  for (let i = 0; i < 4; i++) { h.unlock(); up.push(h.good().state.stage); }
  assert.deepEqual(up, [4, 3, 1, 0]); assert.deepEqual(h.good().effects, DEFAULT_RUNTIME_RENDER_QUALITY);
  assert.equal(h.state.history.length, 8);
});

test('verified decoration and optional invisible stars occupy their ordered steps; no capabilities are a diagnosed no-op', () => {
  const h = harness(QUALITY_CONFIGS.desktop, allCapabilities), stages: number[] = [];
  for (let i = 0; i < 6; i++) { h.unlock(); stages.push(h.bad().state.stage); }
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6]);
  const output = h.feed(); assert.equal(output.effects.reduceVerifiedDecoration, true); assert.equal(output.effects.omitOptionalInvisibleStars, true);
  const none = harness(QUALITY_CONFIGS.desktop, { removableLabels: false, verifiedDecorationReduction: false, pixelScaling: false, optionalInvisibleStars: false });
  const unavailable = none.bad();
  assert.equal(unavailable.changed, false); assert.equal(unavailable.state.stage, 0); assert.equal(unavailable.state.history.length, 0);
  assert.deepEqual(unavailable.skippedStages, [1, 2, 3, 4, 5, 6]); assert.equal(unavailable.effects, DEFAULT_RUNTIME_RENDER_QUALITY);
});

test('cooldown uses the entire window and never banks bad or good streaks while cooling down', () => {
  const h = harness(); h.bad(); assert.equal(h.state.cooldownUntilMs, 21000);
  for (let i = 0; i < 6; i++) { assert.equal(h.good(1).reason, 'cooldown'); assert.equal(h.state.goodWindows, 0); }
  h.setTime(19000); assert.equal(h.feed({ pressure: 'render', rafP95Ms: 80 }).reason, 'cooldown');
  assert.equal(h.state.badWindows, 0, 'End equal to deadline does not admit a partly cooled window');
  h.setTime(21000); assert.equal(h.bad(1).state.badWindows, 1);
  assert.equal(h.bad(1).changed, false); assert.equal(h.bad(1).state.stage, 3);
  h.unlock(); h.good(5); assert.equal(h.state.stage, 3);
  h.feed({ rafP95Ms: 20, rendererSubmitP95Ms: 6 }); assert.equal(h.state.goodWindows, 0);
  h.good(5); assert.equal(h.state.stage, 3); assert.equal(h.good(1).state.stage, 1);
});

test('all lifecycle resets preserve quality, history and cooldown while clearing streaks and requiring settled windows', () => {
  const reasons: QualityResetReason[] = ['pause', 'hidden', 'resume', 'resize', 'surface', 'context', 'view', 'asset-warmup',
    'capture', 'input', 'transition', 'science-error', 'range-stop', 'dispose'];
  const h = harness(); h.bad(); h.unlock(); h.bad(2);
  const before = h.state;
  for (const reason of reasons) {
    const output = advanceQuality(before, { kind: 'reset', generation: 1, nowMs: h.time, reason }, QUALITY_CONFIGS.desktop, currentCapabilities);
    assert.equal(output.state.stage, before.stage); assert.equal(output.changed, false); assert.equal(output.state.history, before.history);
    assert.equal(output.state.cooldownUntilMs, before.cooldownUntilMs); assert.equal(output.state.lastWindowEndMs, null);
    assert.equal(output.state.badWindows, 0); assert.equal(output.state.goodWindows, 0); assert.equal(output.state.settleUntilMs, h.time + 1000);
  }
  h.setState(advanceQuality(before, { kind: 'reset', generation: 1, nowMs: h.time, reason: 'resume' }, QUALITY_CONFIGS.desktop, currentCapabilities).state);
  assert.equal(h.bad(1).reason, 'settling'); assert.equal(h.state.badWindows, 0);
  assert.equal(h.bad(1).state.badWindows, 1);
  const capabilitiesChanged = advanceQuality(before, { kind: 'reset', generation: 1, nowMs: h.time, reason: 'surface' }, QUALITY_CONFIGS.desktop,
    { ...currentCapabilities, removableLabels: false });
  assert.equal(capabilitiesChanged.changed, false); assert.equal(capabilitiesChanged.effects.hideOrdinarySecondaryLabels, false);
});

test('incomplete, missing or compute/unknown samples break streaks and never substitute zero measurements', () => {
  const invalid: Partial<QualityWindow>[] = [
    { endMs: 1999.999 }, { eligibleActiveMs: 1499.999 }, { eligibleActiveMs: 2001 }, { eligibleSamples: 7 }, { eligibleSamples: 8.5 },
    { rafP95Ms: null }, { rendererSubmitP95Ms: null }, { appWorkP95Ms: null }, { rafP95Ms: NaN }, { rendererSubmitP95Ms: Infinity },
    { appWorkP95Ms: -1 }, { pressure: 'compute' }, { pressure: 'unknown' },
  ];
  for (const patch of invalid) {
    const h = harness(); h.bad(2);
    const windowPatch = { rafP95Ms: 80, rendererSubmitP95Ms: 30, appWorkP95Ms: 100, pressure: 'render' as QualityPressure, ...patch };
    if (patch.endMs !== undefined) windowPatch.endMs = h.time + 1999.999;
    h.feed(windowPatch);
    assert.equal(h.state.stage, 0); assert.equal(h.state.badWindows, 0); assert.equal(h.state.goodWindows, 0);
    h.bad(2); assert.equal(h.state.stage, 0, 'A later pair cannot reuse the interrupted bad streak');
  }
  const complete = harness(); complete.bad(3); assert.equal(complete.state.stage, 1, 'Exactly 1500 active ms and eight samples suffice');
  const computation = harness();
  for (let i = 0; i < 10; i++) computation.feed({ appWorkP95Ms: 200 });
  assert.equal(computation.state.stage, 0, 'Full callback cost alone is not attributed renderer pressure');
  const recovery = harness(); recovery.bad(); recovery.unlock(); recovery.good(5);
  recovery.feed({ appWorkP95Ms: null }); recovery.good(5); assert.equal(recovery.state.stage, 1);
  assert.equal(recovery.good(1).state.stage, 0);
});

test('stale generations, overlapping windows and missing full windows cannot complete old streaks', () => {
  const stale = harness(); stale.bad(2);
  const end = stale.state.lastWindowEndMs;
  stale.feed({ generation: -1 }); assert.equal(stale.state.lastWindowEndMs, end); assert.equal(stale.state.badWindows, 0);
  stale.bad(2); assert.equal(stale.state.stage, 0);
  const overlap = harness(); overlap.bad(2); overlap.setTime(2000);
  assert.equal(overlap.bad(1).reason, 'overlapping-window'); assert.equal(overlap.state.badWindows, 0);
  overlap.setTime(4000); overlap.bad(2); assert.equal(overlap.state.stage, 0);
  const gap = harness(); gap.bad(2); gap.setTime(gap.time + 2000);
  assert.equal(gap.bad(1).state.badWindows, 1); assert.equal(gap.state.stage, 0);
  const adjacent = harness(); adjacent.bad(2); adjacent.setTime(adjacent.time + 16.7);
  assert.equal(adjacent.bad(1).state.stage, 1, 'A normal between-frame gap does not represent a missing complete window');
});

test('one-off spikes, alternating pressure and neutral threshold jitter cannot oscillate quality', () => {
  const h = harness();
  for (let i = 0; i < 200; i++) i % 2 ? h.good(1) : h.bad(1);
  assert.equal(h.state.stage, 0); assert.equal(h.state.history.length, 0);
  h.bad(); h.unlock();
  for (let i = 0; i < 200; i++) i % 2 ? h.good(1) : h.bad(1);
  assert.equal(h.state.stage, 1); assert.equal(h.state.history.length, 1);
  for (let i = 0; i < 200; i++) h.feed({ rafP95Ms: i % 2 ? 21.999 : 19.001, rendererSubmitP95Ms: 6 });
  assert.equal(h.state.stage, 1); assert.equal(h.state.history.length, 1);
});

test('pure updates preserve input objects and keep only a bounded 32-change runtime history', () => {
  const h = harness(QUALITY_CONFIGS.desktop, allCapabilities);
  for (let cycle = 0; cycle < 12; cycle++) {
    for (let i = 0; i < 6; i++) { h.unlock(); h.bad(); }
    for (let i = 0; i < 6; i++) { h.unlock(); h.good(); }
    assert.ok(h.state.history.length <= 32); assert.equal(h.state.stage, 0);
  }
  assert.equal(h.state.history.length, 32);
  for (let i = 1; i < h.state.history.length; i++) assert.ok(h.state.history[i]!.atMs - h.state.history[i - 1]!.atMs >= 15000);
  assert.ok(h.state.history.every(change => change.skippedStages.length <= 6));
  const frozen = Object.freeze({ ...h.state, history: Object.freeze(h.state.history.map(change => Object.freeze({ ...change, skippedStages: Object.freeze([...change.skippedStages]) }))) });
  const event = Object.freeze({ kind: 'window' as const, window: Object.freeze({ generation: frozen.generation, startMs: h.time, endMs: h.time + 2000,
    eligibleActiveMs: 1500, eligibleSamples: 8, rafP95Ms: 16.7, rendererSubmitP95Ms: 4, appWorkP95Ms: 5, pressure: 'none' as const }) });
  const before = JSON.stringify(frozen);
  assert.deepEqual(advanceQuality(frozen, event, QUALITY_CONFIGS.desktop, allCapabilities), advanceQuality(frozen, event, QUALITY_CONFIGS.desktop, allCapabilities));
  assert.equal(JSON.stringify(frozen), before);
  assert.deepEqual(Object.keys(frozen).sort(), ['badWindows', 'cooldownUntilMs', 'generation', 'goodWindows', 'history', 'lastWindowEndMs', 'settleUntilMs', 'stage']);
  mkdirSync('qa/m6-runtime-quality', { recursive: true });
  writeFileSync('qa/m6-runtime-quality/controller-report.json', JSON.stringify({ deterministicChangeCycles: 12, changesExercised: 144,
    maximumRetainedChanges: frozen.history.length, maximumStagesSkippedPerChange: 6, thresholds: QUALITY_CONFIGS,
    inputMutation: false, timersDomRafOrScienceOwned: false, scope: 'Pure deterministic CPU scenarios; actual renderer and full-frame performance require integrated QA.' }, null, 2));
});
