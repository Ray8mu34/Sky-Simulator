import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.SKY_CANVAS_URL ?? 'http://127.0.0.1:5173/';
const url = new URL('qa/m5c-canvas/renderer-harness.html', baseUrl).href;
const out = process.env.SKY_CANVAS_OUT ?? 'qa/m5c-canvas/renderer-development';
await mkdir(out, { recursive: true });
const report = { url, samples: [], splitArc: null, errors: [],
  scope: 'Real CanvasSkyRenderer + core snapshot, native pointer and same-context pixels. Split-arc supplementary Canvas uses the actual production helper. This bypasses main/GraphicsHost/state validation and is not a full-app fallback, UI, performance, or 30-minute result.' };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.5 });
try {
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.canvasQa?.renderCount > 0);
  for (const geometricAltitudeDeg of [1, -.2]) {
    const setup = await page.evaluate(async altitude => {
      const { computeSnapshot } = await import('/src/core/astronomy.ts');
      const { resolveObjectDetails } = await import('/src/core/object-details.ts');
      const { catalog } = await import('/src/data/catalog.ts');
      const state = window.canvasQa.state; state.viewMode = 'space'; state.time.running = false; state.selected = null;
      state.observer.latitudeDeg = 0; state.environment.refraction = 'standard'; state.environment.pressureHpa = 1010; state.environment.temperatureC = 10;
      state.layers.atmosphere = false; state.layers.milkyWay = false; state.layers.sunMoon = false;
      state.layers.constellationLines = false; state.layers.constellationLabels = false; state.layers.brightStarNamesZh = false;
      const evaluate = longitude => { state.observer.longitudeDegEast = longitude; const d = resolveObjectDetails(catalog, 'hip:32349', computeSnapshot(state, 0)); return { residual: d.geometricAltitudeDeg - altitude, az: d.azimuthDeg }; };
      let left = evaluate(-180), low = -180, bracket;
      for (let high = -175; high <= 180; high += 5) { const right = evaluate(high); if (left.residual * right.residual <= 0 && (left.az < 180 || right.az < 180)) { bracket = [low, high]; break; } low = high; left = right; }
      if (!bracket) throw new Error('No observer bracket');
      let [a, b] = bracket, fa = evaluate(a).residual;
      for (let iteration = 0; iteration < 45; iteration++) { const middle = (a + b) / 2, fm = evaluate(middle).residual; if (fa * fm <= 0) b = middle; else { a = middle; fa = fm; } }
      state.observer.longitudeDegEast = (a + b) / 2;
      const count = window.canvasQa.renderCount; window.canvasQa.setState(state); return { state, count };
    }, geometricAltitudeDeg);
    await page.waitForFunction(count => window.canvasQa.renderCount > count, setup.count);
    const actual = await page.evaluate(async () => {
      const { refractionPolicyCorrectionDeg } = await import('/src/core/refraction.ts');
      const { resolveObjectDetails } = await import('/src/core/object-details.ts');
      const { catalog } = await import('/src/data/catalog.ts');
      const app = window.canvasQa, d = resolveObjectDetails(catalog, 'hip:32349', app.snapshot), v = app.diagnostics.chartViewport;
      const h = d.geometricAltitudeDeg + refractionPolicyCorrectionDeg(d.geometricAltitudeDeg, app.snapshot.observerRefraction), az = d.azimuthDeg * Math.PI / 180;
      const expected = { x: v.centerX - (90 - h) / 90 * Math.sin(az) * v.radius, y: v.centerY - (90 - h) / 90 * Math.cos(az) * v.radius };
      const canvas = document.querySelector('.sky-canvas2d-canvas'), scale = canvas.width / canvas.clientWidth, r = Math.ceil(6 * scale), size = 2 * r + 1;
      const pixels = canvas.getContext('2d').getImageData(Math.floor(expected.x * scale) - r, Math.floor(expected.y * scale) - r, size, size).data;
      const core = [], nearby = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const distance = Math.hypot(x - r, y - r) / scale, i = (y * size + x) * 4, luma = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]; if (distance <= 1.8) core.push(luma); else if (distance >= 3.5 && distance <= 5) nearby.push(luma); }
      nearby.sort((a, b) => a - b);
      return { expected, details: d, diagnostics: app.diagnostics, pixel: { maximum: Math.max(...core), nearbyMedian: nearby[Math.floor(nearby.length / 2)], sameContextReadback: true } };
    });
    const target = actual.diagnostics.projectedStars.find(star => star.id === 'hip:32349');
    assert.ok(target); assert.ok(Math.hypot(target.x - actual.expected.x, target.y - actual.expected.y) < .001);
    assert.ok(actual.pixel.maximum > actual.pixel.nearbyMedian + 5);
    const canvasBox = await page.locator('.sky-canvas2d-canvas').boundingBox();
    await page.mouse.click(canvasBox.x + actual.expected.x, canvasBox.y + actual.expected.y);
    await page.waitForFunction(() => window.canvasQa.state.selected === 'hip:32349' && window.canvasQa.diagnostics.selectedVisible);
    const focus = await page.evaluate(() => { const count = window.canvasQa.renderCount, result = window.canvasQa.focus(); return { count, result }; });
    assert.equal(focus.result, true); await page.waitForFunction(count => window.canvasQa.renderCount > count, focus.count);
    const selected = await page.evaluate(() => ({ state: window.canvasQa.state, diagnostics: window.canvasQa.diagnostics, details: window.canvasQa.details, appearance: window.canvasQa.appearance }));
    assert.equal(selected.diagnostics.selectedGeometricallyAboveHorizon, geometricAltitudeDeg >= 0);
    assert.equal(selected.diagnostics.selectedApparentAboveHorizon, true); assert.equal(selected.state.viewMode, 'space');
    assert.deepEqual(selected.state.cameras, setup.state.cameras); assert.deepEqual(selected.state.time, setup.state.time); assert.deepEqual(selected.state.observer, setup.state.observer);
    assert.ok(selected.diagnostics.labelHitBoxes.some(label => label.id === 'hip:32349'));
    await page.screenshot({ path: `${out}/sirius-${geometricAltitudeDeg < 0 ? 'negative' : 'positive'}-standard.png` });
    const identity = structuredClone(setup.state); identity.environment.refraction = 'none';
    const count = await page.evaluate(state => { const count = window.canvasQa.renderCount; window.canvasQa.setState(state); return count; }, identity);
    await page.waitForFunction(count => window.canvasQa.renderCount > count, count);
    const none = await page.evaluate(() => window.canvasQa.diagnostics); assert.equal(none.projectedStars.some(star => star.id === 'hip:32349'), geometricAltitudeDeg >= 0);
    identity.environment.refraction = 'standard'; identity.environment.pressureHpa = 0;
    const zeroCount = await page.evaluate(state => { const count = window.canvasQa.renderCount; window.canvasQa.setState(state); return count; }, identity);
    await page.waitForFunction(count => window.canvasQa.renderCount > count, zeroCount);
    const zero = await page.evaluate(() => window.canvasQa.diagnostics); assert.deepEqual(zero.projectedStars, none.projectedStars);
    await page.waitForTimeout(180); const idleCount = await page.evaluate(() => window.canvasQa.renderCount);
    await page.waitForTimeout(220); assert.equal(await page.evaluate(() => window.canvasQa.renderCount), idleCount);
    report.samples.push({ geometricAltitudeDeg, actual, nativePickId: selected.state.selected, selected, none, zero, idleCount });
  }
  report.splitArc = await page.evaluate(async () => {
    const { clipSampleCanvasSkyArcEnu } = await import('/src/render/CanvasSkyProjection.ts');
    const { createRefractionDescriptor, deriveRefractionProfile } = await import('/src/core/refraction.ts');
    const { horizontalToVector } = await import('/src/core/math.ts');
    const environment = { ...window.canvasQa.state.environment, refraction: 'standard', pressureHpa: 1010, temperatureC: 10 };
    const profile = deriveRefractionProfile(createRefractionDescriptor(environment));
    const arc = clipSampleCanvasSkyArcEnu(horizontalToVector(-.1, 0), horizontalToVector(-.1, 170), profile, { maxAngularStepDeg: .1, maxSegments: 256 });
    window.canvasQa.dispose(); document.querySelector('#canvas-fixture-note').remove();
    const canvas = document.createElement('canvas'); canvas.id = 'split-arc-fixture'; canvas.width = 1152; canvas.height = 720; document.querySelector('#sky-stage').append(canvas);
    const ctx = canvas.getContext('2d'), cx = 576, cy = 380, radius = 280;
    ctx.fillStyle = '#070d14'; ctx.fillRect(0, 0, 1152, 720); ctx.strokeStyle = '#354c60'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#dbe5ec'; ctx.font = '18px Microsoft YaHei,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('生产 Canvas helper：标准折射的两个可见区间', cx, 35);
    ctx.font = '13px Microsoft YaHei,sans-serif'; ctx.fillText('几何端点均 −0.1°，不可见中段不连线；此图仅是 helper 补充夹具', cx, 61);
    ctx.strokeStyle = '#bbd9ef'; ctx.lineWidth = 2;
    const paths = arc.paths.map(path => path.map(point => ({ x: cx + point.x * radius, y: cy + point.y * radius })));
    for (const path of paths) { ctx.beginPath(); path.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke(); }
    const path = paths[0], midpoint = path[Math.floor(path.length / 2)], rgba = ctx.getImageData(Math.round(midpoint.x) - 2, Math.round(midpoint.y) - 2, 5, 5).data;
    let maximum = 0; for (let index = 0; index < rgba.length; index += 4) maximum = Math.max(maximum, rgba[index], rgba[index + 1], rgba[index + 2]);
    return { arc, paths, inkChannelMaximum: maximum, nativeRendererDisposedBeforeSupplement: true };
  });
  assert.equal(report.splitArc.arc.paths.length, 2); assert.ok(report.splitArc.arc.sampling.actualSegments <= 256); assert.ok(report.splitArc.inkChannelMaximum > 100);
  await page.screenshot({ path: `${out}/split-visible-intervals-helper.png` }); assert.equal(report.errors.length, 0);
  report.browserVersion = browser.version();
} catch (error) { report.failure = error.stack ?? error.message; throw error; }
finally { await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
