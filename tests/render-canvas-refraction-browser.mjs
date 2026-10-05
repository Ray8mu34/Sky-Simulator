import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_CANVAS_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_CANVAS_OUT ?? 'qa/m5c-canvas/development';
await mkdir(out, { recursive: true });
const report = { url, stars: [], bodies: [], curves: null, layouts: [], errors: [],
  scope: 'Actual no-WebGL Canvas2D functional pixel/native pointer/HUD and paused-idle checks. No performance, GPU timing, 30-minute, or full astronomical-accuracy claim.' };
const sourceFiles = ['src/render/CanvasSkyRenderer.ts', 'src/render/CanvasSkyProjection.ts', 'src/render/SphericalArcBuffer.ts', 'src/core/refraction.ts',
  'src/core/object-details.ts', 'src/main.ts', 'src/state.ts', 'src/ui/controls.ts'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
report.sourceHashesBefore = await sourceHashes();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let context;
const ready = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.pendingInteractionCount === 0);
const read = page => page.evaluate(() => ({ state: window.skyApp.state, snapshot: window.skyApp.snapshot,
  details: window.skyApp.selectedDetails, interaction: window.skyApp.rendererDiagnostics, appearance: window.skyApp.skyAppearanceDiagnostics,
  metrics: window.skyApp.metrics, renderCount: window.skyApp.diagnostics.renderCount,
  detailText: [document.querySelector('.object-alt')?.textContent, document.querySelector('.object-apparent-alt')?.textContent] }));
const apply = async (page, state) => {
  const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.evaluate(state => window.skyApp.setState(state), state);
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty
    && window.skyApp.diagnostics.lastRenderedSelection === window.skyApp.state.selected && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode, count);
  await ready(page);
};
const pixel = (page, point) => page.evaluate(({ x, y }) => {
  const canvas = document.querySelector('.sky-canvas2d-canvas'), scale = canvas.width / canvas.clientWidth;
  const radius = Math.ceil(6 * scale), size = 2 * radius + 1, left = Math.floor(x * scale) - radius, top = Math.floor(y * scale) - radius;
  const data = canvas.getContext('2d').getImageData(left, top, size, size).data, core = [], surroundings = [];
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const distance = Math.hypot(px - radius, py - radius) / scale, index = (py * size + px) * 4;
    const luma = .2126 * data[index] + .7152 * data[index + 1] + .0722 * data[index + 2];
    if (distance <= 1.8) core.push(luma); else if (distance >= 3.5 && distance <= 5) surroundings.push(luma);
  }
  surroundings.sort((a, b) => a - b);
  return { maximum: Math.max(...core), nearbyMedian: surroundings[Math.floor(surroundings.length / 2)], sameContextReadback: true };
}, point);
const nativeClick = async (page, point) => {
  const rect = await page.locator('.sky-canvas2d-canvas').boundingBox();
  await page.mouse.click(rect.x + point.x, rect.y + point.y);
};
const position = (page, id) => page.evaluate(async id => {
  const { refractionPolicyCorrectionDeg } = await import('/src/core/refraction.ts');
  const { resolveObjectDetails } = await import('/src/core/object-details.ts');
  const { catalog } = await import('/src/data/catalog.ts');
  const app = window.skyApp, details = resolveObjectDetails(catalog, id, app.snapshot), v = app.rendererDiagnostics.chartViewport;
  // Independent disk algebra and the exact policy, rather than the renderer's
  // projected-star diagnostic or its Float32 display lookup.
  const altitude = details.geometricAltitudeDeg + refractionPolicyCorrectionDeg(details.geometricAltitudeDeg, app.snapshot.observerRefraction);
  const azimuth = details.azimuthDeg * Math.PI / 180, radius = (90 - altitude) / 90;
  return { x: v.centerX - radius * Math.sin(azimuth) * v.radius, y: v.centerY - radius * Math.cos(azimuth) * v.radius,
    altitudeDeg: altitude, geometricAltitudeDeg: details.geometricAltitudeDeg, azimuthDeg: details.azimuthDeg };
}, id);
const observerAt = (page, base, id, altitudeDeg) => page.evaluate(async ({ base, id, altitudeDeg }) => {
  const { computeSnapshot } = await import('/src/core/astronomy.ts');
  const { resolveObjectDetails } = await import('/src/core/object-details.ts');
  const { catalog } = await import('/src/data/catalog.ts');
  const next = structuredClone(base); next.observer.latitudeDeg = 0;
  const evaluate = longitude => {
    next.observer.longitudeDegEast = longitude;
    const s = computeSnapshot(next, 0), d = resolveObjectDetails(catalog, id, s);
    return { residual: d.geometricAltitudeDeg - altitudeDeg, azimuth: d.azimuthDeg };
  };
  let low = -180, left = evaluate(low), bracket = null;
  for (let high = -175; high <= 180; high += 5) {
    const right = evaluate(high);
    if (left.residual * right.residual <= 0 && (left.azimuth < 180 || right.azimuth < 180)) { bracket = [low, high]; break; }
    low = high; left = right;
  }
  if (!bracket) throw new Error(`No east-side observer bracket for ${id}`);
  let [a, b] = bracket, aResidual = evaluate(a).residual;
  for (let iteration = 0; iteration < 45; iteration++) {
    const midpoint = (a + b) / 2, residual = evaluate(midpoint).residual;
    if (aResidual * residual <= 0) b = midpoint; else { a = midpoint; aResidual = residual; }
  }
  next.observer.longitudeDegEast = (a + b) / 2;
  return next;
}, { base, id, altitudeDeg });
const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} / ${expected}`);
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
try {
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.5 });
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (name, ...args) { return name === 'webgl2' ? null : original.call(this, name, ...args); };
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await ready(page);
  assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
  const baseline = await page.evaluate(() => window.skyApp.state), base = structuredClone(baseline);
  base.time.running = false; base.viewMode = 'space'; base.presentation = 'explanation'; base.selected = null;
  base.environment.refraction = 'standard'; base.environment.pressureHpa = 1010; base.environment.temperatureC = 10;
  base.layers.atmosphere = false; base.layers.milkyWay = false; base.layers.sunMoon = false;
  base.layers.brightStarNamesZh = false; base.layers.constellationLabels = false; base.layers.constellationLines = false;
  for (const targetAltitude of [1, -.2]) {
    const id = 'hip:32349', state = await observerAt(page, base, id, targetAltitude);
    await apply(page, state);
    const expected = await position(page, id), starOnly = await read(page), target = starOnly.interaction.projectedStars.find(star => star.id === id);
    assert.ok(target, `actual rendered star at geometric ${targetAltitude}`);
    close(target.x, expected.x, .001, 'same mapping x'); close(target.y, expected.y, .001, 'same mapping y');
    const pixels = await pixel(page, expected); assert.ok(pixels.maximum > pixels.nearbyMedian + 5, JSON.stringify(pixels));
    await nativeClick(page, expected);
    await page.waitForFunction(id => window.skyApp.state.selected === id && window.skyApp.diagnostics.lastRenderedSelection === id, id);
    const picked = await read(page);
    close(picked.details.geometricAltitudeDeg, targetAltitude, 1e-8, 'geometric detail');
    close(picked.details.apparentAltitudeDeg, expected.altitudeDeg, .1 / 3600, 'apparent detail');
    assert.equal(picked.interaction.selectedGeometricallyAboveHorizon, targetAltitude >= 0);
    assert.equal(picked.interaction.selectedApparentAboveHorizon, true);
    assert.ok(picked.interaction.labelHitBoxes.some(label => label.id === id));
    assert.ok(picked.detailText.every(text => text && text.includes('°')), 'both native detail readouts exist');
    const focusCount = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.evaluate(() => window.skyApp.focusSelection());
    await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && window.skyApp.diagnostics.lastFocusSucceeded, focusCount);
    await ready(page);
    const focused = await read(page), v = focused.interaction;
    close((v.selectedProjectedNdc[0] + 1) * v.chartViewport.width / 2, target.x, .001, 'ring/focus same x');
    close((1 - v.selectedProjectedNdc[1]) * v.chartViewport.height / 2, target.y, .001, 'ring/focus same y');
    assert.deepEqual(focused.state.time, state.time); assert.deepEqual(focused.state.observer, state.observer);
    assert.deepEqual(focused.state.cameras, state.cameras); assert.equal(focused.state.viewMode, 'space');
    assert.equal(v.actualDisplayViewMode, 'ground'); assert.equal(v.refraction.identity, false);
    assert.equal(v.refraction.canvasOwnedLutCopies, 0); assert.equal(focused.metrics.textureCount, 0);
    await page.screenshot({ path: `${out}/star-geometric-${targetAltitude < 0 ? 'negative' : 'positive'}-standard.png` });
    const none = structuredClone(state); none.environment.refraction = 'none'; await apply(page, none);
    const noneRead = await read(page);
    assert.equal(noneRead.interaction.projectedStars.some(star => star.id === id), targetAltitude >= 0);
    const nonePositions = noneRead.interaction.projectedStars, p0 = structuredClone(state); p0.environment.pressureHpa = 0; await apply(page, p0);
    const zeroRead = await read(page); assert.deepEqual(zeroRead.interaction.projectedStars, nonePositions);
    assert.equal(zeroRead.interaction.refraction.identity, true); assert.equal(zeroRead.interaction.refraction.sharedCpuProfileBytesEstimate, 0);
    report.stars.push({ targetAltitude, expected, pixels, nativePickId: picked.state.selected, focused, noneRead, zeroRead });
  }
  for (const id of ['body:Sun', 'body:Moon']) {
    const state = await observerAt(page, base, id, -.2); state.layers.sunMoon = true;
    await apply(page, state);
    const expected = await position(page, id), drawn = await read(page), marker = drawn.interaction.bodyHitTargets.find(body => body.id === id);
    assert.ok(marker); close(marker.x, expected.x, .001, 'body marker x'); close(marker.y, expected.y, .001, 'body marker y');
    await nativeClick(page, expected); await page.waitForFunction(id => window.skyApp.state.selected === id, id); await ready(page);
    const picked = await read(page); assert.equal(picked.interaction.selectedGeometricallyAboveHorizon, false);
    assert.equal(picked.interaction.selectedApparentAboveHorizon, true); assert.ok(picked.appearance.bodyMarkersOnly);
    assert.ok(picked.interaction.labelHitBoxes.some(label => label.id === id));
    await page.screenshot({ path: `${out}/${id.replace(':', '-')}-negative-marker.png` });
    report.bodies.push({ id, expected, marker, picked });
  }
  // Capture actual painted selected-constellation paths, not just a count in diagnostics.
  const curveState = await observerAt(page, base, 'constellation:Ori', 5); curveState.selected = 'constellation:Ori';
  await page.evaluate(() => {
    window.__canvasArcPaths = []; window.__canvasArcPath = [];
    const prototype = CanvasRenderingContext2D.prototype;
    window.__canvasOriginalMethods = { beginPath: prototype.beginPath, moveTo: prototype.moveTo, lineTo: prototype.lineTo, stroke: prototype.stroke };
    prototype.beginPath = function (...args) { window.__canvasArcPath = []; return window.__canvasOriginalMethods.beginPath.apply(this, args); };
    for (const name of ['moveTo', 'lineTo']) prototype[name] = function (x, y) { window.__canvasArcPath.push([x, y]); return window.__canvasOriginalMethods[name].call(this, x, y); };
    prototype.stroke = function (...args) { if (this.canvas.classList.contains('sky-canvas2d-canvas') && this.strokeStyle === '#bbd9ef') window.__canvasArcPaths.push(window.__canvasArcPath.slice()); return window.__canvasOriginalMethods.stroke.apply(this, args); };
  });
  await apply(page, curveState);
  const curves = await page.evaluate(() => {
    const d = window.skyApp.rendererDiagnostics, v = d.chartViewport, paths = window.__canvasArcPaths;
    for (const [name, method] of Object.entries(window.__canvasOriginalMethods)) CanvasRenderingContext2D.prototype[name] = method;
    return { diagnostics: d, paths, boundaryPointCount: paths.flat().filter(([x, y]) => Math.abs(Math.hypot(x - v.centerX, y - v.centerY) / v.radius - 1) < 1e-9).length };
  });
  assert.ok(curves.paths.length > 0 && curves.boundaryPointCount > 0, 'actual selected Orion curves cross the apparent horizon');
  assert.ok(curves.paths.every(path => path.every(([x, y]) => Math.hypot(x - curves.diagnostics.chartViewport.centerX, y - curves.diagnostics.chartViewport.centerY) <= curves.diagnostics.chartViewport.radius + 1e-8)));
  assert.equal(curves.diagnostics.constellationArcSampling.cappedArcCount, 0);
  const curvePath = curves.paths.find(path => path.length > 1), curvePoint = { x: (curvePath[0][0] + curvePath[1][0]) / 2, y: (curvePath[0][1] + curvePath[1][1]) / 2 };
  curves.pixels = await pixel(page, curvePoint); assert.ok(curves.pixels.maximum > curves.pixels.nearbyMedian + 5, 'actual selected curve ink');
  await page.screenshot({ path: `${out}/orion-apparent-horizon-curves.png` }); report.curves = curves;
  const layoutSample = async name => {
    await page.waitForTimeout(180); await ready(page);
    const value = await page.evaluate(() => {
      const app = window.skyApp, stage = document.querySelector('#sky-stage').getBoundingClientRect();
      const blocks = [...document.querySelectorAll('#sky-control-panel,#sky-offline-notice,.controls-compact')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
        const r = element.getBoundingClientRect(); return { id: element.id || element.className, left: r.left - stage.left, top: r.top - stage.top, right: r.right - stage.left, bottom: r.bottom - stage.top };
      });
      return { state: app.state, diagnostics: app.rendererDiagnostics, renderCount: app.diagnostics.renderCount, blocks };
    });
    for (const caption of Object.values(value.diagnostics.fixedHudCaptions)) if (caption.box)
      for (const block of value.blocks) assert.ok(!overlaps(caption.box, block), `${name}: ${block.id} overlaps caption`);
    assert.deepEqual(value.state, curveState, 'HUD/viewport changes preserve the saved complete scene');
    const header = value.diagnostics.fixedHudCaptions.header;
    if (header.lines.length) assert.match(header.lines[0].text, /标准折射/);
    await page.waitForTimeout(220); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), value.renderCount, `${name}: paused stable idle`);
    await page.screenshot({ path: `${out}/${name}.png` }); report.layouts.push({ name, ...value });
  };
  await page.evaluate(() => { const notice = document.querySelector('#sky-offline-notice'); notice.hidden = false; notice.textContent = '折射 Canvas QA：实际离线告示避让'; window.dispatchEvent(new CustomEvent('sky:layout-change')); });
  await layoutSample('desktop-standard-notice-open');
  await page.evaluate(() => { document.querySelector('#sky-offline-notice').hidden = true; window.dispatchEvent(new CustomEvent('sky:layout-change')); });
  await layoutSample('desktop-standard-notice-closed');
  await page.setViewportSize({ width: 390, height: 844 }); await layoutSample('portrait-standard-drawer-closed');
  await page.locator('.controls-compact [aria-controls="sky-control-panel"]').click(); await layoutSample('portrait-standard-drawer-open');
  await page.setViewportSize({ width: 844, height: 390 }); await layoutSample('landscape-standard-drawer-open');
  await page.locator('#sky-control-panel [data-action="close"]').click(); await layoutSample('landscape-standard-drawer-closed');
  assert.equal(report.errors.length, 0); report.browserVersion = browser.version();
} catch (error) { report.failure = error.stack ?? error.message; throw error; }
finally { report.sourceHashesAfter = await sourceHashes(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); if (context) await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
