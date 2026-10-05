import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = process.env.SKY_RENDER_OUT ?? 'qa/m4b-render/final-small-chart', url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }), context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
const errors = [];
try {
  await context.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl2' ? null : original.call(this, kind, ...args); }; });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
  const state = await page.evaluate(() => window.skyApp.state); state.time.running = false; state.selected = 'hip:11767'; state.layers.earthDay = false;
  const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount); await page.evaluate(state => window.skyApp.setState(state), state);
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty, count);
  await page.locator('.controls-compact [aria-controls="sky-control-panel"]').click();
  await page.waitForFunction(() => { const d = window.skyApp.diagnostics; return !d.scienceDirty && !d.activeRequestCount && !d.pendingLatestRequestCount && (!d.solarDay.enabled || !d.solarDay.activeRequestCount && !d.solarDay.pendingLatestRequestCount); });
  await page.waitForTimeout(700); // Let initial teaching/RO deliveries settle before testing pause idle.
  const evidence = await page.evaluate(() => ({ state: window.skyApp.state, interaction: window.skyApp.rendererDiagnostics, renderCount: window.skyApp.diagnostics.renderCount }));
  assert.deepEqual(evidence.state, state); assert.ok(evidence.interaction.chartViewport.radius >= 50 && evidence.interaction.chartViewport.compactHud);
  assert.equal(evidence.interaction.teachingLabelBudget, 3); assert.equal(errors.length, 0);
  await page.screenshot({ path: `${out}/canvas-landscape-open.png` }); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), evidence.renderCount);
  await writeFile(`${out}/report.json`, JSON.stringify({ url, evidence, errors, scope: 'Short dev functional screenshot, no performance or physical phone conclusion.' }, null, 2));
} finally { await context.close(); await browser.close(); }
console.log(`${out}/canvas-landscape-open.png`);
