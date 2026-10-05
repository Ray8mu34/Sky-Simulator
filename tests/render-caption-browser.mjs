import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = process.env.SKY_RENDER_OUT ?? 'qa/m5a-render/canvas-caption-development';
const url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, hasTouch: true });
const errors = [], samples = [];
try {
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl2' ? null : original.call(this, kind, ...args); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
  const state = await page.evaluate(() => window.skyApp.state);
  state.time.running = false; state.selected = 'hip:11767';
  await page.evaluate(state => window.skyApp.setState(state), state);
  await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty && window.skyApp.rendererDiagnostics?.canonicalSelectedId === 'hip:11767');

  const read = () => page.evaluate(() => {
    const app = window.skyApp, interaction = app.rendererDiagnostics;
    const notice = document.querySelector('#sky-offline-notice'), stage = document.querySelector('#sky-stage').getBoundingClientRect();
    const rect = notice.hidden ? null : notice.getBoundingClientRect();
    return { state: app.state, interaction, renderCount: app.diagnostics.renderCount, scienceRequests: app.diagnostics.scienceRequestCount,
      notice: rect ? { left: rect.left - stage.left, top: rect.top - stage.top, right: rect.right - stage.left, bottom: rect.bottom - stage.top } : null };
  });
  const settled = async () => {
    await page.waitForTimeout(500);
    const a = await read(); await page.waitForTimeout(180); const b = await read();
    assert.equal(b.renderCount, a.renderCount, 'paused layout returns to idle');
    return b;
  };
  const notice = async hidden => {
    const before = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.evaluate(hidden => {
      const element = document.querySelector('#sky-offline-notice');
      element.textContent = '离线更新提示：新版本已下载，暂停查看后可在方便时安装。';
      element.hidden = hidden; window.dispatchEvent(new CustomEvent('sky:layout-change'));
    }, hidden);
    await page.waitForFunction(before => window.skyApp.diagnostics.renderCount > before, before);
    return settled();
  };
  for (const [name, width, height, drawer] of [['desktop', 1152, 720, false], ['desktop-narrow', 1024, 720, false], ['landscape-pocket', 844, 390, true]]) {
    await page.setViewportSize({ width, height });
    if (drawer) await page.locator('.controls-compact [aria-controls="sky-control-panel"]').click();
    const off = await notice(true);
    await page.screenshot({ path: `${out}/${name}-notice-off.png` });
    const on = await notice(false);
    assert.deepEqual(on.state, off.state); assert.deepEqual(on.interaction.chartViewport, off.interaction.chartViewport, 'notice moves text, not the chart');
    assert.deepEqual(on.interaction.selectedDirectionEqj, off.interaction.selectedDirectionEqj);
    assert.deepEqual(on.interaction.selectedProjectedNdc, off.interaction.selectedProjectedNdc);
    assert.equal(on.scienceRequests, off.scienceRequests, 'notice needs no new science task');
    for (const caption of Object.values(on.interaction.fixedHudCaptions)) if (caption.box) {
      const { box } = caption, n = on.notice;
      assert.ok(box.left >= 8 && box.top >= 8 && box.right <= width - 8 && box.bottom <= height - 8);
      assert.ok(box.right <= n.left - 7.99 || box.left >= n.right + 7.99 || box.bottom <= n.top - 7.99 || box.top >= n.bottom + 7.99,
        'actual caption is at least eight pixels from the visible update notice');
    }
    assert.equal(on.interaction.fixedHudCaptions.header.status, 'complete');
    if (drawer) { assert.ok(on.interaction.chartViewport.compactHud); assert.equal(on.interaction.teachingLabelBudget, 3); }
    await page.screenshot({ path: `${out}/${name}-notice-on.png` });
    const restored = await notice(true);
    assert.deepEqual(restored.state, off.state);
    assert.deepEqual(restored.interaction.fixedHudCaptions, off.interaction.fixedHudCaptions, 'notice close restores full caption layout');
    samples.push({ name, width, height, off, on, restored });
  }
  assert.equal(errors.length, 0);
  await writeFile(`${out}/report.json`, JSON.stringify({ url, samples, errors,
    scope: 'Development Chrome functional Canvas2D screenshots; actual DOM notice controlled directly, not a service-worker update or physical phone test. No performance measurement.',
    passed: true }, null, 2));
} finally { await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
