import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeQualitySampler } from '../src/platform/runtime-quality-sampling';
import { QUALITY_CONFIGS, type QualityWindow } from '../src/platform/runtime-quality-contract';
import { advanceQuality, createQualityState } from '../src/platform/runtime-quality';

const config = QUALITY_CONFIGS.desktop;
test('three consecutive complete windows consume each finished callback once, with bounded ring and final CPU work', () => {
  const sampler = new RuntimeQualitySampler(1, 0), windows: QualityWindow[] = [];
  for (let now = 0; now <= 6000; now += 10) {
    // This is the same boundary order as main: take previous finished, then record current.
    const window = sampler.takeWindow(now, config);
    if (window) windows.push(window);
    sampler.record({ generation: 1, nowMs: now, rafIntervalMs: now ? 10 : null,
      rendererSubmitMs: 4, appWorkMs: 4.2, exclusion: now ? null : 'not-adjacent' });
    sampler.finishLastAppWork(5);
  }
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map(w => [w.startMs, w.endMs, w.eligibleSamples]), [[0, 2000, 199], [2000, 4000, 200], [4000, 6000, 200]]);
  for (const w of windows) { assert.equal(w.rafP95Ms, 10); assert.equal(w.appWorkP95Ms, 5); assert.equal(w.pressure, 'none'); }
  assert.equal(sampler.diagnostics.sampleCount, 600); assert.equal(sampler.diagnostics.pendingEligibleSamples, 1);
});
test('deadband renderer with high full callback is compute pressure and never causes quality reduction', () => {
  const sampler = new RuntimeQualitySampler(1, 0);
  const caps = { removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false };
  let state = createQualityState(1);
  for (let now = 0; now <= 8000; now += 25) {
    const window = sampler.takeWindow(now, config);
    if (window) {
      assert.equal(window.pressure, 'compute');
      state = advanceQuality(state, { kind: 'window', window }, config, caps).state;
      assert.equal(state.stage, 0); assert.equal(state.badWindows, 0);
    }
    sampler.record({ generation: 1, nowMs: now, rafIntervalMs: 25, rendererSubmitMs: 6,
      appWorkMs: 20, exclusion: null });
  }
});
test('fallback 50ms, sparse dirty and event computation are explicitly excluded instead of bad render windows', () => {
  for (const reason of ['science-fallback', 'science-wait', 'event-compute'] as const) {
    const sampler = new RuntimeQualitySampler(4, 0);
    for (let now = 0; now < 2000; now += 50) sampler.record({ generation: 4, nowMs: now,
      rafIntervalMs: 50, rendererSubmitMs: 3, appWorkMs: 15, exclusion: reason });
    const window = sampler.takeWindow(2000, config)!;
    assert.equal(window.eligibleSamples, 0); assert.equal(window.eligibleActiveMs, 0);
    assert.equal(window.rafP95Ms, null); assert.equal(window.pressure, 'unknown');
    assert.equal(sampler.diagnostics.lastWindowExcluded![reason], 40);
    sampler.reset(5, 2000); assert.equal(sampler.diagnostics.excludedTotal[reason], 40);
    sampler.record({ generation: 4, nowMs: 2010, rafIntervalMs: 10, rendererSubmitMs: 2, appWorkMs: 3, exclusion: null });
    assert.equal(sampler.diagnostics.sampleCount, 0);
  }
});
test('overfull two-second window holds unknown instead of claiming percentiles from a truncated ring', () => {
  const sampler = new RuntimeQualitySampler(1, 0);
  for (let now = 0; now < 2000; now += 2) sampler.record({ generation: 1, nowMs: now,
    rafIntervalMs: 2, rendererSubmitMs: 1, appWorkMs: 2, exclusion: null });
  const window = sampler.takeWindow(2000, config)!;
  assert.equal(sampler.diagnostics.sampleCount, 600); assert.equal(window.eligibleSamples, 1000);
  assert.equal(window.rafP95Ms, null); assert.equal(window.rendererSubmitP95Ms, null); assert.equal(window.pressure, 'unknown');
});
test('renderer CPU bad is attributable render pressure, without subtracting different-frame percentiles', () => {
  const sampler = new RuntimeQualitySampler(1, 0);
  for (let now = 0; now < 2000; now += 20) sampler.record({ generation: 1, nowMs: now,
    rafIntervalMs: 20, rendererSubmitMs: 8, appWorkMs: 10, exclusion: null });
  assert.equal(sampler.takeWindow(2000, config)!.pressure, 'render');
});
