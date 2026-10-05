import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createDefaultState } from '../src/state';
import { scienceInputSignature } from '../src/platform/snapshot-provenance';
import { snapshotNeedsImmediateUi, uiCadenceDue } from '../src/platform/ui-cadence';
import { createViewTransition } from '../src/ui/view-transition';
import { RuntimeQualitySampler } from '../src/platform/runtime-quality-sampling';
import { createQualityState, advanceQuality } from '../src/platform/runtime-quality';
import { QUALITY_CONFIGS, renderBudgetClass } from '../src/platform/runtime-quality-contract';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const extract = (start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return transformSync(source.slice(a, b), { loader: 'ts', target: 'es2022' }).code;
};
test('actual main view intent keeps old picture while waiting, animates only after real paired draw, and never requests/rebases science', async () => {
  const state = createDefaultState(), before = structuredClone(state);
  const events: string[] = [];
  let guard = true, requested = 0, rebased = 0, scheduled = 0;
  let finishAnimation!: () => void;
  const transition = createViewTransition({
    prepare() { guard = false; events.push('prepare'); },
    animate() { events.push('animate'); return { finished: new Promise<void>(resolve => { finishAnimation = resolve; }), cancel() {} }; },
    settle() { guard = true; events.push('settle'); },
  });
  const snapshot = { utDaysJ2000: state.time.utDaysJ2000, requestId: 1 };
  const frameJs = extract('function frame(nowMs: number): void {', 'function onChange(');
  const changeJs = extract('function onChange(reason', 'function resetInteractionIntents(');
  const bindings = {
    state, snapshot, viewTransition: transition, transitionGeneration: 0, transitionFailure: null,
    qualityGeneration: 0, lastRenderedMode: 'ground', lastRenderedUt: null, lastRenderedEffectiveView: null,
    lastRenderedSelection: null, lastRenderedReferenceLock: null, lastPublishedUt: state.time.utDaysJ2000,
    disposed: false, hidden: false, ready: true, dirty: true, scienceDirty: true, pendingSnapshot: null,
    snapshotInputSignature: scienceInputSignature(state), raf: 0, frameCount: 0, renderCount: 0,
    previousFrameMs: null, previousRenderMs: null, frameIntervals: [], renderedIntervals: [],
    lastUiMs: 0, lastScienceMs: 0, lastError: '', actionStatus: '', pendingFocus: null, pendingLocks: new Map(),
    appliedReferenceLocks: {},
    renderer: { kind: 'webgl2', status: { available: true }, resetPointerGestures() {}, render() { events.push('draw'); } },
    science: { activeRequestCount: 0, pendingLatestRequestCount: 0, request() { requested++; } },
    clock: { rebase() { rebased++; }, sample() { return state.time.utDaysJ2000; } },
    resetRuntimeQuality() {}, finishFrameQuality() {}, processInteractionIntents() {}, syncGraphicsStatus: () => false,
    evaluateRuntimeQualityWindow() { events.push('quality-before-draw'); },
    updateControls() {}, updateStatus() {}, invalidate() {}, syncMoonLoupe: () => false, skyAppearanceData: () => null,
    snapshotMatchesState: () => !state.time.running, cancelViewTransition: transition.cancel,
    requestAnimationFrame() { scheduled++; return scheduled; }, snapshotNeedsImmediateUi, uiCadenceDue, scienceInputSignature,
  };
  const actual = new Function(...Object.keys(bindings), `${frameJs}\n${changeJs}
    return {frame,onChange, paired(){pendingSnapshot={snapshot,inputSignature:scienceInputSignature(state)};}};`)(...Object.values(bindings));
  state.viewMode = 'space'; actual.onChange('view'); actual.frame(10);
  assert.equal(guard, false); assert.equal(transition.diagnostics.phase, 'waiting-render');
  assert.deepEqual(events, ['prepare', 'quality-before-draw']); // no opacity/animation while old science is pending
  state.viewMode = 'ground'; actual.onChange('view');
  assert.equal(guard, true); assert.equal(transition.diagnostics.phase, 'idle');
  state.viewMode = 'space'; actual.onChange('view'); actual.paired(); actual.frame(20);
  assert.equal(transition.diagnostics.phase, 'animating');
  assert.ok(events.lastIndexOf('draw') < events.lastIndexOf('animate'));
  assert.ok(events.lastIndexOf('quality-before-draw') < events.lastIndexOf('draw'));
  assert.equal(requested, 0); assert.equal(rebased, 0); assert.equal(scheduled, 0);
  assert.deepEqual(state, { ...before, viewMode: 'space' });
  finishAnimation(); await Promise.resolve(); await Promise.resolve();
  assert.equal(guard, true); assert.equal(transition.diagnostics.phase, 'idle');
});
test('actual main detects an entire fallback event computation between RAFs by revision and breaks adjacency', () => {
  const state = createDefaultState(); state.time.running = true;
  const sampler = new RuntimeQualitySampler(1, 0);
  const actualJs = extract('function finishFrameQuality(', 'function invalidate(');
  const bindings = { state, snapshot: { utDaysJ2000: state.time.utDaysJ2000 }, hidden: false,
    scienceDirty: false, science: { mode: 'worker' }, eventDays: { mainThreadComputationActive: false, mainThreadComputationRevision: 2 },
    renderer: { status: { available: true } }, viewTransition: { diagnostics: { phase: 'idle' } },
    qualitySampler: sampler, qualityConfig: QUALITY_CONFIGS.desktop, qualityState: createQualityState(1),
    qualityCapabilities: { removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false },
    qualityGeneration: 1, qualityPreviousDrawMs: 0, qualityEventComputeRevision: 0,
    qualityLastReason: '', qualitySamplingWorkMs: 0, advanceQuality, applyRuntimeQuality() {},
    performance: { now: () => 100 },
  };
  const actual = new Function(...Object.keys(bindings), `${actualJs}
    return {finishFrameQuality,read:()=>({qualityPreviousDrawMs,qualityEventComputeRevision})};`)(...Object.values(bindings));
  actual.finishFrameQuality(0, 25, true, true, 3, 1);
  assert.equal(sampler.diagnostics.excludedTotal['event-compute'], 1);
  assert.equal(actual.read().qualityPreviousDrawMs, null); assert.equal(actual.read().qualityEventComputeRevision, 2);
  actual.finishFrameQuality(25, 50, true, true, 3, 1);
  assert.equal(sampler.diagnostics.excludedTotal['not-adjacent'], 1);
  actual.finishFrameQuality(50, 75, true, true, 3, 1);
  assert.equal(sampler.diagnostics.pendingEligibleSamples, 1);
});
test('one shared engineering budget class covers narrow viewport and coarse short landscape without device claims', () => {
  assert.equal(renderBudgetClass(719, 900, false), 'mobile');
  assert.equal(renderBudgetClass(720, 900, false), 'desktop');
  assert.equal(renderBudgetClass(844, 390, true), 'mobile');
  assert.equal(renderBudgetClass(844, 600, true), 'mobile');
  assert.equal(renderBudgetClass(844, 601, true), 'desktop');
  assert.equal(renderBudgetClass(844, 390, false), 'desktop');
});
test('actual completed-window helper applies pixel backing change before the actual main draw and final sample', () => {
  const state = createDefaultState(), snapshot = { utDaysJ2000: state.time.utDaysJ2000, requestId: 1 };
  const events: string[] = []; let canvasCleared = false, pixelScale = 1;
  const frameJs = extract('function frame(nowMs: number): void {', 'function onChange(');
  const evaluationJs = extract('function evaluateRuntimeQualityWindow(', 'function finishFrameQuality(');
  const bindings = { state, snapshot, pendingSnapshot: null, ready: true, scienceDirty: false,
    disposed: false, hidden: false, raf: 0, frameCount: 0, renderCount: 0, dirty: false,
    previousFrameMs: null, previousRenderMs: null, lastUiMs: 6000, lastScienceMs: 0,
    lastPublishedUt: state.time.utDaysJ2000, snapshotInputSignature: scienceInputSignature(state),
    lastRenderedUt: null, lastRenderedMode: null, lastRenderedEffectiveView: null,
    lastRenderedSelection: null, lastRenderedReferenceLock: null, frameIntervals: [], renderedIntervals: [],
    qualityGeneration: 1, qualityLastReason: '', qualityConfig: QUALITY_CONFIGS.desktop,
    qualityState: { ...createQualityState(1), stage: 1, badWindows: 2, lastWindowEndMs: 4000 },
    qualityCapabilities: { removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false },
    qualitySampler: { takeWindow: () => ({ generation: 1, startMs: 4000, endMs: 6000, eligibleActiveMs: 1900,
      eligibleSamples: 100, rafP95Ms: 20, rendererSubmitP95Ms: 8, appWorkP95Ms: 9, pressure: 'render' }) },
    renderer: { status: { available: true }, kind: 'webgl2', setRuntimeQuality(value: { pixelScale: number }) {
      events.push('backing-resize'); pixelScale = value.pixelScale; canvasCleared = true;
    }, render() { events.push('paired-draw'); canvasCleared = false; } },
    viewTransition: null, advanceQuality, syncGraphicsStatus: () => false, snapshotMatchesState: () => true,
    processInteractionIntents() {}, updateControls() {}, syncMoonLoupe: () => false, skyAppearanceData: () => null,
    finishFrameQuality() { events.push('sample-finalize'); }, snapshotNeedsImmediateUi, uiCadenceDue,
    requestAnimationFrame: () => { throw new Error('No extra RAF in this endpoint sequencing fixture'); },
  };
  const actual = new Function(...Object.keys(bindings), `${evaluationJs}\n${frameJs}
    function applyRuntimeQuality(value){renderer.setRuntimeQuality(value);dirty=true;}
    return {frame};`)(...Object.values(bindings));
  actual.frame(6000);
  assert.equal(pixelScale, .85); assert.equal(canvasCleared, false);
  assert.deepEqual(events, ['backing-resize', 'paired-draw', 'sample-finalize']);
});
