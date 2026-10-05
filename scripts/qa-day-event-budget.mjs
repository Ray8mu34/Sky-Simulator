import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m5a-platform/day-budget');
const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const channel = process.env.SKY_QA_CHANNEL ?? 'chrome';
const headless = process.env.SKY_QA_HEADED === '0';
await mkdir(outDir, { recursive: true });
const report = { status: 'running', startedAt: new Date().toISOString(), url, channel, headless, samples: [], limitations: [
  'Each app sample uses a fresh browser context; this is a short computation diagnostic, not an FPS or physical-device benchmark.',
  'The first real UI IANA key is measured on the main thread before the event calculation. Worker Intl initialization has its own isolate.',
  'Cooperative generator chunks cannot split a synchronous Intl.DateTimeFormat constructor. Warm same-day UI measurements do not certify all cold chunks below 8ms.',
] };
const browser = await chromium.launch({ channel, headless });
try {
  report.browserVersion = browser.version();
  for (const mode of ['worker', 'fallback']) {
    const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, serviceWorkers: 'block' });
    try {
      await context.addInitScript(() => {
        window.__dayBudgetIntl = [];
        const Original = Intl.DateTimeFormat;
        Intl.DateTimeFormat = new Proxy(Original, { construct(target, args) {
          const started = performance.now();
          const formatter = Reflect.construct(target, args, target);
          window.__dayBudgetIntl.push({ startMs: started, durationMs: performance.now() - started, locale: args[0], options: args[1] });
          return formatter;
        } });
      });
      const page = await context.newPage(), pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const testUrl = new URL(url); if (mode === 'fallback') testUrl.searchParams.set('events-worker', 'off');
      await page.goto(testUrl.href, { waitUntil: 'load' });
      await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
      const initial = await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, intl: [...window.__dayBudgetIntl] }));
      const change = await page.evaluate(() => {
        const state = window.skyApp.state;
        state.time.running = false; state.time.mode = 'simulation';
        state.time.utDaysJ2000 = (Date.parse('2026-09-14T12:00:00Z') - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
        state.observer.latitudeDeg = 40.7128; state.observer.longitudeDegEast = -74.006;
        state.observer.displayZone = { kind: 'iana', name: 'America/New_York', versionNote: '本机浏览器 Intl 时区规则；冷启动诊断。' };
        state.selected = 'body:Moon';
        const started = performance.now(); window.skyApp.setState(state);
        const setStateMs = performance.now() - started;
        const teaching = document.querySelector('#sky-teaching'); teaching.open = true;
        window.dispatchEvent(new CustomEvent('sky:teaching-visibility', { detail: { visible: true } }));
        return { setStateMs, startedMs: started, intlAfterSynchronousChange: [...window.__dayBudgetIntl] };
      });
      await page.waitForFunction(() => {
        const app = window.skyApp, day = app.teachingData, diagnostics = app.diagnostics;
        return day.solarDayStatus === 'ready' && day.objectDayStatus === 'ready' &&
          diagnostics.dayEvents.activeRequestCount === 0 && diagnostics.dayEvents.pendingLatestRequestCount === 0;
      }, undefined, { timeout: 30_000 });
      const cold = await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, teaching: window.skyApp.teachingData, intl: [...window.__dayBudgetIntl], state: window.skyApp.state }));
      const warmStarted = Date.now();
      await page.locator('#sky-search').fill('HIP32349');
      await page.locator('[data-object-id="hip:32349"]').click();
      await page.waitForFunction(() => window.skyApp.state.selected === 'hip:32349' && window.skyApp.teachingData.objectDayStatus === 'ready' && window.skyApp.diagnostics.dayEvents.activeRequestCount === 0, undefined, { timeout: 30_000 });
      const warm = await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, teaching: window.skyApp.teachingData, intl: [...window.__dayBudgetIntl] }));
      assert.equal(cold.diagnostics.dayEvents.mode, mode === 'worker' ? 'worker' : 'main-thread-cooperative');
      assert.equal(cold.diagnostics.workerCount, mode === 'worker' ? 2 : 1);
      assert.equal(warm.teaching.solarDayKey, cold.teaching.solarDayKey);
      assert.equal(warm.diagnostics.dayEvents.cache.maxEntries, 16);
      assert.ok(warm.diagnostics.dayEvents.cache.cacheEntries <= 16);
      assert.deepEqual(pageErrors, []);
      report.samples.push({ mode, url: page.url(), initial, synchronousIanaUiChange: change, cold, warm, warmUiWallMs: Date.now() - warmStarted,
        fallbackChunkBudget: mode === 'fallback' ? { budgetMs: 8, measuredMaxMs: warm.diagnostics.dayEvents.maxFallbackChunkMs, status: warm.diagnostics.dayEvents.maxFallbackChunkMs <= 8 ? 'passed-this-sample' : 'failed-this-sample' } : null,
        mainIntlConstructorBudget: { budgetMs: 8, measuredMaxMs: Math.max(0, ...cold.intl.map(entry => entry.durationMs)), status: cold.intl.every(entry => entry.durationMs <= 8) ? 'passed-this-sample' : 'failed-this-sample' } });
    } finally { await context.close(); }
  }
  const [worker, fallback] = report.samples;
  assert.deepEqual(fallback.cold.teaching.solarDay, worker.cold.teaching.solarDay);
  assert.deepEqual(fallback.cold.teaching.objectDay, worker.cold.teaching.objectDay);
  const atomContext = await browser.newContext();
  try {
    const page = await atomContext.newPage();
    report.isolatedIntlAtomicProbe = await page.evaluate(() => {
      const started = performance.now();
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const constructorMs = performance.now() - started;
      return { constructorMs, budgetMs: 8, status: constructorMs <= 8 ? 'passed-this-sample' : 'failed-this-sample', formatted: formatter.format(new Date('2026-09-14T12:00:00Z')), scope: 'First Intl constructor in a fresh blank page; atomic-library probe, not an application event chunk.' };
    });
  } finally { await atomContext.close(); }
  report.status = report.samples.some(sample => sample.fallbackChunkBudget?.status === 'failed-this-sample' || sample.mainIntlConstructorBudget.status === 'failed-this-sample') ? 'functional-passed-cold-budget-exceeded' : 'functional-passed-sampled-budget-within-limit';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser.close(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.status}; ${resolve(outDir, 'report.json')}`);
}
