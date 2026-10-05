import { chromium, firefox } from '@playwright/test';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runM3Checks, prepareM3Scene, recordM3Workflow, runM3OfflineSmoke } from './qa-m3.mjs';
import { runM3bChecks, waitMilkyWayReady, prepareM3bPerformance, runM3bOfflineSmoke, recordM3bWorkflow } from './qa-m3b.mjs';
import { installGraphicsProbe, runM4aChecks, runM4aOfflineSmoke, recordM4aWorkflow } from './qa-m4a.mjs';
import { runM4bChecks, runM4bPortableSmoke, recordM4bWorkflow } from './qa-m4b.mjs';
import { runM5aChecks, runM5aOfflineSmoke, recordM5aWorkflow } from './qa-m5a.mjs';
import { installDayEventTransferProbe, runM5bChecks, runM5bOfflineSmoke, compareM5bWorkerFallback } from './qa-m5b.mjs';

const kind = process.argv[2] ?? 'visual';
const outDir = resolve(process.env.SKY_QA_OUT_DIR ?? `qa/${kind}`);
await mkdir(outDir, { recursive: true });
const channel = process.env.SKY_QA_CHANNEL ?? 'chrome';
const headless = process.env.SKY_QA_HEADED !== '1';
const launchedAt = new Date().toISOString();
const browser = await (channel === 'firefox' ? firefox : chromium).launch({ headless, ...(channel === 'firefox' ? {} : { channel }) });
const errors = [];
const requests = [];
const consoleErrors = [];
const m5bSourceFiles = ['src/core/stars.ts', 'src/core/object-day-events.ts', 'src/data/object-day-target.ts', 'src/render/SkyRenderer.ts', 'src/render/CanvasSkyRenderer.ts'];
const m5bSourceIdentity = () => Promise.all(m5bSourceFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
let context;
let page;
const m4a = kind === 'm4a' || process.env.SKY_QA_M4A === '1';
const m4b = kind === 'm4b' || process.env.SKY_QA_M4B === '1';
const report = { kind, launchedAt, channel, headless, status: 'running', configuration: { fourViews: process.env.SKY_QA_FOUR_VIEWS === '1', m2: process.env.SKY_QA_M2 === '1', m3: process.env.SKY_QA_M3 === '1', m3b: process.env.SKY_QA_M3B === '1', m4a, m4b, m5a: kind === 'm5a' || process.env.SKY_QA_M5A === '1', forcedNoWebgl2: m4a && process.env.SKY_QA_FORCE_2D === '1', portable: process.env.SKY_QA_PORTABLE === '1' }, assertions: [], screenshots: [], limitations: [] };
report.configuration.m5b = kind === 'm5b' || process.env.SKY_QA_M5B === '1';
try {
  if (kind === 'm5b' || process.env.SKY_QA_M5B === '1') report.sourceBefore = await m5bSourceIdentity();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true, ...(m4a ? { hasTouch: true } : {}), ...(kind === 'recording' ? { recordVideo: { dir: outDir, size: { width: 1152, height: 720 } } } : {}) });
  if (m4a) await installGraphicsProbe(context, process.env.SKY_QA_FORCE_2D === '1');
  if (kind === 'm5b' || process.env.SKY_QA_M5B === '1') await installDayEventTransferProbe(context);
  if (kind === 'offline') await context.setOffline(true);
  page = await context.newPage();
  await page.addInitScript(() => {
    window.__qaLongTasks = [];
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__qaLongTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          if (window.__qaLongTasks.length > 128) window.__qaLongTasks.shift();
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch { window.__qaLongTasks = null; }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const webUrl = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
  const portablePath = resolve('dist-portable/三维全景夜空.html');
  if (kind === 'offline') await stat(portablePath);
  if (kind === 'offline' || process.env.SKY_QA_PORTABLE === '1') report.testedArtifact = { path: portablePath, sha256: createHash('sha256').update(await readFile(portablePath)).digest('hex') };
  await page.goto(kind === 'offline' || process.env.SKY_QA_PORTABLE === '1' ? pathToFileURL(portablePath).href : webUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.skyApp?.ready, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => { const app = window.skyApp, assets = app.diagnostics.assetStatus; return assets && (app.graphicsStatus?.kind === 'canvas2d' || ['uDay', 'uNight', 'uClouds'].every(id => assets.loaded.includes(id))) && assets.pending.length === 0 && assets.errors.length === 0 && !app.diagnostics.assetWarning; }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(1000);
  if (process.env.SKY_QA_M3B === '1') await waitMilkyWayReady(page);
  report.browserVersion = browser.version();
  report.pageUrl = page.url();
  report.buildId = await page.evaluate(() => document.querySelector('meta[name="sky-build-id"]')?.content ?? null);
  report.moduleScripts = await page.locator('script[type="module"][src]').evaluateAll(scripts => scripts.map(script => script.src));
  report.environment = await page.evaluate(() => {
    const canvas = document.querySelector('#sky-stage canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    return { userAgent: navigator.userAgent, platform: navigator.platform, viewport: [innerWidth, innerHeight], backingPixels: canvas ? canvas.width * canvas.height : null, renderer, vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null, renderingClassification: /swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer) ? 'software' : renderer === 'unavailable' ? 'unknown' : 'hardware-string-reported', gpuMemoryScope: 'App estimate only; driver/browser buffers excluded.' };
  });
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(await page.locator('#sky-stage canvas').count() >= 1, '需要实际天空画布');
  report.assertions.push('App initialized with a real sky canvas and no uncaught page errors.');
  const baseline = await page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot, metrics: window.skyApp.metrics, diagnostics: window.skyApp.diagnostics }));
  report.baseline = baseline;
  const assertPaired = async () => {
    const result = await page.waitForFunction(() => {
      if (window.skyApp.diagnostics.scienceDirty || window.skyApp.diagnostics.lastRenderedUt !== window.skyApp.snapshot.utDaysJ2000) return false;
      if (window.skyApp.diagnostics.snapshotInputSignature !== undefined && window.skyApp.diagnostics.snapshotInputSignature !== window.skyApp.diagnostics.currentInputSignature) return false;
      return { utc: window.skyApp.state.time.utDaysJ2000, science: window.skyApp.snapshot.utDaysJ2000, drawn: window.skyApp.diagnostics.lastRenderedUt };
    });
    const paired = await result.jsonValue();
    await result.dispose();
    assert.equal(paired.utc, paired.science); assert.equal(paired.drawn, paired.science);
  };
  const shot = async name => {
    await assertPaired();
    const path = resolve(outDir, name);
    await page.screenshot({ path });
    report.screenshots.push(path);
  };
  if (kind === 'visual') {
    const visualModes = process.env.SKY_QA_FOUR_VIEWS === '1' ? ['ground', 'space', 'globe', 'horizon'] : ['ground', 'space'];
    for (const mode of visualModes) {
      await page.evaluate(mode => { const state = window.skyApp.state; state.time.running = false; state.viewMode = mode; state.density = 'reference'; if (mode === 'space') state.cameras.space.distanceDisplayUnits = 5; window.skyApp.setState(state); }, mode);
      await page.waitForTimeout(350); await shot(`${mode}-1152x720.png`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { const state = window.skyApp.state; state.viewMode = 'ground'; state.density = 'teaching'; window.skyApp.setState(state); });
    await page.waitForTimeout(350); await shot('mobile-ground-390x844.png');
    report.status = 'captured-awaiting-visual-review';
    report.limitations.push('Screenshots are captured evidence; visual equivalence and touch-device behavior require human/device review.');
  } else if (kind === 'offline') {
    assert.equal(requests.length, 0, `file首次断网有HTTP请求：${requests.join(',')}`);
    await shot('file-first-open-worker.png');
    report.workerSnapshot = await page.evaluate(() => window.skyApp.snapshot);
    if (process.env.SKY_QA_M3 === '1') report.workerTeaching = await runM3OfflineSmoke({ page, shot, name: 'file-first-open-m3-worker.png' });
    if (process.env.SKY_QA_M3B === '1') report.workerSky = await runM3bOfflineSmoke({ page, shot, name: 'file-first-open-milky-way-worker.png' });
    if (m4a) report.workerCanvas = await runM4aOfflineSmoke({ page, shot, name: 'file-first-open-canvas2d-worker.png' });
    if (process.env.SKY_QA_M4B === '1') await runM4bPortableSmoke({ page, report, shot });
    if (process.env.SKY_QA_M5A === '1') report.workerDayEvents = await runM5aOfflineSmoke({ page, shot, name: 'file-first-open-selected-day-worker.png' });
    if (process.env.SKY_QA_M5B === '1') report.workerStarMotion = await runM5bOfflineSmoke({ page, shot, prefix: 'file-worker' });
    const fallbackUrl = `${pathToFileURL(portablePath).href}?worker=off`;
    await page.goto(fallbackUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.skyApp?.ready);
    await page.waitForFunction(() => { const app = window.skyApp, assets = app.diagnostics.assetStatus; return assets && (app.graphicsStatus?.kind === 'canvas2d' || assets.loaded.length >= 3) && assets.pending.length === 0 && assets.errors.length === 0 && !app.diagnostics.assetWarning; });
    await page.evaluate(state => window.skyApp.setState(state), baseline.state);
    await page.waitForTimeout(300); await shot('file-first-open-fallback.png');
    const fallback = await page.evaluate(() => ({ snapshot: window.skyApp.snapshot, diagnostics: window.skyApp.diagnostics }));
    assert.equal(fallback.diagnostics.workerMode, 'main-thread-budgeted');
    for (let i = 0; i < fallback.snapshot.bodies.length; i++) {
      assert.equal(fallback.snapshot.bodies[i].apparentAltitudeDeg, report.workerSnapshot.bodies[i].apparentAltitudeDeg);
    }
    assert.equal(requests.length, 0);
    report.assertions.push('Fresh context was offline before file:// first open; zero HTTP requests.', 'Inline Blob Worker and budgeted main-thread fallback give identical body altitudes.');
    report.fallback = fallback.diagnostics;
    if (process.env.SKY_QA_M5B === '1') {
      report.fallbackStarMotion = await runM5bOfflineSmoke({ page, shot, prefix: 'file-cooperative' });
      compareM5bWorkerFallback(report.workerStarMotion, report.fallbackStarMotion);
      assert.equal(requests.length, 0);
      report.assertions.push('First offline file open yields identical candidate/fallback stellar directions, model identities and events in native Worker and same-core cooperative paths, with only single-record requests and zero HTTP.');
    }
    if (process.env.SKY_QA_M5A === '1') {
      report.fallbackDayEvents = await runM5aOfflineSmoke({ page, shot, name: 'file-first-open-selected-day-cooperative.png' });
      assert.equal(report.fallbackDayEvents.diagnostics.dayEvents.mode, 'main-thread-cooperative');
      assert.equal(report.fallbackDayEvents.diagnostics.workerCount, 0);
      assert.deepEqual(report.fallbackDayEvents.teaching.solarDay, report.workerDayEvents.teaching.solarDay);
      assert.deepEqual(report.fallbackDayEvents.teaching.objectDay, report.workerDayEvents.teaching.objectDay);
      assert.equal(requests.length, 0);
      report.assertions.push('First offline file open returns identical solar and selected Moon day events from the existing second Worker and the same-core cooperative fallback, with zero HTTP requests.');
    }
    if (process.env.SKY_QA_M3 === '1') {
      report.fallbackTeaching = await runM3OfflineSmoke({ page, shot, name: 'file-first-open-m3-cooperative-fallback.png' });
      assert.equal(report.fallbackTeaching.diagnostics.solarDay.mode, 'main-thread-cooperative');
      assert.deepEqual(report.fallbackTeaching.teaching.solarDay, report.workerTeaching.teaching.solarDay);
      assert.deepEqual(report.fallbackTeaching.teaching.moon, report.workerTeaching.teaching.moon);
      assert.deepEqual(report.fallbackTeaching.teaching.lunarCalendar, report.workerTeaching.teaching.lunarCalendar);
      assert.deepEqual(report.fallbackTeaching.teaching.moonPhases, report.workerTeaching.teaching.moonPhases);
      assert.ok(report.fallbackTeaching.diagnostics.solarDay.maxFallbackChunkMs <= 8, '实际浏览器事件协作chunk须在8ms预算内');
      assert.equal(requests.length, 0);
      report.assertions.push('Moon texture/loupe, solar events, UTC+8 calendar and explicit quarter search work on first offline file open. Dedicated day Worker and cooperative fallback return identical teaching data; measured fallback chunks stay within 8ms.');
    }
    if (process.env.SKY_QA_M3B === '1') {
      report.fallbackSky = await runM3bOfflineSmoke({ page, shot, name: 'file-first-open-milky-way-fallback.png' });
      assert.deepEqual(report.fallbackSky.model, report.workerSky.model); assert.equal(requests.length, 0);
      report.assertions.push('The fifth named Milky Way sampler and qualitative 0.5 pollution work on first offline open, with one real resident texture and matching Worker/fallback sky models.');
    }
    if (m4a) {
      report.fallbackCanvas = await runM4aOfflineSmoke({ page, shot, name: 'file-first-open-canvas2d-science-fallback.png' });
      assert.deepEqual(report.fallbackCanvas.teaching.solarDay, report.workerCanvas.teaching.solarDay);
      assert.deepEqual(report.fallbackCanvas.teaching.moon, report.workerCanvas.teaching.moon);
      assert.deepEqual(report.fallbackCanvas.teaching.lunarCalendar, report.workerCanvas.teaching.lunarCalendar);
      assert.equal(report.fallbackCanvas.app.solarDay.mode, 'main-thread-cooperative');
      assert.ok(report.fallbackCanvas.app.solarDay.maxFallbackChunkMs <= 8);
      assert.equal(requests.length, 0);
      report.assertions.push('First offline file load has native WebGL2 blocked and a real Canvas2D chart; zero successful WebGL contexts/HTTP requests. Worker and cooperative fallback retain identical solar/calendar/moon data and capture works.');
    }
    report.status = 'passed-browser-functional-checks';
    report.limitations.push('This is the named browser on Windows; Firefox, macOS Safari, PWA reopen and physical mobile remain separate acceptance gates.');
  } else if (kind === 'pwa') {
    await page.waitForFunction(() => document.querySelector('#runtime-status')?.textContent?.includes('离线资源已就绪'), undefined, { timeout: 30_000 });
    const onlineState = await page.evaluate(() => window.skyApp.state);
    await page.close();
    await context.setOffline(true);
    page = await context.newPage();
    const workerResponses = [];
    report.offlineResponses = workerResponses;
    report.offlineFailedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('response', response => workerResponses.push({ url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() }));
    page.on('requestfailed', request => report.offlineFailedRequests.push({ url: request.url(), error: request.failure() }));
    await page.goto(webUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.skyApp?.ready, undefined, { timeout: 30_000 });
    await page.waitForFunction(() => { const app = window.skyApp, assets = app.diagnostics.assetStatus; return assets && (app.graphicsStatus?.kind === 'canvas2d' || assets.loaded.length >= 3) && assets.pending.length === 0 && assets.errors.length === 0 && !app.diagnostics.assetWarning; });
    await page.evaluate(state => window.skyApp.setState(state), onlineState);
    await page.waitForTimeout(500); await shot('pwa-closed-and-reopened-offline.png');
    const coreResponses = workerResponses.filter(response => /^https?:/.test(response.url));
    assert.ok(coreResponses.length >= 3 && coreResponses.every(response => response.fromServiceWorker && response.status === 200), '断网重开所有核心HTTP响应必须来自Service Worker缓存');
    report.offlineResponses = workerResponses;
    report.assertions.push('Production page waited for complete offline-ready status, original tab closed, and a new tab opened while browser context was offline.', 'Core HTML/JS/CSS responses came from the installed Service Worker with status 200.');
    if (process.env.SKY_QA_M3 === '1') report.offlineTeaching = await runM3OfflineSmoke({ page, shot, name: 'pwa-m3-teaching-reopened-offline.png' });
    if (process.env.SKY_QA_M3B === '1') report.offlineSky = await runM3bOfflineSmoke({ page, shot, name: 'pwa-milky-way-reopened-offline.png' });
    if (m4a) report.offlineCanvas = await runM4aOfflineSmoke({ page, shot, name: 'pwa-canvas2d-reopened-offline.png' });
    report.status = 'passed-browser-functional-checks';
    report.limitations.push('PWA install OS integration and cache eviction recovery on physical phones are untested.');
  } else if (kind === 'interaction') {
    await page.evaluate(() => window.skyApp.pause()); await page.waitForTimeout(250);
    const paused = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), paused, '暂停无交互必须停止绘制');
    for (const rate of [600, 86400]) {
      await page.evaluate(rate => { const state = window.skyApp.state; state.time.rateSimSecondsPerRealSecond = rate; state.time.running = true; window.skyApp.setState(state); }, rate);
      await page.waitForTimeout(900); await assertPaired();
      await page.evaluate(() => window.skyApp.pause()); await page.waitForTimeout(200); await assertPaired();
    }
    if (!headless) {
      await page.evaluate(() => { const state = window.skyApp.state; state.time.mode = 'simulation'; state.time.running = true; state.time.rateSimSecondsPerRealSecond = 86400; window.skyApp.setState(state); });
      await page.waitForTimeout(150);
      const backgroundTab = await context.newPage();
      await backgroundTab.goto('about:blank'); await backgroundTab.bringToFront();
      let nativeHidden = false;
      try { await page.waitForFunction(() => document.hidden === true, undefined, { timeout: 3000 }); nativeHidden = true; }
      catch (error) { report.nativeVisibility = { status: 'untested-trigger-did-not-hide', reason: error.message, originalPage: await page.evaluate(() => ({ hidden: document.hidden, visibilityState: document.visibilityState })), backgroundPage: await backgroundTab.evaluate(() => ({ hidden: document.hidden, visibilityState: document.visibilityState })) }; }
      if (nativeHidden) {
        const nativeFrozen = await page.evaluate(() => window.skyApp.state.time.utDaysJ2000);
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000), nativeFrozen);
        await page.bringToFront(); await page.waitForFunction(() => document.hidden === false);
        await page.evaluate(() => window.skyApp.pause());
        await page.waitForTimeout(150); await assertPaired();
        assert.ok(Math.abs(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000) - nativeFrozen) < .05, '原生切tab恢复不应计入隐藏250ms');
        report.nativeVisibility = { status: 'passed-native-tab-trigger' };
        report.assertions.push('Native headed-browser tab visibility freezes teaching time and resumes without background fast-forward.');
      } else { await page.bringToFront(); await page.evaluate(() => window.skyApp.pause()); }
      await backgroundTab.close();
    }
    await page.evaluate(() => {
      const state = window.skyApp.state; state.time.mode = 'simulation'; state.time.running = true; state.time.rateSimSecondsPerRealSecond = 86400; window.skyApp.setState(state);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    const frozen = await page.evaluate(() => window.skyApp.state.time.utDaysJ2000);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000), frozen, '隐藏期间必须保持UTC严格相等');
    await page.evaluate(() => { window.skyApp.pause(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200); await assertPaired();
    assert.equal(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000), frozen);
    const pausedRealtime = await page.evaluate(() => {
      const state = window.skyApp.state; state.time.mode = 'realtime'; state.time.running = false; window.skyApp.setState(state);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      return window.skyApp.state.time.utDaysJ2000;
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200); await assertPaired();
    assert.equal(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000), pausedRealtime, '暂停的realtime模式恢复必须保留UTC');
    report.assertions.push('Paused realtime preserves UTC exactly across hidden/resume; active realtime resumes to wall-clock UTC.');
    await page.evaluate(() => {
      const state = window.skyApp.state; state.time.mode = 'realtime'; state.time.running = true; state.time.rateSimSecondsPerRealSecond = 1; window.skyApp.setState(state);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200); await assertPaired();
    const realtimeDelta = await page.evaluate(() => Math.abs(window.skyApp.state.time.utDaysJ2000 - (Date.now() - Date.UTC(2000, 0, 1, 12)) / 86400000));
    assert.ok(realtimeDelta * 86400 < 1, '实时恢复必须回到系统UTC');
    await page.evaluate(() => window.skyApp.pause()); await page.waitForTimeout(200);
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) { const state = window.skyApp.state; state.time.utDaysJ2000 += i / 86400; state.observer.longitudeDegEast = i; state.viewMode = i % 2 ? 'space' : 'ground'; window.skyApp.setState(state); }
    });
    await page.waitForTimeout(500); await assertPaired();
    const latest = await page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics }));
    assert.equal(latest.state.observer.longitudeDegEast, 99);
    assert.equal(latest.state.viewMode, 'space');
    assert.ok(latest.diagnostics.pendingLatestRequestCount <= 1);
    const canvas = page.locator('#sky-stage canvas').first();
    const box = await canvas.boundingBox();
    if (box) {
      const before = await page.evaluate(() => JSON.stringify(window.skyApp.state.cameras));
      await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .8, box.y + box.height * .5, { steps: 12 }); await page.mouse.up();
      await page.mouse.wheel(0, 150); await page.waitForTimeout(150);
      assert.notEqual(await page.evaluate(() => JSON.stringify(window.skyApp.state.cameras)), before);
    }
    await shot('interaction-final.png');
    report.assertions.push('Paused idle stops continuous rendering.', '600x and 86400x displayed UTC, scientific snapshot UTC and rendered UTC agree.', 'Synthetic visibility events freeze simulation and restore realtime to system UTC.', '100 immediate changes converge to the latest state; queue remains bounded.', 'Native pointer drag and wheel modify the camera.');
    report.limitations.push(report.nativeVisibility?.status === 'passed-native-tab-trigger' ? 'Native tab visibility is tested; realtime resume also has a synthetic branch check. OS window minimization and BFCache navigation remain untested.' : 'The native tab trigger did not hide the original page in this environment, so native visibility is explicitly untested. Synthetic document.hidden branch checks cover simulation freeze and realtime restore.');
    report.status = 'passed-browser-functional-checks';
  } else if (kind === 'm2') {
    const records = JSON.parse(await readFile('assets/runtime/star-meta.json', 'utf8'));
    const polaris = records.find(record => record[2] === 11767);
    const vega = records.find(record => record[2] === 91262);
    assert.ok(polaris && vega, '固定HYG星表需有Polaris与Vega');
    const starId = polaris[0], starHyg = `hyg:${polaris[1]}`;
    const queries = [polaris[8], polaris[9].find(alias => /[\u3400-\u9fff]/.test(alias) && alias !== polaris[8]), polaris[7], `HIP ${polaris[2]}`, `HYG ${polaris[1]}`].filter(Boolean);
    report.searchEvidence = [];
    report.focusEvidence = [];
    report.lockEvidence = [];
    const m2Stable = async () => {
      await assertPaired();
      await page.waitForFunction(() => window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode && window.skyApp.diagnostics.lastRenderedSelection === window.skyApp.state.selected && window.skyApp.diagnostics.pendingInteractionCount === 0);
    };
    const choose = async query => {
      await page.locator('#sky-search').fill(query);
      await page.waitForFunction(() => document.querySelectorAll('#sky-search-results [data-object-id]').length > 0);
      const results = await page.locator('#sky-search-results [data-object-id]').evaluateAll(elements => elements.map(element => ({ id: element.dataset.objectId, label: element.textContent })));
      assert.ok(results.length <= 12);
      await page.locator('#sky-search').press('Enter');
      await m2Stable();
      return { results, selected: await page.evaluate(() => window.skyApp.state.selected) };
    };
    const view = async mode => { await page.locator(`[data-view="${mode}"]`).click(); await m2Stable(); };
    const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i], 0)))) * 180 / Math.PI;
    for (const query of queries) {
      const evidence = await choose(query);
      assert.equal(evidence.selected, starId);
      assert.equal(await page.evaluate(() => window.skyApp.selectedDetails?.id), starId);
      assert.ok((await page.locator('.object-epoch').textContent()).includes('J2000'));
      report.searchEvidence.push({ query, ...evidence });
    }
    report.assertions.push('Chinese, supplied Chinese alias, English, HIP and HYG searches choose the same canonical star through real UI; results are capped at 12.');
    const invariant = await page.evaluate(() => ({ utc: window.skyApp.state.time.utDaysJ2000, observer: window.skyApp.state.observer, selected: window.skyApp.state.selected }));
    for (const mode of ['ground', 'space', 'globe', 'horizon']) {
      await view(mode);
      const before = await page.evaluate(() => window.skyApp.state);
      assert.equal(before.time.utDaysJ2000, invariant.utc); assert.deepEqual(before.observer, invariant.observer); assert.equal(before.selected, invariant.selected);
      await page.locator('[data-action="focus-selection"]').click(); await m2Stable();
      const after = await page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.rendererDiagnostics, app: window.skyApp.diagnostics }));
      assert.equal(after.app.lastFocusSucceeded, true);
      assert.equal(after.diagnostics.selectedId, starId);
      assert.equal(after.diagnostics.selectedVisible, true);
      assert.equal(after.state.time.utDaysJ2000, before.time.utDaysJ2000); assert.deepEqual(after.state.observer, before.observer); assert.equal(after.state.selected, before.selected);
      for (const other of ['ground', 'space', 'globe', 'horizon']) if (other !== mode) assert.deepEqual(after.state.cameras[other], before.cameras[other]);
      if (mode === 'space') { assert.ok(Math.abs(after.diagnostics.selectedProjectedNdc[0]) < .04 && after.diagnostics.selectedProjectedNdc[1] > .2 && after.diagnostics.selectedProjectedNdc[1] < .95, '太空focus应在地球上方可见区域'); }
      else { assert.ok(Math.hypot(...after.diagnostics.selectedProjectedNdc) < .01, `${mode} focus应屏心`); }
      if (mode === 'globe' || mode === 'horizon') assert.equal(after.diagnostics.selectedOnNearHemisphere, true);
      report.focusEvidence.push({ mode, diagnostics: after.diagnostics });
      await shot(`focus-${mode}.png`);
    }
    report.assertions.push('All four views preserve observer/UTC/selection; focus changes only the active camera, centers ground/finite views, uses a visible area above Earth in space, and places finite selections on the near hemisphere.');
    const savedCameras = await page.evaluate(() => window.skyApp.state.cameras);
    for (const mode of ['ground', 'space', 'globe', 'horizon', 'ground']) { await view(mode); assert.deepEqual(await page.evaluate(() => window.skyApp.state.cameras), savedCameras); }
    await view('globe');
    const figure = await choose('Ori'); assert.equal(figure.selected.toLowerCase(), 'constellation:ori');
    const highlight = await page.evaluate(() => window.skyApp.rendererDiagnostics.highlightedConstellationIds);
    assert.deepEqual(highlight.map(id => id.replace(/^constellation:/, '').toLowerCase()), ['ori']);
    assert.equal(await page.evaluate(() => window.skyApp.selectedDetails.magnitude), null);
    await shot('selected-constellation-only.png');
    for (const [query, id] of [['太阳', 'body:Sun'], ['Moon', 'body:Moon']]) { const body = await choose(query); assert.equal(body.selected, id); assert.ok((await page.locator('.object-epoch').textContent()).includes('当日真赤道')); assert.equal(await page.evaluate(() => window.skyApp.rendererDiagnostics.highlightedConstellationIds.length), 0); }
    report.assertions.push('One selected constellation highlights only its own figure; star/body selection removes figure highlight. Sun/Moon selection has topocentric of-date coordinate labels.');
    await choose(polaris[8]);
    for (const mode of ['space', 'globe', 'horizon']) {
      await view(mode); await page.locator('[data-action="focus-selection"]').click(); await m2Stable();
      const locks = await page.locator('#sky-reference-lock option').evaluateAll(options => options.map(option => option.value));
      for (const lock of locks) {
        const before = await page.evaluate(() => ({ state: window.skyApp.state, diagnostic: window.skyApp.rendererDiagnostics }));
        await page.locator('#sky-reference-lock').selectOption(lock); await m2Stable();
        const after = await page.evaluate(() => ({ state: window.skyApp.state, diagnostic: window.skyApp.rendererDiagnostics }));
        assert.equal(after.state.cameras[mode].referenceLock, lock);
        assert.ok(angleDeg(before.diagnostic.viewForwardEqj, after.diagnostic.viewForwardEqj) < .001, '切锁不应改变瞬时物理视线');
        assert.ok(Math.hypot(...before.diagnostic.selectedProjectedNdc.map((value, index) => value - after.diagnostic.selectedProjectedNdc[index])) < .002, '切锁不应跳选中对象投影');
        assert.equal(after.state.time.utDaysJ2000, before.state.time.utDaysJ2000);
        assert.deepEqual(after.state.observer, before.state.observer); assert.equal(after.state.selected, before.state.selected);
        report.lockEvidence.push({ mode, lock, before: before.diagnostic, after: after.diagnostic });
      }
    }
    await view('globe'); await choose(`HIP ${vega[2]}`); await page.locator('[data-action="focus-selection"]').click(); await m2Stable();
    await page.locator('#sky-reference-lock').selectOption('inertial'); await m2Stable();
    const inertialState = await page.evaluate(() => window.skyApp.state), inertialStart = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
    const oneHour = structuredClone(inertialState); oneHour.time.utDaysJ2000 += 1 / 24;
    await page.evaluate(state => window.skyApp.setState(state), oneHour); await m2Stable();
    const inertialAngle = angleDeg(inertialStart, await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj));
    assert.ok(inertialAngle < .001);
    await page.evaluate(state => window.skyApp.setState(state), inertialState); await m2Stable();
    await page.locator('#sky-reference-lock').selectOption('earth-fixed'); await m2Stable();
    const earthState = await page.evaluate(() => window.skyApp.state), earthStart = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
    const earthHour = structuredClone(earthState); earthHour.time.utDaysJ2000 += 1 / 24;
    await page.evaluate(state => window.skyApp.setState(state), earthHour); await m2Stable();
    const earthAngle = angleDeg(earthStart, await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj));
    assert.ok(earthAngle > 5 && earthAngle < 20);
    report.lockTemporalEvidence = { simulatedHours: 1, inertialPhysicalViewAngleDeg: inertialAngle, earthFixedPhysicalViewAngleDeg: earthAngle };
    report.assertions.push('Reference locks preserve instant physical view/projection; one hour changes Earth-fixed physical view while inertial view stays fixed.');
    const aliasState = structuredClone(earthState); aliasState.selected = starHyg;
    await page.evaluate(state => window.skyApp.setState(state), aliasState); await m2Stable();
    await page.locator('[data-action="focus-selection"]').click(); await m2Stable();
    assert.equal(await page.evaluate(() => window.skyApp.state.selected), starHyg);
    assert.equal(await page.evaluate(() => window.skyApp.selectedDetails.id), starId);
    assert.equal(await page.evaluate(() => window.skyApp.rendererDiagnostics.selectedId), starHyg);
    assert.equal(await page.evaluate(() => window.skyApp.rendererDiagnostics.canonicalSelectedId), starId);
    assert.equal(await page.evaluate(() => window.skyApp.rendererDiagnostics.selectedVisible), true);
    assert.ok(await page.evaluate(id => window.skyApp.rendererDiagnostics.labelHitBoxes.some(box => box.id === id), starId));
    const caseState = await page.evaluate(() => window.skyApp.state); caseState.selected = 'constellation:ori';
    await page.evaluate(state => window.skyApp.setState(state), caseState); await m2Stable();
    assert.deepEqual((await page.evaluate(() => window.skyApp.rendererDiagnostics.highlightedConstellationIds)).map(id => id.replace(/^constellation:/, '').toLowerCase()), ['ori']);
    report.assertions.push('Imported noncanonical HYG and lowercase constellation identifiers keep their JSON values while details, visible marker/focus and figure highlight resolve canonically.');
    const exportState = await page.evaluate(() => window.skyApp.state);
    if (!(await page.locator('.scene-section').getAttribute('open'))) await page.locator('.scene-section > summary').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('[data-action="export"]').click();
    const download = await downloadPromise, exportPath = resolve(outDir, 'selected-camera-scene.json'); await download.saveAs(exportPath);
    const exported = JSON.parse(await readFile(exportPath, 'utf8')); assert.equal(JSON.stringify(exported), JSON.stringify(exportState));
    await page.locator('[data-action="clear-selection"]').click(); await m2Stable();
    await page.locator('#sky-import-file').setInputFiles(exportPath); await m2Stable();
    assert.equal(await page.evaluate(() => JSON.stringify(window.skyApp.state)), JSON.stringify(exportState));
    report.assertions.push('Native JSON download/import roundtrip preserves selection, exact UTC/observer, all camera quaternions and every reference lock.');
    await page.evaluate(state => window.skyApp.setState(state), baseline.state); await m2Stable();
    await view('horizon'); await page.locator('#sky-reference-lock').selectOption('local-horizon'); await m2Stable();
    const queuedChange = await page.evaluate(() => {
      const city = document.querySelector('#sky-city'); city.value = '1'; city.dispatchEvent(new Event('change', { bubbles: true }));
      const lock = document.querySelector('#sky-reference-lock'); lock.value = 'inertial'; lock.dispatchEvent(new Event('change', { bubbles: true }));
      const pending = window.skyApp.diagnostics;
      document.querySelector('[data-view="ground"]').click();
      return { pending, afterView: window.skyApp.diagnostics, coherentCameraLockWhileWaiting: window.skyApp.state.cameras.horizon.referenceLock };
    });
    assert.equal(queuedChange.pending.scienceDirty, true); assert.ok(queuedChange.pending.pendingInteractionCount >= 1);
    assert.ok(queuedChange.afterView.pendingInteractionCount >= 1, '切走视图仍要保留已接受锁意图');
    assert.equal(queuedChange.coherentCameraLockWhileWaiting, 'local-horizon');
    await m2Stable();
    assert.equal(await page.evaluate(() => window.skyApp.state.viewMode), 'ground');
    assert.equal(await page.evaluate(() => window.skyApp.state.cameras.horizon.referenceLock), 'inertial');
    assert.equal(await page.evaluate(() => window.skyApp.state.observer.latitudeDeg), 39.9);
    await view('horizon'); assert.equal(await page.locator('#sky-reference-lock').inputValue(), 'inertial');
    report.pendingObserverLockEvidence = queuedChange;
    report.assertions.push('Synchronous real UI observer change, queued reference-lock change and leaving the view retain the intended lock; the new observer snapshot applies it to the inactive camera and returning restores the chosen lock.');
    await page.evaluate(state => window.skyApp.setState(state), baseline.state); await m2Stable();
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
    const mobileSearch = page.locator('[data-action="open-search"]'); const mobileBox = await mobileSearch.boundingBox(); assert.ok(mobileBox?.height >= 44);
    await mobileSearch.click(); await choose(polaris[8]); await page.locator('[data-action="focus-selection"]').click(); await m2Stable(); await shot('mobile-search-and-focus.png');
    report.assertions.push('390x844 browser viewport has a >=44px search action and supports Chinese search, selection and focus.');
    report.limitations.push('Mobile viewport emulation does not verify physical touch-device performance or OS file-manager execution.');
    report.status = 'passed-m2-browser-functional-checks';
  } else if (kind === 'm3') {
    await runM3Checks({ page, outDir, report, shot, assertPaired });
  } else if (kind === 'm3b') {
    await runM3bChecks({ page, outDir, report, shot, assertPaired });
  } else if (kind === 'm4a') {
    await runM4aChecks({ page, context, outDir, report, shot, assertPaired });
  } else if (kind === 'm4b') {
    await runM4bChecks({ page, context, outDir, report, shot, assertPaired });
  } else if (kind === 'm5a') {
    await runM5aChecks({ page, outDir, report, shot, assertPaired });
  } else if (kind === 'm5b') {
    await runM5bChecks({ page, report, shot });
  } else if (kind === 'recording') {
    if (process.env.SKY_QA_M5A === '1') {
      await recordM5aWorkflow({ page, report, shot, assertPaired });
    } else if (process.env.SKY_QA_M4B === '1') {
      await recordM4bWorkflow({ page, report, shot, assertPaired });
    } else if (m4a) {
      await recordM4aWorkflow({ page, context, report, shot });
    } else if (process.env.SKY_QA_M3B === '1') {
      await recordM3bWorkflow({ page, report, shot });
    } else if (process.env.SKY_QA_M3 === '1') {
      await recordM3Workflow({ page, report, shot, assertPaired });
    } else {
    await page.locator('[data-view="ground"]').click();
    await page.locator('#sky-date').fill('2026-09-14');
    await page.locator('#sky-time').fill('23:59:50');
    await page.locator('.apply-time').click();
    await page.locator('#sky-rate').selectOption('600');
    await assertPaired();
    if (process.env.SKY_QA_M2 === '1') {
      await page.locator('#sky-search').fill('北极星'); await page.locator('#sky-search').press('Enter');
      await page.waitForFunction(() => window.skyApp.diagnostics.lastRenderedSelection === 'hip:11767');
      await page.locator('[data-action="focus-selection"]').click(); await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1000);
    await page.mouse.move(780, 310); await page.mouse.down();
    for (let i = 0; i < 30; i++) { await page.mouse.move(780 + i * 4, 310 + i * 1.2); await page.waitForTimeout(35); }
    await page.mouse.up();
    await page.locator('[data-action="play"]').click();
    await page.waitForTimeout(2500);
    await page.locator('[data-action="pause"]').click();
    await assertPaired();
    const afterMidnight = await page.locator('#sky-date').inputValue();
    assert.equal(afterMidnight, '2026-09-15', '录像应实际跨越午夜');
    await page.waitForTimeout(500);
    await page.locator('[data-view="space"]').click(); await page.waitForTimeout(600);
    if (process.env.SKY_QA_M2 === '1') { await page.locator('[data-action="focus-selection"]').click(); await page.waitForTimeout(500); }
    await page.mouse.move(780, 340);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(500); }
    if (process.env.SKY_QA_FOUR_VIEWS === '1') {
      await page.locator('[data-view="globe"]').click(); await page.waitForTimeout(700);
      if (process.env.SKY_QA_M2 === '1') { await page.locator('[data-action="focus-selection"]').click(); await page.waitForTimeout(400); await page.locator('#sky-reference-lock').selectOption('earth-fixed'); await page.waitForTimeout(400); }
      await page.locator('[data-view="horizon"]').click(); await page.waitForTimeout(700);
      if (process.env.SKY_QA_M2 === '1') { await page.locator('[data-action="focus-selection"]').click(); await page.waitForTimeout(400); await page.locator('#sky-reference-lock').selectOption('inertial'); await page.waitForTimeout(400); }
    }
    await page.locator('[data-view="ground"]').click(); await page.waitForTimeout(1000);
    await page.locator('[data-action="pause"]').click(); await page.waitForTimeout(500);
    await shot('recording-final.png');
    report.assertions.push('Actual native browser recording includes full UI, ground drag, 600x crossing midnight, space zoom, view switches and return to paused ground.');
    report.status = 'recorded-awaiting-human-review';
    report.recordingScope = 'Playwright browser viewport video with actual frames and complete UI; no synthetic frame generation.';
    if (process.env.SKY_QA_M2 === '1') report.assertions.push('The recording also uses real Chinese search, canonical star selection, focus in all four views, and external reference-lock controls.');
    }
  } else if (kind === 'performance') {
    const samples = [];
    const modes = process.env.SKY_QA_FOUR_VIEWS === '1' ? ['ground', 'space', 'globe', 'horizon'] : ['ground', 'space'];
    if (process.env.SKY_QA_M3B === '1') report.representativeScene = await prepareM3bPerformance(page);
    else if (process.env.SKY_QA_M3 === '1') report.representativeScene = await prepareM3Scene(page);
    const switchAndDraw = async mode => {
      await page.evaluate(mode => { const state = window.skyApp.state; state.viewMode = mode; state.time.running = false; window.skyApp.setState(state); }, mode);
      await assertPaired();
      await page.waitForFunction(mode => window.skyApp.diagnostics.lastRenderedMode === mode, mode);
    };
    const warmupCycles = Number(process.env.SKY_QA_WARMUP_CYCLES ?? (m4b ? 1 : m4a ? 2 : 5));
    const switchCount = Number(process.env.SKY_QA_SWITCH_COUNT ?? (m4b ? 0 : m4a ? 20 : 100));
    assert.ok(Number.isInteger(warmupCycles) && warmupCycles >= 0 && warmupCycles <= 5);
    assert.ok(Number.isInteger(switchCount) && switchCount >= 0 && switchCount <= 100);
    report.resourceSampling = { warmupCycles, switchCount, scope: switchCount === 0 ? 'No repeated view stress; sampled warmed resources only.' : 'Actually drawn view switches, not just queued state changes.' };
    for (let cycle = 0; cycle < warmupCycles; cycle++) for (const mode of modes) await switchAndDraw(mode);
    await page.waitForTimeout(350);
    await switchAndDraw(modes[0]);
    if (process.env.SKY_QA_M2 === '1') {
      const beforeHighlight = await page.evaluate(() => window.skyApp.state);
      await page.evaluate(() => { const state = window.skyApp.state; state.selected = 'constellation:Ori'; window.skyApp.setState(state); });
      await assertPaired(); await page.waitForFunction(() => window.skyApp.diagnostics.lastRenderedSelection === 'constellation:Ori');
      await page.evaluate(state => window.skyApp.setState(state), beforeHighlight); await assertPaired();
      await page.waitForFunction(selected => window.skyApp.diagnostics.lastRenderedSelection === selected, beforeHighlight.selected);
      report.preSelectionResources = await page.evaluate(() => window.skyApp.rendererDiagnostics);
    }
    report.preStress = await page.evaluate(() => window.skyApp.metrics);
    for (let i = 0; i < switchCount; i++) {
      await switchAndDraw(modes[i % modes.length]);
    }
    await page.waitForTimeout(300);
    await switchAndDraw(modes[0]);
    report.postStress = await page.evaluate(() => window.skyApp.metrics);
    assert.equal(report.postStress.textureCount, report.preStress.textureCount, '视图切换不能累积纹理');
    assert.equal(report.postStress.geometryCount, report.preStress.geometryCount, '视图切换不能累积几何');
    report.assertions.push(`${warmupCycles} complete warmup cycles and ${switchCount} actually drawn view switches (${modes.join(', ')}); texture/geometry counts are stable.`);
    if (process.env.SKY_QA_M2 === '1') {
      const stableState = await page.evaluate(() => window.skyApp.state);
      const figures = JSON.parse(await readFile('assets/runtime/constellation-meta.json', 'utf8')).constellations;
      for (const figure of figures) {
        await page.evaluate(id => { const state = window.skyApp.state; state.selected = `constellation:${id}`; window.skyApp.setState(state); }, figure.id);
        await assertPaired();
        await page.waitForFunction(id => window.skyApp.diagnostics.lastRenderedSelection === `constellation:${id}`, figure.id);
        assert.deepEqual((await page.evaluate(() => window.skyApp.rendererDiagnostics.highlightedConstellationIds)).map(id => id.replace(/^constellation:/, '').toLowerCase()), [figure.id.toLowerCase()]);
        const resources = await page.evaluate(() => window.skyApp.rendererDiagnostics);
        assert.equal(resources.highlightGeometryId, report.preSelectionResources.highlightGeometryId);
        assert.equal(resources.highlightIndexAttributeId, report.preSelectionResources.highlightIndexAttributeId);
        assert.equal(resources.highlightPositionAttributeIsShared, true);
      }
      await page.evaluate(state => window.skyApp.setState(state), stableState); await assertPaired();
      report.postConstellationSelectionStress = await page.evaluate(() => window.skyApp.metrics);
      report.postSelectionResources = await page.evaluate(() => window.skyApp.rendererDiagnostics);
      assert.equal(report.postConstellationSelectionStress.textureCount, report.preStress.textureCount);
      assert.equal(report.postConstellationSelectionStress.geometryCount, report.preStress.geometryCount);
      assert.ok(report.postSelectionResources.labelCache.glyphBytes <= 4 * 1024 * 1024);
      assert.ok(report.postSelectionResources.labelCache.placementCount <= 512);
      report.assertions.push(`All ${figures.length} constellations actually selected and drawn once; returned to identical pre-stress state with stable texture/geometry counts.`);
    }
    const deliveryStart = await page.evaluate(() => { window.skyApp.play(); return { renderCount: window.skyApp.diagnostics.renderCount, performanceNowMs: performance.now() }; });
    const durationMs = Number(process.env.SKY_QA_DURATION_MS ?? 10000);
    const durationLimitMs = m4a || m4b ? 30_000 : 60_000;
    assert.ok(Number.isFinite(durationMs) && durationMs > 0 && durationMs <= durationLimitMs, `本轮性能短测最多${durationLimitMs / 1000}秒；禁止启动30分钟运行`);
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1000) { await page.waitForTimeout(Math.min(1000, durationMs - elapsed)); samples.push(await page.evaluate(() => ({ metrics: window.skyApp.metrics, diagnostics: window.skyApp.diagnostics }))); }
    await page.evaluate(() => window.skyApp.pause());
    report.samples = samples;
    const deliveryEnd = await page.evaluate(() => window.skyApp.diagnostics);
    report.deliveredFrames = { frameCount: deliveryEnd.renderCount - deliveryStart.renderCount, seconds: (deliveryEnd.performanceNowMs - deliveryStart.performanceNowMs) / 1000, framesPerSecond: (deliveryEnd.renderCount - deliveryStart.renderCount) * 1000 / (deliveryEnd.performanceNowMs - deliveryStart.performanceNowMs), intervalsMs: deliveryEnd.deliveredFrameMs, intervalWindowSeconds: deliveryEnd.deliveredSamplingWindowSeconds };
    report.longTasks = await page.evaluate(() => window.__qaLongTasks);
    report.longTaskScope = 'Browser longtask API, bounded to 128 latest entries; includes startup and stress, not GPU work.';
    report.durationMs = durationMs;
    report.status = report.environment.renderingClassification === 'software' ? 'software-rendering-diagnostic-only' : report.environment.renderingClassification === 'unknown' ? 'rendering-device-unverified-diagnostic' : 'short-browser-device-diagnostic';
    report.limitations.push(`${switchCount} switches exercised ${modes.join('/')}.`, `This round is limited to a short test no longer than ${durationLimitMs / 1000} seconds; 30-minute playback is untested.`, 'RAF intervals measure application pacing; browser GPU identity is reported separately; power state is not measured.', 'Worker heap and driver/browser GPU allocations are unavailable.');
    if (report.environment.renderingClassification === 'software') report.limitations.push('Software rendering results must not be cited as physical-device FPS.');
    await shot('performance-final.png');
  } else throw new Error(`Unknown QA kind: ${kind}`);
  assert.equal(errors.length, 0, errors.join('\n'));
  report.expectedCapabilityErrors = m4a && process.env.SKY_QA_FORCE_2D === '1'
    ? consoleErrors.filter(text => /THREE\.WebGLRenderer.*Error creating WebGL(?:2)? context/i.test(text)) : [];
  const gpuErrors = consoleErrors.filter(text => /shader|WebGL|GL_INVALID|VALIDATE_STATUS|COMPILE_STATUS|LINK_STATUS/i.test(text) && !report.expectedCapabilityErrors.includes(text));
  assert.equal(gpuErrors.length, 0, gpuErrors.join('\n'));
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack ?? String(error);
  if (page && kind === 'pwa') {
    try { report.cacheDiagnostic = await page.evaluate(async () => ({ controller: navigator.serviceWorker.controller?.scriptURL, caches: await Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))) })); } catch {}
  }
  if (page) { try { const path = resolve(outDir, 'failure.png'); await page.screenshot({ path }); report.screenshots.push(path); } catch {} }
  process.exitCode = 1;
} finally {
  if (report.sourceBefore) { report.sourceAfter = await m5bSourceIdentity(); report.sourceChangedDuringCheck = JSON.stringify(report.sourceAfter) !== JSON.stringify(report.sourceBefore); }
  report.pageErrors = errors;
  report.consoleErrors = consoleErrors;
  report.httpRequests = requests;
  if (kind === 'recording' && page?.video()) {
    const video = page.video();
    await context.close();
    const path = resolve(outDir, 'interaction.webm');
    await video.saveAs(path);
    report.recording = { path, bytes: (await stat(path)).size };
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`${kind}: ${report.status}; report ${resolve(outDir, 'report.json')}`);
}
