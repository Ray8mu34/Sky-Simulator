import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function installGraphicsProbe(context, blockWebgl2) {
  await context.addInitScript(block => {
    window.__qaBlockWebGL2 = block;
    window.__qaGraphicsProbe = { blockedCalls: 0, webgl2Calls: 0, uniqueSuccessfulContexts: 0 };
    const original = HTMLCanvasElement.prototype.getContext, successful = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (type === 'webgl2') {
        window.__qaGraphicsProbe.webgl2Calls++;
        if (window.__qaBlockWebGL2) { window.__qaGraphicsProbe.blockedCalls++; return null; }
      }
      const result = original.call(this, type, ...args);
      if (type === 'webgl2' && result && !successful.has(result)) {
        successful.add(result); window.__qaGraphicsProbe.uniqueSuccessfulContexts++;
      }
      return result;
    };
  }, blockWebgl2);
}
const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot,
  graphics: window.skyApp.graphicsStatus, app: window.skyApp.diagnostics,
  interaction: window.skyApp.rendererDiagnostics, appearance: window.skyApp.skyAppearance,
  selectedDetails: window.skyApp.selectedDetails,
  actualAppearance: window.skyApp.skyAppearanceDiagnostics, teaching: window.skyApp.teachingData,
  probe: window.__qaGraphicsProbe, metrics: window.skyApp.metrics }));
export async function waitGraphicsReady(page, kind) {
  await page.waitForFunction(kind => {
    const app = window.skyApp, status = app?.graphicsStatus, assets = app?.diagnostics.assetStatus;
    return app?.ready && status?.kind === kind && status.available && !app.diagnostics.scienceDirty
      && app.diagnostics.lastRenderedUt === app.snapshot.utDaysJ2000
      && assets.pending.length === 0 && assets.errors.length === 0;
  }, kind, { timeout: 30_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
export async function runM4aOfflineSmoke({ page, shot, name }) {
  await waitGraphicsReady(page, 'canvas2d');
  const before = await inspect(page);
  assert.equal(before.probe.uniqueSuccessfulContexts, 0); assert.ok(before.probe.blockedCalls > 0);
  assert.equal(before.interaction.rendererKind, 'canvas2d'); assert.equal(before.app.graphics.activeRendererCount, 1);
  assert.equal(before.metrics.textureCount, 0); assert.equal(before.metrics.geometryCount, 0);
  assert.equal(before.teaching.moon.perspective, 'topocentric');
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  const evidence = await inspect(page);
  assert.deepEqual(evidence.state, before.state); assert.equal(evidence.teaching.lunarCalendar.available, true);
  const png = await page.evaluate(() => window.skyApp.capture());
  assert.ok(png.startsWith('data:image/png;base64,'));
  evidence.captureBytes = Buffer.from(png.split(',')[1], 'base64').length;
  assert.ok(evidence.captureBytes > 1000); await shot(name); return evidence;
}
export async function runM4aChecks({ page, context, outDir, report, shot, assertPaired }) {
  await waitGraphicsReady(page, 'canvas2d');
  report.initial = await inspect(page);
  assert.equal(report.initial.probe.uniqueSuccessfulContexts, 0); assert.ok(report.initial.probe.blockedCalls > 0);
  assert.equal(report.initial.graphics.reason, 'webgl2-unavailable');
  assert.equal(await page.locator('[data-view="space"]').isVisible(), false);
  assert.equal(await page.locator('input[data-layer="milkyWay"]').isDisabled(), true);
  assert.equal(await page.locator('#sky-moon-loupe-toggle').isDisabled(), true);
  await page.evaluate(() => {
    const state = window.skyApp.state; state.viewMode = 'space'; state.presentation = 'observation';
    state.time.utDaysJ2000 = (Date.parse('2026-09-26T14:00:00Z') - 946728000000) / 86400000;
    state.environment.artificialSkyBrightness = .5; state.selected = 'body:Moon'; window.skyApp.setState(state);
  });
  await assertPaired(); await waitGraphicsReady(page, 'canvas2d');
  const before = await inspect(page);
  assert.equal(before.state.viewMode, 'space'); assert.equal(before.app.lastRenderedEffectiveView, 'ground');
  assert.equal(before.appearance.reason, 'ground-observation'); assert.deepEqual(before.appearance, before.actualAppearance.model);
  assert.equal(before.teaching.moon.perspective, 'topocentric');
  assert.deepEqual(before.interaction.selectedDirectionEqj, before.selectedDetails.directionEqj);
  const rawMoonDirection = before.snapshot.bodies.find(body => body.id === 'Moon').topocentricDirectionEqj;
  const unitMoonDirection = rawMoonDirection.map(value => value / Math.hypot(...rawMoonDirection));
  const directionError = Math.hypot(...unitMoonDirection.map((value, i) => value - before.interaction.selectedDirectionEqj[i]));
  assert.ok(directionError <= 8 * Number.EPSILON, '站心方向经单位化后应一致至浮点舍入精度');
  report.directionOracle = { rawMoonDirection, unitMoonDirection, directionError, tolerance: 8 * Number.EPSILON, detailsExactlyMatchDrawnDirection: true };
  await page.locator('[data-action="focus-selection"]').click();
  await page.waitForFunction(() => window.skyApp.diagnostics.lastFocusSucceeded === true);
  assert.deepEqual((await inspect(page)).state, before.state);
  const capture = Buffer.from((await page.evaluate(() => window.skyApp.capture())).split(',')[1], 'base64');
  assert.deepEqual(capture.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(resolve(outDir, 'canvas2d-capture.png'), capture); await shot('canvas2d-preserved-space-state.png');
  report.canvas = await runM4aOfflineSmoke({ page, shot, name: 'canvas2d-teaching.png' });
  const anchors = before.app.clockRebaseCount, requests = before.app.scienceRequestCount;
  await page.locator('#sky-retry-3d').click(); await waitGraphicsReady(page, 'canvas2d');
  const failedRetry = await inspect(page);
  assert.equal(failedRetry.graphics.reason, 'retry-failed'); assert.equal(failedRetry.app.graphics.canvasDisposeCount, 1);
  assert.deepEqual(failedRetry.state, before.state); assert.equal(failedRetry.app.clockRebaseCount, anchors);
  assert.equal(failedRetry.app.scienceRequestCount, requests);
  await page.evaluate(() => { window.__qaBlockWebGL2 = false; });
  await page.locator('#sky-retry-3d').click(); await waitGraphicsReady(page, 'webgl2');
  const restoredInitial = await inspect(page);
  assert.equal(restoredInitial.probe.uniqueSuccessfulContexts, 1);
  assert.deepEqual(restoredInitial.state, before.state); assert.equal(restoredInitial.appearance.reason, 'external-diagram');
  assert.equal(restoredInitial.teaching.moon.perspective, 'geocentric');
  assert.equal(restoredInitial.app.clockRebaseCount, anchors); assert.equal(restoredInitial.app.scienceRequestCount, requests);
  report.retry = { failed: failedRetry, successful: restoredInitial }; await shot('retry-three-dimensional.png');
  const glIdentity = restoredInitial.app.graphics.webglCanvasIdentity;
  await page.evaluate(() => {
    const canvas = document.querySelector('.sky-graphics-webgl2 .sky-webgl-canvas');
    window.__qaLoseContext = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    if (!window.__qaLoseContext) throw new Error('WEBGL_lose_context unavailable');
    window.__qaLoseContext.loseContext();
  });
  await waitGraphicsReady(page, 'canvas2d');
  const lost = await inspect(page);
  assert.equal(lost.graphics.reason, 'context-lost'); assert.equal(lost.app.graphics.activeRendererCount, 1);
  assert.equal(lost.app.graphics.retainedWebglInstanceCount, 1); assert.equal(lost.app.graphics.webglSurfaceHidden, true);
  assert.deepEqual(lost.state, before.state); assert.equal(lost.appearance.reason, 'ground-observation');
  assert.equal(lost.teaching.moon.perspective, 'topocentric');
  assert.equal(lost.app.clockRebaseCount, anchors); assert.equal(lost.app.scienceRequestCount, requests);
  assert.ok(lost.metrics.measurementNotes.some(note => note.includes('仍保留原三维实例')));
  await shot('real-context-loss-canvas2d.png');
  await page.evaluate(() => window.__qaLoseContext.restoreContext()); await waitGraphicsReady(page, 'webgl2');
  const restored = await inspect(page);
  assert.equal(restored.app.graphics.webglCanvasIdentity, glIdentity); assert.equal(restored.probe.uniqueSuccessfulContexts, 1);
  assert.equal(restored.app.graphics.fallbackInstanceCount, 0);
  assert.deepEqual(restored.state, before.state); assert.equal(restored.appearance.reason, 'external-diagram');
  assert.equal(restored.app.clockRebaseCount, anchors); assert.equal(restored.app.scienceRequestCount, requests);
  restored.runtimeStatus = await page.locator('#runtime-status').textContent();
  assert.ok(!restored.runtimeStatus.includes('二维方位图中高亮'), '恢复3D须清理已完成的2D标示提示');
  assert.equal(await page.locator('.sky-canvas2d-canvas').count(), 0); await shot('same-webgl-instance-restored.png');
  report.contextRecovery = { lost, restored };
  // One integrated native CDP pinch -> one remaining finger -> lift; independent reviewer owns the wider matrix.
  await page.evaluate(() => { const state = window.skyApp.state; state.viewMode = 'ground'; window.skyApp.setState(state); });
  await assertPaired(); await waitGraphicsReady(page, 'webgl2');
  const gestureBefore = await inspect(page), cdp = await context.newCDPSession(page);
  const point = (id, x, y) => ({ id, x, y, radiusX: 2, radiusY: 2, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 660, 330), point(2, 800, 330)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 630, 330), point(2, 830, 330)] });
  const pinch = await inspect(page);
  // Chrome 154 CDP touchEnd with a nonempty list names the released contacts.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [point(2, 830, 330)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 660, 350)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100); const gestureAfter = await inspect(page);
  assert.notEqual(pinch.state.cameras.ground.verticalFovDeg, gestureBefore.state.cameras.ground.verticalFovDeg);
  assert.notEqual(gestureAfter.state.cameras.ground.azimuthDegNorthEast, pinch.state.cameras.ground.azimuthDegNorthEast);
  assert.equal(gestureAfter.state.selected, gestureBefore.state.selected); assert.deepEqual(gestureAfter.state.time, gestureBefore.state.time);
  assert.deepEqual(gestureAfter.interaction.gesture.activePointerIds, []);
  for (const mode of ['space', 'globe', 'horizon']) assert.deepEqual(gestureAfter.state.cameras[mode], gestureBefore.state.cameras[mode]);
  report.nativeGesture = { before: gestureBefore, pinch, after: gestureAfter }; await cdp.detach();
  await page.setViewportSize({ width: 390, height: 844 }); await waitGraphicsReady(page, 'webgl2'); await shot('mobile-after-recovery.png');
  await page.setViewportSize({ width: 1152, height: 720 }); await waitGraphicsReady(page, 'webgl2');
  await page.waitForTimeout(200); const idle = await page.evaluate(() => window.skyApp.diagnostics.renderCount); await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), idle);
  report.assertions.push('Native WebGL2 getContext is blocked before first load; a real Canvas2D chart still initializes and preserves canonical JSON/selection/UTC/cameras.',
    'Retry failure/success and real WEBGL_lose_context loss/restoration do not rebase the clock or request paused science; restore reuses exactly one WebGL context and original canvas identity.',
    'Display-only ground adaptation and topocentric teaching follow active 2D, then restore external model/geocentric teaching without changing saved view.',
    'Capture and solar/calendar teaching remain available; paused redraw settles; native CDP pinch-to-single-finger transition changes only the active camera and suppresses accidental pick.');
  report.status = 'passed-m4a-browser-functional-checks';
  report.limitations.push('Forced no-WebGL2 is implemented by intercepting the real canvas getContext API while preserving native Canvas2D; it is an intentional capability fault injection.',
    'Native CDP input is browser-engine touch evidence, not a physical phone or OS input device; physical mobile and 30-minute continuous tests remain untested.');
}
export async function recordM4aWorkflow({ page, context, report, shot }) {
  await waitGraphicsReady(page, 'canvas2d');
  await page.locator('#sky-search').fill('北极星'); await page.locator('#sky-search').press('Enter');
  await page.locator('[data-action="focus-selection"]').click(); await page.waitForTimeout(1800);
  await page.evaluate(() => { window.__qaBlockWebGL2 = false; });
  await page.locator('#sky-retry-3d').click(); await waitGraphicsReady(page, 'webgl2'); await page.waitForTimeout(1000);
  const cdp = await context.newCDPSession(page);
  const point = (id, x, y) => ({ id, x, y, radiusX: 2, radiusY: 2, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 650, 320), point(2, 790, 320)] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 650 - i * 2, 320), point(2, 790 + i * 2, 320)] });
    await page.waitForTimeout(60);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [point(2, 814, 320)] });
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 626 + i * 3, 320 + i)] }); await page.waitForTimeout(60); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(900);
  await page.locator('[data-view="space"]').click(); await waitGraphicsReady(page, 'webgl2'); await page.waitForTimeout(900);
  await page.evaluate(() => {
    window.__qaLoseContext = document.querySelector('.sky-webgl-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__qaLoseContext.loseContext();
  });
  await waitGraphicsReady(page, 'canvas2d'); await page.waitForTimeout(2000); await shot('recording-context-loss.png');
  await page.setViewportSize({ width: 390, height: 844 }); await waitGraphicsReady(page, 'canvas2d'); await page.waitForTimeout(1500); await shot('recording-mobile-canvas2d.png');
  await page.evaluate(() => window.__qaLoseContext.restoreContext()); await waitGraphicsReady(page, 'webgl2'); await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 1152, height: 720 }); await waitGraphicsReady(page, 'webgl2');
  await page.locator('[data-view="ground"]').click(); await waitGraphicsReady(page, 'webgl2'); await page.waitForTimeout(1500); await shot('recording-same-webgl-restored.png');
  await cdp.detach(); report.finalGraphics = await inspect(page);
  report.assertions.push('Real browser viewport video includes initial no-WebGL2 Canvas2D search/highlight, native retry, native CDP pinch-to-single-finger movement, actual context loss and restoration, and a portrait Canvas2D chart.');
  report.status = 'recorded-awaiting-human-review';
  report.recordingScope = 'Actual full-UI Playwright video and native Chromium touch fault-recovery sequence; no synthetic frames and no claim of physical-phone or GPU display FPS.';
}
