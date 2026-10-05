import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = process.env.SKY_RENDER_OUT ?? 'qa/m5b-render/development';
const url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const records = JSON.parse(await readFile('qa/science-reference-prep/motion-cache-bound-records.json', 'utf8'));
const metadata = JSON.parse(await readFile('assets/runtime/star-meta.json', 'utf8'));
const figures = JSON.parse(await readFile('assets/runtime/constellation-meta.json', 'utf8')).constellations;
const cases = [['hip:32349', 'hip:32349'], ['hip:71352', 'hip:71352'], ['hip:17851', 'hip:17851'], ['hyg:119623', 'hyg:119623'], ['hyg:11734', 'hip:11767']];
const byId = new Map(records.map(r => [r.id, r]));
function expectedDirection(id, ut) {
  const record = byId.get(id), p = record.p0.map((value, axis) => value + ut / 365.25 * record.vPerJulianYear[axis]);
  return p.map(value => value / Math.hypot(...p));
}
function separation(a, b) {
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...cross), a.reduce((sum, value, axis) => sum + value * b[axis], 0)) * 180 / Math.PI * 3600;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true }), errors = [], samples = [];
let context;
try {
  for (const kind of ['webgl', 'canvas2d']) {
    context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.5 });
    if (kind === 'canvas2d') await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (name, ...args) { return name === 'webgl2' ? null : original.call(this, name, ...args); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /shader|GL_INVALID/.test(message.text())) errors.push(message.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && !window.skyApp.diagnostics.assetStatus.pending.length);
    const baseline = await page.evaluate(() => ({ state: window.skyApp.state, gast: window.skyApp.snapshot.gastHours }));
    const apply = async state => {
      const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
      await page.evaluate(state => window.skyApp.setState(state), state);
      await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty
        && window.skyApp.diagnostics.lastRenderedSelection === window.skyApp.state.selected && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode, count);
    };
    const read = () => page.evaluate(() => ({ state: window.skyApp.state, details: window.skyApp.selectedDetails,
      interaction: window.skyApp.rendererDiagnostics, metrics: window.skyApp.metrics, count: window.skyApp.diagnostics.renderCount }));
    for (const [rawId, canonicalId] of cases) for (const mode of kind === 'webgl' ? ['ground', 'space', 'globe', 'horizon'] : ['ground']) {
      const row = metadata.find(row => row[0] === canonicalId), state = structuredClone(baseline.state);
      state.time.running = false; state.selected = rawId; state.viewMode = mode; state.presentation = 'explanation';
      state.observer.latitudeDeg = row[4]; state.observer.longitudeDegEast = ((row[3] * 15 - baseline.gast * 15 + 540) % 360) - 180;
      // A controlled near-transit observer keeps each test star above the geometric horizon.
      state.layers.atmosphere = false; state.layers.milkyWay = false; state.layers.sunMoon = false;
      state.layers.brightStarNamesZh = false; state.layers.constellationLabels = false; state.layers.constellationLines = false;
      state.layers.ecliptic = false; state.layers.celestialEquator = false; state.layers.celestialPoles = false;
      await apply(state);
      const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
      await page.evaluate(() => window.skyApp.focusSelection());
      await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && window.skyApp.diagnostics.lastFocusSucceeded === true, count);
      await page.waitForTimeout(120);
      const focused = await read(), d = focused.interaction, motion = d.starMotion;
      assert.equal(focused.state.selected, rawId); assert.equal(d.canonicalSelectedId, canonicalId);
      assert.equal(d.selectedVisible, true); assert.deepEqual(focused.state.time, state.time); assert.deepEqual(focused.state.observer, state.observer);
      for (const inactive of ['ground', 'space', 'globe', 'horizon'].filter(view => view !== mode)) assert.deepEqual(focused.state.cameras[inactive], state.cameras[inactive]);
      assert.deepEqual(focused.details.starMotion, motion.selectedModel);
      assert.equal(motion.selectedModel.model, byId.get(canonicalId).motionModel);
      assert.ok(separation(d.selectedDirectionEqj, expectedDirection(canonicalId, motion.snapshotUtDaysJ2000)) < 1e-7);
      const cacheError = separation(motion.cachedSelectedDirectionEqj, expectedDirection(canonicalId, motion.snapshotUtDaysJ2000));
      assert.ok(cacheError <= motion.combinedDirectionBoundArcsec + 1e-7);
      assert.equal(motion.constellationAnchorUtDaysJ2000, motion.cachedUtDaysJ2000);
      assert.ok(d.labelHitBoxes.some(label => label.id === canonicalId), 'selected label survives ordinary label toggles');
      if (kind === 'webgl') { assert.equal(motion.pointLinePositionShared, true); assert.equal(motion.pointHighlightPositionShared, true); }
      const pixel = await page.evaluate(({ x, y }) => {
        const canvas = document.querySelector('.sky-webgl-canvas,.sky-canvas2d-canvas'), scale = canvas.width / canvas.clientWidth;
        const radius = Math.ceil(6 * scale), size = radius * 2 + 1, left = Math.floor(x * scale) - radius, top = Math.floor(y * scale) - radius;
        const gl = canvas.getContext('webgl2');
        let pixels;
        if (gl) { pixels = new Uint8Array(size * size * 4); gl.readPixels(left, canvas.height - top - size, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels); }
        else pixels = canvas.getContext('2d').getImageData(left, top, size, size).data;
        const inner = [], surrounding = [];
        for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
          const distance = Math.hypot(px - radius, py - radius) / scale, index = (py * size + px) * 4;
          const luma = .2126 * pixels[index] + .7152 * pixels[index + 1] + .0722 * pixels[index + 2];
          if (distance <= 1.8) inner.push(luma); else if (distance >= 3.5 && distance <= 5) surrounding.push(luma);
        }
        surrounding.sort((a, b) => a - b);
        return { coreMaximum: Math.max(...inner), nearbyMedian: surrounding[Math.floor(surrounding.length / 2)], sameContextReadback: true };
      }, motion.cachedSelectedPixel);
      assert.ok(pixel.coreMaximum > pixel.nearbyMedian + 3, `actual star core ${canonicalId}/${kind}/${mode}: ${JSON.stringify(pixel)}`);
      await page.screenshot({ path: `${out}/${kind}-${mode}-${rawId.replace(':', '-')}.png` });
      // Clear only selection, then click the actual cached point, with no label/selection overlay to hit.
      const cleared = structuredClone(focused.state); cleared.selected = null; await apply(cleared);
      await page.mouse.click(motion.cachedSelectedPixel.x, motion.cachedSelectedPixel.y);
      await page.waitForFunction(id => window.skyApp.state.selected === id && window.skyApp.diagnostics.lastRenderedSelection === id, canonicalId);
      samples.push({ kind, mode, rawId, canonicalId, focused, cacheErrorArcsec: cacheError, pixel, nativePickId: canonicalId });
    }
    if (kind === 'webgl') {
      const state = await page.evaluate(() => window.skyApp.state); state.viewMode = 'globe'; state.layers.constellationLines = true;
      state.layers.backHemisphere = true; state.selected = 'constellation:Ori'; await apply(state);
      const before = await read(), resourceIds = [], drawCounts = [];
      for (const figure of figures) {
        const current = await page.evaluate(() => window.skyApp.state); current.selected = `constellation:${figure.id}`; await apply(current);
        const actual = await read(), d = actual.interaction;
        assert.deepEqual(d.highlightedConstellationIds, [figure.id]); assert.equal(d.highlightDrawRangeCount, figure.lineCount * 2);
        assert.equal(d.highlightGeometryId, before.interaction.highlightGeometryId); assert.equal(d.highlightIndexAttributeId, before.interaction.highlightIndexAttributeId);
        assert.equal(d.starMotion.positionAttributeId, before.interaction.starMotion.positionAttributeId); assert.equal(d.highlightPositionAttributeIsShared, true);
        assert.equal(actual.metrics.geometryCount, before.metrics.geometryCount); assert.equal(actual.metrics.textureCount, before.metrics.textureCount);
        assert.ok(actual.metrics.drawCallsPerFrame <= 25);
        resourceIds.push([figure.id, d.highlightGeometryId, d.highlightIndexAttributeId]); drawCounts.push(actual.metrics.drawCallsPerFrame);
      }
      samples.push({ resourceReuse: '88 actual selection renders', before, after: await read(), resourceIds, drawCounts });
    }
    await page.waitForTimeout(500); const idleCount = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.waitForTimeout(180); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), idleCount);
    await context.close(); context = null;
  }
  assert.equal(errors.length, 0);
  await writeFile(`${out}/report.json`, JSON.stringify({ url, browserVersion: browser.version(), samples, errors,
    scope: 'Development functional actual point readback/native mouse picks/selected labels; no GPU timing, physical phone, 30-minute or full astronomical-accuracy result.' }, null, 2));
} finally { if (context) await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
