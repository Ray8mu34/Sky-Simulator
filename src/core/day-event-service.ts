import type { SimulationState, SolarDayEvents } from '../contracts';
import type { ObjectDayEvents, ObjectDayTarget } from './object-day-events';
import { computeObjectDayEvents, computeObjectDayEventsCooperatively, objectDayFromSolarEvents, objectDayKey } from './object-day-events';
import { computeSolarDayEvents, computeSolarDayEventsCooperatively } from './solar-events';
import { solarDayKey } from './day-event-key';

export interface CacheDiagnostics {
  readonly cacheEntries: number;
  readonly maxEntries: number;
  readonly computations: number;
  readonly cacheHits: number;
  readonly cacheEvictions: number;
}
export interface DayEventService {
  keyForSolar(state: SimulationState): string;
  keyForObject(state: SimulationState, target: ObjectDayTarget): string;
  computeSolar(state: SimulationState): SolarDayEvents;
  computeObject(state: SimulationState, target: ObjectDayTarget): ObjectDayEvents;
  computeSolarCooperatively(state: SimulationState, yieldFn: () => Promise<void>): Promise<SolarDayEvents>;
  computeObjectCooperatively(state: SimulationState, target: ObjectDayTarget, yieldFn: () => Promise<void>): Promise<ObjectDayEvents>;
  clear(): void;
  diagnostics(): CacheDiagnostics;
}
type SolarEntry = { kind: 'solar'; events: SolarDayEvents; selectedSunView?: ObjectDayEvents };
type CacheEntry = SolarEntry | { kind: 'object'; events: ObjectDayEvents };

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}

/** One mixed bounded LRU. The selected Sun view lives in its existing solar entry. */
export function createDayEventService(options: { maxEntries?: number } = {}): DayEventService {
  const maxEntries = options.maxEntries ?? 16;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) throw new RangeError('日事件混合缓存条数须为1至64的整数。');
  const cache = new Map<string, CacheEntry>();
  let computations = 0, cacheHits = 0, cacheEvictions = 0;
  const get = (key: string): CacheEntry | undefined => {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); cacheHits++; }
    return entry;
  };
  const retain = <T extends CacheEntry>(key: string, entry: T): T => {
    computations++; freezeTree(entry.events);
    cache.delete(key); cache.set(key, entry);
    if (cache.size > maxEntries) { cache.delete(cache.keys().next().value!); cacheEvictions++; }
    return entry;
  };
  const solarEntry = (state: SimulationState): SolarEntry => {
    const key = solarDayKey(state), known = get(key);
    if (known) { if (known.kind !== 'solar') throw new Error('缓存key类型矛盾。'); return known; }
    return retain(key, { kind: 'solar', events: computeSolarDayEvents(state) });
  };
  const solarEntryCooperatively = async (state: SimulationState, yieldFn: () => Promise<void>): Promise<SolarEntry> => {
    const key = solarDayKey(state), known = get(key);
    if (known) { if (known.kind !== 'solar') throw new Error('缓存key类型矛盾。'); return known; }
    return retain(key, { kind: 'solar', events: await computeSolarDayEventsCooperatively(state, yieldFn) });
  };
  const sunView = (state: SimulationState, entry: SolarEntry): ObjectDayEvents => entry.selectedSunView ??= freezeTree(objectDayFromSolarEvents(state, entry.events));
  return {
    keyForSolar: solarDayKey,
    keyForObject: objectDayKey,
    computeSolar(state) { return solarEntry(state).events; },
    computeObject(state, target) {
      // Validate even the Sun target instead of accepting a malformed body tag.
      const key = objectDayKey(state, target);
      if (target.kind === 'body' && target.id === 'body:Sun') return sunView(state, solarEntry(state));
      const known = get(key);
      if (known) { if (known.kind !== 'object') throw new Error('缓存key类型矛盾。'); return known.events; }
      return retain(key, { kind: 'object', events: computeObjectDayEvents(state, target) }).events;
    },
    async computeSolarCooperatively(state, yieldFn) { return (await solarEntryCooperatively(state, yieldFn)).events; },
    async computeObjectCooperatively(state, target, yieldFn) {
      const key = objectDayKey(state, target);
      if (target.kind === 'body' && target.id === 'body:Sun') return sunView(state, await solarEntryCooperatively(state, yieldFn));
      const known = get(key);
      if (known) { if (known.kind !== 'object') throw new Error('缓存key类型矛盾。'); return known.events; }
      return retain(key, { kind: 'object', events: await computeObjectDayEventsCooperatively(state, target, yieldFn) }).events;
    },
    clear() { cache.clear(); },
    diagnostics() { return { cacheEntries: cache.size, maxEntries, computations, cacheHits, cacheEvictions }; },
  };
}
