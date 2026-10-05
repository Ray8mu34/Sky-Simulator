import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Functional scheduling evidence only. Controlled throttling is never a device budget result.
const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m6-platform/main-quality-development');
const expectedBuild = process.env.SKY_QA_BUILD_ID;
const expectedEntry = process.env.SKY_QA_ENTRY;
const sourcePaths = ['src/main.ts', 'src/platform/runtime-quality-contract.ts', 'src/platform/runtime-quality.ts',
  'src/platform/runtime-quality-sampling.ts', 'src/platform/graphics-host.ts', 'src/platform/day-event-service.ts',
  'src/ui/view-transition.ts', 'src/render/SkyRenderer.ts', 'src/render/CanvasSkyRenderer.ts'];
const identities = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
await mkdir(out, { recursive: true });
const report = { status: 'prepared', startedAt: new Date().toISOString(), url, channel: 'chrome', headless: false,
  scope: 'Actual main quality scheduling and exclusions; one controlled 4x CPU-throttling trigger, no FPS or device budget conclusion.',
  limits: ['No production QA setter or changed thresholds. Recovery/hysteresis are additionally covered by pure controller tests.',
    'A short controlled CPU-throttling path does not prove actual device performance or 30-minute stability.'],
  sourceBefore: await identities(), cases: [], errors: [], consoleErrors: [] };
let browser, context;
const poll = async (probe, description, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${description}`);
};
const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics,
  renderer: window.skyApp.rendererDiagnostics, snapshotUt: window.skyApp.snapshot?.utDaysJ2000,
  build: { id: document.querySelector('meta[name="sky-build-id"]')?.content,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) },
  hidden: document.hidden, token: window.__qualityDocumentToken }));
const rawSample = value => ({ performanceNowMs: value.diagnostics.performanceNowMs,
  frameCount: value.diagnostics.frameCount, renderCount: value.diagnostics.renderCount,
  scienceRequestCount: value.diagnostics.scienceRequestCount, activeRequestCount: value.diagnostics.activeRequestCount,
  runtimeQuality: value.diagnostics.runtimeQuality });
async function open(fallback = false) {
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { window.__qualityDocumentToken = crypto.randomUUID(); });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const actualUrl = new URL(url); if (fallback) actualUrl.searchParams.set('worker', 'off');
  await page.goto(actualUrl.href); await page.bringToFront();
  await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty
    && window.skyApp.diagnostics.assetStatus.pending.length === 0, undefined, { timeout: 30_000 });
  const initial = await inspect(page);
  initial.environment = await page.evaluate(() => {
    const canvas = document.querySelector('.sky-webgl-canvas'), gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    return { userAgent: navigator.userAgent, renderer, classification: /or similar/i.test(renderer) ? 'privacy-masked-device-unverified'
      : /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer) ? 'software' : renderer === 'unavailable' ? 'unknown' : 'hardware-string-reported' };
  });
  if (expectedBuild) assert.equal(initial.build.id, expectedBuild);
  if (expectedEntry) assert.ok(initial.build.entries.some(entry => entry.endsWith(`/assets/${expectedEntry}`)));
  assert.equal(initial.hidden, false);
  await page.evaluate(() => {
    const state = window.skyApp.state; state.time.running = false; state.time.mode = 'simulation';
    state.time.rateSimSecondsPerRealSecond = 600; state.viewMode = 'ground';
    window.skyApp.setState(state);
  });
  await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty);
  return { page, initial };
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
  {
    const { page, initial } = await open();
    const rawSamples = [];
    await page.evaluate(() => window.skyApp.play());
    await poll(async () => {
      const value = await inspect(page); rawSamples.push(rawSample(value));
      const d = value.diagnostics.runtimeQuality;
      return d.sampling.lastWindow?.eligibleActiveMs >= 1500 && d.sampling.lastWindow?.eligibleSamples >= 8;
    }, 'native worker eligible window');
    const after = await inspect(page);
    assert.equal(after.diagnostics.runtimeQuality.state.stage, 0);
    assert.equal(after.diagnostics.runtimeQuality.effects.pixelScale, 1);
    assert.ok(after.diagnostics.runtimeQuality.sampling.sampleCount <= 600);
    assert.equal(after.token, initial.token);
    await page.evaluate(() => window.skyApp.pause());
    await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty);
    await page.waitForTimeout(100);
    const idle = await inspect(page); await page.waitForTimeout(150);
    assert.equal((await inspect(page)).diagnostics.frameCount, idle.diagnostics.frameCount);
    report.cases.push({ name: 'native-baseline-eligible-holds-default-and-paused-idle', initial, after, idle, rawSamples });
    await context.close(); context = null;
  }
  {
    const { page, initial } = await open(true);
    const rawSamples = [];
    await page.evaluate(() => window.skyApp.play());
    for (let i = 0; i < 5; i++) { await page.waitForTimeout(900); rawSamples.push(rawSample(await inspect(page))); }
    const after = await inspect(page), q = after.diagnostics.runtimeQuality;
    assert.equal(after.diagnostics.workerMode, 'main-thread-budgeted');
    assert.equal(q.state.stage, 0); assert.equal(q.sampling.lastWindow.eligibleSamples, 0);
    assert.equal(q.sampling.lastWindow.pressure, 'unknown');
    assert.ok(q.sampling.excludedTotal['science-fallback'] > 0);
    assert.equal(after.token, initial.token);
    report.cases.push({ name: 'explicit-fallback-50ms-never-render-pressure', initial, after, rawSamples });
    await context.close(); context = null;
  }
  {
    const { page, initial } = await open();
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => {
      const state = window.skyApp.state; state.viewMode = 'ground'; state.presentation = 'explanation';
      state.density = 'reference'; state.selected = 'body:Moon'; state.environment.refraction = 'standard';
      state.environment.pressureHpa = 1013.25; state.environment.temperatureC = 15;
      for (const key of Object.keys(state.layers)) state.layers[key] = true;
      window.skyApp.setState(state);
    });
    await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty);
    const before = await inspect(page);
    const rawSamples = [];
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      await page.evaluate(() => window.skyApp.play());
      await poll(async () => {
        const value = await inspect(page); rawSamples.push(rawSample(value));
        return value.diagnostics.runtimeQuality.state.stage > 0;
      },
        'controlled actual renderer-pressure trigger', 16_000);
      const after = await inspect(page), q = after.diagnostics.runtimeQuality;
      assert.equal(q.state.stage, 1); assert.equal(q.state.history.length, 1);
      assert.equal(q.state.history[0].reason, 'degraded');
      assert.equal(q.sampling.lastWindow.pressure, 'render');
      assert.ok(q.sampling.lastWindow.rendererSubmitP95Ms > q.config.badRendererSubmitP95Ms);
      assert.equal(after.diagnostics.clockRebaseCount, before.diagnostics.clockRebaseCount + 1); // play only
      assert.deepEqual(after.state.cameras, before.state.cameras);
      assert.deepEqual(after.state.observer, before.state.observer); assert.equal(after.state.selected, before.state.selected);
      assert.ok(q.state.history.length <= 32); assert.equal(after.token, initial.token);
      await page.screenshot({ path: resolve(out, 'controlled-throttle-label-reduction.png') });
      report.cases.push({ name: 'controlled-4x-cpu-render-pressure-degrades-labels-first', simulatedCpuThrottlingRate: 4, before, after, rawSamples });
    } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
    await context.close(); context = null;
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
  report.sourceAfter = await identities(); assert.deepEqual(report.sourceAfter, report.sourceBefore);
  report.status = 'passed-main-quality-functional';
} catch (error) {
  report.status = 'failed-main-quality-functional'; report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close(); report.allBrowsersClosed = true;
  report.endedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), cases: report.cases.length }));
}
