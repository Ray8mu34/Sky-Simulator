import type { SimulationState, SolarDayEvents } from '../contracts';
import type { CacheDiagnostics } from '../core/day-event-service';
import type { ObjectDayEvents, ObjectDayTarget } from '../core/object-day-events';

export type DayEventComponent = 'solar' | 'selected';
export interface DayEventNeeds { readonly solar: boolean; readonly selected: ObjectDayTarget | null }
export interface DayEventComponentKeys { readonly solar: string | null; readonly selected: string | null }
export interface DayEventRequest {
  readonly kind: 'day-events'; readonly requestId: number; readonly batchKey: string;
  readonly state: SimulationState; readonly needs: DayEventNeeds; readonly componentKeys: DayEventComponentKeys;
}
export type DayEventComponentResponse =
  | { kind: 'day-events'; requestId: number; batchKey: string; component: 'solar'; key: string; status: 'ready'; result: SolarDayEvents }
  | { kind: 'day-events'; requestId: number; batchKey: string; component: 'selected'; key: string; status: 'ready'; result: ObjectDayEvents }
  | { kind: 'day-events'; requestId: number; batchKey: string; component: DayEventComponent; key: string; status: 'error'; error: string };
export interface DayEventDone {
  readonly kind: 'day-events-done'; readonly requestId: number; readonly batchKey: string;
  readonly durationMs: number; readonly cache: CacheDiagnostics;
}
export type DayEventResponse = DayEventComponentResponse | DayEventDone;

/** The platform consumes one core service; this port adds no astronomy or result model. */
export interface DayEventComputationPort {
  keyForSolar(state: SimulationState): string;
  keyForObject(state: SimulationState, target: ObjectDayTarget): string;
  computeSolarCooperatively(state: SimulationState, yieldFn: () => Promise<void>): Promise<SolarDayEvents>;
  computeObjectCooperatively(state: SimulationState, target: ObjectDayTarget, yieldFn: () => Promise<void>): Promise<ObjectDayEvents>;
  diagnostics(): CacheDiagnostics;
  clear(): void;
}
