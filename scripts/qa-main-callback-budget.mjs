import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:4173/';
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m5c-platform/main-callback-budget');
const expectedBuild = process.env.SKY_QA_BUILD_ID, expectedEntry = process.env.SKY_QA_ENTRY;
assert.ok(expectedBuild && expectedEntry, 'Set the new frozen SKY_QA_BUILD_ID and SKY_QA_ENTRY before sampling.');
const durationMs = 15_000;
await mkdir(out, { recursive: true });
const report = { status: 'prepared', url, durationMs, channel: process.env.SKY_QA_CHANNEL ?? 'chrome', headless: false,
  startedAt: new Date().toISOString(), errors: [], consoleErrors: [], samples: [],
  scope: 'Actual whole main requestAnimationFrame callback CPU, renderer CPU and application pacing are separate measurements.',
  limits: ['CPU callback duration is not GPU execution/completion or physically displayed FPS.',
    'Timer precision, JIT, GC, OS scheduling and instrumentation can affect the observed values. A short sample does not prove sustained or 30-minute performance.',
    'Renderer CPU quantiles are its latest 240 render calls; exact main CPU quantiles are the latest 600 identified callbacks, while a bounded histogram describes the full 15s window.'] };
let browser, context, page;

async function instrument(context) {
  await context.addInitScript(() => {
    const nativeRaf = window.requestAnimationFrame.bind(window), now = performance.now.bind(performance);
    const capacity = 600, binWidthMs = .1, ring = new Array(capacity), histogram = new Uint32Array(capacity);
    let mainCallback = null, enabled = false, sequence = 0, retained = 0, identificationReads = 0;
    let startMs = null, endMs = null, cpuTotalMs = 0, cpuMaxMs = 0, wrapperTotalMs = 0, wrapperMaxMs = 0;
    let allWrappedCallbacks = 0, nonMainCallbacks = 0, countAbove6Ms = 0, countAbove10Ms = 0;
    window.requestAnimationFrame = function(callback) {
      return nativeRaf(function(timestamp) {
        allWrappedCallbacks++;
        if (mainCallback && callback !== mainCallback) { nonMainCallbacks++; return callback(timestamp); }
        const learn = !mainCallback && window.skyApp;
        const before = learn ? (++identificationReads, window.skyApp.diagnostics.frameCount) : null;
        const start = now();
        try { return callback(timestamp); }
        finally {
          const finish = now(), cpuMs = finish - start;
          if (learn) {
            const after = (++identificationReads, window.skyApp.diagnostics.frameCount);
            if (after === before + 1) mainCallback = callback;
          }
          if (enabled && mainCallback === callback) {
            sequence++; cpuTotalMs += cpuMs; cpuMaxMs = Math.max(cpuMaxMs, cpuMs);
            if (cpuMs > 6) countAbove6Ms++; if (cpuMs > 10) countAbove10Ms++;
            histogram[Math.min(capacity - 1, Math.floor(cpuMs / binWidthMs))]++;
            ring[(sequence - 1) % capacity] = { sequence, rafTimestampMs: timestamp, enteredMs: start, cpuMs };
            retained = Math.min(capacity, sequence);
            const overhead = now() - finish; wrapperTotalMs += overhead; wrapperMaxMs = Math.max(wrapperMaxMs, overhead);
          }
        }
      });
    };
    window.__qaMainCallbackBudget = {
      get identified() { return !!mainCallback; },
      start() {
        if (!mainCallback) throw new Error('The actual main callback identity has not been observed.');
        ring.fill(undefined); histogram.fill(0); sequence = retained = 0; cpuTotalMs = cpuMaxMs = wrapperTotalMs = wrapperMaxMs = 0;
        countAbove6Ms = countAbove10Ms = 0; startMs = now(); endMs = null; enabled = true;
      },
      stop() { enabled = false; endMs = now(); },
      read() {
        const values = [];
        for (let i = Math.max(1, sequence - retained + 1); i <= sequence; i++) values.push(ring[(i - 1) % capacity]);
        return { identified: !!mainCallback, callbackName: mainCallback?.name ?? null, enabled, startMs, endMs,
          callbackCount: sequence, capacity, retainedSamples: values, histogram: [...histogram], binWidthMs,
          histogramOverflowLowerMs: (capacity - 1) * binWidthMs,
          cpuTotalMs, cpuMeanMs: sequence ? cpuTotalMs / sequence : null, cpuMaxMs, countAbove6Ms, countAbove10Ms,
          bookkeepingTotalMs: wrapperTotalMs, bookkeepingMeanMs: sequence ? wrapperTotalMs / sequence : null, bookkeepingMaxMs: wrapperMaxMs,
          identificationReads, allWrappedCallbacks, nonMainCallbacks,
          instrumentationScope: 'Identify by the real frameCount increment before measurement, then compare callback identity without per-frame diagnostics reads. Callback timers exclude the wrapper bookkeeping; its measured cost is reported separately. performance.now call overhead and global wrapper dispatch are not fully isolated.' };
      },
    };
  });
}
const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics,
  metrics: window.skyApp.metrics, snapshotUt: window.skyApp.snapshot.utDaysJ2000,
  refraction: window.skyApp.rendererDiagnostics?.refraction,
  curves: window.skyApp.rendererDiagnostics?.sphericalArcs,
  moon: window.skyApp.moonLoupeDiagnostics ? { open: window.skyApp.moonLoupeDiagnostics.open, status: window.skyApp.moonLoupeDiagnostics.status } : null }));
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * p)] ?? null; };
function histogramQuantileInterval(probe, q) {
  let count = 0; const wanted = Math.max(1, Math.ceil(probe.callbackCount * q));
  for (let i = 0; i < probe.histogram.length; i++) {
    count += probe.histogram[i];
    if (count >= wanted) return { lowerInclusiveMs: i * probe.binWidthMs, upperExclusiveMs: i === probe.histogram.length - 1 ? null : (i + 1) * probe.binWidthMs };
  }
  return null;
}
try {
  browser = await chromium.launch({ channel: report.channel, headless: false }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1 });
  await instrument(context); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(url); await page.bringToFront(); await page.waitForFunction(() => window.skyApp?.ready);
  report.build = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  assert.equal(report.build.id, expectedBuild); assert.ok(report.build.entries.some(entry => entry.endsWith(`/assets/${expectedEntry}`)));
  await page.evaluate(() => {
    const state = window.skyApp.state; state.time.running = false; state.time.mode = 'simulation'; state.time.rateSimSecondsPerRealSecond = 600;
    state.time.utDaysJ2000 = (Date.parse('2026-09-14T09:55:00Z') - 946728000000) / 86400000;
    state.viewMode = 'ground'; state.presentation = 'explanation'; state.density = 'reference'; state.selected = 'body:Moon';
    state.observer.latitudeDeg = 30.25; state.observer.longitudeDegEast = 120.17; state.observer.heightMeters = 20;
    state.observer.displayZone = { kind: 'fixed', offsetMinutes: 480 };
    state.environment.refraction = 'standard'; state.environment.pressureHpa = 1013.25; state.environment.temperatureC = 15;
    for (const key of Object.keys(state.layers)) state.layers[key] = true;
    state.cameras.ground.azimuthDegNorthEast = 265; state.cameras.ground.altitudeDeg = 12; state.cameras.ground.verticalFovDeg = 75;
    window.skyApp.setState(state); document.querySelector('#sky-teaching').open = true; document.querySelector('#sky-object-day').open = true;
    window.dispatchEvent(new CustomEvent('sky:teaching-visibility')); window.dispatchEvent(new CustomEvent('sky:object-day-visibility'));
  });
  await page.waitForFunction(() => {
    const app = window.skyApp, d = app.diagnostics;
    return !d.scienceDirty && d.lastRenderedUt === app.state.time.utDaysJ2000 && d.assetStatus.pending.length === 0 && d.assetStatus.errors.length === 0 &&
      app.teachingData.solarDayStatus === 'ready' && app.teachingData.objectDayStatus === 'ready';
  }, undefined, { timeout: 30_000 });
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.status === 'ready');
  await page.waitForFunction(() => window.__qaMainCallbackBudget.identified);
  await page.waitForTimeout(400);
  report.environment = await page.evaluate(() => {
    const canvas = document.querySelector('.sky-webgl-canvas'), gl = canvas.getContext('webgl2'), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    return { renderer, vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null, userAgent: navigator.userAgent,
      cssViewport: [innerWidth, innerHeight], backingSize: [canvas.width, canvas.height], hidden: document.hidden,
      classification: /or similar/i.test(renderer) ? 'privacy-masked-device-unverified' : /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer) ? 'software' : renderer === 'unavailable' ? 'unknown' : 'hardware-string-reported' };
  });
  assert.equal(report.environment.hidden, false);
  report.representativeScene = await inspect(page);
  assert.equal(report.representativeScene.diagnostics.workerMode, 'worker'); assert.equal(report.representativeScene.diagnostics.workerCount, 2);
  assert.equal(report.representativeScene.refraction.enabled, true); assert.equal(report.representativeScene.moon.open, true);
  await page.evaluate(() => window.skyApp.play()); await page.waitForTimeout(400);
  report.measurementStart = await page.evaluate(() => {
    const diagnostics = window.skyApp.diagnostics; window.__qaMainCallbackBudget.start();
    return { diagnostics, state: window.skyApp.state, performanceNowMs: performance.now() };
  });
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    report.samples.push(await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, performanceNowMs: performance.now(), hidden: document.hidden })));
  }
  report.measurementEnd = await page.evaluate(() => {
    window.__qaMainCallbackBudget.stop(); const probe = window.__qaMainCallbackBudget.read(), diagnostics = window.skyApp.diagnostics;
    return { probe, diagnostics, metrics: window.skyApp.metrics, state: window.skyApp.state, performanceNowMs: performance.now(), hidden: document.hidden };
  });
  await page.evaluate(() => window.skyApp.pause());
  const probe = report.measurementEnd.probe;
  if (process.env.SKY_QA_REQUIRE_DEFAULT_QUALITY === '1') {
    const qualitySamples = [report.measurementStart.diagnostics, ...report.samples.map(sample => sample.diagnostics), report.measurementEnd.diagnostics]
      .map(value => value.runtimeQuality);
    const defaults = { hideOrdinaryBackLabels: false, hideOrdinarySecondaryLabels: false, ordinaryLabelBudgetScale: 1,
      reduceVerifiedDecoration: false, pixelScale: 1, omitOptionalInvisibleStars: false };
    for (const value of qualitySamples) {
      assert.equal(value?.state.stage, 0, 'Default-quality budget cannot be passed by automatically reducing quality.');
      assert.deepEqual(value.effects, defaults); assert.deepEqual(value.state.history, []);
    }
    report.defaultQualityDuringBudget = { verified: true, checkedSamples: qualitySamples.length, effects: defaults,
      scope: 'Stage 0/effects default at start, each second and end; empty change history proves no intervening automatic quality reduction.' };
  }
  assert.equal(probe.enabled, false); assert.ok(probe.callbackCount > 0); assert.ok(probe.retainedSamples.length <= 600);
  assert.equal(probe.histogram.reduce((sum, value) => sum + value, 0), probe.callbackCount);
  assert.equal(report.measurementEnd.hidden, false); assert.ok(report.samples.every(sample => !sample.hidden));
  const durationSeconds = (probe.endMs - probe.startMs) / 1000;
  const cpuValues = probe.retainedSamples.map(sample => sample.cpuMs);
  report.mainCallbackCpu = { meanAllWindowMs: probe.cpuMeanMs, maxAllWindowMs: probe.cpuMaxMs, callbackCount: probe.callbackCount,
    fullWindowP50IntervalMs: histogramQuantileInterval(probe, .5), fullWindowP95IntervalMs: histogramQuantileInterval(probe, .95), fullWindowP99IntervalMs: histogramQuantileInterval(probe, .99),
    latest600ExactMs: { p50: quantile(cpuValues, .5), p95: quantile(cpuValues, .95), p99: quantile(cpuValues, .99) },
    over6Ms: probe.countAbove6Ms, over10Ms: probe.countAbove10Ms, seconds: durationSeconds,
    fullWindowP95AtMost6ms: probe.countAbove6Ms <= probe.callbackCount - Math.ceil(.95 * probe.callbackCount),
    budgetDecisionScope: 'Exact all-window count above6ms proves/disproves nearest-rank p95≤6ms; histogram interval is not rounded into a pass.' };
  report.rendererCpu = { quantilesMs: report.measurementEnd.diagnostics.rendererCpuFrameMs,
    scope: 'Existing active renderer CPU latest-240 ring, taken at measurement end before pause/capture; not the whole app callback and not GPU time.' };
  report.applicationPacing = { rafIntervalsMs: report.measurementEnd.metrics.frameMs,
    submittedIntervalMs: report.measurementEnd.diagnostics.deliveredFrameMs,
    submittedRenderCount: report.measurementEnd.diagnostics.renderCount - report.measurementStart.diagnostics.renderCount,
    seconds: durationSeconds,
    cpuRendererSubmissionsPerSecond: (report.measurementEnd.diagnostics.renderCount - report.measurementStart.diagnostics.renderCount) / durationSeconds,
    scope: 'Application RAF and renderer CPU submission cadence only; no claim of GPU completion or screen refresh FPS.' };
  report.inputAndWork = { input: 'One existing API play command before the window; no synthetic interaction/extra draw during measurement.',
    scienceRequests: report.measurementEnd.diagnostics.scienceRequestCount - report.measurementStart.diagnostics.scienceRequestCount,
    frames: report.measurementEnd.diagnostics.frameCount - report.measurementStart.diagnostics.frameCount,
    renderSubmissions: report.applicationPacing.submittedRenderCount,
    clockRebases: report.measurementEnd.diagnostics.clockRebaseCount - report.measurementStart.diagnostics.clockRebaseCount,
    workers: report.measurementEnd.diagnostics.workerCount, dayEvents: report.measurementEnd.diagnostics.dayEvents };
  report.instrumentation = { measuredBookkeepingTotalMs: probe.bookkeepingTotalMs, measuredBookkeepingMeanMs: probe.bookkeepingMeanMs,
    measuredBookkeepingMaxMs: probe.bookkeepingMaxMs, approximateMeasuredFractionOfWindow: probe.bookkeepingTotalMs / (durationSeconds * 1000),
    identificationDiagnosticsReads: probe.identificationReads, maxRawSamples: 600, histogramBins: 600,
    limitations: probe.instrumentationScope };
  assert.deepEqual(report.errors, []); assert.equal(report.consoleErrors.filter(message => /shader|webgl|gl_invalid/i.test(message)).length, 0);
  report.status = report.mainCallbackCpu.fullWindowP95AtMost6ms ? 'passed-short-main-cpu-budget' : 'failed-short-main-cpu-budget';
  if (!report.mainCallbackCpu.fullWindowP95AtMost6ms) process.exitCode = 1;
  await page.screenshot({ path: resolve(out, 'representative-scene-after-window.png') });
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
} finally {
  if (context) await context.close(); if (browser) await browser.close(); report.browserClosed = true;
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), main: report.mainCallbackCpu, renderer: report.rendererCpu, failure: report.failure?.message }));
