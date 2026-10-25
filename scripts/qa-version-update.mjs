import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { installGraphicsProbe, waitGraphicsReady } from './qa-m4a.mjs';
import { startUpdateServer } from './qa-update-server.mjs';

const root = resolve('qa/version-update'), out = resolve(root, 'evidence');
const packages = { A: resolve(root, 'test-build-a'), B: resolve(root, 'test-build-b') };
const report = { status: 'running', startedAt: new Date().toISOString(), assertions: [], screenshots: [], pageErrors: [], limitations: [
  'A and B are genuine SHA256-committed builds of the same product source, distinguished by QA metadata.',
  'Chromium Canvas2D fallback exercises version/UI lifecycle; this is not a GPU or physical-device test.',
  'Network failures and a held resource are supplied by the private test HTTP server. Offline reopen uses Playwright offline mode.',
] };
await mkdir(out, { recursive: true });
async function buildPackage(version) {
  const logs = [];
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['scripts/build-web.mjs'], { env: { ...process.env, SKY_BUILD_QA_ROOT: root,
      SKY_BUILD_OUT_DIR: packages[version], SKY_BUILD_TEST_TAG: `version-ui-${version.toLowerCase()}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => logs.push(value.toString())); child.stderr.on('data', value => logs.push(value.toString()));
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Build ${version}: ${code}`)));
  }).finally(() => writeFile(resolve(out, `build-${version}.txt`), logs.join('')));
}
const pass = text => { report.assertions.push(text); console.log(`PASS ${text}`); };
async function waitFor(label, predicate) {
  for (const end = performance.now() + 30_000; performance.now() < end;) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function phase(page, value) { await page.waitForFunction(value => window.skyApp?.offlineStatus?.phase === value, value, { timeout: 30_000 }); }
const status = page => page.evaluate(() => window.skyApp.offlineStatus);
const state = page => page.evaluate(() => window.skyApp.state);
async function shot(page, name) { await page.screenshot({ path: resolve(out, name) }); report.screenshots.push(name); }
let server, browser, context;
try {
  if (process.env.SKY_QA_SKIP_TEST_BUILDS !== '1') { await buildPackage('A'); await buildPackage('B'); }
  const a = JSON.parse(await readFile(resolve(packages.A, 'build-report.json'), 'utf8'));
  const b = JSON.parse(await readFile(resolve(packages.B, 'build-report.json'), 'utf8'));
  assert.notEqual(a.buildId, b.buildId); report.builds = { A: a.buildId, B: b.buildId };
  server = await startUpdateServer(packages); server.select('/lesson-one/', 'A');
  const url = `${server.origin}/lesson-one/`;
  browser = await chromium.launch({ channel: process.env.SKY_QA_CHANNEL ?? 'chrome', headless: true });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, reducedMotion: 'reduce' });
  await installGraphicsProbe(context, true);
  const control = await context.newPage(); await control.goto(server.origin);
  async function open() {
    const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'load' }); await waitGraphicsReady(page, 'canvas2d'); return page;
  }
  let page = await open(); await phase(page, 'ready'); await page.reload(); await waitGraphicsReady(page, 'canvas2d'); await phase(page, 'ready');
  const versionText = await page.locator('#sky-app-version').textContent();
  const release = JSON.parse(await readFile('package.json', 'utf8')).version;
  assert.ok(versionText.includes(`v${release}`) && versionText.includes(a.buildId.slice(0, 8)), versionText);
  const before = await state(page);
  await page.locator('#sky-check-update').click();
  await page.waitForFunction(() => window.skyApp.offlineStatus.updateCheck === 'current');
  assert.match(await page.locator('#sky-offline-state').textContent(), /未发现更新/);
  assert.deepEqual(await state(page), before); await shot(page, 'current-desktop.png');
  pass('Visible version identifies the current page; a real check reports no update without changing the lesson.');

  server.select('/lesson-one/', 'A', 'sw.js');
  await page.locator('#sky-check-update').click(); await phase(page, 'update-failed');
  assert.equal((await status(page)).updateCheck, 'failed');
  assert.match(await page.locator('#sky-offline-notice').textContent(), /重试|当前版本可继续离线使用/);
  assert.deepEqual(await state(page), before); await shot(page, 'check-failure.png');
  pass('A genuine update-request failure shows a retry and preserves the complete active version and lesson.');

  const coreFile = b.offlineCore.find(file => file.url.endsWith('.css')).url.replace(/^\.\//, '');
  server.select('/lesson-one/', 'B', coreFile);
  await page.locator('#sky-offline-retry').click(); await phase(page, 'update-failed');
  assert.equal((await status(page)).activeBuildId, a.buildId);
  assert.equal(await page.evaluate(name => caches.has(name), `sky-v3:${url}:${b.buildId}`), false);
  assert.deepEqual(await state(page), before);
  pass('An actual failed core download discards the candidate cache and retains the active build.');

  server.select('/lesson-one/', 'B'); const releaseDownload = server.hold('/lesson-one/', coreFile);
  await page.locator('#sky-offline-retry').click();
  await waitFor('held core resource', () => server.requests.some(item => item.held));
  await phase(page, 'installing');
  assert.notEqual((await status(page)).updateCheck, 'current');
  assert.doesNotMatch(await page.locator('#sky-offline-state').textContent(), /最新|未发现更新/);
  assert.equal(await page.locator('#sky-check-update').isDisabled(), true); await shot(page, 'downloading.png');
  releaseDownload(); await phase(page, 'update-ready');
  assert.equal((await status(page)).waitingBuildId, b.buildId);
  assert.equal((await status(page)).expectedBuildId, a.buildId);
  assert.match(await page.locator('#sky-offline-notice').textContent(), /关闭本应用所有页面/);
  assert.deepEqual(await state(page), before);
  pass('While a real download is held the UI is busy, never current; the committed candidate becomes a persistent update notice.');

  await page.locator('#sky-offline-save').click();
  assert.equal(await page.locator('#sky-scene-name').evaluate(element => document.activeElement === element), true);
  await page.locator('#sky-scene-name').fill('版本更新保留'); await page.locator('#sky-save-scene').click();
  const saved = await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1'));
  assert.ok(saved); const savedId = JSON.parse(saved).scenes[0].id;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#sky-offline-save').click();
  assert.equal(await page.locator('#sky-scene-name').evaluate(element => document.activeElement === element), true);
  assert.ok((await page.locator('#sky-offline-save').boundingBox()).height >= 44);
  await shot(page, 'waiting-mobile-save.png');
  const keeper = await open(); await phase(keeper, 'update-ready');
  assert.equal((await status(keeper)).expectedBuildId, a.buildId);
  await context.setOffline(true); await page.reload(); await waitGraphicsReady(page, 'canvas2d'); await phase(page, 'update-ready');
  assert.equal((await status(page)).expectedBuildId, a.buildId);
  await page.close();
  assert.equal(await control.evaluate(async url => (await navigator.serviceWorker.getRegistration(url)).waiting?.state, url), 'installed');
  await keeper.close();
  await waitFor('natural activation', () => control.evaluate(async url => {
    const reg = await navigator.serviceWorker.getRegistration(url);
    return reg && !reg.waiting && !reg.installing && reg.active?.state === 'activated';
  }, url));
  page = await open(); await phase(page, 'ready');
  assert.equal((await status(page)).expectedBuildId, b.buildId);
  assert.equal((await status(page)).activeBuildId, b.buildId);
  assert.equal(await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1')), saved);
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
  await page.locator('#sky-saved-scenes').selectOption(savedId); await page.locator('#sky-load-saved-scene').click();
  assert.deepEqual(await state(page), before);
  assert.equal(await page.locator('#sky-offline-notice').isVisible(), false);
  await shot(page, 'new-version-offline.png');
  pass('Save navigation works on desktop/mobile; only closing every page activates B, which reopens offline and loads the unchanged saved scene.');
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(error); }
finally {
  await context?.close(); await browser?.close(); await server?.close();
  report.requests = server?.requests ?? []; report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Version/update QA: ${report.status}; ${resolve(out, 'report.json')}`);
}
