import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { installGraphicsProbe, waitGraphicsReady } from './qa-m4a.mjs';
import { startUpdateServer } from './qa-update-server.mjs';

const outDir = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/final-m4b/updates');
const packagesRoot = resolve(process.env.SKY_QA_UPDATE_PACKAGES_ROOT ?? 'qa/m4b-platform');
const testTagPrefix = process.env.SKY_QA_UPDATE_TEST_TAG ?? 'm4b-update';
assert.match(testTagPrefix, /^[a-z0-9-]{1,38}$/i, 'QA update tag prefix must leave two characters for the build suffix.');
const packages = { A: resolve(process.env.SKY_QA_UPDATE_LEGACY_DIR ?? 'qa/m4b-platform/legacy-m4a-web'),
  B: resolve(packagesRoot, 'test-build-b'), C: resolve(packagesRoot, 'test-build-c') };
const testTags = { B: `${testTagPrefix}-b`, C: `${testTagPrefix}-c` };
if (testTagPrefix !== 'm4b-update') {
  assert.notEqual(packagesRoot, resolve('qa/m4b-platform'), 'A new update label must use a new packages root to preserve M4B test packages.');
  assert.notEqual(outDir, resolve('qa/final-m4b/updates'), 'A new update label must use a new report directory to preserve M4B evidence.');
}
const channel = process.env.SKY_QA_CHANNEL ?? 'chrome', headless = process.env.SKY_QA_HEADED !== '1';
const report = { status: 'running', startedAt: new Date().toISOString(), channel, headless, assertions: [], screenshots: [], limitations: [
  'A is the unmodified archived M4A Web package. Its old update UI cannot acquire the new MessageChannel/version protocol retroactively.',
  'B and C are controlled test packages produced by the full SHA256 build pipeline; only a QA HTML meta tag differs. They are not separate product releases.',
  'WebGL2 is actually denied at context creation; this lifecycle test uses native Canvas2D and is not a GPU benchmark.',
  'Offline is Playwright browser-context simulation. The browser may still attempt background Service Worker update fetches; deliberate server-side faults remain enforced and recorded.',
], qaConfiguration: { packagesRoot, testTagPrefix, legacyDirectory: packages.A, outDir } };
await mkdir(outDir, { recursive: true });
async function buildTest(version) {
  const log = [];
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['scripts/build-web.mjs'], { cwd: process.cwd(), env: { ...process.env,
      SKY_BUILD_QA_ROOT: packagesRoot, SKY_BUILD_OUT_DIR: packages[version], SKY_BUILD_TEST_TAG: testTags[version] }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => log.push(data.toString())); child.stderr.on('data', data => log.push(data.toString()));
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Controlled build ${version} exited ${code}`)));
  }).finally(() => writeFile(resolve(outDir, `build-${version}.txt`), log.join('')));
}
let server, browser, context;
const pageErrors = [], consoleErrors = [];
const fail = (condition, message) => { assert.ok(condition, message); report.assertions.push(message); };
const snapshot = page => page.evaluate(() => ({ status: window.skyApp?.offlineStatus ?? null, state: window.skyApp?.state,
  buildId: document.querySelector('meta[name="sky-build-id"]')?.content ?? null, testTag: document.querySelector('meta[name="sky-qa-build"]')?.content ?? null,
  modules: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src), runtime: document.querySelector('#runtime-status')?.textContent,
  graphics: window.skyApp?.graphicsStatus, probe: window.__qaGraphicsProbe,
  controller: navigator.serviceWorker.controller ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state } : null,
  userAgent: navigator.userAgent, platform: navigator.platform }));
// This Playwright version treats an async waitForFunction predicate's Promise as truthy.
// Await the actual boolean on the Node side instead of inspecting an in-progress install.
async function waitCondition(label, probe, timeoutMs = 30_000) {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) { if (await probe()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitApp(page) { await waitGraphicsReady(page, 'canvas2d'); }
async function waitPhase(page, phase) { await page.waitForFunction(phase => window.skyApp?.offlineStatus?.phase === phase, phase, { timeout: 30_000 }); }
async function screenshot(page, name) { await page.screenshot({ path: resolve(outDir, name) }); report.screenshots.push(name); }
async function pageAt(url) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push({ url: page.url(), message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ url: page.url(), message: message.text() }); });
  await page.goto(url, { waitUntil: 'load' }); await waitApp(page); return page;
}
async function registration(control, scope) {
  return control.evaluate(async scope => {
    const reg = await navigator.serviceWorker.getRegistration(scope);
    return reg ? { scope: reg.scope, active: reg.active?.state ?? null, waiting: reg.waiting?.state ?? null, installing: reg.installing?.state ?? null,
      activeScriptURL: reg.active?.scriptURL ?? null, waitingScriptURL: reg.waiting?.scriptURL ?? null, installingScriptURL: reg.installing?.scriptURL ?? null } : null;
  }, scope);
}
async function update(page) {
  await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); if (!reg) throw new Error('Missing registration'); await reg.update(); });
}
async function waitActive(control, scope, buildId) {
  // Never ping the old active worker while waiting: messages can keep its events alive.
  await waitCondition('natural activation after every owned scope client closes',async()=>{
    const actual=await registration(control,scope);
    report.activationChecks??=[];report.activationChecks.push({at:new Date().toISOString(),expected:buildId,passive:true,...actual});
    if(report.activationChecks.length>32)report.activationChecks.shift();
    return actual?.waiting===null&&actual.installing===null&&actual.active==='activated';
  });
  const actual=await control.evaluate(async ({ scope }) => {
    const reg = await navigator.serviceWorker.getRegistration(scope), worker = reg?.active;
    if (!worker || worker.state !== 'activated') return {activeState:worker?.state??null,waitingState:reg?.waiting?.state??null};
    const channel = new MessageChannel();
    return new Promise(done => {
      const timer = setTimeout(() => { channel.port1.close(); done({activeState:worker.state,waitingState:reg.waiting?.state??null,scope:reg.scope,error:'new active worker status timeout'}); }, 5000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); done({activeState:worker.state,waitingState:reg.waiting?.state??null,scope:reg.scope,result:event.data}); };
      worker.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
    });
  }, { scope });
  report.activationChecks.push({at:new Date().toISOString(),expected:buildId,passive:false,...actual});
  assert.ok(actual.result?.type==='OFFLINE_STATUS_RESULT'&&actual.result.complete===true&&actual.result.buildId===buildId&&actual.result.scope===scope,JSON.stringify(actual));
}
async function cacheOracle(control, scope, build) {
  const actual = await control.evaluate(async ({ scope, build }) => {
    const cacheName = `sky-v3:${scope}:${build.buildId}`, existing = await caches.has(cacheName);
    if (!existing) return { cacheName, exists: false };
    const cache = await caches.open(cacheName), marker = await cache.match(new URL('./__sky_offline_commit__', scope));
    const files = [];
    for (const item of build.offlineCore) {
      const response = await cache.match(new URL(item.url, scope));
      const hash = response ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('') : null;
      files.push({ url: item.url, expected: item.sha256, actual: hash });
    }
    return { cacheName, exists: true, commit: marker ? await marker.json() : null, files };
  }, { scope, build });
  assert.equal(actual.exists, true);
  assert.equal(actual.commit?.buildId, build.buildId, JSON.stringify(actual)); assert.equal(actual.commit.files, build.offlineCore.length);
  assert.ok(actual.files.every(file => file.actual === file.expected), 'Every cached core resource must match the actual package SHA256');
  return actual;
}
async function saveScene(page) {
  await page.evaluate(() => {
    const state = window.skyApp.state; state.viewMode = 'space'; state.selected = 'hip:91262'; state.layers.earthDay = false;
    state.observer.displayZone = { kind: 'fixed', offsetMinutes: 345 }; state.time.running = false;
    window.skyApp.setState(state);
  }); await waitApp(page);
  const expected = await page.evaluate(() => window.skyApp.state);
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
  await page.locator('#sky-scene-name').fill('升级保留 · 星空'); await page.locator('#sky-save-scene').click();
  const stored = await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1'));
  assert.ok(stored); const record = JSON.parse(stored).scenes[0]; assert.deepEqual(record.state, expected);
  return { expected, stored, id: record.id };
}
async function loadScene(page, scene) {
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
  await page.locator('#sky-saved-scenes').selectOption(scene.id); await page.locator('#sky-load-saved-scene').click(); await waitApp(page);
  assert.deepEqual(await page.evaluate(() => window.skyApp.state), scene.expected);
  assert.equal(await page.evaluate(() => localStorage.getItem('panoramic-night-sky:scene-library:v1')), scene.stored);
}

try {
  if (process.env.SKY_QA_SKIP_TEST_BUILDS !== '1') { await buildTest('B'); await buildTest('C'); }
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(async version => ({ version, directory: packages[version], report: JSON.parse(await readFile(resolve(packages[version], 'build-report.json'), 'utf8')),
    swSha256: createHash('sha256').update(await readFile(resolve(packages[version], 'sw.js'))).digest('hex'), htmlSha256: createHash('sha256').update(await readFile(resolve(packages[version], 'index.html'))).digest('hex') })));
  report.packages = [a, b, c]; assert.notEqual(b.report.buildId, c.report.buildId); assert.notEqual(b.swSha256, c.swSha256);
  assert.equal(b.report.testTag, testTags.B); assert.equal(c.report.testTag, testTags.C);
  // Equivalent JS proves the deliberately controlled difference is package identity, not invented features.
  const bJs = b.report.offlineCore.filter(file => file.url.endsWith('.js')), cJs = c.report.offlineCore.filter(file => file.url.endsWith('.js'));
  assert.deepEqual(bJs, cJs);
  server = await startUpdateServer(packages); const first = `${server.origin}/lesson-one/`, second = `${server.origin}/lesson-two/`;
  server.select('/lesson-one/', 'A'); server.select('/lesson-two/', 'B');
  browser = await chromium.launch({ channel, headless }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 } }); await installGraphicsProbe(context, true);
  const control = await context.newPage(); await control.goto(`${server.origin}/`);
  let page = await pageAt(first);
  await waitCondition('legacy A activation', async () => (await registration(control, first))?.active === 'activated');
  await page.reload({ waitUntil: 'load' }); await waitApp(page);
  await page.waitForFunction(() => document.querySelector('#runtime-status')?.textContent.includes('离线资源已就绪'), undefined, { timeout: 15_000 });
  const oldState = await page.evaluate(() => window.skyApp.state); report.legacyInitial = await snapshot(page);
  await context.setOffline(true); await page.reload({ waitUntil: 'load' }); await waitApp(page); report.legacyOffline = await snapshot(page); await context.setOffline(false);
  server.select('/lesson-one/', 'B'); await update(page);
  await waitCondition('B waiting installation', async () => (await registration(control, first))?.waiting === 'installed');
  report.legacyWaiting = { app: await snapshot(page), registration: await registration(control, first) };
  report.legacyWaiting.cacheDiagnostic = await control.evaluate(async ({scope,buildId}) => {
    const reg = await navigator.serviceWorker.getRegistration(scope), channel = new MessageChannel();
    const result = await new Promise(done => {
      const timer = setTimeout(() => { channel.port1.close(); done({ error: 'Waiting worker protocol timeout' }); }, 5000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); done(event.data); };
      reg.waiting.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
    });
    return { result, keys: (await (await caches.open(`sky-v3:${scope}:${buildId}`)).keys()).map(request => request.url) };
  }, {scope:first,buildId:b.report.buildId});
  report.legacyWaiting.newCache = await cacheOracle(control, first, b.report);
  assert.deepEqual(report.legacyWaiting.app.state, oldState); assert.equal(report.legacyWaiting.app.modules[0], report.legacyInitial.modules[0]);
  fail(true, 'Archived A continues unchanged while the real B package is installed and committed; A’s old UI behavior is reported without pretending it was patched.');
  await screenshot(page, 'legacy-a-while-b-waits.png'); await page.close(); await waitActive(control, first, b.report.buildId);
  page = await pageAt(first); await waitPhase(page, 'ready'); report.firstNewVersion = await snapshot(page);
  assert.equal(report.firstNewVersion.buildId, b.report.buildId); assert.equal(report.firstNewVersion.probe.uniqueSuccessfulContexts, 0);
  const saved = await saveScene(page); report.savedScene = { id: saved.id, name: '升级保留 · 星空', state: saved.expected, bytes: Buffer.byteLength(saved.stored) };
  const other = await pageAt(second); await waitPhase(other, 'ready'); await other.reload({ waitUntil: 'load' }); await waitApp(other); await waitPhase(other, 'ready');
  const scopeTwoBefore = await cacheOracle(control, second, b.report);
  const fault = c.report.offlineCore.find(file => file.url.endsWith('.css')).url.replace(/^\.\//, '');
  server.select('/lesson-one/', 'C', fault);
  await page.evaluate(async () => { window.__qaFailedInstall = false; const reg = await navigator.serviceWorker.getRegistration(); reg.addEventListener('updatefound', () => { const worker = reg.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'redundant') window.__qaFailedInstall = true; }); }); });
  await update(page);
  await page.waitForFunction(() => window.__qaFailedInstall, undefined, { timeout: 30_000 }); await waitPhase(page, 'update-failed');
  report.failedUpdate = { app: await snapshot(page), registration: await registration(control, first), oldCache: await cacheOracle(control, first, b.report),
    candidateCacheExists: await control.evaluate(name => caches.has(name), `sky-v3:${first}:${c.report.buildId}`) };
  assert.equal(report.failedUpdate.candidateCacheExists, false); assert.deepEqual(report.failedUpdate.app.state, saved.expected);
  assert.equal(report.failedUpdate.app.status.activeBuildId, b.report.buildId); assert.equal(report.failedUpdate.registration.waiting, null);
  assert.ok(server.requests.some(request => request.fault && request.status === 404)); await screenshot(page, 'failed-download-retains-b.png');
  const failedReloadResponses = [];
  const recordFailedReloadResponse = response => { if (/^https?:/.test(response.url())) failedReloadResponses.push({url:response.url(),status:response.status(),fromServiceWorker:response.fromServiceWorker()}); };
  page.on('response',recordFailedReloadResponse);
  await context.setOffline(true); await page.reload({ waitUntil: 'load' }); await waitApp(page);
  await waitCondition('complete B after failed-update offline reload', async () => {
    const value=await snapshot(page);
    return value.buildId===b.report.buildId && value.status?.activeBuildId===b.report.buildId && ['ready','update-failed'].includes(value.status.phase);
  });
  report.bAfterFailedOfflineReload = { app: await snapshot(page), registration: await registration(control, first), cache: await cacheOracle(control, first, b.report), responses:failedReloadResponses };
  assert.ok(failedReloadResponses.length>=3 && failedReloadResponses.every(response=>response.status===200&&response.fromServiceWorker));
  await loadScene(page, saved); page.off('response',recordFailedReloadResponse); await context.setOffline(false);
  fail(true, 'A genuine failed C core download removes only candidate C; B remains usable offline and its named scene is unchanged.');
  server.select('/lesson-one/', 'C'); await update(page); await waitPhase(page, 'update-ready');
  const keeper = await pageAt(first); await waitPhase(keeper, 'update-ready');
  report.keeperWhileCWaits = await snapshot(keeper);
  assert.equal(report.keeperWhileCWaits.buildId, b.report.buildId);
  assert.deepEqual(report.keeperWhileCWaits.modules, report.firstNewVersion.modules);
  const indexed = await pageAt(`${first}index.html?classroom=continues`); await waitPhase(indexed, 'update-ready');
  report.indexNavigationWhileCWaits = await snapshot(indexed);
  assert.equal(report.indexNavigationWhileCWaits.buildId, b.report.buildId);
  assert.deepEqual(report.indexNavigationWhileCWaits.modules, report.firstNewVersion.modules); await indexed.close();
  fail(true, 'Online root and index.html entry navigation both serve active B HTML/modules while C waits, preventing mixed package identity.');
  report.successfulWaiting = { app: await snapshot(page), registration: await registration(control, first), cache: await cacheOracle(control, first, c.report) };
  assert.equal(report.successfulWaiting.app.buildId, b.report.buildId); assert.equal(report.successfulWaiting.app.status.waitingBuildId, c.report.buildId);
  assert.match(report.successfulWaiting.app.status.message, /关闭本应用所有页面/); assert.doesNotMatch(report.successfulWaiting.app.status.message, /刷新即可/);
  assert.deepEqual(report.successfulWaiting.app.state, saved.expected); await screenshot(page, 'b-teaching-cached-c-waits.png');
  await context.setOffline(true); await page.reload({ waitUntil: 'load' }); await waitApp(page); await waitPhase(page, 'update-ready');
  assert.equal((await snapshot(page)).buildId, b.report.buildId); await page.close();
  assert.equal((await registration(control, first)).waiting, 'installed');
  fail(true, 'Even offline reload and closing one B page leave B active while another same-scope teaching page remains open.');
  await keeper.close(); await waitActive(control, first, c.report.buildId);
  page = await pageAt(first); await waitPhase(page, 'ready'); await loadScene(page, saved);
  report.finalC = await snapshot(page); assert.equal(report.finalC.buildId, c.report.buildId); assert.equal(report.finalC.status.activeBuildId, c.report.buildId);
  await other.reload({ waitUntil: 'load' }); await waitApp(other); await waitPhase(other, 'ready');
  report.scopeTwoAfter = await cacheOracle(control, second, b.report); assert.deepEqual(report.scopeTwoAfter, scopeTwoBefore);
  report.finalScopeOne = await cacheOracle(control, first, c.report);
  report.cacheNames = await control.evaluate(() => caches.keys());
  assert.equal(report.cacheNames.includes(`sky-v3:${first}:${b.report.buildId}`), false);
  assert.equal((await snapshot(other)).buildId, b.report.buildId);
  fail(true, 'After all scope-one clients close, C activates with complete matching SHA256 resources; scope-two B cache and offline page are untouched.');
  await screenshot(page, 'c-active-offline-scene-preserved.png'); await screenshot(other, 'separate-subdirectory-b-offline.png');
  await page.close(); await other.close(); await server.close(); await context.setOffline(false);
  report.originStopped = await fetch(server.origin).then(() => ({ unreachable:false })).catch(error => ({ unreachable:true, error:String(error), code:error.cause?.code ?? null }));
  assert.equal(report.originStopped.unreachable,true,'Actual localhost origin must be stopped, not just page network emulation');
  const genuineResponses=[];
  const trueFirst=await context.newPage(), trueSecond=await context.newPage();
  for(const target of [trueFirst,trueSecond]) target.on('response',response=>{if(/^https?:/.test(response.url()))genuineResponses.push({url:response.url(),status:response.status(),fromServiceWorker:response.fromServiceWorker()});});
  await trueFirst.goto(first,{waitUntil:'load'}); await waitApp(trueFirst); await waitPhase(trueFirst,'ready'); await loadScene(trueFirst,saved);
  await trueSecond.goto(second,{waitUntil:'load'}); await waitApp(trueSecond); await waitPhase(trueSecond,'ready');
  report.originUnavailableReopen={first:await snapshot(trueFirst),second:await snapshot(trueSecond),responses:genuineResponses,
    firstCache:await cacheOracle(control,first,c.report),secondCache:await cacheOracle(control,second,b.report)};
  assert.equal(report.originUnavailableReopen.first.buildId,c.report.buildId); assert.equal(report.originUnavailableReopen.second.buildId,b.report.buildId);
  assert.ok(genuineResponses.length>=6&&genuineResponses.every(response=>response.status===200&&response.fromServiceWorker));
  await screenshot(trueFirst,'c-reopened-origin-truly-stopped.png'); await screenshot(trueSecond,'scope-two-b-origin-truly-stopped.png');
  fail(true,'With the actual localhost server stopped and browser networking online, both scopes reopen from their own committed packages and the saved scene survives.');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(!consoleErrors.some(error => /shader|GL_INVALID|WebGLProgram|compile error/i.test(error.message)), 'No shader/GL errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if(context) report.failurePages=await Promise.all(context.pages().filter(page=>page.url().includes('/lesson-')).map(async page=>({app:await snapshot(page),registration:await registration(page,page.url())}))).catch(()=>[]);
  if(context&&server)report.failureRegistration=await context.pages()[0]?.evaluate(async origin=>({registrations:(await navigator.serviceWorker.getRegistrations()).map(reg=>({scope:reg.scope,active:reg.active?.state??null,waiting:reg.waiting?.state??null,installing:reg.installing?.state??null})),caches:await caches.keys(),controller:navigator.serviceWorker.controller?.scriptURL??null}),server.origin).catch(()=>null);
} finally {
  report.finishedAt = new Date().toISOString(); report.pageErrors = pageErrors; report.consoleErrors = consoleErrors;
  report.serverRequests = server?.requests ?? [];
  await context?.close(); await browser?.close(); await server?.close();
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PWA update lifecycle: ${report.status}; ${resolve(outDir, 'report.json')}`);
}
