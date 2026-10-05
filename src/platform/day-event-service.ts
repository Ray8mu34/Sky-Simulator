import type { SimulationState } from '../contracts';
import type { CacheDiagnostics } from '../core/day-event-service';
import type { ObjectDayTarget } from '../core/object-day-events';
import type { DayEventComponent, DayEventComponentKeys, DayEventComponentResponse, DayEventComputationPort, DayEventNeeds, DayEventRequest, DayEventResponse } from './day-event-protocol';

type ScheduledRequest = DayEventRequest & { immediate: boolean };
type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
export interface DayEventServiceOptions {
  forceFallback?: boolean;
  createWorker(): { worker: WorkerPort; release(): void };
  createScience(): DayEventComputationPort;
  keyForSolar(state: SimulationState): string;
  keyForObject(state: SimulationState, target: ObjectDayTarget): string;
}
const CANCELLED = Symbol('cancelled-day-component');
const components = ['solar', 'selected'] as const;
const emptyKeys = (): DayEventComponentKeys => ({ solar: null, selected: null });

/** One active batch and one latest union of visible component demands. No astronomy or clock. */
export class DayEventScheduler {
  private worker: WorkerPort | null = null;
  private releaseWorker: (() => void) | null = null;
  private fallback: DayEventComputationPort | null = null;
  private inFlight: ScheduledRequest | null = null;
  private pending: ScheduledRequest | null = null;
  private desired: DayEventComponentKeys = emptyKeys();
  private readonly latest: Partial<Record<DayEventComponent, DayEventComponentResponse>> = {};
  private readonly componentCounts = {
    solar: { accepted: 0, stale: 0, cancelled: 0, replayed: 0 }, selected: { accepted: 0, stale: 0, cancelled: 0, replayed: 0 },
  };
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastStartedMs = -Infinity;
  private lastDurationMs = 0;
  private maxFallbackChunkMs = 0;
  private lastFallbackActiveComputeMs = 0;
  private fallbackComputeRevision = 0;
  private startedCount = 0;
  private staleResultCount = 0;
  private cache: CacheDiagnostics | null = null;
  mode: 'worker' | 'main-thread-cooperative' = 'worker';
  readonly notes: string[] = [];

  constructor(private readonly accept: (response: DayEventComponentResponse) => void, private readonly options: DayEventServiceOptions) {
    try {
      if (options.forceFallback) throw new Error('已要求日事件主线程协作回退');
      const created = options.createWorker(), worker = created.worker;
      this.worker = worker; this.releaseWorker = created.release;
      worker.onmessage = (event: MessageEvent<DayEventResponse>) => {
        if (this.worker !== worker || this.disposed) return;
        this.receive(event.data);
      };
      worker.onerror = event => {
        event.preventDefault();
        if (this.worker === worker) this.useFallback('日事件 Worker 不可用，改为分组件协作计算');
      };
    } catch (error) { this.useFallback(error instanceof Error ? error.message : String(error)); }
  }
  keyForSolar(state: SimulationState): string { return this.options.keyForSolar(state); }
  keyForObject(state: SimulationState, target: ObjectDayTarget): string { return this.options.keyForObject(state, target); }
  private completed(component: DayEventComponent, key: string | null): boolean { return key === null || this.latest[component]?.key === key; }
  private needed(request: DayEventRequest): boolean {
    return components.some(component => request.componentKeys[component] !== null && request.componentKeys[component] === this.desired[component]
      && !this.completed(component, request.componentKeys[component]));
  }
  /** Call once with both panels' current union, never separate consumer requests. */
  request(state: SimulationState, needs: DayEventNeeds, immediate = !state.time.running, suppliedKeys?: DayEventComponentKeys): DayEventComponentKeys {
    const keys = suppliedKeys ?? { solar: needs.solar ? this.keyForSolar(state) : null, selected: needs.selected ? this.keyForObject(state, needs.selected) : null };
    if ((keys.solar !== null) !== needs.solar || (keys.selected !== null) !== (needs.selected !== null)) throw new Error('日事件需求与组件标识不一致');
    if (this.disposed) return keys;
    const previous = this.desired;
    this.desired = { ...keys };
    const batchKey = JSON.stringify([keys.solar, keys.selected]);
    for (const component of components) {
      if (this.desired.solar !== keys.solar || this.desired.selected !== keys.selected) return keys;
      const retained = this.latest[component];
      if (keys[component] !== null && previous[component] !== keys[component] && retained?.key === keys[component]) {
        this.componentCounts[component].replayed++;
        this.accept(retained);
        if (this.desired.solar !== keys.solar || this.desired.selected !== keys.selected) return keys;
      }
    }
    // A visibility callback may have changed the demand during a synchronous replay.
    if (this.desired.solar !== keys.solar || this.desired.selected !== keys.selected) return keys;
    if (components.every(component => this.completed(component, keys[component]))) { this.pending = null; this.clearTimer(); return keys; }
    if (this.inFlight?.batchKey === batchKey) { this.pending = null; this.clearTimer(); return keys; }
    if (this.pending?.batchKey === batchKey) {
      if (immediate && !this.pending.immediate) { this.pending.immediate = true; this.clearTimer(); this.pump(); }
      return keys;
    }
    this.pending = { kind: 'day-events', requestId: ++this.sequence, batchKey, state: structuredClone(state), needs: structuredClone(needs), componentKeys: { ...keys }, immediate };
    if (immediate) this.clearTimer();
    this.pump(); return keys;
  }
  clearDemand(): void {
    this.desired = emptyKeys(); this.pending = null; this.clearTimer();
  }
  private receive(response: DayEventResponse): void {
    const active = this.inFlight;
    if (!active || this.disposed || response.requestId !== active.requestId || response.batchKey !== active.batchKey) return;
    if (response.kind === 'day-events-done') {
      this.clearWatchdog(); this.cache = response.cache; this.lastDurationMs = response.durationMs;
      this.inFlight = null; this.pump(); return;
    }
    if (response.kind !== 'day-events' || !components.includes(response.component) || response.key !== active.componentKeys[response.component]) return;
    this.deliver(response);
  }
  private deliver(response: DayEventComponentResponse): void {
    if (this.disposed || response.key !== this.desired[response.component]) {
      this.componentCounts[response.component].stale++; this.staleResultCount++; return;
    }
    this.latest[response.component] = response;
    this.componentCounts[response.component].accepted++;
    this.accept(response);
  }
  get diagnostics() {
    return { mode: this.mode, enabled: this.desired.solar !== null || this.desired.selected !== null,
      activeRequestCount: this.inFlight ? 1 : 0, pendingLatestRequestCount: this.pending ? 1 : 0,
      currentBatchKey: JSON.stringify([this.desired.solar, this.desired.selected]), componentKeys: { ...this.desired },
      startedCount: this.startedCount, staleResultCount: this.staleResultCount, lastComputeWallMs: this.lastDurationMs,
      maxFallbackChunkMs: this.maxFallbackChunkMs, lastFallbackActiveComputeMs: this.lastFallbackActiveComputeMs,
      workerCount: this.worker ? 1 : 0, cache: this.cache ?? this.fallback?.diagnostics() ?? { cacheEntries: 0, maxEntries: 16, computations: 0, cacheHits: 0, cacheEvictions: 0 },
      components: Object.fromEntries(components.map(component => [component, { ...this.componentCounts[component], enabled: this.desired[component] !== null,
        desiredKey: this.desired[component], readyKey: this.latest[component]?.status === 'ready' ? this.latest[component]?.key : null,
        errorKey: this.latest[component]?.status === 'error' ? this.latest[component]?.key : null }])), notes: [...this.notes] };
  }
  /** Previous QA keeps its solar fields; queue counts refer to the same combined worker. */
  get solarDiagnostics() { return { ...this.diagnostics, enabled: this.desired.solar !== null, currentKey: this.desired.solar }; }
  get mainThreadComputationActive(): boolean { return this.mode === 'main-thread-cooperative' && this.inFlight !== null; }
  get mainThreadComputationRevision(): number { return this.fallbackComputeRevision; }
  private pump(): void {
    if (this.disposed || this.inFlight || !this.pending || this.timer !== null) return;
    if (!this.needed(this.pending)) { this.pending = null; return; }
    const delay = this.pending.immediate ? 0 : Math.max(0, this.lastStartedMs + 1000 - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.inFlight || !this.pending) return;
      const request = this.pending; this.pending = null;
      if (!this.needed(request)) return;
      this.inFlight = request; this.lastStartedMs = performance.now(); this.startedCount++;
      if (this.worker) {
        try { this.watchdog = setTimeout(() => this.useFallback('日事件 Worker 超时，改为分组件协作计算'), 20_000); this.worker.postMessage(request); }
        catch { this.useFallback('日事件 Worker 发送失败，改为分组件协作计算'); }
      } else void this.computeFallback(request);
    }, delay);
  }
  private async computeFallback(request: ScheduledRequest): Promise<void> {
    this.fallbackComputeRevision++;
    try {
    const started = performance.now(); let activeComputeMs = 0;
    try { this.fallback ??= this.options.createScience(); }
    catch (error) {
      for (const component of components) {
        const key = request.componentKeys[component];
        if (key) this.deliver({ kind: 'day-events', requestId: request.requestId, batchKey: request.batchKey, component, key, status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      if (this.inFlight?.requestId === request.requestId) this.inFlight = null;
      this.pump(); return;
    }
    for (const component of components) {
      const key = request.componentKeys[component];
      if (!key || key !== this.desired[component] || this.disposed) continue;
      let chunkStarted = performance.now();
      const recordChunk = () => { const elapsed = performance.now() - chunkStarted; activeComputeMs += elapsed; this.maxFallbackChunkMs = Math.max(this.maxFallbackChunkMs, elapsed); };
      try {
        const yieldFn = async () => {
          recordChunk(); await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (this.disposed || key !== this.desired[component]) throw CANCELLED;
          chunkStarted = performance.now();
        };
        const actual = component === 'solar' ? this.fallback.keyForSolar(request.state) : this.fallback.keyForObject(request.state, request.needs.selected!);
        if (actual !== key) throw new Error('日事件输入标识不一致');
        if (component === 'solar') {
          const result = await this.fallback.computeSolarCooperatively(request.state, yieldFn); recordChunk();
          this.deliver({ kind: 'day-events', requestId: request.requestId, batchKey: request.batchKey, component, key, status: 'ready', result });
        } else {
          const result = await this.fallback.computeObjectCooperatively(request.state, request.needs.selected!, yieldFn); recordChunk();
          this.deliver({ kind: 'day-events', requestId: request.requestId, batchKey: request.batchKey, component, key, status: 'ready', result });
        }
      } catch (error) {
        if (error === CANCELLED) this.componentCounts[component].cancelled++;
        else this.deliver({ kind: 'day-events', requestId: request.requestId, batchKey: request.batchKey, component, key, status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.lastFallbackActiveComputeMs = activeComputeMs;
    this.cache = this.fallback.diagnostics(); this.lastDurationMs = performance.now() - started;
    if (this.inFlight?.requestId === request.requestId) this.inFlight = null;
    this.pump();
    } finally { this.fallbackComputeRevision++; }
  }
  private useFallback(reason: string): void {
    if (this.disposed) return;
    this.clearWatchdog(); this.worker?.terminate(); this.releaseWorker?.(); this.worker = null; this.releaseWorker = null;
    if (!this.pending && this.inFlight && this.needed(this.inFlight)) this.pending = this.inFlight;
    this.inFlight = null; this.mode = 'main-thread-cooperative'; this.notes.push(reason);
    if (this.notes.length > 8) this.notes.shift(); this.pump();
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private clearWatchdog(): void { if (this.watchdog !== null) clearTimeout(this.watchdog); this.watchdog = null; }
  dispose(): void {
    this.disposed = true; this.clearDemand(); this.clearWatchdog(); this.worker?.terminate(); this.releaseWorker?.();
    this.worker = null; this.releaseWorker = null; this.inFlight = null; this.fallback?.clear();
    delete this.latest.solar; delete this.latest.selected;
  }
}
