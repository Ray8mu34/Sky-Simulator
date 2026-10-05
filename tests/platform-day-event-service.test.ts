import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDefaultState } from '../src/state';
import type { SimulationState, SolarDayEvents } from '../src/contracts';
import type { ObjectDayEvents, ObjectDayTarget } from '../src/core/object-day-events';
import { DayEventScheduler } from '../src/platform/day-event-service';
import type { DayEventComponentResponse, DayEventComputationPort, DayEventRequest, DayEventResponse } from '../src/platform/day-event-protocol';

// Transport/scheduling oracle only. Astronomy and scientific cache accuracy have separate core tests.
const solar = { dateLocal: 'stub-solar' } as SolarDayEvents;
const object = { dateLocal: 'stub-object' } as ObjectDayEvents;
const cache = { cacheEntries: 1, maxEntries: 16, computations: 1, cacheHits: 0, cacheEvictions: 0 };
const sun: ObjectDayTarget = { kind: 'body', id: 'body:Sun' }, moon: ObjectDayTarget = { kind: 'body', id: 'body:Moon' };
const solarKey = (state: SimulationState) => `solar:${Math.floor(state.time.utDaysJ2000)}`;
const objectKey = (state: SimulationState, target: ObjectDayTarget) => `object:${target.id}:${Math.floor(state.time.utDaysJ2000)}`;
class FakeWorker {
  onmessage: Worker['onmessage'] = null; onerror: Worker['onerror'] = null;
  requests: DayEventRequest[] = []; terminated = 0;
  postMessage(message: DayEventRequest) { this.requests.push(message); }
  terminate() { this.terminated++; }
  emit(message: DayEventResponse) { this.onmessage?.call(this as unknown as Worker, { data: message } as MessageEvent<DayEventResponse>); }
}
function respond(worker: FakeWorker, request: DayEventRequest, component: 'solar' | 'selected', status: 'ready' | 'error' = 'ready') {
  const common = { kind: 'day-events' as const, requestId: request.requestId, batchKey: request.batchKey, component, key: request.componentKeys[component]! };
  worker.emit(status === 'error' ? { ...common, status, error: 'controlled error' }
    : component === 'solar' ? { ...common, component: 'solar', status, result: solar } : { ...common, component: 'selected', status, result: object });
}
const done = (worker: FakeWorker, request: DayEventRequest) => worker.emit({ kind: 'day-events-done', requestId: request.requestId, batchKey: request.batchKey, durationMs: 1, cache });
async function until(probe: () => boolean) { const end = Date.now() + 1500; while (!probe() && Date.now() < end) await delay(1); assert.ok(probe(), 'Scheduler did not converge'); }
function fixture(forceFallback = false, suppliedCore?: DayEventComputationPort, onAccept?: (response: DayEventComponentResponse) => void) {
  const worker = new FakeWorker(), accepted: DayEventComponentResponse[] = []; let releases = 0;
  const core: DayEventComputationPort = suppliedCore ?? { keyForSolar: solarKey, keyForObject: objectKey,
    computeSolarCooperatively: async (_state, yieldFn) => { await yieldFn(); return solar; },
    computeObjectCooperatively: async (_state, _target, yieldFn) => { await yieldFn(); return object; }, clear() {}, diagnostics: () => cache };
  const service = new DayEventScheduler(response => { accepted.push(response); onAccept?.(response); }, { forceFallback, keyForSolar: solarKey, keyForObject: objectKey,
    createWorker: () => ({ worker, release: () => { releases++; } }), createScience: () => core });
  return { worker, accepted, service, releases: () => releases };
}
test('reentrant solar replay changing demand prevents delivery of the old selected component', async t => {
  const a=createDefaultState(),b=structuredClone(a);b.time.utDaysJ2000+=1;let armed=false;
  const f=fixture(false,undefined,response=>{if(armed&&response.component==='solar'){armed=false;f.service.request(b,{solar:true,selected:sun},true);}});
  t.after(()=>f.service.dispose());f.service.request(a,{solar:true,selected:moon},true);await until(()=>f.worker.requests.length===1);
  respond(f.worker,f.worker.requests[0],'solar');respond(f.worker,f.worker.requests[0],'selected');done(f.worker,f.worker.requests[0]);
  f.service.request(b,{solar:true,selected:moon},true);await until(()=>f.worker.requests.length===2);armed=true;
  f.service.request(a,{solar:true,selected:moon},true);
  assert.deepEqual(f.accepted.map(response=>response.component),['solar','selected','solar']);
  assert.equal(f.service.diagnostics.componentKeys.selected,objectKey(b,sun));assert.equal(f.service.diagnostics.pendingLatestRequestCount,1);
});
test('latest union stays bounded and a matching solar result survives repeated selected-key changes', async t => {
  const f = fixture(); t.after(() => f.service.dispose()); const state = createDefaultState();
  f.service.request(state, { solar: true, selected: moon }, true); await until(() => f.worker.requests.length === 1);
  const first = f.worker.requests[0];
  for (let i = 0; i < 100; i++) f.service.request(state, { solar: true, selected: i % 2 ? sun : moon }, true);
  assert.equal(f.service.diagnostics.activeRequestCount, 1); assert.equal(f.service.diagnostics.pendingLatestRequestCount, 1);
  respond(f.worker, first, 'solar'); respond(f.worker, first, 'selected');
  assert.deepEqual(f.accepted.map(value => value.component), ['solar']); assert.equal(f.service.diagnostics.staleResultCount, 1);
  done(f.worker, first); await until(() => f.worker.requests.length === 2);
  const latest = f.worker.requests[1]; assert.equal(latest.needs.solar, true); assert.equal(latest.needs.selected?.id, 'body:Sun');
  respond(f.worker, latest, 'selected'); done(f.worker, latest);
  assert.equal(f.accepted.at(-1)?.component, 'selected'); assert.equal(f.service.diagnostics.activeRequestCount, 0);
});
for (const component of ['solar', 'selected'] as const) for (const status of ['ready', 'error'] as const) {
  test(`${component} ${status}: A→B→A before B completes replays A once without another calculation`, async t => {
    const f = fixture(); t.after(() => f.service.dispose()); const a = createDefaultState(), b = structuredClone(a); b.time.utDaysJ2000 += 1;
    const needs = component === 'solar' ? { solar: true, selected: null } : { solar: false, selected: moon };
    f.service.request(a, needs, true); await until(() => f.worker.requests.length === 1);
    respond(f.worker, f.worker.requests[0], component, status); done(f.worker, f.worker.requests[0]);
    f.service.request(b, needs, true); await until(() => f.worker.requests.length === 2);
    f.service.request(a, needs, true);
    assert.equal(f.accepted.length, 2); assert.equal(f.accepted[1].key, f.accepted[0].key); assert.equal(f.accepted[1].status, status);
    for (let i = 0; i < 20; i++) f.service.request(a, needs, true);
    assert.equal(f.accepted.length, 2); assert.equal(f.worker.requests.length, 2); assert.equal(f.service.diagnostics.pendingLatestRequestCount, 0);
    respond(f.worker, f.worker.requests[1], component, status); done(f.worker, f.worker.requests[1]); assert.equal(f.accepted.length, 2);
  });
}
test('closing one component rejects only that response; old done cannot release a newer active batch', async t => {
  const f = fixture(); t.after(() => f.service.dispose()); const state = createDefaultState();
  f.service.request(state, { solar: true, selected: moon }, true); await until(() => f.worker.requests.length === 1); const first = f.worker.requests[0];
  f.service.request(state, { solar: false, selected: moon }, true); respond(f.worker, first, 'solar'); respond(f.worker, first, 'selected'); done(f.worker, first);
  assert.deepEqual(f.accepted.map(value => value.component), ['selected']);
  f.service.request(state, { solar: false, selected: sun }, true); await until(() => f.worker.requests.length === 2);
  done(f.worker, first); assert.equal(f.service.diagnostics.activeRequestCount, 1);
  f.service.clearDemand(); respond(f.worker, f.worker.requests[1], 'selected'); done(f.worker, f.worker.requests[1]); assert.equal(f.accepted.length, 1);
});
test('pausing upgrades the same queued batch to immediate rather than retaining the playing delay', async t => {
  const f = fixture(); t.after(() => f.service.dispose()); const a = createDefaultState(), b = structuredClone(a); b.time.utDaysJ2000 += 1;
  f.service.request(a, { solar: true, selected: null }, false); await until(() => f.worker.requests.length === 1);
  respond(f.worker, f.worker.requests[0], 'solar'); done(f.worker, f.worker.requests[0]);
  f.service.request(b, { solar: true, selected: null }, false); await delay(20); assert.equal(f.worker.requests.length, 1);
  f.service.request(b, { solar: true, selected: null }, true); await until(() => f.worker.requests.length === 2);
});
test('cooperative selected cancellation leaves the still-needed solar component valid and latest selection converges', async t => {
  let objectStarted = false, release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const core: DayEventComputationPort = { keyForSolar: solarKey, keyForObject: objectKey,
    computeSolarCooperatively: async (_state, yieldFn) => { await yieldFn(); return solar; },
    computeObjectCooperatively: async (_state, target, yieldFn) => { if (target.id === 'body:Moon') { objectStarted = true; await gate; } await yieldFn(); return object; },
    clear() {}, diagnostics: () => cache };
  const f = fixture(true, core); t.after(() => { release(); f.service.dispose(); }); const state = createDefaultState();
  f.service.request(state, { solar: true, selected: moon }, true); await until(() => objectStarted);
  assert.equal(f.accepted[0].component, 'solar');
  f.service.request(state, { solar: true, selected: sun }, true); release();
  await until(() => f.accepted.some(value => value.component === 'selected' && value.key === objectKey(state, sun)));
  assert.ok(!f.accepted.some(value => value.component === 'selected' && value.key === objectKey(state, moon)));
  assert.equal(f.service.diagnostics.components.selected.cancelled, 1); assert.equal(f.service.diagnostics.workerCount, 0);
});
test('disposal releases the one worker and rejects late messages without launching pending work', async () => {
  const f = fixture(), state = createDefaultState(); f.service.request(state, { solar: true, selected: null }, true); await until(() => f.worker.requests.length === 1);
  f.service.dispose(); respond(f.worker, f.worker.requests[0], 'solar'); done(f.worker, f.worker.requests[0]); await delay(5);
  assert.equal(f.worker.terminated, 1); assert.equal(f.releases(), 1); assert.equal(f.accepted.length, 0); assert.equal(f.service.diagnostics.workerCount, 0);
});
test('completed cooperative work changes the observable revision even when no computation remains active at the next RAF', async t => {
  const f = fixture(true); t.after(() => f.service.dispose());
  const initial = f.service.mainThreadComputationRevision;
  f.service.request(createDefaultState(), { solar: true, selected: null }, true);
  await until(() => f.accepted.length === 1 && !f.service.mainThreadComputationActive);
  assert.equal(f.service.mainThreadComputationRevision, initial + 2);
  assert.equal(f.service.diagnostics.workerCount, 0);
});
