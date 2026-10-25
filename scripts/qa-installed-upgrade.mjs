import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { installGraphicsProbe, waitGraphicsReady } from './qa-m4a.mjs';
import { startUpdateServer } from './qa-update-server.mjs';

// Exercise immutable previous/current packages without rebuilding either release.
const packages = {
  OLD: resolve(process.env.SKY_QA_INSTALLED_OLD ?? 'qa/teaching-resilience/sustained-baseline/frozen-web'),
  NEW: resolve(process.env.SKY_QA_INSTALLED_NEW ?? 'dist'),
};
const out = resolve(process.env.SKY_QA_INSTALLED_OUT ?? 'qa/installed-upgrade');
const report = { status: 'running', startedAt: new Date().toISOString(), assertions: [], pageErrors: [], screenshots: [], limitations: [
  'Previously built production packages are served unchanged on private localhost; this does not change the public site.',
  'Chrome Canvas2D fallback isolates installed Service Worker upgrade behavior. Offline is browser-context simulation.',
] };
await mkdir(out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function packageIdentity(directory) {
  const build = JSON.parse(await readFile(resolve(directory, 'build-report.json'), 'utf8'));
  const identity = { directory, buildId: build.buildId, testTag: build.testTag, htmlSha256: sha(await readFile(resolve(directory, 'index.html'))),
    swSha256: sha(await readFile(resolve(directory, 'sw.js'))), modules: build.offlineCore.filter(file => file.url.endsWith('.js')) };
  for (const file of build.offlineCore) assert.equal(sha(await readFile(resolve(directory, file.url))), file.sha256, `Frozen resource changed: ${file.url}`);
  return identity;
}
const pass = message => { report.assertions.push(message); console.log(`PASS ${message}`); };
async function waitFor(label, predicate) {
  for (const until = performance.now() + 30_000; performance.now() < until;) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function phase(page, phase) { await page.waitForFunction(phase => window.skyApp?.offlineStatus?.phase === phase, phase, { timeout: 30_000 }); }
const snapshot = page => page.evaluate(() => ({ status: window.skyApp.offlineStatus, state: window.skyApp.state,
  pageBuild: document.querySelector('meta[name="sky-build-id"]').content,
  modules: [...document.querySelectorAll('script[type="module"][src]')].map(element => element.src) }));
async function shot(page, name) { await page.screenshot({ path: resolve(out, name) }); report.screenshots.push(name); }
let server, browser, context;
try {
  report.packages = { old: await packageIdentity(packages.OLD), new: await packageIdentity(packages.NEW) };
  const oldId = report.packages.old.buildId, newId = report.packages.new.buildId;
  assert.notEqual(oldId, newId); assert.equal(report.packages.old.testTag, null); assert.equal(report.packages.new.testTag, null);
  server = await startUpdateServer(packages); server.select('/installed-app/', 'OLD'); const url = `${server.origin}/installed-app/`;
  browser = await chromium.launch({ channel: process.env.SKY_QA_CHANNEL ?? 'chrome', headless: true }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 } }); await installGraphicsProbe(context, true);
  const control = await context.newPage(); await control.goto(server.origin);
  async function open() {
    const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'load' }); await waitGraphicsReady(page, 'canvas2d'); return page;
  }
  let page = await open(); await phase(page, 'ready'); await page.reload(); await waitGraphicsReady(page, 'canvas2d'); await phase(page, 'ready');
  await page.evaluate(() => {
    const scene = window.skyApp.state; scene.selected = 'hip:91262'; scene.viewMode = 'space'; scene.layers.earthDay = false;
    scene.observer.displayZone = { kind: 'fixed', offsetMinutes: 345 }; scene.time.running = false;
    window.skyApp.setState(scene);
  });
  const before = await snapshot(page); assert.equal(before.pageBuild, oldId);
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
  await page.locator('#sky-scene-name').fill('旧版课堂 · 升级保留'); await page.locator('#sky-save-scene').click();
  const stored = await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1'));
  const savedScene = JSON.parse(stored).scenes[0]; assert.deepEqual(savedScene.state, before.state);
  report.savedScene = { id: savedScene.id, name: savedScene.name, state: savedScene.state, storageSha256: sha(stored) };
  const keeper = await open(); await phase(keeper, 'ready');
  pass(`Actual previous release ${oldId} is installed, controlled, and has a named user scene saved through its existing UI.`);

  server.select('/installed-app/', 'NEW');
  await page.evaluate(async () => { await window.skyApp.checkForOfflineUpdate(); }); await phase(page, 'update-ready');
  await keeper.evaluate(async () => { await window.skyApp.checkForOfflineUpdate(); }); await phase(keeper, 'update-ready');
  report.oldWhileNewWaits = await snapshot(page); report.secondOldPage = await snapshot(keeper);
  for (const value of [report.oldWhileNewWaits, report.secondOldPage]) {
    assert.equal(value.pageBuild, oldId); assert.equal(value.status.activeBuildId, oldId); assert.equal(value.status.waitingBuildId, newId);
    assert.deepEqual(value.modules, before.modules);
  }
  assert.deepEqual(report.oldWhileNewWaits.state, before.state);
  assert.equal(await page.locator('#sky-offline-notice').isVisible(), true);
  await shot(page, 'actual-old-release-new-waiting.png');
  pass('Both old pages keep their original JavaScript and page identity while the actual new release is cached and waiting.');

  await page.close();
  assert.equal(await control.evaluate(async url => (await navigator.serviceWorker.getRegistration(url)).waiting?.state, url), 'installed');
  await keeper.close();
  await waitFor('new production release natural activation', () => control.evaluate(async url => {
    const reg = await navigator.serviceWorker.getRegistration(url);
    return reg && !reg.waiting && !reg.installing && reg.active?.state === 'activated';
  }, url));
  await context.setOffline(true); page = await open(); await phase(page, 'ready');
  report.newOffline = await snapshot(page);
  assert.equal(report.newOffline.pageBuild, newId); assert.equal(report.newOffline.status.activeBuildId, newId);
  assert.match(await page.locator('#sky-app-version').textContent(), /v0\.2\.0/);
  assert.equal(await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1')), stored);
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
  await page.locator('#sky-saved-scenes').selectOption(savedScene.id); await page.locator('#sky-load-saved-scene').click();
  assert.deepEqual((await snapshot(page)).state, before.state);
  assert.equal(await page.locator('#sky-offline-notice').isVisible(), false);
  await shot(page, 'actual-new-release-offline-saved-scene.png');
  pass(`Only closing every old page activates ${newId}; v0.2.0 opens offline and loads the exact original saved scene.`);
  assert.deepEqual(await packageIdentity(packages.OLD), report.packages.old);
  assert.deepEqual(await packageIdentity(packages.NEW), report.packages.new);
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n')); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(error); }
finally {
  await context?.close(); await browser?.close(); await server?.close();
  report.requests = server?.requests ?? []; report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Installed-release upgrade QA: ${report.status}; ${resolve(out, 'report.json')}`);
}
