import type { SimulationState } from '../contracts';
import { mod } from './math';
import { validateObserver } from './observer';
import { localDayBounds } from './time';
import { SOLAR_EVENT_DEFINITION_VERSION } from './solar-events';

/** Retained solar key convention; physical model version invalidates the mixed cache. */
export function dayContextKeyParts(state: SimulationState): readonly unknown[] {
  validateObserver(state.observer);
  const bounds = localDayBounds(state.time.utDaysJ2000, state.observer.displayZone);
  const zone = state.observer.displayZone.kind === 'fixed' ? ['fixed', state.observer.displayZone.offsetMinutes]
    : ['iana', state.observer.displayZone.name, state.observer.displayZone.versionNote];
  return [bounds.startUt, bounds.endUt, state.observer.latitudeDeg, mod(state.observer.longitudeDegEast + 180, 360) - 180, state.observer.heightMeters, zone];
}

export function solarDayKey(state: SimulationState): string {
  return JSON.stringify(['AE2.1.19', SOLAR_EVENT_DEFINITION_VERSION, ...dayContextKeyParts(state)]);
}
