import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createDefaultState } from '../src/state';
import { SimulationClock } from '../src/platform/clock';
import { uiCadenceDue, snapshotNeedsImmediateUi } from '../src/platform/ui-cadence';
import { scienceInputSignature } from '../src/platform/snapshot-provenance';
import { dateToUt, utToDate } from '../src/core/time';

// Execute the real main frame body; mock only transport/DOM/render endpoints.
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const frameStart = mainSource.indexOf('function frame(nowMs: number): void {');
const frameEnd = mainSource.indexOf('function onChange(', frameStart);
assert.ok(frameStart >= 0 && frameEnd > frameStart);
const frameJs = transformSync(mainSource.slice(frameStart, frameEnd), { loader: 'ts', target: 'es2022' }).code;

for (const [date, rate] of [['4000-12-31T23:59:59Z', 86400], ['-002000-01-01T00:00:01Z', -86400]] as const) {
  test(`actual main stops at ${date} with immediate paused controls, preserved state and no next RAF`, () => {
    const state = createDefaultState(); state.time.utDaysJ2000 = dateToUt(new Date(date)); state.time.running = true;
    state.time.rateSimSecondsPerRealSecond = rate; state.selected = 'body:Moon';
    const before = structuredClone(state), clock = new SimulationClock();
    clock.rebase(state.time.utDaysJ2000, rate, true, 0);
    const snapshot = { utDaysJ2000: state.time.utDaysJ2000, requestId: 1 };
    const updates: typeof state[] = [], draws: Array<{ ut: number; state: typeof state }> = [];
    let requested = 0, scheduled = 0;
    const bindings = {
      state, clock, snapshot, pendingSnapshot: null, ready: true, scienceDirty: false,
      disposed: false, hidden: false, raf: 0, frameCount: 0, renderCount: 0, dirty: true,
      previousFrameMs: 100, previousRenderMs: null, lastUiMs: 100, lastScienceMs: 0,
      lastPublishedUt: state.time.utDaysJ2000, snapshotInputSignature: scienceInputSignature(state),
      lastRenderedUt: null, lastRenderedMode: null, lastRenderedEffectiveView: null,
      lastRenderedSelection: null, lastRenderedReferenceLock: null, lastError: '',
      frameIntervals: [], renderedIntervals: [],
      renderer: { status: { available: true }, kind: 'webgl2', render(value: typeof state, valueSnapshot: typeof snapshot) {
        draws.push({ ut: valueSnapshot.utDaysJ2000, state: structuredClone(value) });
      } },
      science: { activeRequestCount: 0, pendingLatestRequestCount: 0, request() { requested++; } },
      syncGraphicsStatus: () => false, snapshotMatchesState: () => true, processInteractionIntents: () => {},
      updateControls: () => { updates.push(structuredClone(state)); }, updateStatus: () => {},
      syncMoonLoupe: () => false, skyAppearanceData: () => null, invalidate: () => {},
      requestAnimationFrame: () => { scheduled++; return scheduled; },
      qualityGeneration: 0, viewTransition: null, transitionFailure: null,
      cancelViewTransition: () => {}, resetRuntimeQuality: () => {}, finishFrameQuality: () => {},
      evaluateRuntimeQualityWindow: () => {},
      snapshotNeedsImmediateUi, uiCadenceDue, scienceInputSignature, utToDate,
    };
    const factory = new Function(...Object.keys(bindings), `${frameJs}\nreturn {frame,read:()=>({lastUiMs,lastError,renderCount})};`);
    const actual = factory(...Object.values(bindings)); actual.frame(110);
    assert.equal(state.time.running, false); assert.equal(state.time.utDaysJ2000, before.time.utDaysJ2000);
    assert.deepEqual(state, { ...before, time: { ...before.time, running: false } });
    assert.deepEqual(updates, [state]); assert.equal(actual.read().lastUiMs, 110);
    assert.equal(requested, 0); assert.equal(scheduled, 0); assert.equal(clock.rebaseCount, 2);
    assert.equal(draws.length, 1); assert.equal(draws[0]!.ut, state.time.utDaysJ2000); assert.deepEqual(draws[0]!.state, state);
    assert.match(actual.read().lastError, /范围边界.*暂停/);
  });
}
