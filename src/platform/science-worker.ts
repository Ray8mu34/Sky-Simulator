import { computeSnapshot } from '../core/astronomy';
import type { SimulationState } from '../contracts';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
workerScope.onmessage = (event: MessageEvent<{ state: SimulationState; requestId: number }>) => {
  try {
    const snapshot = computeSnapshot(event.data.state, event.data.requestId);
    workerScope.postMessage({ snapshot });
  } catch (error) {
    workerScope.postMessage({ requestId: event.data.requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
