import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewTransition } from '../src/ui/view-transition';
import type {
  ViewTransitionAdapter, ViewTransitionCancelReason, ViewTransitionHandle, ViewTransitionTicket,
} from '../src/platform/runtime-quality-contract';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls: string[] = [];
  const handles: Array<ViewTransitionHandle & { completion: ReturnType<typeof deferred>; cancellations: number }> = [];
  let guarded = false, opacity = 1;
  let onPrepare: ((ticket: ViewTransitionTicket) => void) | undefined;
  let onAnimate: ((ticket: ViewTransitionTicket) => void) | undefined;
  let prepareError: Error | undefined, animateError: Error | undefined, cancelError: Error | undefined;
  const adapter: ViewTransitionAdapter = {
    prepare(ticket) {
      calls.push(`prepare:${ticket.generation}:${ticket.target}`);
      guarded = true; // Waiting for science keeps the previous paired picture visible.
      onPrepare?.(ticket);
      if (prepareError) throw prepareError;
    },
    animate(ticket, duration) {
      calls.push(`animate:${ticket.generation}:${ticket.target}:${duration}`);
      opacity = 0;
      onAnimate?.(ticket);
      if (animateError) throw animateError;
      const completion = deferred();
      const handle = { finished: completion.promise, completion, cancellations: 0,
        cancel() {
          handle.cancellations++;
          calls.push(`cancel:${ticket.generation}`);
          // Deliberately leave finished unresolved: late native callbacks remain possible.
          if (cancelError) throw cancelError;
        } };
      handles.push(handle);
      return handle;
    },
    settle() { calls.push('settle'); opacity = 1; guarded = false; },
  };
  return { adapter, calls, handles,
    get guarded() { return guarded; }, get opacity() { return opacity; },
    set onPrepare(value: typeof onPrepare) { onPrepare = value; },
    set onAnimate(value: typeof onAnimate) { onAnimate = value; },
    set prepareError(value: Error | undefined) { prepareError = value; },
    set animateError(value: Error | undefined) { animateError = value; },
    set cancelError(value: Error | undefined) { cancelError = value; },
  };
}
const ticket = (generation: number, target: ViewTransitionTicket['target'] = 'space'): ViewTransitionTicket => ({ generation, target });
async function flush() { await Promise.resolve(); await Promise.resolve(); }

test('one paired target starts one 300ms fade; waiting keeps the previous picture and completion restores input', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  transition.request(ticket(1));
  assert.equal(transition.diagnostics.phase, 'waiting-render');
  assert.equal(transition.diagnostics.handleCount, 0);
  assert.equal(env.guarded, true); assert.equal(env.opacity, 1);
  transition.onPairedRender(ticket(0));
  transition.onPairedRender(ticket(1, 'ground'));
  assert.equal(env.handles.length, 0);
  transition.onPairedRender(ticket(1));
  transition.onPairedRender(ticket(1));
  assert.equal(transition.diagnostics.phase, 'animating');
  assert.equal(transition.diagnostics.handleCount, 1);
  assert.equal(env.opacity, 0); assert.equal(env.guarded, true);
  assert.equal(env.handles.length, 1);
  env.handles[0].completion.resolve(); await flush();
  assert.deepEqual(env.calls, ['prepare:1:space', 'animate:1:space:300', 'cancel:1', 'settle']);
  assert.equal(env.guarded, false); assert.equal(env.opacity, 1);
  assert.deepEqual(transition.diagnostics, { phase: 'idle', ticket: null,
    reducedMotion: false, handleCount: 0, lastCancelReason: null });
});

test('rapid intents keep only the latest ticket and stale success/rejection cannot settle a new animation', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  transition.request(ticket(1)); transition.request(ticket(2, 'globe'));
  transition.onPairedRender(ticket(1));
  assert.equal(env.handles.length, 0);
  transition.onPairedRender(ticket(2, 'globe'));
  const old = env.handles[0];
  transition.request(ticket(3, 'horizon'));
  assert.equal(old.cancellations, 1);
  assert.equal(env.guarded, true); assert.equal(env.opacity, 1);
  old.completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'waiting-render'); assert.equal(env.guarded, true);
  transition.onPairedRender(ticket(3, 'horizon'));
  const second = env.handles[1];
  transition.request(ticket(4, 'ground'));
  transition.onPairedRender(ticket(4, 'ground'));
  const calls = env.calls.length;
  second.completion.reject(new Error('old animation cancelled')); await flush();
  assert.equal(env.calls.length, calls);
  assert.equal(transition.diagnostics.ticket?.generation, 4);
  assert.equal(transition.diagnostics.handleCount, 1); assert.equal(env.guarded, true);
  env.handles[2].completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
});

test('generations are monotonic, tickets/diagnostics are immutable and cancelled intents never replay', () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  const mutable = { generation: 2, target: 'globe' as ViewTransitionTicket['target'] };
  transition.request(mutable); mutable.target = 'ground';
  transition.request(ticket(2, 'horizon')); transition.request(ticket(1));
  assert.equal(env.calls.length, 1);
  assert.equal(transition.diagnostics.ticket?.target, 'globe');
  assert.equal(Object.isFrozen(transition.diagnostics), true);
  assert.equal(Object.isFrozen(transition.diagnostics.ticket), true);
  transition.cancel('capture');
  const calls = env.calls.length;
  transition.request(ticket(2, 'globe')); transition.onPairedRender(ticket(2, 'globe'));
  assert.equal(env.calls.length, calls);
  assert.equal(transition.diagnostics.lastCancelReason, 'capture');
  transition.request(ticket(3)); assert.equal(transition.diagnostics.phase, 'waiting-render');
});

test('initial and dynamic reduced motion switch directly, clear the handle and never revive the cancelled intent', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter, { reducedMotion: true });
  transition.request(ticket(1)); transition.onPairedRender(ticket(1));
  assert.deepEqual(env.calls, ['settle']); assert.equal(env.guarded, false);
  assert.equal(transition.diagnostics.phase, 'idle');
  transition.setReducedMotion(false); transition.request(ticket(2)); transition.onPairedRender(ticket(2));
  transition.setReducedMotion(true);
  assert.equal(transition.diagnostics.handleCount, 0); assert.equal(env.opacity, 1); assert.equal(env.guarded, false);
  const calls = env.calls.length;
  env.handles[0].completion.reject(new Error('native cancellation')); await flush();
  transition.onPairedRender(ticket(2)); transition.setReducedMotion(true);
  assert.equal(env.calls.length, calls);
  transition.request(ticket(3, 'globe'));
  assert.equal(env.handles.length, 1); assert.equal(transition.diagnostics.phase, 'idle');
  transition.setReducedMotion(false); transition.request(ticket(4, 'horizon'));
  assert.equal(transition.diagnostics.phase, 'waiting-render');
  transition.setReducedMotion(true);
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
});

const cancelReasons: ViewTransitionCancelReason[] = ['latest', 'reduced-motion', 'hidden', 'pagehide', 'dispose', 'resize',
  'surface', 'context', 'import', 'reset', 'capture', 'focus', 'reference-lock', 'science-error', 'range-stop'];
test('every lifecycle cancellation restores waiting/animating surfaces and late completion cannot affect the next target', async () => {
  for (const reason of cancelReasons) for (const animate of [false, true]) {
    const env = fixture(), transition = createViewTransition(env.adapter);
    transition.request(ticket(1)); if (animate) transition.onPairedRender(ticket(1));
    transition.cancel(reason);
    const cancelled = transition.diagnostics;
    assert.equal(cancelled.phase, 'idle', `${reason}/${animate}`);
    assert.equal(cancelled.handleCount, 0); assert.equal(cancelled.ticket, null);
    assert.equal(cancelled.lastCancelReason, reason);
    assert.equal(env.guarded, false); assert.equal(env.opacity, 1);
    assert.equal(env.handles[0]?.cancellations ?? 0, animate ? 1 : 0);
    transition.request(ticket(2, 'globe'));
    const calls = env.calls.length;
    env.handles[0]?.completion.resolve(); await flush();
    assert.equal(env.calls.length, calls); assert.equal(env.guarded, true);
    assert.equal(transition.diagnostics.ticket?.generation, 2);
    transition.dispose();
  }
});

test('native finish rejection settles the current surface without requiring another render/timer callback', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  transition.request(ticket(1)); transition.onPairedRender(ticket(1));
  env.handles[0].completion.reject(new Error('native animation aborted')); await flush();
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(transition.diagnostics.handleCount, 0);
  assert.equal(env.guarded, false); assert.equal(env.opacity, 1);
});

test('dispose is idempotent in waiting/animating phases and all later callbacks/requests are inert', async () => {
  for (const animate of [false, true]) {
    const env = fixture(), transition = createViewTransition(env.adapter);
    transition.request(ticket(1)); if (animate) transition.onPairedRender(ticket(1));
    transition.dispose(); const calls = env.calls.length;
    transition.dispose(); transition.request(ticket(2)); transition.onPairedRender(ticket(1));
    transition.cancel('capture'); transition.setReducedMotion(true);
    env.handles[0]?.completion.resolve(); await flush();
    assert.equal(env.calls.length, calls);
    assert.deepEqual(transition.diagnostics, { phase: 'disposed', ticket: null,
      reducedMotion: false, handleCount: 0, lastCancelReason: 'dispose' });
    assert.equal(env.guarded, false); assert.equal(env.opacity, 1);
  }
});

test('adapter preparation/animation/cancellation failures leave no guarded or retained controller resources', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  env.prepareError = new Error('prepare failed');
  assert.throws(() => transition.request(ticket(1)), /prepare failed/);
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
  env.prepareError = undefined; env.animateError = new Error('animate failed');
  transition.request(ticket(2));
  assert.throws(() => transition.onPairedRender(ticket(2)), /animate failed/);
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.opacity, 1);
  env.animateError = undefined;
  transition.request(ticket(3)); transition.onPairedRender(ticket(3));
  env.cancelError = new Error('cancel failed');
  assert.throws(() => transition.cancel('context'), /cancel failed/);
  assert.equal(transition.diagnostics.handleCount, 0); assert.equal(env.guarded, false); assert.equal(env.opacity, 1);
  const calls = env.calls.length;
  env.handles[0].completion.resolve(); await flush();
  assert.equal(env.calls.length, calls);
});

test('reentrant adapters cannot retain an obsolete returned handle or overwrite a newer prepared ticket', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  env.onPrepare = current => { if (current.generation === 1) transition.request(ticket(2, 'globe')); };
  transition.request(ticket(1));
  assert.equal(transition.diagnostics.ticket?.generation, 2);
  env.onAnimate = current => { if (current.generation === 2) transition.request(ticket(3, 'horizon')); };
  transition.onPairedRender(ticket(2, 'globe'));
  assert.equal(transition.diagnostics.phase, 'waiting-render');
  assert.equal(transition.diagnostics.ticket?.generation, 3);
  assert.equal(transition.diagnostics.handleCount, 0); assert.equal(env.handles[0].cancellations, 1);
  env.handles[0].completion.reject(new Error('obsolete handle')); await flush();
  assert.equal(env.guarded, true);
  env.onAnimate = undefined;
  transition.onPairedRender(ticket(3, 'horizon'));
  assert.equal(transition.diagnostics.handleCount, 1);
  env.handles[1].completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'idle');
});

test('a newer request made synchronously by old handle cancellation wins over the outer request', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  transition.request(ticket(1)); transition.onPairedRender(ticket(1));
  const old = env.handles[0], cancel = old.cancel.bind(old);
  old.cancel = () => { cancel(); transition.request(ticket(3, 'horizon')); };
  transition.request(ticket(2, 'globe'));
  assert.equal(transition.diagnostics.ticket?.generation, 3);
  assert.equal(transition.diagnostics.ticket?.target, 'horizon');
  assert.equal(transition.diagnostics.phase, 'waiting-render');
  assert.equal(env.guarded, true);
  assert.equal(env.calls.includes('prepare:2:globe'), false);
  assert.equal(env.calls.at(-1), 'prepare:3:horizon');
  old.completion.resolve(); await flush();
  assert.equal(transition.diagnostics.ticket?.generation, 3); assert.equal(env.guarded, true);
  transition.onPairedRender(ticket(2, 'globe')); assert.equal(env.handles.length, 1);
  transition.onPairedRender(ticket(3, 'horizon'));
  env.handles[1].completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
});

test('explicit cancel cannot settle the guard of a newer request created by that handle cancellation', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  transition.request(ticket(1)); transition.onPairedRender(ticket(1));
  const old = env.handles[0], cancel = old.cancel.bind(old);
  old.cancel = () => { cancel(); transition.request(ticket(3, 'horizon')); };
  transition.cancel('latest');
  assert.equal(transition.diagnostics.ticket?.generation, 3);
  assert.equal(transition.diagnostics.phase, 'waiting-render');
  assert.equal(transition.diagnostics.handleCount, 0);
  assert.equal(env.guarded, true); assert.equal(env.calls.at(-1), 'prepare:3:horizon');
  const calls = env.calls.length;
  old.completion.reject(new Error('late old cancellation')); await flush();
  assert.equal(env.calls.length, calls); assert.equal(env.guarded, true);
  transition.onPairedRender(ticket(3, 'horizon'));
  env.handles[1].completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
});

test('hundreds of rapid view intents keep a bounded single handle/latest ticket and finish in idle', async () => {
  const env = fixture(), transition = createViewTransition(env.adapter);
  const targets: ViewTransitionTicket['target'][] = ['ground', 'space', 'globe', 'horizon'];
  for (let generation = 0; generation < 400; generation++) {
    const next = ticket(generation, targets[generation % 4]);
    transition.request(next); transition.onPairedRender(next);
    assert.equal(transition.diagnostics.handleCount, 1);
    assert.equal(transition.diagnostics.ticket?.generation, generation);
    assert.equal(env.handles.slice(0, -1).every(handle => handle.cancellations === 1), true);
  }
  const calls = env.calls.length;
  for (const handle of env.handles.slice(0, -1)) handle.completion.resolve();
  await flush(); assert.equal(env.calls.length, calls); assert.equal(transition.diagnostics.handleCount, 1);
  env.handles.at(-1)!.completion.resolve(); await flush();
  assert.equal(transition.diagnostics.phase, 'idle'); assert.equal(env.guarded, false);
});

test('the duration stays in the agreed short range and invalid generations fail before adapter effects', () => {
  const env = fixture();
  for (const durationMs of [249, 401, -1, 0, NaN, Infinity]) {
    assert.throws(() => createViewTransition(env.adapter, { durationMs }), RangeError);
  }
  for (const durationMs of [250, 400]) {
    const transition = createViewTransition(env.adapter, { durationMs });
    transition.request(ticket(durationMs)); transition.onPairedRender(ticket(durationMs));
    assert.equal(env.calls.includes(`animate:${durationMs}:space:${durationMs}`), true);
    transition.dispose();
  }
  const transition = createViewTransition(env.adapter);
  const calls = env.calls.length;
  for (const generation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => transition.request(ticket(generation)), RangeError);
  }
  assert.equal(env.calls.length, calls); assert.equal(transition.diagnostics.phase, 'idle');
});
