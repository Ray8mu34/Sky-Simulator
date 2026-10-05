import { firefox } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runM5aOfflineSmoke } from './qa-m5a.mjs';
import { installGraphicsProbe, waitGraphicsReady } from './qa-m4a.mjs';
import { installSnapshotTransferProbe } from './qa-snapshot-transfer.mjs';

// One diagnostic attempt, not a replacement for the original failed matrix.
const artifact = resolve('dist-portable/三维全景夜空.html');
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/final-release-night/firefox-diagnostic-01');
const expectedSha = process.env.SKY_QA_PORTABLE_SHA256;
assert.match(expectedSha ?? '', /^[a-f0-9]{64}$/i);
assert.equal(resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''), resolve('.qa-browsers'));
const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
assert.equal(sha256, expectedSha.toLowerCase());
await assert.rejects(access(resolve(out, 'report.json')), { code: 'ENOENT' }, 'Use a new diagnostic output directory.');
await mkdir(out, { recursive: true });
const sourceFiles = ['src/main.ts', 'src/render/SkyRenderer.ts', 'src/render/shaders.ts', 'src/ui/controls.ts', 'src/ui/refraction-controls.ts'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
  createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running-diagnostic', startedAt: new Date().toISOString(),
  artifact: { path: artifact, sha256, bytes: (await stat(artifact)).size },
  channel: 'firefox', headed: true, originalFailure: resolve('qa/final-release-night/firefox-offline/report.json'),
  sourceBefore: await sourceHashes(), steps: [], errors: [], consoleErrors: [], httpRequests: [], pageEvents: [],
  limits: ['One native-worker fresh-context diagnostic; no forced click, no noWaitAfter, no timeout extension, no whole-matrix retry.',
    'DOM event listeners, bounded trace and per-step screenshot/readPixels/toDataURL observations may change timing; this is not a performance measurement.',
    'Raw pixels are read only from the existing native context, without requesting another app render or rebinding its framebuffer.',
    'A non-reproduction does not replace the first Firefox failure or establish the full new-package Firefox matrix.'] };
let browser, context, page, traceStarted = false;
const save = async () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));

async function observe(label) {
  const raw = await page.evaluate(() => {
    const app = window.skyApp, canvas = document.querySelector('.sky-webgl-canvas');
    const button = document.querySelector('#sky-apply-refraction');
    const rect = button?.getBoundingClientRect();
    const centre = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
    const describe = element => element ? { tag: element.tagName, id: element.id, className: String(element.className),
      text: element.textContent?.trim().slice(0, 100) } : null;
    const style = canvas ? getComputedStyle(canvas) : null;
    const gl = canvas?.getContext('webgl2');
    let glFacts = null, rawCanvasPng = null;
    if (gl) {
      const samplePixels = [];
      const readFramebufferIsDefault = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === null;
      if (!gl.isContextLost() && readFramebufferIsDefault) {
        for (const [u, v] of [[.15, .2], [.4, .3], [.6, .5], [.75, .7], [.9, .9]]) {
          const pixel = new Uint8Array(4);
          const x = Math.min(gl.drawingBufferWidth - 1, Math.floor(gl.drawingBufferWidth * u));
          const y = Math.min(gl.drawingBufferHeight - 1, Math.floor(gl.drawingBufferHeight * v));
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          samplePixels.push({ x, y, rgba: [...pixel] });
        }
      }
      glFacts = { contextLost: gl.isContextLost(), attributes: gl.getContextAttributes(), readFramebufferIsDefault,
        drawingBufferWidth: gl.drawingBufferWidth, drawingBufferHeight: gl.drawingBufferHeight, samplePixels };
      rawCanvasPng = canvas.toDataURL('image/png');
    }
    return { performanceMs: performance.now(), document: { hidden: document.hidden, visibilityState: document.visibilityState,
        focused: document.hasFocus(), activeElement: describe(document.activeElement) },
      button: { describe: describe(button), rect: rect?.toJSON(), disabled: button?.disabled, centreElement: describe(centre),
        computed: button ? { opacity: getComputedStyle(button).opacity, pointerEvents: getComputedStyle(button).pointerEvents,
          display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility } : null },
      form: { mode: document.querySelector('#sky-refraction-mode')?.value, pressure: document.querySelector('#sky-pressure')?.value,
        temperature: document.querySelector('#sky-temperature')?.value, status: document.querySelector('#sky-refraction')?.dataset.refractionStatus,
        text: document.querySelector('#sky-refraction-status')?.textContent },
      canvas: canvas ? { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON(),
        opacity: style.opacity, display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
        parentOpacity: getComputedStyle(canvas.parentElement).opacity } : null,
      gl: glFacts, rawCanvasPng,
      state: app?.state, snapshot: app?.snapshot, details: app?.selectedDetails, teaching: app?.teachingData,
      diagnostics: app?.diagnostics, graphics: app?.graphicsStatus, rendererRefraction: app?.rendererDiagnostics?.refraction,
      graphicsProbe: window.__qaGraphicsProbe, nativeWorkerProbe: { created: window.__qaWorkersCreated,
        transfers: window.__qaSnapshotTransfers, replies: window.__qaSnapshotReplies },
      eventTrace: window.__qaEventLog, eventCounts: window.__qaEventCounts };
  });
  if (raw.rawCanvasPng) {
    const bytes = Buffer.from(raw.rawCanvasPng.split(',')[1], 'base64');
    const file = resolve(out, `${label}-raw-canvas.png`); await writeFile(file, bytes);
    raw.rawCanvas = { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    delete raw.rawCanvasPng;
  }
  return raw;
}
async function checkpoint(label) {
  const raw = await observe(label);
  const path = resolve(out, `${label}.json`); await writeFile(path, JSON.stringify(raw, null, 2));
  report.steps.push({ label, path, observedPerformanceMs: raw.performanceMs });
  await save(); // Save raw evidence before screenshot or the next native action.
  await page.screenshot({ path: resolve(out, `${label}.png`) });
  return raw;
}
async function paired() {
  await page.waitForFunction(() => {
    const app = window.skyApp, d = app?.diagnostics, state = app?.state, profile = app?.snapshot?.observerRefraction;
    return app?.ready && !d.scienceDirty && d.lastRenderedUt === state.time.utDaysJ2000 &&
      app.snapshot.utDaysJ2000 === state.time.utDaysJ2000 && d.snapshotInputSignature === d.currentInputSignature &&
      profile?.mode === state.environment.refraction && profile.pressureHpa === state.environment.pressureHpa &&
      profile.temperatureC === state.environment.temperatureC && document.querySelector('#sky-refraction')?.dataset.refractionStatus === 'ready';
  }, undefined, { timeout: 20_000 });
}
function verifyApply(before, after, mode, pressureHpa, temperatureC) {
  const expectedState = structuredClone(before.state);
  Object.assign(expectedState.environment, { refraction: mode, pressureHpa, temperatureC });
  assert.deepEqual(after.state, expectedState);
  assert.equal(after.diagnostics.scienceRequestCount, before.diagnostics.scienceRequestCount + 1);
  assert.equal(after.diagnostics.clockRebaseCount, before.diagnostics.clockRebaseCount);
  assert.deepEqual(after.teaching.solarDay, before.teaching.solarDay); assert.deepEqual(after.teaching.objectDay, before.teaching.objectDay);
  assert.equal(after.diagnostics.dayEvents.cache.computations, before.diagnostics.dayEvents.cache.computations);
  assert.deepEqual(after.rendererRefraction.descriptor, after.snapshot.observerRefraction);
  assert.equal(after.rendererRefraction.identity, mode === 'none' || pressureHpa === 0);
}
async function nativeApply(label, mode, pressureHpa, temperatureC) {
  const before = await checkpoint(`${label}-before-draft`);
  await page.locator('#sky-refraction-mode').selectOption(mode);
  await page.locator('#sky-pressure').fill(String(pressureHpa));
  await page.locator('#sky-temperature').fill(String(temperatureC));
  await checkpoint(`${label}-before-click`);
  report.activeStep = `${label}-native-click`; await save();
  // Original Playwright default timeout: 30 seconds. No forced/noWaitAfter click.
  await page.locator('#sky-apply-refraction').click();
  await checkpoint(`${label}-click-returned`);
  await paired(); const after = await checkpoint(`${label}-paired`);
  verifyApply(before, after, mode, pressureHpa, temperatureC);
  report.activeStep = null; await save(); return after;
}

try {
  await save(); browser = await firefox.launch({ headless: false }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1 });
  await installGraphicsProbe(context, false); await installSnapshotTransferProbe(context);
  await context.addInitScript(() => {
    window.__qaEventLog = []; window.__qaEventCounts = {};
    const describe = element => element instanceof Element ? `${element.tagName.toLowerCase()}#${element.id}.${String(element.className).slice(0, 64)}` : String(element);
    const record = (event, listenerPhase) => {
      const name = `${event.type}:${listenerPhase}`;
      window.__qaEventCounts[name] = (window.__qaEventCounts[name] ?? 0) + 1;
      const row = { type: event.type, listenerPhase, eventPhase: event.eventPhase, isTrusted: event.isTrusted,
        performanceMs: performance.now(), timeStamp: event.timeStamp, defaultPrevented: event.defaultPrevented,
        target: describe(event.target), activeElement: describe(document.activeElement),
        clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType,
        button: event.button, detail: typeof event.detail === 'number' ? event.detail : undefined,
        hidden: document.hidden, visibilityState: document.visibilityState };
      if (event.type === 'submit' || event.type === 'click') row.stateEnvironment = window.skyApp?.state.environment;
      window.__qaEventLog.push(row); if (window.__qaEventLog.length > 384) window.__qaEventLog.shift();
    };
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'submit', 'focus', 'blur', 'focusin', 'focusout']) {
      document.addEventListener(type, event => record(event, 'capture'), true);
      document.addEventListener(type, event => record(event, 'bubble'));
    }
    for (const type of ['visibilitychange', 'webglcontextlost', 'webglcontextrestored']) document.addEventListener(type, event => record(event, 'capture'), true);
    for (const type of ['focus', 'blur', 'pagehide', 'pageshow']) window.addEventListener(type, event => record(event, 'window'));
  });
  await context.setOffline(true);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); traceStarted = true;
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) report.httpRequests.push(request.url()); });
  for (const name of ['close', 'crash', 'framenavigated']) page.on(name, frame => report.pageEvents.push({ name, utc: new Date().toISOString(), url: frame?.url?.() ?? page.url() }));
  report.fileUrl = pathToFileURL(artifact).href; report.freshContextOfflineBeforeFile = true;
  await page.goto(report.fileUrl); await page.waitForFunction(() => window.skyApp?.ready); await waitGraphicsReady(page, 'webgl2');
  await checkpoint('01-first-file');
  await runM5aOfflineSmoke({ page }); await paired(); await checkpoint('02-after-same-m5a-smoke');
  await page.locator('#sky-refraction').evaluate(section => { section.open = true; });
  await nativeApply('03-standard', 'standard', 1013.25, 15);
  await nativeApply('04-p0-second-click', 'standard', 0, 80);
  report.reproduction = 'Original second-click timeout not reproduced in this one instrumented diagnostic.';
  await save();
  // Continue only the same-context tuple closure, not native/fallback/loss matrix retries.
  await nativeApply('05-none-closure', 'none', 1010, 10);
  assert.deepEqual(report.errors, []); assert.equal(report.httpRequests.length, 0);
  report.status = 'completed-diagnostic-original-failure-not-reproduced';
} catch (error) {
  report.status = 'failed-diagnostic'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.failureCheckpoint = await checkpoint('failure-observation').then(raw => ({ frameCount: raw.diagnostics?.frameCount,
      renderCount: raw.diagnostics?.renderCount, environment: raw.state?.environment, gl: raw.gl, form: raw.form })).catch(observeError => ({ error: observeError.message }));
  }
} finally {
  if (traceStarted) { await context.tracing.stop({ path: resolve(out, 'trace.zip') }).catch(error => { report.traceStopError = error.message; }); }
  if (context) await context.close(); if (browser) await browser.close();
  report.browserClosed = true; report.sourceAfter = await sourceHashes();
  report.sourceStable = JSON.stringify(report.sourceAfter) === JSON.stringify(report.sourceBefore);
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), activeStep: report.activeStep,
  failure: report.failure?.message, sourceStable: report.sourceStable, browserClosed: report.browserClosed }));
