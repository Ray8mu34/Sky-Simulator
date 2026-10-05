/** Short real-application Canvas fallback functionality QA, default development server. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve('qa/m4-canvas'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
const testedUrl = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const page = await context.newPage(), errors = [], report = { status: 'running', runAtUtc: new Date().toISOString(),
  testedUrl, sourceEntry: 'src/main.ts', artifactKind: process.env.SKY_QA_ARTIFACT_KIND ?? 'development-server real application source',
  builtArtifactValidation: process.env.SKY_QA_ARTIFACT_KIND === 'production-build', artifactHash: null,
  assertions: [], screenshots: [], limitations: ['Default5173 checks development-server real application code, not the final production build.', 'Short browser functionality check, not30-minuteperformance acceptance. Canvas GPU driver memory is unmeasured.'] };
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const native = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (['webgl2', 'webgl', 'experimental-webgl'].includes(kind)) return null;
    return native.call(this, kind, ...args);
  };
});
const check = (condition, message) => { assert.ok(condition, message); report.assertions.push(message); };
const paired = async () => {
  await page.waitForFunction(() => window.skyApp?.ready && window.skyApp.graphicsStatus?.kind === 'canvas2d'
    && window.skyApp.rendererDiagnostics?.rendererKind === 'canvas2d'
    && window.skyApp.rendererDiagnostics.utDaysJ2000 === window.skyApp.snapshot.utDaysJ2000);
  await page.waitForTimeout(130);
};
const scene = async state => { await page.evaluate(value => window.skyApp.setState(value), state); await paired(); };
const shot = async name => { const path = `${out}/${name}.png`; await page.screenshot({ path, fullPage: false }); report.screenshots.push(path); };
const read = () => page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot, diagnostics: window.skyApp.rendererDiagnostics,
  graphics: window.skyApp.graphicsStatus, appearance: window.skyApp.skyAppearance, metrics: window.skyApp.metrics,
  appearanceDiagnostics: window.skyApp.skyAppearanceDiagnostics }));
try {
  await page.goto(testedUrl, { waitUntil: 'load' }); await paired();
  const baseline = (await read()).state;
  const external = structuredClone(baseline); external.viewMode = 'space'; external.presentation = 'explanation';
  await scene(external);
  const first = await read(), savedCameras = JSON.stringify(first.state.cameras);
  check(first.diagnostics.projectedStars.length > 500, 'No WebGL2 retains a real upper-hemisphere star chart');
  check(first.graphics.capabilities.cameraInteraction === false && first.graphics.capabilities.moonLoupe === false, 'Capabilities explicitly disable unsupported3D camera/moonloupe');
  check(first.state.viewMode === 'space', 'Fixed local overview retains serialized external view mode');
  check(first.metrics.textureCount === 0 && first.metrics.geometryCount === 0, 'Canvas fallback loads no WebGL textures/geometries');
  check(first.diagnostics.chartViewport.centerX > 640, 'Desktop open control panel is avoided by chart viewport');
  const oracle = await page.evaluate(async () => {
    const { catalog } = await import('/src/data/catalog.ts'); const { propagateStarDirection } = await import('/src/core/stars.ts');
    const app = window.skyApp, diag = app.rendererDiagnostics, v = diag.chartViewport, matrix = app.snapshot.eqjToHorizontalGeometric;
    let maximumPixelError = 0, minimumUp = 1;
    for (const target of diag.projectedStars) {
      const star = catalog.stars.find(star => star.id === target.id), eqj = propagateStarDirection(star, app.snapshot.utDaysJ2000);
      const h = matrix.map(row => row.reduce((sum, value, i) => sum + value * eqj[i], 0));
      const length = Math.hypot(...h), horizontal = Math.hypot(h[0], h[1]); minimumUp = Math.min(minimumUp, h[2]);
      const r = 1 - Math.atan2(h[2], horizontal) / (Math.PI / 2);
      const x = v.centerX + (horizontal ? -h[0] / horizontal * r : 0) * v.radius;
      const y = v.centerY + (horizontal ? -h[1] / horizontal * r : 0) * v.radius;
      maximumPixelError = Math.max(maximumPixelError, Math.hypot(target.x - x, target.y - y));
      if (length < .99) throw Error('Invalid unit direction');
    }
    const below = catalog.stars.find(star => { const d = propagateStarDirection(star, app.snapshot.utDaysJ2000); return matrix[2].reduce((sum, value, i) => sum + value * d[i], 0) < -.2; });
    return { maximumPixelError, minimumUp, belowId: below.id };
  });
  check(oracle.maximumPixelError < 1e-7 && oracle.minimumUp >= 0, 'Every rendered star matches current proper motion and same snapshot ENU; no lower hemisphere');
  report.geometryOracle = oracle;
  await shot('desktop-open-panel');
  const target = first.diagnostics.projectedStars.filter(star => !first.diagnostics.labelHitBoxes.some(box => star.x >= box.x && star.x <= box.x + box.w && star.y >= box.y && star.y <= box.y + box.h)
    && !first.diagnostics.bodyHitTargets.some(body => Math.hypot(star.x - body.x, star.y - body.y) < body.radius)).sort((a, b) => a.magnitude - b.magnitude)[0];
  assert.ok(target);
  await page.mouse.click(target.x, target.y); await paired();
  check((await read()).state.selected === target.id, 'Tap selects a real catalog object using existing selection/details path');
  await page.evaluate(() => window.skyApp.focusSelection()); await paired();
  const selected = await read();
  check(selected.diagnostics.selectedVisible && JSON.stringify(selected.state.cameras) === savedCameras, 'Focus highlights upper direction without changing any serialized camera');
  check(selected.diagnostics.labelHitBoxes.filter(label => label.id === target.id).length <= 1, 'Selected and ordinary star labels are deduplicated');
  await shot('selected-real-star');
  const multi = await page.evaluate(() => {
    const canvas = document.querySelector('.sky-canvas2d-canvas'), before = window.skyApp.state.selected;
    const fire = (type, pointerId, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientX: x, clientY: y, button: 0, pointerType: 'touch' }));
    fire('pointerdown', 11, 900, 350); fire('pointerdown', 12, 950, 350); fire('pointermove', 11, 880, 330);
    fire('pointerup', 12, 950, 350); fire('pointerup', 11, 880, 330);
    return { before, after: window.skyApp.state.selected, active: window.skyApp.rendererDiagnostics.activePointerCount };
  });
  check(multi.before === multi.after && multi.active === 0, 'Two-finger session ignores pan/zoom and suppresses accidental tap/clear');
  const below = structuredClone(external); below.selected = oracle.belowId;
  await scene(below); await page.evaluate(() => window.skyApp.focusSelection()); await paired();
  const hidden = await read();
  check(!hidden.diagnostics.selectedVisible && /地平线下/.test(hidden.diagnostics.focusReason), 'Focus on a below-horizon catalog object is unavailable with an explicit reason');
  check(JSON.stringify(hidden.state.cameras) === savedCameras, 'Below-horizon focus preserves all camera state');
  const constellation = structuredClone(external); constellation.selected = 'constellation:Cyg'; constellation.layers.constellationLines = false;
  await scene(constellation);
  const figure = await read();
  check(figure.diagnostics.highlightedConstellationIds.includes('Cyg') && figure.diagnostics.sampledConstellationSegments > 0, 'Selected constellation has a separate clipped direction highlight when ordinary lines are off');
  check(figure.diagnostics.sampledConstellationPointCount <= figure.diagnostics.sampledConstellationSegments * 65, 'Constellation arc sampling is bounded');
  const day = structuredClone(external); day.presentation = 'observation'; day.time.utDaysJ2000 = (Date.parse('2026-09-14T04:00:00Z') - Date.parse('2000-01-01T12:00:00Z')) / 86400000;
  day.selected = null; day.layers.constellationLines = false; day.layers.constellationLabels = false; day.layers.brightStarNamesZh = false;
  await scene(day); const noon = await read();
  check(noon.appearance.scope === 'local-observer' && noon.appearance.visibilityApplied && noon.appearance.starVisibility === 0, 'Saved external view still uses same-core local ground appearance in2D');
  check(noon.diagnostics.projectedStars.length === 0, 'Daylight hides real stars while Sun/Moon science continues');
  const color = await page.evaluate(() => {
    const canvas = document.querySelector('.sky-canvas2d-canvas'), view = window.skyApp.rendererDiagnostics.chartViewport;
    const x = Math.floor((view.centerX + 6) * view.pixelRatio), y = Math.floor((view.centerY + 6) * view.pixelRatio);
    return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
  });
  const srgb = value => Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055));
  const expected = noon.appearance.backgroundLinearRgb.map(srgb);
  check(color.slice(0, 3).every((value, i) => Math.abs(value - expected[i]) < 8), 'Canvas background converts shared linearRGB to sRGB');
  report.daylightColor = { sampled: color, nearCenterExpected: expected };
  const bodyOracle = await page.evaluate(() => {
    const app = window.skyApp, diag = app.rendererDiagnostics, view = diag.chartViewport;
    return diag.bodyHitTargets.map(marker => {
      const body = app.snapshot.bodies.find(body => `body:${body.id}` === marker.id), d = body.topocentricDirectionEqj;
      const [e, n, u] = app.snapshot.eqjToHorizontalGeometric.map(row => row.reduce((sum, value, i) => sum + value * d[i], 0));
      const h = Math.hypot(e, n), r = 1 - Math.atan2(u, h) / (Math.PI / 2);
      return { id: marker.id, error: Math.hypot(marker.x - (view.centerX - e / h * r * view.radius), marker.y - (view.centerY - n / h * r * view.radius)), u };
    });
  });
  check(bodyOracle.length > 0 && bodyOracle.every(body => body.error < 1e-7 && body.u >= 0), 'Sun/Moon marker positions use topocentric directions even with external state saved');
  report.bodyOracle = bodyOracle; await shot('daylight-direction-markers');
  await scene(external);
  const png = await page.evaluate(() => window.skyApp.capture());
  check(png.startsWith('data:image/png;base64,'), 'PNG capture composites2D chart, explanatory annotations and labels');
  await writeFile(`${out}/captured-chart.png`, Buffer.from(png.split(',')[1], 'base64'));
  for (const [name, viewport] of [['mobile-portrait', { width: 390, height: 844 }], ['mobile-landscape', { width: 844, height: 390 }]]) {
    await page.setViewportSize(viewport); await paired();
    const close = page.locator('[data-action="close"]'); if (await close.isVisible()) await close.click(); await paired();
    const mobile = await read(), canvasSize = await page.locator('.sky-canvas2d-canvas').evaluate(canvas => [canvas.width, canvas.height]);
    check(canvasSize[0] * canvasSize[1] <= 1500000, `${name}: backing pixel budget respected`);
    const disk = mobile.diagnostics.chartViewport;
    check(disk.centerX - disk.radius >= 0 && disk.centerX + disk.radius < viewport.width && disk.centerY - disk.radius >= 0 && disk.centerY + disk.radius < viewport.height, `${name}: complete hemisphere disk remains inside viewport`);
    check(JSON.stringify(mobile.state.cameras) === savedCameras, `${name}: resize/collapse retains all serialized cameras`);
    check(mobile.metrics.visibleLabelCount <= 18, `${name}: teaching labels use mobile budget and disk area cap`);
    if (name === 'mobile-landscape') check(disk.centerX > viewport.width / 2, 'Coarse-pointer short landscape reserves toolbar width while retaining disk radius');
    await shot(name); report[name] = { viewport: disk, pixels: canvasSize, labels: mobile.metrics.visibleLabelCount };
  }
  check(errors.length === 0, 'No uncaught real application page errors in all2D scenarios');
  report.status = 'pass'; report.pageErrors = errors;
} catch (error) { report.status = 'fail'; report.failure = String(error.stack ?? error); report.pageErrors = errors; throw error; }
finally { await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await context.close(); await browser.close(); }
console.log(`Canvas fallback checks passed: ${report.assertions.length}; screenshots${report.screenshots.length}; browser closed.`);
