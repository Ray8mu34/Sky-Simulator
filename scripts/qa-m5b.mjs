import assert from 'node:assert/strict';
import { runM5aOfflineSmoke } from './qa-m5a.mjs';

export async function installDayEventTransferProbe(context) {
  await context.addInitScript(() => {
    window.__qaDayEventTransfers = []; window.__qaNativeWorkerCreatedCount = 0;
    const NativeWorker = Worker, originalPost = NativeWorker.prototype.postMessage, ids = new WeakMap();
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args, target); ids.set(worker, ++window.__qaNativeWorkerCreatedCount); return worker;
    } });
    NativeWorker.prototype.postMessage = function(message, ...rest) {
      if (message?.kind === 'day-events') {
        window.__qaDayEventTransfers.push({ workerId: ids.get(this) ?? null, requestId: message.requestId,
          componentKeys: structuredClone(message.componentKeys), target: structuredClone(message.needs.selected),
          targetJsonBytes: new TextEncoder().encode(JSON.stringify(message.needs.selected)).length });
        if (window.__qaDayEventTransfers.length > 32) window.__qaDayEventTransfers.shift();
      }
      return originalPost.call(this, message, ...rest);
    };
  });
}

const cases = [
  { id: 'hip:57939', query: 'HIP57939', expectedModel: 'linear-space', reason: null, role: 'Source-consistent distance/RV candidate, Groombridge 1830.' },
  { id: 'hip:103527', query: 'HIP103527', expectedModel: 'tangent', reason: 'radial-velocity-unavailable', role: 'Source RV zero is conservatively represented as null and an unavailable bit, not certified measured zero.' },
  { id: 'hip:17851', query: 'HIP17851', expectedModel: 'tangent', reason: 'source-field-inconsistent', role: 'Fixed HYG inconsistent source record, Pleione.' },
  { id: 'hyg:119623', query: 'HYG119623', expectedModel: 'tangent', reason: 'source-field-inconsistent', role: 'Second fixed source exception without a HIP identity.' },
];
const ready = page => page.waitForFunction(() => {
  const app = window.skyApp, teaching = app.teachingData, diagnostics = app.diagnostics;
  return !diagnostics.scienceDirty && teaching.objectDayStatus === 'ready' && teaching.objectDay?.id === app.state.selected &&
    diagnostics.lastRenderedSelection === app.state.selected && diagnostics.lastRenderedUt === app.snapshot.utDaysJ2000 &&
    diagnostics.dayEvents.activeRequestCount === 0 && diagnostics.dayEvents.pendingLatestRequestCount === 0;
}, undefined, { timeout: 30_000 });

/** Only transports and compares the core-produced model identity; no policy/propagation formula in QA. */
export async function runM5bOfflineSmoke({ page, shot, prefix = 'star-motion' }) {
  const bodies = await runM5aOfflineSmoke({ page, shot: null });
  const samples = [];
  for (const example of cases) {
    const before = await page.evaluate(() => window.skyApp.state);
    await page.locator('#sky-search').fill(example.query); await page.locator(`[data-object-id="${example.id}"]`).click();
    await ready(page);
    const sample = await page.evaluate(() => ({ state: window.skyApp.state, details: window.skyApp.selectedDetails,
      teaching: window.skyApp.teachingData, diagnostics: window.skyApp.diagnostics,
      nativeWorkerCreatedCount: window.__qaNativeWorkerCreatedCount, transfers: [...window.__qaDayEventTransfers],
      rendererStarMotion: window.skyApp.rendererDiagnostics?.starMotion ?? null }));
    assert.deepEqual(sample.state, { ...before, selected: example.id });
    const metadata = sample.details.starMotion;
    assert.equal(metadata.model, example.expectedModel); if (example.reason) assert.ok(metadata.fallbackReasons.includes(example.reason));
    assert.deepEqual(sample.teaching.objectDay.starMotion, metadata); assert.equal(sample.teaching.objectDay.astrometryModelVersion, metadata.modelVersion);
    assert.deepEqual(sample.rendererStarMotion.selectedModel, metadata);
    assert.equal(sample.teaching.objectDayKey, sample.teaching.objectDay.key);
    assert.equal(sample.diagnostics.dayEvents.cache.maxEntries, 16); assert.ok(sample.diagnostics.dayEvents.cache.cacheEntries <= 16);
    assert.equal(sample.diagnostics.dayEvents.activeRequestCount, 0); assert.equal(sample.diagnostics.dayEvents.pendingLatestRequestCount, 0);
    assert.ok(sample.nativeWorkerCreatedCount <= 2);
    if (sample.diagnostics.dayEvents.mode === 'worker') {
      const transfer = sample.transfers.findLast(message => message.target?.id === example.id && message.componentKeys.selected === sample.teaching.objectDayKey);
      assert.ok(transfer, `No actual native event-worker transfer for ${example.id}`);
      assert.equal(transfer.target.kind, 'star'); assert.ok(transfer.targetJsonBytes <= 2048);
      assert.deepEqual(Object.keys(transfer.target).sort(), ['astrometry', 'astrometrySourceVersion', 'id', 'kind']);
      assert.deepEqual(Object.keys(transfer.target.astrometry).sort(), ['decDeg', 'distancePc', 'id', 'pmDecMasYr', 'pmRaCosDecMasYr', 'qualityFlags', 'raHours', 'radialVelocityKmS']);
      assert.equal(transfer.target.astrometry.id, example.id);
      assert.ok(transfer.target.astrometrySourceVersion.endsWith(':astrometry-v2'));
      const a = transfer.target.astrometry, keyRecord = JSON.parse(transfer.componentKeys.selected).at(-1);
      assert.deepEqual(keyRecord, [transfer.target.astrometrySourceVersion, 'j2000-motion-linear-or-tangent-ut-v2', metadata.policyVersion,
        a.id, a.raHours, a.decDeg, a.pmRaCosDecMasYr, a.pmDecMasYr, a.distancePc, a.radialVelocityKmS, a.qualityFlags]);
      sample.actualTransfer = transfer;
    } else {
      assert.equal(sample.nativeWorkerCreatedCount, 0); assert.deepEqual(sample.transfers, []);
    }
    if (shot && example.id === 'hip:17851') {
      await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await shot(`${prefix}-exception-events.png`);
    }
    samples.push({ ...example, ...sample });
  }
  return { bodies: { solarDay: bodies.teaching.solarDay, moonDay: bodies.teaching.objectDay }, samples,
    scope: 'Real catalog selection, same-core event output/model identity and native Worker single-record transport. Scientific accuracy and GPU cached-position validation are separate.' };
}

export async function runM5bChecks({ page, report, shot }) {
  report.starMotion = await runM5bOfflineSmoke({ page, shot });
  report.assertions.push('Actual candidate, source-zero-RV fallback and two fixed source exceptions have identical model identity in details and selected day events.',
    'The existing native second Worker received one eight-field stellar record per demand; complete source/model/policy and scalar inputs are in its event key, with no third Worker.');
  report.status = 'passed-m5b-targeted-transport-checks';
}

export function compareM5bWorkerFallback(worker, fallback) {
  assert.deepEqual(fallback.bodies, worker.bodies);
  assert.equal(fallback.samples.length, worker.samples.length);
  for (let index = 0; index < worker.samples.length; index++) {
    assert.equal(fallback.samples[index].id, worker.samples[index].id);
    assert.deepEqual(fallback.samples[index].details, worker.samples[index].details);
    assert.deepEqual(fallback.samples[index].teaching.objectDay, worker.samples[index].teaching.objectDay);
    assert.deepEqual(fallback.samples[index].teaching.solarDay, worker.samples[index].teaching.solarDay);
  }
}
