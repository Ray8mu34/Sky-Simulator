import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m5a-platform/lifecycle');
const appUrl = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const channel = process.env.SKY_QA_CHANNEL ?? 'chrome', headless = process.env.SKY_QA_HEADED === '0';
const destination = new URL('qa-lifecycle-target.html', appUrl).href;
const expectedBuild = process.env.SKY_QA_BUILD_ID;
const expectedEntry = process.env.SKY_QA_ENTRY;
await mkdir(outDir, { recursive: true });
const report = { status: 'running', appUrl, channel, headless, startedAt: new Date().toISOString(),
  expectedIdentity: { buildId: expectedBuild ?? null, entry: expectedEntry ?? null }, limitations: [] };
async function buildIdentity(page) {
  const identity = await page.evaluate(() => ({ buildId: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  if (expectedBuild) assert.equal(identity.buildId, expectedBuild, 'Lifecycle page must be the requested frozen build.');
  if (expectedEntry) assert.ok(identity.entries.some(entry => entry.endsWith(`/assets/${expectedEntry}`)), 'Lifecycle module must match the requested frozen entry.');
  return identity;
}
// Playwright normally disables BFCache. Remove that default flag, without forcing eligibility.
const browser = await chromium.launch({ channel, headless, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
try {
  report.browserVersion = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route(destination, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Lifecycle navigation target</title><p>Actual same-origin navigation target.</p>' }));
    await context.addInitScript(() => {
      const key = '__skyLifecycleEvidence';
      window.__skyDocumentIdentity = crypto.randomUUID();
      const write = record => {
        const entries = JSON.parse(sessionStorage.getItem(key) ?? '[]'); entries.push(record); sessionStorage.setItem(key, JSON.stringify(entries.slice(-16)));
      };
      window.addEventListener('pageshow', event => write({ event: 'pageshow', persisted: event.persisted, documentIdentity: window.__skyDocumentIdentity, url: location.href }));
    });
    const page = await context.newPage();
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
    report.initialBuild = await buildIdentity(page);
    // Register after the app listener. Microtasks between event listeners would otherwise capture before disposal.
    await page.evaluate(() => window.addEventListener('pagehide', event => {
      const key = '__skyLifecycleEvidence', entries = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      entries.push({ event: 'pagehide', persisted: event.persisted, documentIdentity: window.__skyDocumentIdentity, url: location.href,
        lifecycle: window.skyApp.diagnostics.lifecycle, workerCount: window.skyApp.diagnostics.workerCount });
      sessionStorage.setItem(key, JSON.stringify(entries.slice(-16)));
    }));
    const before = await page.evaluate(() => ({ documentIdentity: window.__skyDocumentIdentity, state: window.skyApp.state, diagnostics: window.skyApp.diagnostics }));
    await page.goto(destination, { waitUntil: 'load' });
    report.firstNavigationEvidence = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__skyLifecycleEvidence') ?? '[]'));
    await page.goBack({ waitUntil: 'commit', timeout: 5000 });
    await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
    const returned = await page.evaluate(() => ({ documentIdentity: window.__skyDocumentIdentity, state: window.skyApp.state, diagnostics: window.skyApp.diagnostics,
      events: JSON.parse(sessionStorage.getItem('__skyLifecycleEvidence') ?? '[]'),
      navigation: performance.getEntriesByType('navigation').map(entry => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons?.toJSON?.() ?? entry.notRestoredReasons ?? null })) }));
    report.before = before; report.returned = returned;
    report.returnedBuild = await buildIdentity(page);
    assert.deepEqual(report.returnedBuild, report.initialBuild);
    const restored = returned.documentIdentity === before.documentIdentity && returned.events.some(entry => entry.event === 'pageshow' && entry.persisted && entry.documentIdentity === before.documentIdentity);
    if (restored) {
      assert.equal(returned.diagnostics.lifecycle.disposed, false);
      assert.equal(returned.diagnostics.lifecycle.persistedPageHideCount, 1);
      assert.deepEqual(returned.state, before.state);
      // Real reload exits the restored document, instead of synthesizing pagehide or terminating its workers from QA.
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.skyApp?.ready);
      report.reloadedBuild = await buildIdentity(page);
      assert.deepEqual(report.reloadedBuild, report.initialBuild);
      const finalEvents = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__skyLifecycleEvidence') ?? '[]'));
      report.finalNavigationEvidence = finalEvents;
      const disposed = finalEvents.findLast(entry => entry.event === 'pagehide' && entry.documentIdentity === before.documentIdentity);
      if (!disposed?.persisted) {
        assert.equal(disposed.lifecycle.disposed, true); assert.equal(disposed.lifecycle.disposeCount, 1); assert.equal(disposed.workerCount, 0);
        report.status = 'passed-real-bfcache-return-then-real-dispose';
      } else {
        report.status = 'passed-real-bfcache-return-final-dispose-unverified';
        report.limitations.push('The real reload retained the document again; nonpersisted cleanup after BFCache remains unverified.');
      }
    } else {
      const disposed = report.firstNavigationEvidence.findLast(entry => entry.event === 'pagehide' && entry.documentIdentity === before.documentIdentity);
      if (disposed && !disposed.persisted) {
        assert.equal(disposed.lifecycle.disposed, true); assert.equal(disposed.workerCount, 0); assert.equal(disposed.lifecycle.disposeCount, 1);
      }
      report.status = 'bfcache-not-restored-real-navigation-cleanup-observed';
      report.limitations.push('Actual browser navigation did not restore the document. BFCache remains unverified; notRestoredReasons and page transition evidence are retained. Vite HMR or browser eligibility may affect this development test.');
    }
  } finally { await context.close(); }
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally { await browser.close(); report.allBrowsersClosed = true; report.finishedAt = new Date().toISOString(); await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(`${report.status}; ${resolve(outDir, 'report.json')}`); }
