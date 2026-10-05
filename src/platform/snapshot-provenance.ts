import type { SimulationState } from '../contracts';

/** Identifies the physical observer/environment inputs represented by a snapshot. */
export function scienceInputSignature(state: SimulationState): string {
  return JSON.stringify([
    state.observer.latitudeDeg, state.observer.longitudeDegEast, state.observer.heightMeters,
    state.environment.refraction, state.environment.pressureHpa, state.environment.temperatureC,
  ]);
}
