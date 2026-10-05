import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadAcceptanceScene } from '../src/state.ts';

const url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_RENDER_OUT ?? 'qa/m4b-render';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { url, browserVersion: browser.version(), earth: [], layout: [], errors: [] };
const ready = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const apply = async (page, state) => {
  const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.evaluate(state => window.skyApp.setState(state), state);
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, count);
  await ready(page); await page.waitForTimeout(120);
};
try {
  const context = await browser.newContext({ viewport: { width: 1152, height: 720 } });
  try {
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /shader|GL_INVALID/.test(message.text())) report.errors.push(message.text()); });
    await page.goto(url); await ready(page);
    await page.waitForFunction(() => !window.skyApp.diagnostics.assetStatus.pending.length && !window.skyApp.diagnostics.assetStatus.errors.length);
    const baseline = loadAcceptanceScene('V02'); baseline.time.running = false; baseline.selected = null;
    baseline.layers.atmosphere = false; baseline.layers.earthClouds = false; baseline.layers.earthNightLights = false;
    for (const [name, day, clouds, night] of [['day-on', true, false, false], ['day-off', false, false, false], ['cloud-only', false, true, false], ['night-only', false, false, true]]) {
      const state = structuredClone(baseline); state.layers.earthDay = day; state.layers.earthClouds = clouds; state.layers.earthNightLights = night;
      await apply(page, state);
      const evidence = await page.evaluate(name => {
        const canvas = document.querySelector('.sky-webgl-canvas'), read = document.createElement('canvas'); read.width = canvas.width; read.height = canvas.height;
        const ctx = read.getContext('2d'); ctx.drawImage(canvas, 0, 0); const image = ctx.getImageData(0, 0, read.width, read.height);
        window.__earthDayImages ??= {}; window.__earthDayImages[name] = image;
        return { state: window.skyApp.state, interaction: window.skyApp.rendererDiagnostics, metrics: window.skyApp.metrics, assets: window.skyApp.diagnostics.assetStatus };
      }, name);
      assert.equal(evidence.interaction.earthLayers.dayEnabled, day);
      assert.equal(evidence.interaction.earthLayers.cloudEnabled, clouds);
      assert.equal(evidence.interaction.earthLayers.nightEnabled, night);
      assert.ok(evidence.interaction.earthLayers.meshVisible && evidence.interaction.earthLayers.opaque && evidence.interaction.earthLayers.depthWrite && evidence.interaction.earthLayers.dayTextureReady);
      assert.deepEqual(evidence.state, state);
      report.earth.push({ name, ...evidence }); await page.screenshot({ path: `${out}/${name}.png` });
    }
    report.earthPixels = await page.evaluate(() => {
      const images = window.__earthDayImages, state = window.skyApp.state, image = images['day-off'], w = image.width, h = image.height;
      const radius = h / (2 * Math.tan(state.cameras.space.verticalFovDeg * Math.PI / 360)) / Math.sqrt(state.cameras.space.distanceDisplayUnits ** 2 - 1);
      const compare = (name, a, b) => {
        let count = 0, changed = 0, squared = 0, maximum = 0, offSum = 0, onSum = 0;
        for (let y = Math.ceil(h / 2 - radius * .96); y < h / 2 + radius * .96; y++) for (let x = Math.ceil(w / 2 - radius * .96); x < w / 2 + radius * .96; x++) {
          if (Math.hypot(x - w / 2, y - h / 2) > radius * .96) continue;
          let delta = 0; const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; squared += d * d; maximum = Math.max(maximum, Math.abs(d)); delta += Math.abs(d); offSum += b.data[i + c]; onSum += a.data[i + c]; }
          count++; if (delta > 3) changed++;
        }
        return { name, count, changed, rms: Math.sqrt(squared / (count * 3)), maximum, meanBefore: offSum / (count * 3), meanAfter: onSum / (count * 3) };
      };
      return [compare('day texture', images['day-on'], image), compare('cloud independent', images['cloud-only'], image), compare('night independent', images['night-only'], image)];
    });
    assert.ok(report.earthPixels.every(pixel => pixel.changed > 10 && pixel.rms > .1), 'each independent layer changes actual Earth pixels');
    assert.ok(report.earthPixels.find(pixel => pixel.name === 'day texture').meanBefore > 2, 'day disabled retains a lit solid sphere');
    for (const name of ['geometryId', 'materialId', 'dayTextureId']) assert.equal(new Set(report.earth.map(sample => sample.interaction.earthLayers[name])).size, 1);
    assert.equal(new Set(report.earth.map(sample => sample.metrics.textureCount)).size, 1);
  } finally { await context.close(); }

  if (process.env.SKY_RENDER_EARTH_ONLY !== '1') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl2' ? null : original.call(this, kind, ...args); };
    });
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url); await ready(page); assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
    const state = await page.evaluate(() => window.skyApp.state); state.time.running = false; state.layers.earthDay = false; state.selected = 'hip:11767'; await apply(page, state);
    const sample = async name => {
      const value = await page.evaluate(() => {
        const app = window.skyApp, panel = document.querySelector('#sky-control-panel'), stage = document.querySelector('#sky-stage').getBoundingClientRect(), r = panel.getBoundingClientRect();
        const visible = !!panel.getClientRects().length;
        const count = app.diagnostics.renderCount, layer = document.querySelector('[data-layer="earthDay"]');
        return { state: app.state, diagnostics: app.rendererDiagnostics, count, panel: visible ? { left: r.left - stage.left, top: r.top - stage.top, right: r.right - stage.left, bottom: r.bottom - stage.top } : null,
          disabledDay: layer.disabled, savedDay: app.state.layers.earthDay };
      });
      assert.ok(value.disabledDay && value.savedDay === false);
      assert.deepEqual(value.state, state, 'drawer/resize never changes scientific state or cameras');
      if (value.panel) {
        const v = value.diagnostics.chartViewport;
        assert.ok(v.radius >= 50, 'a technically unoccluded 8px chart is not usable');
        const disk = { left: v.centerX - v.radius, top: v.centerY - v.radius, right: v.centerX + v.radius, bottom: v.centerY + v.radius };
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        assert.ok(!overlaps(disk, value.panel), 'actual sky disk remains in a free rectangle');
        if (v.compactHud) assert.ok(!overlaps(v.layoutRegion, value.panel), 'short explanations move into the same free pocket');
      }
      await page.waitForTimeout(250); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), value.count, 'paused layout settles and stops rendering');
      report.layout.push({ name, ...value }); await page.screenshot({ path: `${out}/${name}.png` });
    };
    await sample('canvas-portrait-closed');
    await page.locator('.controls-compact [aria-controls="sky-control-panel"]').click(); await page.waitForTimeout(180); await ready(page); await sample('canvas-portrait-open');
    // A stylesheet changes the painted box, with no controls attribute or UI
    // event to notify the app. This specifically exercises the late-bound RO.
    const beforeResize = await page.evaluate(() => ({ height: document.querySelector('#sky-control-panel').getBoundingClientRect().height, count: window.skyApp.diagnostics.renderCount }));
    await page.evaluate(height => {
      const style = document.createElement('style'); style.id = 'render-qa-panel-size'; style.textContent = `#sky-control-panel{max-height:${height}px!important;height:${height}px!important}`; document.head.append(style);
    }, Math.round(beforeResize.height * .7));
    await page.waitForFunction(before => window.skyApp.diagnostics.renderCount > before.count && document.querySelector('#sky-control-panel').getBoundingClientRect().height < before.height - 10, beforeResize);
    await page.waitForTimeout(120); await sample('canvas-portrait-panel-resized');
    const resizedCount = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.locator('#render-qa-panel-size').evaluate(element => element.remove());
    await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, resizedCount); await page.waitForTimeout(120); await sample('canvas-portrait-panel-restored');
    report.layoutTranslation = await page.evaluate(async () => {
      const event = () => window.dispatchEvent(new CustomEvent('sky:layout-change'));
      const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
      event(); await frames();
      const before = window.skyApp.rendererDiagnostics, start = performance.now();
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.controls-compact')).transform); matrix.translateSelf(0, -12);
      const style = document.createElement('style'); style.id = 'render-qa-translation'; style.textContent = `.controls-compact{transform:${matrix.toString()}!important}`; document.head.append(style); event(); await frames();
      const after = window.skyApp.rendererDiagnostics, stage = document.querySelector('#sky-stage').getBoundingClientRect(), r = document.querySelector('.controls-compact').getBoundingClientRect();
      const expected = { x: r.left - stage.left - 4, y: r.top - stage.top - 4, w: r.width + 8, h: r.height + 8 };
      const elapsedMs = performance.now() - start;
      style.remove(); event(); await frames();
      return { beforeLayoutCount: before.labelCache.layoutCount, afterLayoutCount: after.labelCache.layoutCount, expected, actual: after.labelOcclusionRects, elapsedMs };
    });
    assert.ok(report.layoutTranslation.elapsedMs < 100, 'probe must exercise the sub-100ms layout throttle boundary');
    assert.ok(report.layoutTranslation.afterLayoutCount > report.layoutTranslation.beforeLayoutCount);
    assert.ok(report.layoutTranslation.actual.some(rect => ['x', 'y', 'w', 'h'].every(key => Math.abs(rect[key] - report.layoutTranslation.expected[key]) < .1)), 'one paused redraw has the translated occluder');
    await page.waitForTimeout(120); await sample('canvas-portrait-translation-restored');
    await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(200); await ready(page); await sample('canvas-landscape-open');
    await page.locator('#sky-control-panel [data-action="close"]').click(); await page.waitForTimeout(180); await sample('canvas-landscape-closed');
  } finally { await context.close(); }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
} catch (error) { report.failure = error.message; throw error; }
finally { await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify({ pixels: report.earthPixels, layout: report.layout.map(sample => ({ name: sample.name, viewport: sample.diagnostics.chartViewport, panel: sample.panel })), errors: report.errors }, null, 2));
