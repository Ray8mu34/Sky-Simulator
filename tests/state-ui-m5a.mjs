import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5a-ui/development';
await mkdir(out, { recursive: true });
const browsers = [], checks = [], errors = []; let page;
let actualBuild;
async function verifyBuild(page) {
  const value = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.getAttribute('content') ?? null, entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  if (process.env.SKY_QA_BUILD_ID) assert.equal(value.id, process.env.SKY_QA_BUILD_ID);
  if (process.env.SKY_QA_ENTRY) assert.ok(value.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)), JSON.stringify(value));
  actualBuild ??= value;
}
const current = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const ready = page => page.waitForFunction(() => {
  const t = window.skyApp.teachingData;
  return t?.objectDayStatus === 'ready' && t.objectDay?.key === t.objectDayKey && document.querySelector('#sky-object-day').dataset.objectDayKey === t.objectDayKey;
});
async function choose(page, name, expectedId) { await page.locator('#sky-search').fill(name); await page.locator('#sky-search').press('Enter'); if (expectedId) assert.equal((await current(page)).selected, expectedId, `Actual search result for ${name}`); }
async function readDay(page) { await ready(page); return page.evaluate(() => window.skyApp.teachingData.objectDay); }
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); browsers.push(browser);
  page = await browser.newPage({ viewport: { width: 1152, height: 720 }, hasTouch: true }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page); await paired(page);
  await choose(page, '月球', 'body:Moon'); const moon = await readDay(page), before = await current(page);
  assert.equal(moon.id, 'body:Moon');
  assert.deepEqual(await page.locator('[data-object-event-ut]').evaluateAll(buttons => buttons.map(button => Number(button.dataset.objectEventUt))), moon.crossings.map(c => c.utDaysJ2000));
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-moon-events.png` });
  checks.push('Real Moon selection displays the full same-day core array and its current geometric position separately; no adjacent-day pair is invented.');

  const allowed = moon.crossings.find(c => c.jumpAllowed); assert.ok(allowed);
  await page.locator(`[data-object-event-ut="${allowed.utDaysJ2000}"]`).click(); await paired(page); await ready(page);
  const jumped = await current(page), expected = structuredClone(before);
  expected.time.utDaysJ2000 = allowed.utDaysJ2000; expected.time.running = false; expected.time.mode = 'simulation';
  assert.deepEqual(jumped, expected);
  checks.push('A real allowed event jumps the sole UT and pauses; location, selection, view, rate, layers and all four cameras remain intact.');
  await choose(page, 'HIP 32349', 'hip:32349'); const sirius = await readDay(page);
  assert.equal(sirius.kind, 'star'); assert.ok(sirius.crossings.length > 0);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-star-events.png` });
  await choose(page, '北极星', 'hip:11767'); const polar = await readDay(page);
  assert.equal(polar.state, 'always-above'); assert.equal(await page.locator('[data-object-event-ut]').count(), 0);
  assert.match(await page.locator('.object-day-status').textContent(), /本日周极/);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-star-always-above.png` });
  const polarState = await current(page);
  await page.locator('#sky-city').selectOption('3'); const southern = await readDay(page);
  assert.equal(southern.state, 'always-below'); assert.match(await page.locator('.object-day-status').textContent(), /本日终日不升/);
  assert.equal((await current(page)).time.utDaysJ2000, polarState.time.utDaysJ2000);
  assert.deepEqual((await current(page)).cameras, polarState.cameras);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-star-always-below.png` });
  await page.locator('#sky-city').selectOption('0'); await ready(page);
  await choose(page, '天鹅座'); await page.waitForFunction(() => window.skyApp.teachingData.objectDayStatus === 'unsupported');
  assert.equal(await page.locator('[data-object-event-ut]').count(), 0); assert.match(await page.locator('.object-day-status').textContent(), /星座/);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-constellation-unsupported.png` });
  checks.push('Real Sirius, Polaris above in Hangzhou, Polaris below in Sydney, and constellation unsupported states are distinct; switching object/location clears the prior event array.');

  // Mode changes consume the identical observer-day event data and retain each camera.
  await choose(page, '月球'); const sameDay = await readDay(page), cameras = (await current(page)).cameras;
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await page.locator(`[data-view="${mode}"]`).click(); await paired(page); const day = await readDay(page);
    assert.equal(day.key, sameDay.key); assert.deepEqual(day.crossings, sameDay.crossings); assert.deepEqual((await current(page)).cameras, cameras);
  }
  checks.push('Four real views use the same observer-day key and crossings; switching view preserves all camera states.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#sky-control-panel').isVisible(), false);
  await page.locator('.controls-drawer-toggle').click(); await ready(page);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded();
  for (const button of await page.locator('[data-object-event-ut]').all()) { const box = await button.boundingBox(); assert.ok(box.height >= 44); }
  await page.screenshot({ path: `${out}/390-object-day.png` });
  const beforeClose = await current(page);
  await page.locator('.controls-drawer-toggle').click();
  assert.equal(await page.locator('#sky-object-day').isVisible(), false); assert.deepEqual(await current(page), beforeClose);
  checks.push('The phone object-day block has 44px event targets; closing the actual drawer hides only the presentation and preserves complete state.');
  await browser.close(); browsers.pop();

  const noGl = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] }); browsers.push(noGl);
  page = await noGl.newPage({ viewport: { width: 1152, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page); await paired(page); assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
  await choose(page, '月球'); const overviewDay = await readDay(page);
  assert.equal(overviewDay.key, moon.key); assert.deepEqual(overviewDay.crossings, moon.crossings);
  await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/2d-moon-events.png` });
  checks.push('Genuine no-WebGL Canvas2D still provides the same observer-day Moon key and event array; a missing direction marker does not imply a missing rise/set.');
  assert.deepEqual(errors, []);
} catch (error) { if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); throw error; }
finally {
  await Promise.all(browsers.map(browser => browser.close()));
  await writeFile(`${out}/report.json`, JSON.stringify({ url, stage: process.env.SKY_UI_QA_STAGE ?? 'development', actualBuild, checks, errors, browserClosed: true, limits: ['Astronomical accuracy is validated separately by science/reference tests.', 'Desktop touch simulation, not physical-phone, performance or 30-minute evidence.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
