import type { MoonAppearance, MoonPhaseSequence, SimulationState, SolarDayEvents } from '../contracts';
import type { LunarCalendarInfo } from '../data/lunar';
import type { ObjectDayEvents } from './object-day-events';
import { createDayEventService } from './day-event-service';

export interface TeachingData {
  solarDay?: SolarDayEvents;
  solarDayKey?: string;
  solarDayStatus?: 'pending' | 'ready' | 'error';
  solarDayError?: string;
  objectDay?: ObjectDayEvents;
  objectDayKey?: string;
  objectDayStatus?: 'pending' | 'ready' | 'error' | 'unsupported';
  objectDayError?: string;
  objectDayUnsupportedReason?: string;
  moon?: MoonAppearance;
  lunarCalendar?: LunarCalendarInfo;
  moonPhases?: MoonPhaseSequence;
  moonPhaseStatus?: 'pending' | 'ready' | 'error';
  moonPhaseError?: string;
}

/** Compatibility facade; applications instantiate only the unified mixed service. */
export function createSolarDayService(options: { maxEntries?: number } = {}) {
  const service = createDayEventService(options);
  return { keyFor: service.keyForSolar, compute: service.computeSolar, computeCooperatively: service.computeSolarCooperatively,
    clear: service.clear, diagnostics: service.diagnostics };
}

export { computeSolarDayEvents, computeSolarDayEventsCooperatively } from './solar-events';
export { computeMoonAppearance, computeMoonQuarterSequence, resolveLunarAppearance } from './moon';
export { createDayEventService } from './day-event-service';
export type { CacheDiagnostics, DayEventService } from './day-event-service';
export { solarDayKey } from './day-event-key';
