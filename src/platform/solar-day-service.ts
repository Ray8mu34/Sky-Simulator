import workerSource from 'virtual:sky-day-worker';
import { createDayEventService, solarDayKey } from '../core/teaching';
import { objectDayKey } from '../core/object-day-events';
import { DayEventScheduler } from './day-event-service';
import type { DayEventComponentResponse } from './day-event-protocol';

/** Browser adapter for the existing second worker. The scheduler itself is CPU-testable. */
export class DayEventService extends DayEventScheduler {
  constructor(accept: (response: DayEventComponentResponse) => void, forceFallback = false) {
    super(accept, {
      forceFallback, keyForSolar: solarDayKey, keyForObject: objectDayKey,
      createScience: () => createDayEventService({ maxEntries: 16 }),
      createWorker() {
        const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
        try { return { worker: new Worker(url), release: () => URL.revokeObjectURL(url) }; }
        catch (error) { URL.revokeObjectURL(url); throw error; }
      },
    });
  }
}
