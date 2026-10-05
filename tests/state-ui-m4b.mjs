import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m4b-ui/development';
const qaUrl = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const stage = process.env.SKY_UI_QA_STAGE ?? 'development';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], assertions = [];
let page;
const current = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => window.skyApp.ready && window.skyApp.snapshot && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const reveal = (page, selector) => page.locator(selector).scrollIntoViewIfNeeded();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(qaUrl); await paired(page);
  assert.equal(await page.locator('#sky-control-panel').isVisible(), false);
  for (const selector of ['.compact-time', '.compact-play', '.compact-reset', '#sky-compact-view', '.compact-search']) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, selector);
  }
  await page.screenshot({ path: `${out}/390-bottom-collapsed.png` });
  await page.locator('.controls-drawer-toggle').click();
  assert.equal(await page.locator('#sky-time-span').inputValue(), 'day');
  const rect = await page.locator('#sky-control-panel').boundingBox();
  assert.ok(rect.y > 844 / 3 && rect.height <= 844 / 2);
  assert.equal(await page.locator('#sky-control-panel').getAttribute('data-sky-dock'), 'bottom');
  assert.equal(await page.locator('.compact-reset').isVisible(), true);
  await page.screenshot({ path: `${out}/390-bottom-time.png` });
  assertions.push('390px phone simulation starts collapsed; the actual bottom drawer leaves visible sky, stays at most half-height, and all five persistent targets are at least 44px.');

  await page.locator('.time-zone-settings').evaluate(el => { el.open = true; });
  const before = await current(page);
  const counters = await page.evaluate(() => ({ requests: window.skyApp.diagnostics.scienceRequestCount, rebases: window.skyApp.diagnostics.clockRebaseCount }));
  const lunar = await page.locator('.lunar-calendar-readout').textContent();
  await page.locator('#sky-zone-offset').fill('+05:45');
  await page.locator('#sky-zone-form button').click(); await paired(page);
  const zoneState = await current(page), expected = structuredClone(before);
  expected.observer.displayZone = { kind: 'fixed', offsetMinutes: 345 };
  assert.deepEqual(zoneState, expected);
  assert.deepEqual(await page.evaluate(() => ({ requests: window.skyApp.diagnostics.scienceRequestCount, rebases: window.skyApp.diagnostics.clockRebaseCount })), counters);
  assert.equal(await page.locator('.lunar-calendar-readout').textContent(), lunar);
  assert.equal(await page.locator('.input-zone-label').textContent(), 'UTC+05:45');
  assert.equal(await page.locator('.compact-clock').textContent(), '19:45');
  await page.screenshot({ path: `${out}/390-zone-0545.png` });
  assertions.push('A non-whole-hour fixed zone edits only displayZone; UTC, complete scientific state, lunar UTC+8 line, request count and clock anchor remain unchanged.');

  await page.locator('.time-zone-settings').evaluate(el => { el.open = false; });
  const slider = page.locator('#sky-day-slider');
  await reveal(page, '#sky-day-slider');
  const label = await page.locator('.time-window-label').textContent();
  await slider.focus(); await slider.press('End'); await paired(page);
  const endpoint = (await current(page)).time.utDaysJ2000;
  assert.match(await page.locator('#sky-time').inputValue(), /^00:00:00$/);
  assert.equal(await page.locator('.time-window-label').textContent(), label);
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.up(); await paired(page);
  const moved = (await current(page)).time.utDaysJ2000;
  assert.ok(moved < endpoint && moved > endpoint - 1, 'Second real pointer drag uses the same displayed day, not next day');
  assert.equal(await page.locator('.time-window-label').textContent(), label);
  assertions.push('The native slider End key reaches next-day midnight; a subsequent real pointer drag remains in the previously displayed window, with no hidden extra 24-hour jump.');

  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  assert.equal(await page.locator('#sky-preset option').count(), 21);
  assert.equal(await page.locator('#sky-preset optgroup').count(), 9);
  await page.locator('#sky-preset').selectOption('G02'); await page.locator('#sky-load-preset').click(); await paired(page);
  const preset = await current(page);
  await page.locator('.scene-library-section').evaluate(el => { el.open = true; });
  const name = '<img src=x onerror="window.badSceneName=1"> 教学';
  await page.locator('#sky-scene-name').fill(name); await page.locator('#sky-save-scene').click();
  assert.equal(await page.locator('#sky-saved-scenes option:checked').textContent(), name);
  assert.equal(await page.locator('.scene-section img').count(), 0);
  assert.equal(await page.evaluate(() => window.badSceneName), undefined);
  await page.locator('.compact-reset').click(); await paired(page); assert.deepEqual(await current(page), preset);
  await page.locator('#sky-preset').selectOption('G03'); await page.locator('#sky-load-preset').click(); await paired(page);
  await page.locator('#sky-load-saved-scene').click(); await paired(page); assert.deepEqual(await current(page), preset);
  await page.locator('#sky-share-scene').click();
  await page.waitForFunction(() => !document.querySelector('.share-result').hidden);
  const shareUrl = new URL(await page.locator('#sky-share-value').inputValue()), appUrl = new URL(qaUrl);
  assert.equal(shareUrl.origin, appUrl.origin); assert.equal(shareUrl.pathname, appUrl.pathname); assert.ok(shareUrl.hash.startsWith('#scene='));
  assert.deepEqual(await current(page), preset);
  await page.screenshot({ path: `${out}/390-local-scene-share.png` });
  assertions.push('All 21 presets in nine topics are available; explicit new local save, load, current-start reset and Web share preserve complete state. User-controlled HTML-like names remain literal text.');

  await page.locator('#sky-teaching').evaluate(el => { el.open = true; });
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => !document.querySelector('#sky-moon-loupe').hidden);
  assert.equal(await page.locator('#sky-control-panel').isVisible(), false);
  const loupe = await page.locator('#sky-moon-loupe').boundingBox(), bar = await page.locator('.controls-compact').boundingBox();
  assert.ok(loupe.y + loupe.height < bar.y, 'Loupe remains above the bottom bar');
  await page.screenshot({ path: `${out}/390-loupe-above-bar.png` });
  await page.locator('#sky-moon-loupe-close').click(); assert.equal(await page.locator('#sky-moon-loupe').isVisible(), false);
  assertions.push('Opening the teaching Moon loupe closes the phone drawer; the loupe and its 44px close button remain above the persistent toolbar.');

  // An additional small responsive matrix; no animation or performance sampling.
  await page.setViewportSize({ width: 360, height: 800 });
  const bar360 = await page.locator('.controls-compact').boundingBox();
  assert.ok(bar360.x >= 0 && bar360.x + bar360.width <= 360);
  for (const selector of ['.compact-time', '.compact-play', '.compact-reset', '#sky-compact-view', '.compact-search']) {
    const rect = await page.locator(selector).boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44, selector);
  }
  await page.screenshot({ path: `${out}/360-bottom-collapsed.png` });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('.controls-drawer-toggle').click();
  const landscapePanel = await page.locator('#sky-control-panel').boundingBox(), header = await page.locator('.panel-header').boundingBox(), scroll = await page.locator('.panel-scroll').boundingBox();
  assert.ok(landscapePanel.height <= 195 && header.height >= 44 && scroll.height >= 44, 'Short landscape leaves a scrollable content row below a 44px header');
  assert.equal(await page.locator('.compact-reset').isVisible(), true);
  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  await reveal(page, '#sky-load-preset');
  assert.equal(await page.locator('#sky-load-preset').isVisible(), true);
  await page.screenshot({ path: `${out}/844x390-bottom-scroll.png` });
  await page.locator('.controls-drawer-toggle').click();
  assert.equal(await page.locator('#sky-control-panel').isVisible(), false);
  assert.deepEqual(await current(page), preset);
  assertions.push('360px toolbar stays within the viewport with 44px targets; coarse-touch 844×390 landscape retains a 44px header plus at least one scrollable content row, with persistent reset and a native close toggle.');

  if (process.env.SKY_UI_QA_EXTENDED === '1') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.controls-drawer-toggle').click();
    await page.locator('.time-zone-settings').evaluate(el => { el.open = true; });
    await page.locator('#sky-zone-kind').selectOption('iana');
    await page.locator('#sky-zone-name').fill('America/New_York');
    await page.locator('#sky-zone-form button').click(); await paired(page);
    await page.locator('.time-zone-settings').evaluate(el => { el.open = false; });
    await page.locator('#sky-date').fill('2026-11-01'); await page.locator('#sky-time').fill('01:30:00');
    const preFold = await current(page);
    await page.locator('#sky-time-form button').click();
    assert.match(await page.locator('.time-controls-status').textContent(), /重复/); assert.deepEqual(await current(page), preFold);
    await page.locator('#sky-time-ambiguity').selectOption('earlier'); await page.locator('#sky-time-form button').click(); await paired(page);
    const early = (await current(page)).time.utDaysJ2000;
    await page.locator('#sky-time-ambiguity').selectOption('later'); await page.locator('#sky-time-form button').click(); await paired(page);
    const late = (await current(page)).time.utDaysJ2000;
    assert.ok(Math.abs((late - early) * 24 - 1) < 1e-8);
    await page.locator('#sky-date').fill('2026-03-08'); await page.locator('#sky-time').fill('02:30:00');
    const preGap = await current(page); await page.locator('#sky-time-form button').click();
    assert.match(await page.locator('.time-controls-status').textContent(), /不存在|缺失/); assert.deepEqual(await current(page), preGap);
    await page.locator('#sky-time').fill('12:00:00'); await page.locator('#sky-time-form button').click(); await paired(page);
    await page.screenshot({ path: `${out}/390-iana-navigation.png` });
    assertions.push('IANA repeated input rejects by default, explicit earlier/later differ by one actual hour, and missing wall time rejects without changing state.');

    await page.locator('.time-zone-settings').evaluate(el => { el.open = true; });
    await page.locator('#sky-zone-kind').selectOption('fixed'); await page.locator('#sky-zone-offset').fill('+08:00');
    await page.locator('#sky-zone-form button').click(); await paired(page);
    await page.locator('.time-zone-settings').evaluate(el => { el.open = false; });
    await page.locator('#sky-date').fill('2026-01-31'); await page.locator('#sky-time').fill('22:00:00'); await page.locator('#sky-time-form button').click(); await paired(page);
    await page.locator('#sky-time-span').selectOption('month'); await page.locator('[data-time-step="1"]').click(); await paired(page);
    assert.equal(await page.locator('#sky-date').inputValue(), '2026-02-28'); assert.equal(await page.locator('#sky-time').inputValue(), '22:00:00');
    await page.locator('#sky-date').fill('2024-01-31'); await page.locator('#sky-time-form button').click(); await paired(page);
    await page.locator('[data-time-step="1"]').click(); await paired(page); assert.equal(await page.locator('#sky-date').inputValue(), '2024-02-29');
    await page.locator('#sky-date').fill('0-01-01'); await page.locator('#sky-time-form button').click(); await paired(page);
    assert.match(await page.locator('.era-readout').textContent(), /公元前 1 年/);
    await page.screenshot({ path: `${out}/390-year-zero-input.png` });
    await page.locator('.compact-reset').click(); await paired(page); assert.deepEqual(await current(page), preset);
    assertions.push('Month step clamps Jan31 to Feb28/29 while preserving wall time; astronomical year zero is accepted under a fixed offset, and one persistent reset restores the loaded full scene.');

    // Local data must survive a page recreation; a new Save never overwrites implicitly.
    await page.reload(); await paired(page); await page.locator('.controls-drawer-toggle').click();
    await page.locator('.scene-section').evaluate(el => { el.open = true; }); await page.locator('.scene-library-section').evaluate(el => { el.open = true; });
    const id = await page.locator('#sky-saved-scenes option').nth(1).getAttribute('value');
    await page.locator('#sky-saved-scenes').selectOption(id); await page.locator('#sky-load-saved-scene').click(); await paired(page);
    assert.deepEqual(await current(page), preset);
    await page.locator('#sky-scene-name').fill('明确改名'); await page.locator('#sky-update-saved-scene').click();
    assert.equal(await page.locator('#sky-saved-scenes option:checked').textContent(), '明确改名');
    assert.equal(await page.locator('#sky-saved-scenes option').count(), 2);
    await page.locator('#sky-remove-saved-scene').click(); assert.equal(await page.locator('#sky-saved-scenes option').count(), 1);
    assertions.push('Named full scenes survive a page reload; overwrite and delete target the explicit selected id and never silently create or clear unrelated records.');
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ stage, url: qaUrl, assertions, errors, browserClosed: true, limitations: ['Desktop Chrome touch simulation, not an actual phone.', 'No FPS, benchmark or 30-minute test.'] }, null, 2));
}
console.log(JSON.stringify({ passed: assertions.length, out, browserClosed: true }));
