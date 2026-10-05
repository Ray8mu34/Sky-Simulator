import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:4173/';
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/final-m5c-ui-cadence/main-interaction');
assert.ok(process.env.SKY_QA_BUILD_ID && process.env.SKY_QA_ENTRY);
await mkdir(out, { recursive: true });
const report = { status: 'running', url, checks: [], errors: [], limits: ['Targeted real main/DOM cadence check, not performance or a new scientific event oracle.'] };
let browser, context, page;
const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot,
  teaching: window.skyApp.teachingData, diagnostics: window.skyApp.diagnostics,
  dom: { utc: document.querySelector('.utc-readout').textContent, objectDate: document.querySelector('.object-day-heading').textContent,
    solarDate: document.querySelector('.solar-day-heading').textContent, objectKey: document.querySelector('#sky-object-day').dataset.objectDayKey } }));
const paired = page => page.waitForFunction(() => {
  const app = window.skyApp, descriptor = app.snapshot?.observerRefraction, env = app.state.environment;
  return app.ready && !app.diagnostics.scienceDirty && app.diagnostics.lastRenderedUt === app.state.time.utDaysJ2000 &&
    descriptor?.mode === env.refraction && descriptor.pressureHpa === env.pressureHpa && descriptor.temperatureC === env.temperatureC &&
    document.querySelector('#sky-refraction').dataset.refractionStatus === 'ready';
}, undefined, { timeout: 20_000 });
const dayReady = page => page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready' &&
  window.skyApp.teachingData.objectDayStatus === 'ready' && document.querySelector('#sky-object-day').dataset.objectDayKey === window.skyApp.teachingData.objectDayKey);
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 } }); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message)); await page.goto(url); await page.waitForFunction(() => window.skyApp?.ready);
  report.build = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  assert.equal(report.build.id, process.env.SKY_QA_BUILD_ID); assert.ok(report.build.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)));
  await page.evaluate(() => {
    const state = window.skyApp.state; state.time.running = false; state.time.mode = 'simulation'; state.time.rateSimSecondsPerRealSecond = 600;
    state.time.utDaysJ2000 = (Date.parse('2026-09-14T15:59:30Z') - 946728000000) / 86400000;
    state.selected = 'body:Moon'; state.observer.displayZone = { kind: 'fixed', offsetMinutes: 480 };
    state.environment.refraction = 'standard'; state.environment.pressureHpa = 1013.25; state.environment.temperatureC = 15;
    window.skyApp.setState(state); document.querySelector('#sky-teaching').open = true; document.querySelector('#sky-object-day').open = true;
    document.querySelector('#sky-refraction').open = true;
    window.dispatchEvent(new CustomEvent('sky:teaching-visibility')); window.dispatchEvent(new CustomEvent('sky:object-day-visibility'));
  });
  await paired(page); await dayReady(page); report.before = await inspect(page);
  assert.equal(report.before.teaching.objectDay.dateLocal, '2026-09-14');
  await page.evaluate(() => {
    const audit = { records: [], firstNewOrClearedMs: null, playLowerMs: null, playUpperMs: null };
    const collect = () => {
      const objectHeading = document.querySelector('.object-day-heading').textContent;
      const solarHeading = document.querySelector('.solar-day-heading').textContent;
      const objectUts = [...document.querySelectorAll('[data-object-event-ut]')].map(button => Number(button.dataset.objectEventUt));
      const solarUts = [...document.querySelectorAll('.solar-day-events [data-event-ut]')].map(button => Number(button.dataset.eventUt));
      const record = { atMs: performance.now(), objectHeading, solarHeading, objectUts, solarUts };
      audit.records.push(record); if (audit.records.length > 600) audit.records.shift();
      if (audit.firstNewOrClearedMs === null && (!objectHeading.startsWith('2026-09-14') || !solarHeading.startsWith('2026-09-14'))) audit.firstNewOrClearedMs = record.atMs;
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.querySelector('#sky-object-day'), { subtree: true, childList: true, characterData: true, attributes: true });
    observer.observe(document.querySelector('#sky-teaching'), { subtree: true, childList: true, characterData: true });
    window.__qaUiDayAudit = audit; window.__qaUiDayAuditObserver = observer; collect();
    audit.playLowerMs = performance.now(); window.skyApp.play(); audit.playUpperMs = performance.now();
  });
  await page.locator('#sky-pressure').fill('950'); await page.locator('#sky-temperature').fill('-20');
  await page.waitForTimeout(360);
  report.playingDraft = await inspect(page);
  assert.equal(report.playingDraft.state.environment.pressureHpa, 1013.25); assert.equal(report.playingDraft.state.environment.temperatureC, 15);
  assert.equal(await page.locator('#sky-pressure').inputValue(), '950'); assert.equal(await page.locator('#sky-temperature').inputValue(), '-20');
  await page.evaluate(() => window.skyApp.pause()); await paired(page); await dayReady(page); report.paused = await inspect(page);
  report.audit = await page.evaluate(() => { window.__qaUiDayAuditObserver.disconnect(); return window.__qaUiDayAudit; });
  assert.equal(report.paused.state.time.running, false); assert.equal(report.paused.teaching.objectDay.dateLocal, '2026-09-15');
  assert.equal(report.paused.teaching.solarDay.dateLocal, '2026-09-15'); assert.notEqual(report.paused.teaching.objectDayKey, report.before.teaching.objectDayKey);
  assert.equal(report.paused.dom.objectKey, report.paused.teaching.objectDayKey);
  const expectedUtc = new Date(Math.round(report.paused.state.time.utDaysJ2000 * 86400000) + 946728000000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(report.paused.dom.utc, `UTC ${expectedUtc}`);
  assert.ok(report.audit.firstNewOrClearedMs !== null);
  report.observedMidnightRefreshUpperMs = report.audit.firstNewOrClearedMs - (report.audit.playLowerMs + 50);
  assert.ok(report.observedMidnightRefreshUpperMs <= 180, 'The known 600x midnight is 50 real milliseconds after play; old-day UI clears or updates within the existing 180ms.');
  for (const record of report.audit.records) for (const [heading, uts] of [[record.objectHeading, record.objectUts], [record.solarHeading, record.solarUts]]) {
    const date = heading.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (!date) { assert.deepEqual(uts, []); continue; }
    for (const ut of uts) assert.equal(new Date(Math.round(ut * 86400000) + 946728000000 + 8 * 3600000).toISOString().slice(0, 10), date,
      'Every visible dated heading must own only its actual local-day event buttons.');
  }
  report.checks.push('Actual 600x playback crosses fixed-UTC+8 midnight; old event buttons clear/update within 180ms, and every observed dated heading owns only same-day events.',
    'An uncommitted P/T draft survives real periodic playback updates; pause publishes the exact accepted UTC and matching new-day result immediately.');
  const beforeApply = report.paused;
  await page.locator('#sky-apply-refraction').click(); await paired(page); await dayReady(page); report.applied = await inspect(page);
  assert.equal(report.applied.state.environment.pressureHpa, 950); assert.equal(report.applied.state.environment.temperatureC, -20);
  assert.equal(report.applied.state.time.utDaysJ2000, beforeApply.state.time.utDaysJ2000);
  assert.equal(report.applied.diagnostics.clockRebaseCount, beforeApply.diagnostics.clockRebaseCount);
  assert.deepEqual(report.applied.state.cameras, beforeApply.state.cameras); assert.equal(report.applied.state.selected, beforeApply.state.selected);
  assert.deepEqual(report.applied.teaching.solarDay, beforeApply.teaching.solarDay); assert.deepEqual(report.applied.teaching.objectDay, beforeApply.teaching.objectDay);
  assert.equal(report.applied.diagnostics.dayEvents.cache.computations, beforeApply.diagnostics.dayEvents.cache.computations);
  report.checks.push('A real paused apply consumes the preserved draft immediately without changing UTC/cameras/selection or recomputing its fixed-definition day events.');
  assert.deepEqual(report.errors, []); report.status = 'passed-main-ui-cadence-regression';
  await page.screenshot({ path: resolve(out, 'paused-next-day-refraction.png') });
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
} finally {
  if (context) await context.close(); if (browser) await browser.close(); report.browserClosed = true;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), midnightRefreshUpperMs: report.observedMidnightRefreshUpperMs, failure: report.failure?.message }));
