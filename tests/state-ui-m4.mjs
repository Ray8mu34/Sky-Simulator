import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m4-ui/development';
const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const browsers = [], assertions = [], errors = [], startedAt = new Date().toISOString();
let activePage;
function observeErrors(page, phase) { page.on('pageerror', error => errors.push({ phase, error: error.message })); }
const current = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => window.skyApp.ready && window.skyApp.snapshot && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
async function openAppearance(page) {
  await page.locator('.layer-section').evaluate(el => { el.open = true; });
  await page.locator('.appearance-controls').evaluate(el => { el.open = true; });
  await page.locator('#sky-artificial-light').scrollIntoViewIfNeeded();
}
async function touchDrag(session, points, next) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: next });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
try {
  // Chrome itself denies WebGL; this exercises the genuine construction-failure path.
  const noGl = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] }); browsers.push(noGl);
  const page = await noGl.newPage({ viewport: { width: 1152, height: 720 }, acceptDownloads: true, hasTouch: true, isMobile: true }); activePage = page;
  observeErrors(page, 'no-webgl');
  await page.goto(url); await paired(page);
  assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
  assert.equal(await page.locator('.sky-graphics-canvas2d canvas.sky-canvas2d-canvas').count(), 1);
  assert.equal(await page.locator('#sky-graphics-mode').textContent(), '2D');
  assert.match(await page.locator('.graphics-boundary').textContent(), /全天方位图 · 北上东左.*仅方向标记/);
  assert.equal(await page.locator('.view-switch').isVisible(), false);
  assert.equal(await page.locator('.reference-lock-row').isVisible(), false);
  await page.evaluate(() => {
    const next = window.skyApp.state;
    next.viewMode = 'space'; next.presentation = 'explanation'; next.selected = 'hip:11767';
    next.cameras.space.orientationQuaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    next.cameras.space.distanceDisplayUnits = 5;
    next.cameras.globe.referenceLock = 'earth-fixed';
    next.cameras.horizon.referenceLock = 'inertial';
    next.environment.artificialSkyBrightness = .5;
    window.skyApp.setState(next);
  }); await paired(page);
  const saved = await current(page);
  const status = await page.evaluate(() => window.skyApp.graphicsStatus);
  for (const layer of status.capabilities.unsupportedLayers) {
    const input = page.locator(`[data-layer="${layer}"]`);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await input.isChecked(), saved.layers[layer]);
  }
  for (const key of ['constellationLines', 'constellationLabels', 'brightStarNamesZh', 'secondaryNames', 'sunMoon', 'atmosphere']) assert.equal(await page.locator(`[data-layer="${key}"]`).isDisabled(), false);
  await page.locator('[data-layer="milkyWay"]').evaluate((el, value) => { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); el.checked = value; }, saved.layers.milkyWay);
  assert.deepEqual(await current(page), saved);
  await page.screenshot({ path: `${out}/2d-startup-overview.png` });
  assertions.push('Real no-WebGL startup draws one Canvas2D overview, labels the north-up/east-left geometry and direction-only bodies, hides 3D views/reference lock, and disables unsupported layers without changing their saved values.');

  await openAppearance(page);
  assert.match(await page.locator('#sky-appearance-scope').textContent(), /原理示意/);
  assert.equal(await page.locator('#sky-observe-appearance').textContent(), '观察模式＋大气');
  await page.locator('#sky-observe-appearance').click(); await paired(page);
  const observing = await current(page);
  const expected = structuredClone(saved); expected.presentation = 'observation'; expected.layers.atmosphere = true;
  assert.deepEqual(observing, expected);
  assert.equal(await page.evaluate(() => window.skyApp.skyAppearance.reason), 'ground-observation');
  assert.match(await page.locator('#sky-appearance-scope').textContent(), /定性观察/);
  assert.doesNotMatch(await page.locator('#sky-appearance-values').textContent(), /银河对比/);
  await page.locator('#sky-search').fill('北极星'); await page.locator('#sky-search').press('Enter'); await paired(page);
  assert.equal(await page.locator('[data-action="focus-selection"]').textContent(), '标示');
  const beforeMark = await current(page);
  await page.locator('[data-action="focus-selection"]').click();
  await page.waitForFunction(() => window.skyApp.diagnostics.lastFocusSucceeded === true);
  assert.deepEqual(await current(page), beforeMark);
  await page.locator('#sky-teaching').evaluate(el => { el.open = true; });
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  assert.equal(await page.locator('#sky-moon-loupe-toggle').isDisabled(), true);
  assert.match(await page.locator('.moon-loupe-status').textContent(), /月相读数保留/);
  assert.match(await page.locator('.lunar-calendar-readout').textContent(), /农历（UTC\+8）/);
  assert.equal(await page.locator('.twilight-row').count(), 3);
  await page.locator('#sky-teaching').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/2d-science-and-teaching.png` });
  assertions.push('2D local observation adapts the shared model while a saved space view and all four cameras remain intact; selection/highlight, solar-day events and UTC+8 lunar calendar work, while the Moon loupe is explicitly unavailable.');

  const beforeJson = await current(page);
  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  const downloading = page.waitForEvent('download'); await page.locator('[data-action="export"]').click();
  const download = await downloading; await download.saveAs(`${out}/2d-preserved-3d-scene.json`);
  assert.deepEqual(JSON.parse(await readFile(`${out}/2d-preserved-3d-scene.json`, 'utf8')), beforeJson);
  await page.locator('[data-action="reset"]').click(); await paired(page);
  await page.locator('#sky-import-file').setInputFiles(`${out}/2d-preserved-3d-scene.json`); await paired(page);
  assert.deepEqual(await current(page), beforeJson);
  const beforeRetry = await current(page);
  await page.locator('#sky-retry-3d').click();
  await page.waitForFunction(() => window.skyApp.graphicsStatus.reason === 'retry-failed'); await paired(page);
  assert.deepEqual(await current(page), beforeRetry);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.graphics.activeRendererCount), 1);
  assertions.push('Real JSON export/import retains external view, four cameras and unsupported layer values in 2D; a genuinely blocked 3D retry preserves the complete scientific state and leaves one active fallback renderer.');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.sky-control-panel').isVisible(), false);
  assert.equal(await page.locator('#sky-compact-view').isVisible(), false);
  for (const selector of ['.controls-drawer-toggle', '.compact-play', '.compact-search', '#sky-compact-graphics']) {
    const rect = await page.locator(selector).boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
  }
  await page.screenshot({ path: `${out}/2d-mobile-portrait-collapsed.png` });
  await page.locator('#sky-compact-graphics').click();
  assert.equal(await page.locator('#sky-retry-3d').isVisible(), true);
  await page.locator('[data-action="close"]').click();
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await page.locator('.sky-control-panel').isVisible(), false);
  for (const selector of ['.controls-drawer-toggle', '.compact-play', '.compact-search', '#sky-compact-graphics']) {
    const rect = await page.locator(selector).boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
  }
  await page.screenshot({ path: `${out}/2d-mobile-landscape-collapsed.png` });
  await page.locator('.controls-drawer-toggle').click();
  const scrolling = await page.locator('.panel-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; return { scrollTop: el.scrollTop, client: el.clientHeight, content: el.scrollHeight }; });
  assert.ok(scrolling.scrollTop > 0 && scrolling.content > scrolling.client);
  await page.screenshot({ path: `${out}/2d-mobile-landscape-scroll.png` });
  await page.locator('[data-action="close"]').click();
  await page.setViewportSize({ width: 360, height: 780 });
  for (const selector of ['.controls-drawer-toggle', '.compact-play', '.compact-search', '#sky-compact-graphics']) {
    const rect = await page.locator(selector).boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44 && rect.x + rect.width <= 360);
  }
  await page.screenshot({ path: `${out}/2d-mobile-360-collapsed.png` });
  await noGl.close(); browsers.splice(browsers.indexOf(noGl), 1);
  assertions.push('Portrait resize collapses the panel and exposes 44px playback/search/2D controls; its mode entry opens the retry notice, and the short landscape panel remains scrollable.');

  const gl = await chromium.launch({ channel: 'chrome', headless: true }); browsers.push(gl);
  const mobile = await gl.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); activePage = mobile;
  observeErrors(mobile, 'webgl-touch-and-context');
  await mobile.goto(url); await paired(mobile);
  await mobile.waitForFunction(() => window.skyApp.graphicsStatus.kind === 'webgl2');
  const session = await mobile.context().newCDPSession(mobile);
  const beforeSky = await current(mobile);
  await touchDrag(session, [{ x: 180, y: 350, id: 1 }], [{ x: 240, y: 395, id: 1 }]);
  await mobile.waitForTimeout(80);
  assert.notDeepEqual((await current(mobile)).cameras.ground, beforeSky.cameras.ground);
  await mobile.locator('.controls-drawer-toggle').click();
  const beforePanelTouch = await current(mobile);
  await touchDrag(session, [{ x: 45, y: 42, id: 1 }, { x: 110, y: 42, id: 2 }], [{ x: 30, y: 95, id: 1 }, { x: 145, y: 95, id: 2 }]);
  assert.deepEqual(await current(mobile), beforePanelTouch);
  await mobile.locator('#sky-teaching').evaluate(el => { el.open = true; });
  await mobile.locator('#sky-moon-loupe-toggle').click();
  await mobile.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.status === 'ready' && window.skyApp.moonLoupeDiagnostics.open);
  const beforeLoupeTouch = await current(mobile);
  const loupe = await mobile.locator('#sky-moon-loupe').boundingBox();
  await touchDrag(session, [{ x: loupe.x + 20, y: loupe.y + 25, id: 1 }, { x: loupe.x + 75, y: loupe.y + 25, id: 2 }], [{ x: loupe.x + 10, y: loupe.y + 75, id: 1 }, { x: loupe.x + 95, y: loupe.y + 75, id: 2 }]);
  assert.deepEqual(await current(mobile), beforeLoupeTouch);
  assertions.push('Chrome trusted touch input moves the 3D sky as a positive control, while two-finger gestures on controls and the complete loupe preserve every scientific state field. This is browser emulation, not a physical-device test.');

  await mobile.evaluate(() => {
    const next = window.skyApp.state; next.viewMode = 'space'; next.selected = 'body:Moon';
    window.skyApp.setState(next);
  }); await paired(mobile);
  const beforeLoss = await current(mobile);
  const originalIdentity = await mobile.evaluate(() => window.skyApp.diagnostics.graphics.webglCanvasIdentity);
  await mobile.evaluate(() => {
    const canvas = document.querySelector('.sky-graphics-webgl2 canvas.sky-webgl-canvas');
    window.__uiOriginalCanvas = canvas;
    window.__uiLostExtension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__uiLostExtension.loseContext();
  });
  await mobile.waitForFunction(() => window.skyApp.graphicsStatus.kind === 'canvas2d'); await paired(mobile);
  assert.deepEqual(await current(mobile), beforeLoss);
  assert.equal(await mobile.locator('#sky-moon-loupe').isVisible(), false);
  await mobile.locator('.controls-drawer-toggle').click();
  assert.equal(await mobile.locator('#sky-moon-loupe-toggle').isDisabled(), true);
  assert.equal(await mobile.locator('#sky-retry-3d').isDisabled(), true);
  assert.match(await mobile.locator('#sky-retry-3d').textContent(), /等待三维恢复/);
  await mobile.screenshot({ path: `${out}/context-lost-2d.png` });
  await mobile.waitForTimeout(150);
  await mobile.evaluate(() => window.__uiLostExtension.restoreContext());
  await mobile.waitForFunction(() => window.skyApp.graphicsStatus.kind === 'webgl2'); await paired(mobile);
  assert.deepEqual(await current(mobile), beforeLoss);
  assert.equal(await mobile.evaluate(() => window.skyApp.diagnostics.graphics.webglCanvasIdentity), originalIdentity);
  assert.equal(await mobile.evaluate(() => document.querySelector('.sky-graphics-webgl2 canvas.sky-webgl-canvas') === window.__uiOriginalCanvas), true);
  assert.equal(await mobile.locator('#sky-moon-loupe-toggle').isDisabled(), false);
  assert.equal(await mobile.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed'), 'false');
  await mobile.locator('#sky-moon-loupe-toggle').click();
  await mobile.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.status === 'ready' && window.skyApp.moonLoupeDiagnostics.open);
  await mobile.screenshot({ path: `${out}/3d-restored-loupe.png` });
  assertions.push('Real WebGL context loss switches to 2D and closes/disables the loupe without changing saved space view, selection, UTC or cameras; restore reuses the identical canvas and allows a fresh loupe open.');

  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'passed', stage: process.env.SKY_UI_QA_STAGE ?? 'development', startedAt, endedAt: new Date().toISOString(), assertions, errors, limits: 'Functional Chrome UI testing only. Synthetic trusted desktop-browser touch, not physical phone verification; side drawer retained, original bottom drawer not implemented; no FPS benchmark or 30-minute run.' }, null, 2));
  console.log(`Passed ${assertions.length} M4 UI groups; evidence: ${out}`);
} catch (error) {
  await activePage?.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'failed', startedAt, assertions, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
}
