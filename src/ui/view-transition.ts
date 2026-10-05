import type {
  ViewTransitionAdapter, ViewTransitionCancelReason, ViewTransitionController,
  ViewTransitionDiagnostics, ViewTransitionHandle, ViewTransitionTicket,
} from '../platform/runtime-quality-contract';

/** Lifecycle only: the caller owns the paired render and all DOM/animation effects. */
export function createViewTransition(
  adapter: ViewTransitionAdapter,
  options: { durationMs?: number; reducedMotion?: boolean } = {},
): ViewTransitionController {
  const durationMs = options.durationMs ?? 300;
  if (!Number.isFinite(durationMs) || durationMs < 250 || durationMs > 400) {
    throw new RangeError('View transition duration must be between 250 and 400 ms.');
  }

  let reducedMotion = options.reducedMotion ?? false;
  let disposed = false;
  let phase: ViewTransitionDiagnostics['phase'] = 'idle';
  let ticket: Readonly<ViewTransitionTicket> | null = null;
  let handle: ViewTransitionHandle | null = null;
  let latestGeneration = -1;
  let token = 0;
  let lastCancelReason: ViewTransitionCancelReason | null = null;

  function release(reason?: ViewTransitionCancelReason): void {
    // Invalidate before cancellation: a cancelled handle may finish at any time.
    token++;
    const releaseToken = token;
    const previousHandle = handle;
    handle = null;
    ticket = null;
    phase = disposed ? 'disposed' : 'idle';
    if (reason) lastCancelReason = reason;
    try {
      previousHandle?.cancel();
    } finally {
      // A cancelling adapter may synchronously prepare a newer intent.
      if (token === releaseToken) adapter.settle();
    }
  }

  function isCurrent(expectedToken: number, expectedTicket: ViewTransitionTicket): boolean {
    return !disposed && token === expectedToken && ticket === expectedTicket;
  }

  function finish(expectedToken: number, expectedTicket: ViewTransitionTicket): void {
    if (!isCurrent(expectedToken, expectedTicket)) return;
    release();
  }

  return {
    request(next) {
      if (disposed) return;
      if (!Number.isSafeInteger(next.generation) || next.generation < 0) {
        throw new RangeError('View transition generation must be a non-negative safe integer.');
      }
      // Generations are allocated by main, once per intent; no queue or replay.
      if (next.generation <= latestGeneration) return;
      if (ticket || handle) release('latest');
      if (disposed || next.generation <= latestGeneration) return;
      latestGeneration = next.generation;
      token++;
      if (reducedMotion) {
        adapter.settle();
        return;
      }
      ticket = Object.freeze({ generation: next.generation, target: next.target });
      phase = 'waiting-render';
      const expectedToken = token;
      const expectedTicket = ticket;
      try {
        adapter.prepare(expectedTicket);
      } catch (error) {
        if (isCurrent(expectedToken, expectedTicket)) release();
        throw error;
      }
    },
    onPairedRender(rendered) {
      if (disposed || phase !== 'waiting-render' || !ticket
        || rendered.generation !== ticket.generation || rendered.target !== ticket.target) return;
      const expectedToken = token;
      const expectedTicket = ticket;
      phase = 'animating';
      try {
        const nextHandle = adapter.animate(expectedTicket, durationMs);
        // A reentrant adapter can replace/cancel the intent before returning.
        if (!isCurrent(expectedToken, expectedTicket)) {
          void nextHandle.finished.catch(() => {});
          nextHandle.cancel();
          return;
        }
        handle = nextHandle;
        // Both finish and native animation cancellation restore one latest intent.
        // Adapter errors are synchronous; asynchronous settle errors cannot retain
        // controller resources or create an unhandled animation rejection.
        void nextHandle.finished.then(
          () => finish(expectedToken, expectedTicket),
          () => finish(expectedToken, expectedTicket),
        ).catch(() => {});
      } catch (error) {
        if (isCurrent(expectedToken, expectedTicket)) release();
        throw error;
      }
    },
    cancel(reason) {
      if (!disposed) release(reason);
    },
    setReducedMotion(reduced) {
      if (disposed || reduced === reducedMotion) return;
      reducedMotion = reduced;
      release('reduced-motion');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release('dispose');
    },
    get diagnostics(): ViewTransitionDiagnostics {
      return Object.freeze({ phase, ticket, reducedMotion,
        handleCount: handle ? 1 : 0, lastCancelReason });
    },
  };
}
