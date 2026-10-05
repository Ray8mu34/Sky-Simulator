import type { SimulationState } from '../contracts';
import type { SimulationClock } from './clock';

/** Read the existing clock and request a new physical-input snapshot; this API cannot rebase it. */
export function requestEnvironmentSnapshot(state: SimulationState, clock: Pick<SimulationClock, 'sample'>,
  science: { request(state: SimulationState): void }, nowMs: number): number {
  if (state.time.running) state.time.utDaysJ2000 = clock.sample(nowMs);
  science.request(state);
  return state.time.utDaysJ2000;
}
