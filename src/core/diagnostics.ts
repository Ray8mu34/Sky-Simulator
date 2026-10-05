/** Test diagnostics only. Never imported by the runtime UI, worker or renderer. */
import * as Engine from 'astronomy-engine';
import type { SimulationState } from '../contracts';
import { computeSnapshot } from './astronomy';

/** Run synchronously in an isolated test process; restore the pinned default even on error. */
export function compareFixedDeltaT(state: SimulationState, deltaSeconds: number) {
  const production = computeSnapshot(state, 0);
  try {
    Engine.SetDeltaTFunction(() => deltaSeconds);
    const aligned = computeSnapshot(state, 0);
    return { production, aligned };
  } finally {
    Engine.SetDeltaTFunction(Engine.DeltaT_EspenakMeeus);
  }
}
