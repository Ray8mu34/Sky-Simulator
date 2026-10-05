import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:4173/';
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/s09-ui/original-01';
await mkdir(out, { recursive: true });
const report = { url, stage: process.env.SKY_UI_QA_STAGE ?? 'frozen e279 original / diagnostic, no source changes',
  records: [], mutations: [], errors: [], failure: null, limits: ['DOM/core same-UT title comparison, not a moon texture/physical orientation oracle.',
    'A 2-second paused observation and cropped native DOM screenshots distinguish persistent UI mismatch from glyph reading; no added application clock or science solver.'] };
let browser, page;
async function paired() {
  await page.waitForFunction(() => {
    const app = window.skyApp, d = app?.diagnostics;
    return app?.ready && !app.state.time.running && !d.scienceDirty && d.lastRenderedUt === app.state.time.utDaysJ2000
      && d.lastRenderedMode === app.state.viewMode && d.pendingInteractionCount === 0;
  });
}
async function read() {
  return page.evaluate(() => {
    const app = window.skyApp, label = document.querySelector('.moon-phase-name'), text = label.textContent;
    return { text, innerText: label.innerText, codePointsHex: [...text].map(char => char.codePointAt(0).toString(16)),
      count: document.querySelectorAll('.moon-phase-name').length, outerHTML: label.outerHTML,
      font: getComputedStyle(label).font, moon: app.teachingData.moon, state: app.state,
      snapshotUt: app.snapshot.utDaysJ2000, scienceDirty: app.diagnostics.scienceDirty,
      lastRenderedUt: app.diagnostics.lastRenderedUt, clockRebaseCount: app.diagnostics.clockRebaseCount,
      scienceRequestCount: app.diagnostics.scienceRequestCount, phase: app.diagnostics.viewTransition.phase };
  });
}
async function loadSeed() {
  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  await page.locator('#sky-preset').selectOption('S09'); await page.locator('#sky-load-preset').click(); await paired();
  await page.locator('#sky-teaching').evaluate(el => { el.open = true; });
  await page.locator('#sky-quarter-search').click();
  await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  return page.evaluate(() => window.skyApp.teachingData.moonPhases);
}
async function inspect(name, expectedName) {
  await paired();
  const first = await read();
  await page.waitForTimeout(2100);
  const settled = await read();
  await page.locator('#sky-moon-loupe-toggle').scrollIntoViewIfNeeded();
  if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => { const app = window.skyApp; return app.moonLoupeDiagnostics.open && app.moonLoupeDiagnostics.status === 'ready' && app.moonLoupeDiagnostics.utDaysJ2000 === app.state.time.utDaysJ2000; });
  const loupe = await read();
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.locator('.moon-phase-name').screenshot({ path: `${out}/${name}-native-title.png` });
  report.records.push({ name, first, settled, loupe });
  for (const value of [first, settled, loupe]) {
    assert.equal(value.snapshotUt, value.state.time.utDaysJ2000);
    assert.equal(value.moon.utDaysJ2000, value.state.time.utDaysJ2000);
    assert.equal(value.moon.phaseNameZh, expectedName);
    assert.equal(value.text, value.moon.phaseNameZh, `${name}: actual DOM must equal the paired core label`);
  }
  assert.deepEqual(settled.state, first.state); assert.equal(settled.clockRebaseCount, first.clockRebaseCount);
  assert.equal(settled.scienceRequestCount, first.scienceRequestCount);
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true }); page = await browser.newPage({ viewport: { width: 1152, height: 720 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await paired();
  report.build = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(el => el.getAttribute('src')) }));
  if (process.env.SKY_QA_BUILD_ID) assert.equal(report.build.id, process.env.SKY_QA_BUILD_ID);
  if (process.env.SKY_QA_ENTRY) assert.ok(report.build.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)));
  const entry = report.build.entries.find(entry => entry.includes('/assets/'));
  if (entry) { const response = await page.request.get(new URL(entry, page.url()).href); report.build.moduleSha256 = createHash('sha256').update(await response.body()).digest('hex'); }
  await page.evaluate(() => {
    window.__qaMoonTitleMutations = [];
    new MutationObserver(records => {
      if (!records.some(record => record.target.parentElement?.closest('.moon-phase-name') || record.target instanceof Element && record.target.matches('.moon-phase-name'))) return;
      const app = window.skyApp;
      if (window.__qaMoonTitleMutations.length < 96) window.__qaMoonTitleMutations.push({ atMs: performance.now(),
        text: document.querySelector('.moon-phase-name').textContent, stateUt: app.state.time.utDaysJ2000,
        snapshotUt: app.snapshot?.utDaysJ2000, moon: app.teachingData.moon?.phaseNameZh });
    }).observe(document.querySelector('#controls'), { subtree: true, childList: true, characterData: true });
  });
  const sequence = await loadSeed(); report.sequence = sequence;
  const lower = sequence.events.find(event => event.phaseLongitudeDeg === 270), upper = sequence.events.find(event => event.phaseLongitudeDeg === 90);
  await page.locator(`[data-event-ut="${lower.utDaysJ2000}"]`).click(); await inspect('lower-270-north', '下弦月附近');
  await page.locator(`[data-event-ut="${upper.utDaysJ2000}"]`).click(); await inspect('direct-270-to-90-north', '上弦月附近');
  const beforeSouth = await page.evaluate(() => window.skyApp.state);
  await page.evaluate(() => { const state = window.skyApp.state; state.observer.name = '南半球核对'; state.observer.latitudeDeg = -33.87; state.observer.longitudeDegEast = 151.21; state.observer.heightMeters = 58; window.skyApp.setState(state); });
  await inspect('upper-90-south', '上弦月附近');
  const south = await page.evaluate(() => window.skyApp.state);
  assert.equal(south.time.utDaysJ2000, beforeSouth.time.utDaysJ2000); assert.deepEqual(south.cameras, beforeSouth.cameras);
  // Repeat the actual final driver route: reload S09 before each new phase.
  await loadSeed(); await page.locator(`[data-event-ut="${lower.utDaysJ2000}"]`).click(); await paired();
  await loadSeed(); await page.locator(`[data-event-ut="${upper.utDaysJ2000}"]`).click(); await inspect('reloaded-seed-90-north', '上弦月附近');
  report.mutations = await page.evaluate(() => window.__qaMoonTitleMutations); assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  if (page) { report.last = await read().catch(() => null); await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); }
  throw error;
} finally {
  if (page) report.mutations = await page.evaluate(() => window.__qaMoonTitleMutations ?? []).catch(() => report.mutations);
  await browser?.close(); report.browserClosed = true;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.records.length, out, browserClosed: true }));
