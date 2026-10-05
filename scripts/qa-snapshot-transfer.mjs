import assert from 'node:assert/strict';

/** Passive listeners on the two native workers; never replace their actual responses. */
export async function installSnapshotTransferProbe(context) {
  await context.addInitScript(() => {
    window.__qaSnapshotTransfers = []; window.__qaSnapshotReplies = []; window.__qaWorkersCreated = 0;
    window.__qaDocumentToken = `${performance.timeOrigin}:${Math.random()}`;
    const NativeWorker = Worker, originalPost = NativeWorker.prototype.postMessage, ids = new WeakMap();
    function payloadFacts(value) {
      const facts = { typedArrayBytes: 0, arrayBufferBytes: 0, largestArray: 0 };
      const visit = item => {
        if (!item || typeof item !== 'object') return;
        if (ArrayBuffer.isView(item)) { facts.typedArrayBytes += item.byteLength; return; }
        if (item instanceof ArrayBuffer) { facts.arrayBufferBytes += item.byteLength; return; }
        if (Array.isArray(item)) facts.largestArray = Math.max(facts.largestArray, item.length);
        for (const entry of Object.values(item)) visit(entry);
      };
      visit(value); return facts;
    }
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args, target); ids.set(worker, ++window.__qaWorkersCreated);
      worker.addEventListener('message', event => {
        if (!event.data?.snapshot) return;
        const snapshot = event.data.snapshot;
        window.__qaSnapshotReplies.push({ workerId: ids.get(worker), requestId: snapshot.requestId, ut: snapshot.utDaysJ2000,
          descriptor: structuredClone(snapshot.observerRefraction), eclipticOfDateToEqj: structuredClone(snapshot.eclipticOfDateToEqj),
          jsonBytes: new TextEncoder().encode(JSON.stringify(snapshot)).length, ...payloadFacts(snapshot) });
        if (window.__qaSnapshotReplies.length > 128) window.__qaSnapshotReplies.shift();
      });
      return worker;
    } });
    NativeWorker.prototype.postMessage = function(message, ...rest) {
      if (message?.state && Number.isInteger(message.requestId) && !message.kind) {
        window.__qaSnapshotTransfers.push({ workerId: ids.get(this), requestId: message.requestId, performanceMs: performance.now(),
          ut: message.state.time.utDaysJ2000, environment: structuredClone(message.state.environment), ...payloadFacts(message) });
        if (window.__qaSnapshotTransfers.length > 128) window.__qaSnapshotTransfers.shift();
      }
      return originalPost.call(this, message, ...rest);
    };
  });
}

export function assertSnapshotTransfers(probe, forceFallback) {
  assert.equal(probe.created, forceFallback ? 0 : 2);
  if (forceFallback) { assert.deepEqual(probe.transfers, []); assert.deepEqual(probe.replies, []); return; }
  assert.ok(probe.replies.length > 0);
  for (const reply of probe.replies) {
    assert.deepEqual(Object.keys(reply.descriptor).sort(), ['definitionVersion', 'mode', 'pressureHpa', 'profileVersion', 'temperatureC']);
    assert.equal(reply.typedArrayBytes, 0); assert.equal(reply.arrayBufferBytes, 0);
    assert.ok(reply.largestArray < 512); assert.ok(reply.jsonBytes < 16 * 1024);
    assert.equal(reply.eclipticOfDateToEqj.length, 3);
    assert.ok(reply.eclipticOfDateToEqj.every(row => row.length === 3 && row.every(Number.isFinite)));
  }
  for (const request of probe.transfers) {
    assert.equal(request.typedArrayBytes, 0); assert.equal(request.arrayBufferBytes, 0); assert.ok(request.largestArray < 512);
  }
}
