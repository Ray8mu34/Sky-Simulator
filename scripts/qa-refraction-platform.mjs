import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runM5aOfflineSmoke } from './qa-m5a.mjs';
import { installSnapshotTransferProbe, assertSnapshotTransfers } from './qa-snapshot-transfer.mjs';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m5c-platform/development');
const channel = process.env.SKY_QA_CHANNEL ?? 'chrome';
const headless = process.env.SKY_QA_HEADED !== '1';
const sourcePaths = ['src/main.ts', 'src/core/refraction.ts', 'src/render/SkyRenderer.ts', 'src/ui/refraction-controls.ts'];
const sourceIdentity = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
await mkdir(out, { recursive: true });
const report = { status: 'running', startedAt: new Date().toISOString(), url, channel, headless,
  sourceBefore: await sourceIdentity(), checks: [], cases: [], errors: [], consoleErrors: [], screenshots: [],
  limits: ['Development main/transport functionality; no GPU error bound, display FPS, cold-compute budget, physical-mobile or final-release claim.'] };
let browser, context, page;

const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot,
  details: window.skyApp.selectedDetails, teaching: window.skyApp.teachingData, diagnostics: window.skyApp.diagnostics,
  rendererRefraction: window.skyApp.rendererDiagnostics?.refraction ?? null, token: window.__qaDocumentToken }));
const paired = page => page.waitForFunction(() => {
  const app = window.skyApp, d = app?.diagnostics, s = app?.state, descriptor = app?.snapshot?.observerRefraction;
  return app?.ready && !d.scienceDirty && d.lastRenderedUt === s.time.utDaysJ2000 && app.snapshot.utDaysJ2000 === s.time.utDaysJ2000 &&
    d.snapshotInputSignature === d.currentInputSignature && descriptor?.mode === s.environment.refraction &&
    descriptor.pressureHpa === s.environment.pressureHpa && descriptor.temperatureC === s.environment.temperatureC &&
    document.querySelector('#sky-refraction')?.dataset.refractionStatus === 'ready';
}, undefined, { timeout: 20_000 });
const idle = async page => {
  await paired(page);
  await page.waitForFunction(() => window.skyApp.diagnostics.activeRequestCount === 0 && window.skyApp.diagnostics.pendingLatestRequestCount === 0);
};
async function apply(page, mode, pressure, temperature) {
  await page.locator('#sky-refraction-mode').selectOption(mode);
  await page.locator('#sky-pressure').fill(String(pressure)); await page.locator('#sky-temperature').fill(String(temperature));
  const before = await inspect(page);
  await page.locator('#sky-apply-refraction').click(); await idle(page);
  return { before, after: await inspect(page) };
}
function assertSameDay(before, after) {
  assert.equal(after.teaching.solarDayKey, before.teaching.solarDayKey);
  assert.equal(after.teaching.objectDayKey, before.teaching.objectDayKey);
  assert.deepEqual(after.teaching.solarDay, before.teaching.solarDay);
  assert.deepEqual(after.teaching.objectDay, before.teaching.objectDay);
  assert.equal(after.diagnostics.dayEvents.startedCount, before.diagnostics.dayEvents.startedCount);
  assert.equal(after.diagnostics.dayEvents.cache.computations, before.diagnostics.dayEvents.cache.computations);
}

async function runPath(forceFallback) {
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, serviceWorkers: 'block' });
  await installSnapshotTransferProbe(context); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(forceFallback ? `${url}${url.includes('?') ? '&' : '?'}worker=off` : url);
  await page.waitForFunction(() => window.skyApp?.ready);
  const initialToken = await page.evaluate(() => window.__qaDocumentToken);
  await runM5aOfflineSmoke({ page }); await idle(page);
  const path = { forceFallback, cases: [], running: [] };
  await page.locator('#sky-refraction').evaluate(section => { section.open = true; });

  const beforeDraft = await inspect(page);
  await page.locator('#sky-pressure').fill('730'); await page.locator('#sky-temperature').fill('-20');
  await page.waitForTimeout(100);
  const draft = await inspect(page);
  assert.deepEqual(draft.state, beforeDraft.state);
  assert.equal(draft.diagnostics.scienceRequestCount, beforeDraft.diagnostics.scienceRequestCount);
  assert.equal(draft.diagnostics.clockRebaseCount, beforeDraft.diagnostics.clockRebaseCount);
  report.checks.push(`${forceFallback ? 'Cooperative' : 'Native'}: editing the P/T draft does not request science or alter the single clock/state.`);

  for (const [mode, pressure, temperature] of [['standard', 730, -20], ['standard', 0, 80], ['none', 1010, 10]]) {
    const result = await apply(page, mode, pressure, temperature);
    const expected = structuredClone(result.before.state);
    Object.assign(expected.environment, { refraction: mode, pressureHpa: pressure, temperatureC: temperature });
    assert.deepEqual(result.after.state, expected);
    assert.equal(result.after.diagnostics.clockRebaseCount, result.before.diagnostics.clockRebaseCount);
    assert.equal(result.after.diagnostics.scienceRequestCount, result.before.diagnostics.scienceRequestCount + 1);
    assertSameDay(result.before, result.after);
    path.cases.push(result.after);
  }
  report.checks.push(`${forceFallback ? 'Cooperative' : 'Native'}: three actual form transactions keep exact paused UTC, all cameras/selection and day outputs; one new paired snapshot per apply, zero clock rebase/day recomputation.`);

  const burst = await page.evaluate(() => {
    const app = window.skyApp, before = app.diagnostics, form = document.querySelector('#sky-refraction-form');
    for (const pressure of [900, 1100, 800]) {
      document.querySelector('#sky-refraction-mode').value = 'standard';
      document.querySelector('#sky-pressure').value = String(pressure); document.querySelector('#sky-temperature').value = '5';
      form.requestSubmit();
    }
    return { before, after: app.diagnostics, pendingDetails: app.selectedDetails, pendingAppearance: app.skyAppearance };
  });
  assert.equal(burst.after.scienceRequestCount, burst.before.scienceRequestCount + 3);
  assert.equal(burst.after.clockRebaseCount, burst.before.clockRebaseCount);
  assert.equal(burst.pendingDetails, null); assert.equal(burst.pendingAppearance, null);
  assert.ok(burst.after.activeRequestCount <= 1 && burst.after.pendingLatestRequestCount <= 1);
  await idle(page); path.burst = { ...burst, accepted: await inspect(page) };
  assert.equal(path.burst.accepted.snapshot.observerRefraction.pressureHpa, 800);
  report.checks.push(`${forceFallback ? 'Cooperative' : 'Native'}: three rapid commits retain one active plus one latest; old paired readouts are unavailable while pending and the final 800 hPa snapshot wins.`);

  for (const rate of [600, 86400, -600]) {
    const anchor = await page.evaluate(rate => {
      const state = window.skyApp.state; state.time.rateSimSecondsPerRealSecond = rate; state.time.running = true;
      const lower = performance.now(); window.skyApp.setState(state); const upper = performance.now();
      return { lower, upper, ut: state.time.utDaysJ2000, rebaseCount: window.skyApp.diagnostics.clockRebaseCount, state };
    }, rate);
    await page.waitForTimeout(100);
    const commit = await page.evaluate(() => {
      document.querySelector('#sky-refraction-mode').value = 'standard';
      document.querySelector('#sky-pressure').value = '950'; document.querySelector('#sky-temperature').value = '0';
      const lower = performance.now(); document.querySelector('#sky-refraction-form').requestSubmit(); const upper = performance.now();
      return { lower, upper, state: window.skyApp.state, diagnostics: window.skyApp.diagnostics };
    });
    assert.equal(commit.diagnostics.clockRebaseCount, anchor.rebaseCount);
    const extrema = [commit.lower - anchor.upper, commit.upper - anchor.lower].map(ms => anchor.ut + ms * rate / 86_400_000);
    const roundoff = Number.EPSILON * Math.abs(anchor.ut) * 16;
    assert.ok(commit.state.time.utDaysJ2000 >= Math.min(...extrema) - roundoff && commit.state.time.utDaysJ2000 <= Math.max(...extrema) + roundoff,
      `Applied ${rate}x UTC must be sampled from the original anchor bracket.`);
    assert.deepEqual(commit.state.cameras, anchor.state.cameras); assert.equal(commit.state.selected, anchor.state.selected);
    await page.waitForTimeout(120);
    const paused = await page.evaluate(() => { window.skyApp.pause(); return window.skyApp.diagnostics.clockRebaseCount; });
    await idle(page); const settled = await inspect(page);
    assert.equal(settled.diagnostics.clockRebaseCount, paused);
    assert.equal(settled.snapshot.observerRefraction.pressureHpa, 950);
    path.running.push({ rate, anchor, commit, settled });
  }
  report.checks.push(`${forceFallback ? 'Cooperative' : 'Native'}: 600x, 86400x and reverse commits sample the original monotonic anchor within measured call brackets, then pause with an exactly paired final sky.`);

  path.probe = await page.evaluate(() => ({ created: window.__qaWorkersCreated, transfers: window.__qaSnapshotTransfers, replies: window.__qaSnapshotReplies }));
  assertSnapshotTransfers(path.probe, forceFallback);
  assert.equal(await page.evaluate(() => window.__qaDocumentToken), initialToken, 'HMR/reload invalidated this development run.');
  const screenshot = resolve(out, `${forceFallback ? 'fallback' : 'worker'}-paired-refraction.png`);
  await page.locator('#sky-refraction').scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  report.cases.push(path); await context.close(); context = null; page = null;
}

try {
  browser = await chromium.launch({ channel, headless }); report.browserVersion = browser.version();
  await runPath(false); await runPath(true);
  for (let i = 0; i < report.cases[0].cases.length; i++) {
    const worker = report.cases[0].cases[i], fallback = report.cases[1].cases[i];
    const science = ({ requestId, ...snapshot }) => snapshot;
    assert.deepEqual(science(fallback.snapshot), science(worker.snapshot));
    assert.deepEqual(fallback.details, worker.details); assert.deepEqual(fallback.teaching, worker.teaching);
  }
  assert.deepEqual(report.errors, []);
  assert.equal(report.consoleErrors.filter(message => /webgl|shader|gl_invalid|three\.webgl/i.test(message)).length, 0);
  report.checks.push('Native Blob snapshot transport carries only five refraction scalars and a 3×3 ECT matrix; no LUT/typed-array/catalog payload and at most the two existing workers. Paused full snapshots, selected details and teaching outputs exactly match the same-core forced fallback.');
  report.status = 'passed-targeted-platform-functional-checks';
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
  if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (context) await context.close(); if (browser) await browser.close();
  report.browserClosed = true; report.finishedAt = new Date().toISOString(); report.sourceAfter = await sourceIdentity();
  report.sourceChanged = JSON.stringify(report.sourceBefore) !== JSON.stringify(report.sourceAfter);
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, sourceChanged: report.sourceChanged, report: resolve(out, 'report.json'), failure: report.failure?.message }));
