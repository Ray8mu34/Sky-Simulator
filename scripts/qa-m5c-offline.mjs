import { chromium, firefox } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runM5aOfflineSmoke } from './qa-m5a.mjs';
import { installGraphicsProbe, waitGraphicsReady } from './qa-m4a.mjs';
import { installSnapshotTransferProbe, assertSnapshotTransfers } from './qa-snapshot-transfer.mjs';

const channel = process.env.SKY_QA_CHANNEL ?? 'chrome';
const out = resolve(process.env.SKY_QA_OUT_DIR ?? `qa/final-m5c/${channel}-offline`);
const artifact = resolve(process.env.SKY_QA_PORTABLE_PATH ?? 'dist-portable/三维全景夜空.html');
const expectedSha = process.env.SKY_QA_PORTABLE_SHA256;
assert.match(expectedSha ?? '', /^[0-9a-f]{64}$/i, 'Set SKY_QA_PORTABLE_SHA256 to the frozen root artifact hash.');
const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex'); assert.equal(sha256, expectedSha.toLowerCase());
if (channel === 'firefox') assert.equal(resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''), resolve('.qa-browsers'));
await mkdir(out, { recursive: true });
const report = { status: 'running', channel, headless: process.env.SKY_QA_HEADED !== '1', startedAt: new Date().toISOString(),
  artifact: { path: artifact, sha256, bytes: (await stat(artifact)).size }, checks: [], paths: [], httpRequests: [], errors: [], consoleErrors: [], screenshots: [],
  limits: ['Named Windows browser and real WebGL context-loss fault injection; not macOS Safari, a physical phone, GPU accuracy/FPS, cold budget or a 30-minute run.',
    'Snapshot fallback is budgeted synchronous core; day fallback is the same-core cooperative generator. No prior large update matrix is repeated.'] };
let browser, context, page;
const inspect = page => page.evaluate(() => {
  const app = window.skyApp, interaction = app.rendererDiagnostics;
  return { state: app.state, snapshot: app.snapshot, details: app.selectedDetails, teaching: app.teachingData,
    diagnostics: app.diagnostics, graphics: app.graphicsStatus, metrics: app.metrics,
    renderer: { refraction: interaction?.refraction, kind: interaction?.rendererKind ?? 'webgl2',
      actualDisplayViewMode: interaction?.actualDisplayViewMode, sourceStateViewMode: interaction?.sourceStateViewMode,
      selectedDirectionEqj: interaction?.selectedDirectionEqj, selectedProjectedNdc: interaction?.selectedProjectedNdc,
      selectedApparentAboveHorizon: interaction?.selectedApparentAboveHorizon },
    appearanceFrame: app.skyAppearanceDiagnostics?.displayFrame,
    probe: { created: window.__qaWorkersCreated, transfers: window.__qaSnapshotTransfers, replies: window.__qaSnapshotReplies },
    graphicsProbe: window.__qaGraphicsProbe };
});
async function paired() {
  await page.waitForFunction(() => {
    const app = window.skyApp, d = app?.diagnostics, s = app?.state, descriptor = app?.snapshot?.observerRefraction;
    return app?.ready && !d.scienceDirty && d.lastRenderedUt === s.time.utDaysJ2000 && app.snapshot.utDaysJ2000 === s.time.utDaysJ2000 &&
      d.snapshotInputSignature === d.currentInputSignature && descriptor?.mode === s.environment.refraction &&
      descriptor.pressureHpa === s.environment.pressureHpa && descriptor.temperatureC === s.environment.temperatureC &&
      document.querySelector('#sky-refraction')?.dataset.refractionStatus === 'ready';
  }, undefined, { timeout: 20_000 });
}
async function shot(name) {
  await paired(); const path = resolve(out, name); await page.screenshot({ path }); report.screenshots.push(path);
}
function assertNoEventCompute(before, after) {
  assert.deepEqual(after.teaching.solarDay, before.teaching.solarDay); assert.deepEqual(after.teaching.objectDay, before.teaching.objectDay);
  assert.equal(after.teaching.solarDayKey, before.teaching.solarDayKey); assert.equal(after.teaching.objectDayKey, before.teaching.objectDayKey);
  assert.equal(after.diagnostics.dayEvents.startedCount, before.diagnostics.dayEvents.startedCount);
  assert.equal(after.diagnostics.dayEvents.cache.computations, before.diagnostics.dayEvents.cache.computations);
}
function assertBackendSwitch(before, after) {
  assert.deepEqual(after.state, before.state); assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.details, before.details);
  assert.equal(after.diagnostics.scienceRequestCount, before.diagnostics.scienceRequestCount);
  assert.equal(after.diagnostics.clockRebaseCount, before.diagnostics.clockRebaseCount); assertNoEventCompute(before, after);
  assert.equal(after.diagnostics.graphics.activeRendererCount, 1); assert.equal(after.graphicsProbe.uniqueSuccessfulContexts, 1);
}
async function runPath(forceFallback) {
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1 });
  await installGraphicsProbe(context, false); await installSnapshotTransferProbe(context);
  await context.setOffline(true); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) report.httpRequests.push(request.url()); });
  const fileUrl = `${pathToFileURL(artifact).href}${forceFallback ? '?worker=off' : ''}`;
  await page.goto(fileUrl); await page.waitForFunction(() => window.skyApp?.ready); await waitGraphicsReady(page, 'webgl2');
  const path = { forceFallback, fileUrl, freshContextOfflineBeforeFirstOpen: true, samples: [], contextRecovery: null };
  path.firstOpen = await inspect(page); assert.equal(report.httpRequests.length, 0);
  if (!report.environment) report.environment = await page.evaluate(() => {
    const gl = document.querySelector('.sky-webgl-canvas').getContext('webgl2'), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    return { userAgent: navigator.userAgent, renderer,
      classification: /or similar/i.test(renderer) ? 'privacy-masked-device-unverified' : /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer) ? 'software' : renderer === 'unavailable' ? 'unknown' : 'hardware-string-reported',
      scope: 'Browser renderer string only; no physical-device performance conclusion.' };
  });
  await runM5aOfflineSmoke({ page }); await paired();
  await page.locator('#sky-refraction').evaluate(section => { section.open = true; });
  for (const [mode, pressureHpa, temperatureC] of [['standard', 1013.25, 15], ['standard', 0, 80], ['none', 1010, 10]]) {
    const before = await inspect(page);
    await page.locator('#sky-refraction-mode').selectOption(mode); await page.locator('#sky-pressure').fill(String(pressureHpa));
    await page.locator('#sky-temperature').fill(String(temperatureC)); await page.locator('#sky-apply-refraction').click(); await paired();
    const after = await inspect(page), expectedState = structuredClone(before.state);
    Object.assign(expectedState.environment, { refraction: mode, pressureHpa, temperatureC });
    assert.deepEqual(after.state, expectedState); assert.equal(after.diagnostics.scienceRequestCount, before.diagnostics.scienceRequestCount + 1);
    assert.equal(after.diagnostics.clockRebaseCount, before.diagnostics.clockRebaseCount); assertNoEventCompute(before, after);
    assert.deepEqual(after.renderer.refraction.descriptor, after.snapshot.observerRefraction);
    assert.equal(after.renderer.refraction.identity, mode === 'none' || pressureHpa === 0);
    assert.equal(after.renderer.refraction.residentTextureCount, 1); assert.equal(after.renderer.refraction.textureBytes, 32768);
    path.samples.push(after);
  }
  await shot(`${forceFallback ? 'fallback' : 'worker'}-none.png`);
  await page.locator('#sky-refraction-mode').selectOption('standard'); await page.locator('#sky-pressure').fill('1013.25');
  await page.locator('#sky-temperature').fill('15'); await page.locator('#sky-apply-refraction').click(); await paired();
  await shot(`${forceFallback ? 'fallback' : 'worker'}-standard.png`);
  await page.locator('[data-view="space"]').click(); await waitGraphicsReady(page, 'webgl2'); await paired();
  const beforeLoss = await inspect(page); assert.equal(beforeLoss.renderer.refraction.identity, true);
  await page.evaluate(() => {
    window.__qaOriginalCanvas = document.querySelector('.sky-webgl-canvas'); window.__qaOriginalGl = window.__qaOriginalCanvas.getContext('webgl2');
    window.__qaLoseContext = window.__qaOriginalGl.getExtension('WEBGL_lose_context');
    if (!window.__qaLoseContext) throw new Error('Native WEBGL_lose_context is unavailable.');
    window.__qaLoseContext.loseContext();
  });
  await waitGraphicsReady(page, 'canvas2d'); await paired();
  const lost = await inspect(page); assertBackendSwitch(beforeLoss, lost);
  assert.equal(lost.renderer.refraction.identity, false); assert.deepEqual(lost.renderer.refraction.descriptor, lost.snapshot.observerRefraction);
  assert.equal(lost.renderer.sourceStateViewMode, 'space'); assert.equal(lost.renderer.actualDisplayViewMode, 'ground');
  assert.equal(lost.appearanceFrame, 'observer-standard-refraction-horizon');
  assert.equal(lost.diagnostics.lastRenderedEffectiveView, 'ground'); assert.equal(lost.teaching.moon.perspective, 'topocentric');
  assert.equal(lost.renderer.refraction.canvasOwnedLutCopies, 0); assert.equal(lost.renderer.refraction.textureCount, 0);
  assert.equal(lost.diagnostics.graphics.retainedWebglInstanceCount, 1);
  const capture = await page.evaluate(() => window.skyApp.capture()); assert.ok(capture.startsWith('data:image/png;base64,'));
  path.canvasCaptureBytes = Buffer.from(capture.split(',')[1], 'base64').length; assert.ok(path.canvasCaptureBytes > 1000);
  await shot(`${forceFallback ? 'fallback' : 'worker'}-context-lost-canvas.png`);
  await page.evaluate(() => window.__qaLoseContext.restoreContext()); await waitGraphicsReady(page, 'webgl2'); await paired();
  const restored = await inspect(page); assertBackendSwitch(beforeLoss, restored);
  assert.equal(restored.renderer.refraction.identity, true); assert.equal(restored.teaching.moon.perspective, 'geocentric');
  assert.equal(restored.diagnostics.graphics.webglCanvasIdentity, beforeLoss.diagnostics.graphics.webglCanvasIdentity);
  assert.equal(restored.diagnostics.graphics.fallbackInstanceCount, 0);
  assert.equal(await page.evaluate(() => document.querySelector('.sky-webgl-canvas') === window.__qaOriginalCanvas &&
    window.__qaOriginalCanvas.getContext('webgl2') === window.__qaOriginalGl), true);
  await page.locator('[data-view="ground"]').click(); await waitGraphicsReady(page, 'webgl2'); await paired();
  const groundRestored = await inspect(page); assert.equal(groundRestored.renderer.refraction.enabled, true);
  assert.equal(groundRestored.renderer.refraction.textureId, path.samples[0].renderer.refraction.textureId);
  assert.equal(groundRestored.renderer.refraction.residentTextureCount, 1);
  assert.equal(groundRestored.diagnostics.scienceRequestCount, beforeLoss.diagnostics.scienceRequestCount);
  assert.equal(groundRestored.diagnostics.clockRebaseCount, beforeLoss.diagnostics.clockRebaseCount);
  assertSnapshotTransfers(groundRestored.probe, forceFallback); path.contextRecovery = { beforeLoss, lost, restored, groundRestored };
  await shot(`${forceFallback ? 'fallback' : 'worker'}-same-context-restored.png`);
  report.paths.push(path); assert.equal(report.httpRequests.length, 0); await context.close(); context = null; page = null;
}

try {
  browser = await (channel === 'firefox' ? firefox : chromium).launch({ headless: report.headless, ...(channel === 'firefox' ? {} : { channel }) });
  report.browserVersion = browser.version(); await runPath(false); await runPath(true);
  const normalized = ({ requestId, ...snapshot }) => snapshot;
  for (let index = 0; index < report.paths[0].samples.length; index++) {
    const worker = report.paths[0].samples[index], fallback = report.paths[1].samples[index];
    assert.deepEqual(normalized(fallback.snapshot), normalized(worker.snapshot)); assert.deepEqual(fallback.details, worker.details);
    assert.deepEqual(fallback.teaching, worker.teaching);
  }
  assert.deepEqual(report.errors, []); assert.equal(report.httpRequests.length, 0);
  assert.equal(report.consoleErrors.filter(message => /shader|webgl|gl_invalid|compile_status|link_status/i.test(message)).length, 0);
  report.checks.push('Two fresh contexts were offline before first file open, with no HTTP requests; native two workers and forced zero-worker fallback.',
    'Actual form applies standard/P0/none through one new paired snapshot and no clock rebase/day-event recomputation; complete snapshots, details and teaching match exactly between core paths.',
    'Native snapshot messages have only five refraction scalar metadata fields and a 3×3 ECT matrix, no LUT/ArrayBuffer/typed-array catalog transfer.',
    'Real context loss preserves state, all cameras, snapshot, event results and clock; native Canvas2D applies the saved local profile to an effective-ground chart while canonical view remains space.',
    'Real restoration reuses the original native GL context/canvas and single 32KiB profile texture; external geometry is identity, returning ground applies the same profile again, and 2D PNG capture succeeds.');
  report.status = 'passed-targeted-offline-refraction-checks';
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) { report.lastObserved = await inspect(page).catch(() => null); await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {}); }
} finally {
  if (context) await context.close(); if (browser) await browser.close(); report.browserClosed = true;
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, channel, report: resolve(out, 'report.json'), failure: report.failure?.message }));
