import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { installGraphicsProbe } from './qa-m4a.mjs';

// Bounded feature acceptance. Production build must already be served at URL.
const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_QA_OUT_DIR ?? '_local-archive/sky-visibility-20261010';
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile('media/screenshots/capture-manifest.json', 'utf8'));
const scene = structuredClone(manifest.captures[0].state);
scene.time.running = false;
scene.time.utDaysJ2000 = (Date.UTC(2026, 0, 15, 14) - Date.UTC(2000, 0, 1, 12)) / 86400000;
scene.environment.moonlightEnabled = false;
scene.cameras.ground = { kind: 'ground', azimuthDegNorthEast: 180, altitudeDeg: 40, verticalFovDeg: 75 };
scene.selected = 'constellation:Ori';
const report = { url, scope: 'Feature smoke: desktop Chrome, narrow viewport and Canvas fallback; no device or long-run performance claim.', checks: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ready = async page => {
  await page.waitForFunction(() => {
    const a = window.skyApp;
    return a?.ready && !a.diagnostics.scienceDirty && a.diagnostics.lastRenderedUt === a.state.time.utDaysJ2000
      && a.diagnostics.lastRenderedSelection === a.state.selected && a.diagnostics.assetStatus.pending.length === 0
      && a.diagnostics.assetStatus.errors.length === 0 && a.diagnostics.viewTransition?.phase === 'idle';
  }, null, { timeout: 45000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const info = page => page.evaluate(() => ({ state: window.skyApp.state, appearance: window.skyApp.skyAppearance,
  renderer: window.skyApp.rendererDiagnostics, graphics: window.skyApp.graphicsStatus, metrics: window.skyApp.metrics,
  visibility: window.skyApp.skyAppearanceDiagnostics?.constellationVisibility ?? null }));
const observe = (page, forcedFallback = false) => {
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (forcedFallback && message.text() === 'THREE.WebGLRenderer: THREE.WebGLRenderer: Error creating WebGL context.') {
      report.expectedFallbackDiagnostic = message.text(); return;
    }
    report.errors.push(message.text());
  });
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); observe(page);
  await page.goto(url + '#scene=' + encodeURIComponent(JSON.stringify(scene))); await ready(page);
  const initial = await info(page);
  await page.locator('.appearance-controls > summary').click();
  await page.locator('#sky-observe-appearance').click(); await ready(page);
  await page.locator('[data-sky-light="0"]').click(); await ready(page);
  report.dark = await info(page);
  assert.equal(report.dark.appearance.visibilityApplied, true);
  assert.equal(report.dark.appearance.limitingMagnitude, 6.5);
  await page.screenshot({ path: out + '/dark.png' });
  await page.locator('[data-sky-light="1"]').click(); await ready(page);
  report.city = await info(page);
  assert.equal(report.city.appearance.limitingMagnitude, 3);
  assert.deepEqual(report.city.state.cameras, initial.state.cameras);
  assert.deepEqual(report.city.state.observer, initial.state.observer);
  assert.deepEqual(report.city.state.time, initial.state.time);
  assert.equal(report.city.renderer.sphericalArcs.updateCount, report.dark.renderer.sphericalArcs.updateCount);
  assert.equal(report.city.renderer.sphericalArcs.requestedUploadBytesLastRender, 0);
  assert.equal(report.city.metrics.geometryCount, report.dark.metrics.geometryCount);
  assert.equal(report.city.metrics.drawCallsPerFrame, report.dark.metrics.drawCallsPerFrame);
  assert.ok(report.city.visibility.magnitudeVisibleSourceArcCount < report.dark.visibility.magnitudeVisibleSourceArcCount);
  assert.ok(report.city.visibility.selectedMagnitudeVisibleSourceArcCount < report.dark.visibility.selectedMagnitudeVisibleSourceArcCount);
  assert.equal(report.city.visibility.magnitudeAttributeShared, true);
  assert.equal(report.city.visibility.magnitudeAttributeVersion, report.dark.visibility.magnitudeAttributeVersion);
  await page.screenshot({ path: out + '/city.png' });
  report.checks.push('Dark/city enable real limiting magnitude without changing time, location or camera; no arc rebuild, buffer upload or extra draw calls.');
  await page.locator('#sky-full-star-map').click(); await ready(page);
  assert.equal((await info(page)).appearance.visibilityApplied, false);
  await page.screenshot({ path: out + '/full-map.png' });
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await page.locator(`[data-view="${mode}"]`).click(); await ready(page);
    assert.deepEqual((await info(page)).state.time, initial.state.time);
  }
  const underground = structuredClone(scene);
  underground.observer.latitudeDeg = -30;
  underground.presentation = 'explanation';
  underground.selected = 'hip:11767';
  underground.cameras.ground.azimuthDegNorthEast = 0;
  underground.cameras.ground.altitudeDeg = -20;
  underground.layers.terrain = true;
  await page.evaluate(s => window.skyApp.setState(s), underground); await ready(page);
  report.opaque = await info(page);
  assert.equal(report.opaque.renderer.selectedVisible, false);
  const terrain = page.locator('input[data-layer="terrain"]');
  await terrain.check(); await ready(page);
  report.transparent = await info(page);
  assert.equal(report.transparent.state.layers.terrain, false);
  assert.equal(report.transparent.state.layers.horizon, true);
  assert.equal(report.transparent.renderer.selectedVisible, true);
  await page.screenshot({ path: out + '/transparent-ground.png' });
  await terrain.uncheck(); await ready(page);
  assert.equal((await info(page)).renderer.selectedVisible, false);
  report.checks.push('Below-horizon Polaris becomes visible only with transparent ground; horizon reference stays enabled.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(s => window.skyApp.setState(s), scene); await ready(page);
  await page.locator('.controls-drawer-toggle').click();
  await page.locator('#sky-observe-appearance').click();
  await page.locator('#sky-artificial-light').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await ready(page);
  assert.equal((await info(page)).state.environment.artificialSkyBrightness, .01);
  await page.screenshot({ path: out + '/narrow-keyboard.png' });
  report.checks.push('Narrow viewport mode buttons and keyboard slider are operable.');
  await context.close();

  const fallback = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await installGraphicsProbe(fallback, true);
  const canvas = await fallback.newPage(); observe(canvas, true);
  await canvas.goto(url + '#scene=' + encodeURIComponent(JSON.stringify(scene))); await ready(canvas);
  await canvas.locator('.appearance-controls > summary').click();
  await canvas.locator('#sky-observe-appearance').click();
  await canvas.locator('[data-sky-light="1"]').click(); await ready(canvas);
  report.canvas = await info(canvas);
  assert.equal(report.canvas.graphics.kind, 'canvas2d');
  assert.equal(report.canvas.appearance.visibilityApplied, true);
  assert.equal(await canvas.locator('input[data-layer="terrain"]').isDisabled(), true);
  await canvas.screenshot({ path: out + '/canvas-city.png' });
  report.checks.push('Canvas fallback applies pollution and honestly disables unsupported transparent lower hemisphere.');
  await fallback.close();
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
finally { await browser.close(); await writeFile(out + '/report.json', JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ status: report.status, checks: report.checks, errors: report.errors, failure: report.failure, out }));
