import workerSource from 'virtual:sky-worker';
import { computeSnapshot } from '../core/astronomy';
import type { ScienceSnapshot, SimulationState } from '../contracts';
import { scienceInputSignature } from './snapshot-provenance';

type Request = { state: SimulationState; requestId: number };
/** One active request plus one replaceable latest request; old results never overwrite newer state. */
export class SnapshotService {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private inFlight: Request | null = null;
  private pending: Request | null = null;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastFallbackStart = -Infinity;
  private fallbackDurationMs = 0;
  mode: 'worker' | 'main-thread-budgeted' = 'worker';
  readonly notes: string[] = [];

  constructor(private readonly accept: (snapshot: ScienceSnapshot, inputSignature: string) => void, private readonly fail: (message: string) => void, forceFallback = false) {
    try {
      if (forceFallback) throw new Error('已要求主线程回退');
      this.workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = (event: MessageEvent<{ snapshot?: ScienceSnapshot; error?: string }>) => {
        if (this.disposed) return;
        this.clearWatchdog();
        const completed = this.inFlight;
        this.inFlight = null;
        if (event.data.error && !this.pending) this.fail(event.data.error);
        else if (event.data.snapshot && completed && !this.pending && event.data.snapshot.requestId === completed.requestId) this.accept(event.data.snapshot, scienceInputSignature(completed.state));
        this.pump();
      };
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.useFallback('Worker 不可用，计算已限频转入主线程');
      };
    } catch (error) {
      this.useFallback(error instanceof Error ? error.message : String(error));
    }
  }

  request(state: SimulationState): number {
    if (this.disposed) return this.sequence;
    this.pending = { state: structuredClone(state), requestId: ++this.sequence };
    this.pump();
    return this.sequence;
  }

  get pendingLatestRequestCount(): number { return this.pending ? 1 : 0; }
  get requestedCount(): number { return this.sequence; }
  get activeRequestCount(): number { return this.inFlight ? 1 : 0; }
  get lastMainThreadComputeMs(): number { return this.fallbackDurationMs; }

  private pump(): void {
    if (this.disposed || this.inFlight || !this.pending) return;
    if (this.worker) {
      this.inFlight = this.pending;
      this.pending = null;
      try {
        this.worker.postMessage(this.inFlight);
        this.watchdog = setTimeout(() => this.useFallback('Worker 超时，计算已限频转入主线程'), 5000);
      } catch { this.useFallback('Worker 消息发送失败，计算已限频转入主线程'); }
      return;
    }
    if (this.timer !== null) return;
    // Monolithic engine calls cannot be interrupted; cap rate and measure every call.
    // Reserve at most ~12% time using the measured prior cost, never above 20Hz.
    const interval = Math.max(50, this.fallbackDurationMs / 0.12);
    const delay = Math.max(0, this.lastFallbackStart + interval - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.pending || this.disposed) return;
      const request = this.pending;
      this.pending = null;
      this.inFlight = request;
      const start = performance.now();
      this.lastFallbackStart = start;
      try { this.accept(computeSnapshot(request.state, request.requestId), scienceInputSignature(request.state)); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
      finally {
        this.fallbackDurationMs = performance.now() - start;
        this.inFlight = null;
        this.pump();
      }
    }, delay);
  }

  private useFallback(reason: string): void {
    if (this.disposed) return;
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    if (this.inFlight && !this.pending) this.pending = this.inFlight;
    this.inFlight = null;
    this.mode = 'main-thread-budgeted';
    this.notes.push(reason);
    this.pump();
  }
  private clearWatchdog(): void { if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = null; }
  dispose(): void {
    this.disposed = true;
    this.clearWatchdog();
    if (this.timer) clearTimeout(this.timer);
    this.worker?.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
    this.inFlight = this.pending = null;
  }
}
