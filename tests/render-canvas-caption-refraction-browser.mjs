import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_CANVAS_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_CANVAS_OUT ?? 'qa/m5c-canvas/caption-development';
await mkdir(out, { recursive: true });
const files = ['src/render/CanvasSkyRenderer.ts', 'src/render/CanvasSkyProjection.ts', 'src/render/CanvasOverviewLayout.ts', 'src/render/Occlusion.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const report = { url, sourceHashesBefore: await hashes(), samples: [], errors: [],
  scope: 'One 1024px desktop real-app Canvas2D DOM-caption regression. The actual offline notice is manually shown at its existing 340px maximum width; this is not an SW-update or performance test.' };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 720 }, deviceScaleFactor: 1.5 });
try {
  await context.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (name, ...args) { return name === 'webgl2' ? null : original.call(this, name, ...args); }; });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
  const state = await page.evaluate(() => window.skyApp.state);
  state.environment.refraction = 'standard'; state.environment.pressureHpa = 1010; state.environment.temperatureC = 10;
  state.viewMode = 'space'; state.time.running = false; state.selected = null;
  const count = await page.evaluate(state => { const count = window.skyApp.diagnostics.renderCount; window.skyApp.setState(state); return count; }, state);
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty, count);
  const sample = async name => {
    await page.waitForTimeout(200);
    const value = await page.evaluate(() => {
      const app = window.skyApp, stage = document.querySelector('#sky-stage').getBoundingClientRect(), notice = document.querySelector('#sky-offline-notice'), r = notice.getBoundingClientRect();
      return { state: app.state, diagnostics: app.rendererDiagnostics, count: app.diagnostics.renderCount,
        notice: notice.hidden ? null : { left: r.left - stage.left, right: r.right - stage.left, top: r.top - stage.top, bottom: r.bottom - stage.top } };
    });
    assert.deepEqual(value.state, state); assert.equal(value.diagnostics.fixedHudCaptions.header.status, 'complete');
    const header = value.diagnostics.fixedHudCaptions.header.box;
    if (value.notice) assert.ok(header.right <= value.notice.left - 8 || header.left >= value.notice.right + 8 || header.bottom <= value.notice.top - 8 || header.top >= value.notice.bottom + 8);
    await page.waitForTimeout(220); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), value.count, 'paused caption layout returns to idle');
    await page.screenshot({ path: `${out}/${name}.png` }); report.samples.push({ name, ...value }); return value;
  };
  const before = await sample('standard-notice-closed-before');
  const openedCount = await page.evaluate(() => {
    const count = window.skyApp.diagnostics.renderCount, notice = document.querySelector('#sky-offline-notice');
    notice.style.width = '340px'; notice.textContent = 'Canvas 折射回归：实际离线告示压到标题，标题应保持两行并避让。'; notice.hidden = false;
    window.dispatchEvent(new CustomEvent('sky:layout-change')); return count;
  });
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, openedCount);
  const opened = await sample('standard-notice-open-reflow');
  assert.notDeepEqual(opened.diagnostics.fixedHudCaptions.header.box, before.diagnostics.fixedHudCaptions.header.box);
  assert.deepEqual(opened.diagnostics.chartViewport, before.diagnostics.chartViewport, 'caption reflow does not squeeze or move the map');
  const closedCount = await page.evaluate(() => { const count = window.skyApp.diagnostics.renderCount, notice = document.querySelector('#sky-offline-notice'); notice.hidden = true; notice.style.removeProperty('width'); window.dispatchEvent(new CustomEvent('sky:layout-change')); return count; });
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, closedCount);
  const restored = await sample('standard-notice-closed-restored');
  assert.deepEqual(restored.diagnostics.fixedHudCaptions.header.box, before.diagnostics.fixedHudCaptions.header.box);
  assert.equal(report.errors.length, 0); report.browserVersion = browser.version();
} catch (error) { report.failure = error.stack ?? error.message; throw error; }
finally { report.sourceHashesAfter = await hashes(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
