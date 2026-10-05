import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { waitGraphicsReady } from './qa-m4a.mjs';
import { installSnapshotTransferProbe, assertSnapshotTransfers } from './qa-snapshot-transfer.mjs';

const artifact = resolve('dist-portable/三维全景夜空.html'), out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/portable-startup');
const expectedSha = process.env.SKY_QA_PORTABLE_SHA256;
assert.match(expectedSha ?? '', /^[a-f0-9]{64}$/i);
const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex'); assert.equal(sha256, expectedSha.toLowerCase());
await mkdir(out, { recursive: true });
const report = { status: 'running', artifact: { path: artifact, sha256, bytes: (await stat(artifact)).size },
  headed: true, httpRequests: [], errors: [], consoleErrors: [],
  scope: 'Lowest necessary fresh native-worker portable startup check after pure renderer changes; previous detailed offline/fallback/context matrices are retained separately.' };
let browser, context, page;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 } }); await installSnapshotTransferProbe(context);
  await context.setOffline(true); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) report.httpRequests.push(request.url()); });
  await page.goto(pathToFileURL(artifact).href); await waitGraphicsReady(page, 'webgl2');
  report.initial = await page.evaluate(() => ({ state: window.skyApp.state, snapshotUt: window.skyApp.snapshot.utDaysJ2000,
    descriptor: window.skyApp.snapshot.observerRefraction, diagnostics: window.skyApp.diagnostics }));
  assert.equal(report.initial.state.time.running, false); assert.equal(report.initial.snapshotUt, report.initial.state.time.utDaysJ2000);
  const before = report.initial.diagnostics;
  await page.locator('#sky-refraction').evaluate(section => { section.open = true; });
  await page.locator('#sky-refraction-mode').selectOption('standard'); await page.locator('#sky-pressure').fill('1013.25');
  await page.locator('#sky-temperature').fill('15'); await page.locator('#sky-apply-refraction').click();
  await page.waitForFunction(() => {
    const app = window.skyApp;
    return !app.diagnostics.scienceDirty && app.diagnostics.lastRenderedUt === app.state.time.utDaysJ2000 &&
      app.snapshot.observerRefraction.mode === 'standard' && document.querySelector('#sky-refraction').dataset.refractionStatus === 'ready';
  });
  report.standard = await page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics,
    refraction: window.skyApp.rendererDiagnostics.refraction,
    probe: { created: window.__qaWorkersCreated, transfers: window.__qaSnapshotTransfers, replies: window.__qaSnapshotReplies } }));
  assert.equal(report.standard.diagnostics.clockRebaseCount, before.clockRebaseCount);
  assert.equal(report.standard.diagnostics.scienceRequestCount, before.scienceRequestCount + 1);
  assert.equal(report.standard.state.time.utDaysJ2000, report.initial.state.time.utDaysJ2000);
  assert.equal(report.standard.refraction.enabled, true); assert.equal(report.standard.refraction.textureBytes, 32768);
  assertSnapshotTransfers(report.standard.probe, false);
  assert.deepEqual(report.httpRequests, []); assert.deepEqual(report.errors, []);
  assert.equal(report.consoleErrors.filter(message => /shader|webgl|gl_invalid/i.test(message)).length, 0);
  await page.locator('#sky-refraction').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(out, 'file-first-open-standard.png') });
  report.status = 'passed-minimal-portable-startup';
} catch (error) { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { if (context) await context.close(); if (browser) await browser.close(); report.browserClosed = true; await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), sha256, failure: report.failure?.message }));
