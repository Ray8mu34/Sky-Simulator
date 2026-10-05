import { createDayEventService } from '../core/teaching';
import type { DayEventComponentResponse, DayEventRequest } from './day-event-protocol';

const days = createDayEventService({ maxEntries: 16 });
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<DayEventRequest>) => {
  const request = event.data;
  if (request.kind !== 'day-events') return;
  const { requestId, batchKey, state, componentKeys, needs } = request;
  const started = performance.now();
  const send = (value: DayEventComponentResponse) => scope.postMessage(value);
  // Current synchronous work is bounded; main rejects obsolete component keys.
  try {
    if (needs.solar && componentKeys.solar !== null) {
      const key = componentKeys.solar;
      try {
        if (JSON.stringify([componentKeys.solar, componentKeys.selected]) !== batchKey || days.keyForSolar(state) !== key) throw new Error('太阳日事件输入标识不一致');
        send({ kind: 'day-events', requestId, batchKey, component: 'solar', key, status: 'ready', result: days.computeSolar(state) });
      } catch (error) { send({ kind: 'day-events', requestId, batchKey, component: 'solar', key, status: 'error', error: error instanceof Error ? error.message : String(error) }); }
    }
    if (needs.selected && componentKeys.selected !== null) {
      const key = componentKeys.selected;
      try {
        if (JSON.stringify([componentKeys.solar, componentKeys.selected]) !== batchKey || days.keyForObject(state, needs.selected) !== key) throw new Error('对象日事件输入标识不一致');
        send({ kind: 'day-events', requestId, batchKey, component: 'selected', key, status: 'ready', result: days.computeObject(state, needs.selected) });
      } catch (error) { send({ kind: 'day-events', requestId, batchKey, component: 'selected', key, status: 'error', error: error instanceof Error ? error.message : String(error) }); }
    }
  } finally {
    scope.postMessage({ kind: 'day-events-done', requestId, batchKey, durationMs: performance.now() - started, cache: days.diagnostics() });
  }
};
