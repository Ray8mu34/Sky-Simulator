import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createDefaultState } from '../src/state';
import { SimulationClock } from '../src/platform/clock';
import { scienceInputSignature } from '../src/platform/snapshot-provenance';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('}, message => {', source.indexOf('science = new SnapshotService(')) + 3;
const end = source.indexOf('}, new URLSearchParams', start) + 1;
const pairedStart = source.indexOf('function snapshotMatchesState(): boolean {');
const pairedEnd = source.indexOf('function processInteractionIntents(', pairedStart);
assert.ok(start > 3 && end > start && pairedStart > 0 && pairedEnd > pairedStart);
const actualJs = transformSync(`const fail = ${source.slice(start, end)};\n${source.slice(pairedStart, pairedEnd)}`, { loader: 'ts', target: 'es2022' }).code;

for (const scenario of ['paired', 'observer-pending', 'refraction-pending', 'first-snapshot-failed'] as const) {
  test(`actual main failure callback publishes stopped ${scenario} UI without borrowing unpaired science`, () => {
    const state = createDefaultState(); state.time.running = true; state.time.rateSimSecondsPerRealSecond = 600;
    const oldState = structuredClone(state), snapshot = scenario === 'first-snapshot-failed' ? null : { utDaysJ2000: state.time.utDaysJ2000 };
    if (scenario === 'observer-pending') state.observer.latitudeDeg = 42;
    if (scenario === 'refraction-pending') { state.environment.refraction = 'standard'; state.environment.pressureHpa = 730; }
    const before = structuredClone(state), clock = new SimulationClock(); clock.rebase(state.time.utDaysJ2000, 600, true, 1000);
    let fullUi = 0, playbackUi = 0, statusUi = 0, requested = 0;
    const bindings = { state, snapshot, clock, scienceDirty: scenario !== 'paired', snapshotInputSignature: scienceInputSignature(oldState),
      lastError: '', lastUiMs: 10, performance: { now: () => 1100 }, scienceInputSignature,
      updateControls: () => { fullUi++; }, controls: { syncPlayback: () => { playbackUi++; } }, updateStatus: () => { statusUi++; },
      science: { request: () => { requested++; } },
      cancelViewTransition: () => {}, resetRuntimeQuality: () => {},
    };
    const factory = new Function(...Object.keys(bindings), `${actualJs}\nreturn {fail,read:()=>({lastError,lastUiMs,scienceDirty})};`);
    const actual = factory(...Object.values(bindings)); actual.fail('injected transport/core exception');
    assert.deepEqual(state, { ...before, time: { ...before.time, running: false } });
    assert.equal(clock.rebaseCount, 2); assert.equal(clock.sample(9999), state.time.utDaysJ2000);
    assert.equal(fullUi, scenario === 'paired' ? 1 : 0); assert.equal(playbackUi, scenario === 'paired' ? 0 : 1);
    assert.equal(statusUi, 1); assert.equal(requested, 0); assert.equal(actual.read().lastUiMs, 1100);
    assert.equal(actual.read().scienceDirty, scenario !== 'paired'); assert.match(actual.read().lastError, /天文计算失败/);
  });
}
