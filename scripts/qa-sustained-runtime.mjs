import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startUpdateServer } from './qa-update-server.mjs';

// Reproducible bounded native-browser run. A baseline package is copied once so
// concurrent implementation/builds cannot silently change its recorded identity.
const runTag = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const out = resolve(process.env.SKY_QA_OUT_DIR ?? `qa/teaching-resilience/sustained-${runTag}`);
const durationMs = Number(process.env.SKY_QA_DURATION_MS ?? 30 * 60 * 1000);
const intervalMs = Number(process.env.SKY_QA_SAMPLE_MS ?? 60 * 1000);
assert.ok(durationMs >= 1000 && durationMs <= 60 * 60 * 1000);
assert.ok(intervalMs >= 1000 && intervalMs <= 60 * 1000);
await mkdir(out, { recursive: true });
const frozen = resolve(out, 'frozen-web');
await cp(resolve(process.env.SKY_QA_BUILD_DIR ?? 'dist'), frozen, { recursive: true, force: false, errorOnExist: true });
const html = await readFile(resolve(frozen, 'index.html'), 'utf8');
const buildId = html.match(/name="sky-build-id" content="([^"]+)"/)?.[1];
assert.ok(buildId, 'Frozen package needs a build identity');
const report = { status: 'running', startedAt: new Date().toISOString(), durationMs, intervalMs, buildId,
  packageSource: resolve(process.env.SKY_QA_BUILD_DIR ?? 'dist'), frozen, headless: true,
  limits: ['One desktop Windows browser and synthetic scene schedule; no physical mobile or Safari coverage.',
    'Runtime counters and JS heap are browser-reported evidence, not measured GPU memory or frame-rate certification.',
    'Pause checkpoints check exact shared UT after science settles; live playback legitimately permits pending science requests.',
    'Concurrent local work may affect timing. No forced garbage collection or CPU throttling is used.'],
  samples: [], pageErrors: [], consoleErrors: [] };
let browser, context, server;
const persist = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const ready = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty
  && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000
  && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode
  && window.skyApp.diagnostics.assetStatus.pending.length === 0, undefined, { timeout: 90000 });
try {
  server = await startUpdateServer({ frozen }); server.select('/stability/', 'frozen');
  browser = await chromium.launch({ channel: process.env.SKY_QA_CHANNEL ?? 'chrome', headless: true });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(`${server.origin}/stability/`); await ready(page);
  report.environment = await page.evaluate(() => {
    const gl = document.querySelector('.sky-webgl-canvas')?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, hidden: document.hidden,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      buildId: document.querySelector('meta[name="sky-build-id"]')?.content };
  });
  assert.equal(report.environment.buildId, buildId); assert.equal(report.environment.hidden, false);
  const started = Date.now(); let sampleIndex = 0;
  while (true) {
    const mode = ['ground', 'space', 'globe', 'horizon'][sampleIndex % 4];
    await page.evaluate(() => window.skyApp.pause());
    await page.locator(`[data-view="${mode}"]`).click(); await ready(page);
    await page.waitForFunction(() => window.skyApp.diagnostics.viewTransition?.phase === 'idle');
    const sample = await page.evaluate(() => {
      const a = window.skyApp, d = a.diagnostics;
      return { elapsedMs: performance.now(), mode: a.state.viewMode, renderedMode: d.lastRenderedMode,
        stateUt: a.state.time.utDaysJ2000, snapshotUt: a.snapshot.utDaysJ2000, renderedUt: d.lastRenderedUt,
        hidden: document.hidden, graphicsKind: d.graphics.activeKind, metrics: a.metrics,
        counters: { frame: d.frameCount, render: d.renderCount, science: d.scienceRequestCount, workers: d.workerCount,
          activeRequests: d.activeRequestCount, pendingRequests: d.pendingLatestRequestCount },
        assets: d.assetStatus, qualityStage: d.runtimeQuality.state.stage,
        qualitySamples: d.runtimeQuality.sampling.sampleCount,
        renderer: a.rendererDiagnostics };
    });
    sample.wallElapsedMs = Date.now() - started;
    assert.equal(sample.mode, sample.renderedMode); assert.equal(sample.stateUt, sample.snapshotUt);
    assert.equal(sample.stateUt, sample.renderedUt); assert.equal(sample.hidden, false);
    assert.equal(sample.graphicsKind, 'webgl2'); assert.ok(sample.counters.workers <= 2);
    assert.equal(sample.counters.pendingRequests, 0); assert.deepEqual(sample.assets.errors, []);
    assert.ok(sample.qualitySamples <= 600);
    report.samples.push(sample); await persist();
    console.log(`checkpoint ${sampleIndex}: ${mode}, ${Math.round(sample.wallElapsedMs / 1000)} s, textures ${sample.metrics.textureCount}, geometries ${sample.metrics.geometryCount}`);
    if (Date.now() - started >= durationMs) break;
    await page.locator('[data-action="play"]').click();
    await page.waitForFunction(() => window.skyApp.state.time.running);
    await page.waitForTimeout(Math.min(intervalMs, Math.max(0, durationMs - (Date.now() - started))));
    sampleIndex++;
  }
  await page.screenshot({ path: resolve(out, 'final.png') });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  const sameView = ['ground', 'space', 'globe', 'horizon'].map(mode => {
    const samples = report.samples.filter(sample => sample.mode === mode), first = samples[1] ?? samples[0], last = samples.at(-1);
    if (!first) return null;
    return { mode, samples: samples.length, postWarmupTextureDelta: last.metrics.textureCount - first.metrics.textureCount,
      postWarmupGeometryDelta: last.metrics.geometryCount - first.metrics.geometryCount,
      firstHeapBytes: first.metrics.mainThreadJsHeapBytes, lastHeapBytes: last.metrics.mainThreadJsHeapBytes };
  }).filter(Boolean);
  report.resourceComparison = sameView;
  for (const item of sameView) { assert.equal(item.postWarmupTextureDelta, 0); assert.equal(item.postWarmupGeometryDelta, 0); }
  report.actualDurationMs = Date.now() - started;
  report.status = 'passed-bounded-native-runtime';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close(); await server?.close();
  report.finishedAt = new Date().toISOString(); report.allOwnedProcessesClosed = true; await persist();
  console.log(JSON.stringify({ status: report.status, buildId, report: resolve(out, 'report.json') }));
}
