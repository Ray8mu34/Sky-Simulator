import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const channel = process.env.SKY_QA_CHANNEL ?? 'chrome';
const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:4173/';
const out = `_local-archive/device-context-20261028/${channel}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel, headless: process.env.SKY_QA_HEADED !== '1' });
const report = { checks: [], errors: [], channel, url };
const paired = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty);
const state = page => page.evaluate(() => window.skyApp.state);
const observe = page => page.on('pageerror', e => report.errors.push(e.message));
const open = async (page, selector) => { if (!await page.locator(selector).evaluate(e => e.open)) await page.locator(`${selector} > summary`).click(); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Tokyo', locale: 'zh-CN',
    geolocation: { latitude: 35.6812, longitude: 139.7671, accuracy: 25 }, permissions: ['geolocation'] });
  const page = await context.newPage(); observe(page); await page.goto(url); await paired(page);
  await page.waitForFunction(() => window.skyApp.state.observer.name === '设备当前位置'); await paired(page);
  const first = await state(page);
  assert.equal(first.observer.latitudeDeg, 35.6812); assert.equal(first.observer.displayZone.name, 'Asia/Tokyo');
  assert.equal(first.time.running, false); assert.equal(first.time.rateSimSecondsPerRealSecond, 1);
  assert.ok(Math.abs(first.time.utDaysJ2000 * 86400000 + 946728000000 - Date.now()) < 8000);
  assert.equal(first.observer.heightMeters, 0); await expect(page.locator('#sky-device-location-status')).toContainText('海拔未返回');
  await expect(page.locator('#sky-date')).toHaveAttribute('type', 'date'); await expect(page.locator('#sky-time')).toHaveAttribute('type', 'time');
  report.checks.push('Fresh entry reads device clock, Asia/Tokyo timezone and browser-granted mock location; unavailable altitude explicitly uses 0m.');

  const date = page.locator('#sky-date'), time = page.locator('#sky-time');
  await date.scrollIntoViewIfNeeded(); await date.fill('2028-02-28'); await time.fill('23:59:10');
  assert.equal((await state(page)).time.utDaysJ2000, first.time.utDaysJ2000, 'Picker values remain a draft until Apply.');
  // Click the actual native calendar indicator, then select the next day with the popup keyboard.
  const box = await date.boundingBox(); await date.click({ position: { x: box.width - 12, y: box.height / 2 } });
  await page.screenshot({ path: `${out}/calendar-open.png` });
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await expect(date).toHaveValue('2028-02-29');
  await time.scrollIntoViewIfNeeded(); const tbox = await time.boundingBox();
  await time.click({ position: { x: tbox.width - 12, y: tbox.height / 2 } });
  await page.screenshot({ path: `${out}/time-picker-open.png` }); await page.keyboard.press('Escape');
  await expect(time).toHaveValue('23:59:10');
  await page.locator('.apply-time').click(); await paired(page);
  const selected = await state(page);
  assert.equal(new Date(selected.time.utDaysJ2000 * 86400000 + 946728000000).toISOString(), '2028-02-29T14:59:10.000Z');
  assert.equal(selected.time.running, false);
  await date.fill(''); await page.locator('.apply-time').click(); await expect(date).toHaveAttribute('aria-invalid', 'true');
  assert.equal((await state(page)).time.utDaysJ2000, selected.time.utDaysJ2000);
  await date.fill('2028-02-29'); await page.locator('.apply-time').click();
  report.checks.push('Native calendar opens and keyboard selects leap day; time popup opens/Escape dismisses; only Apply changes UTC, empty input retains state with an error.');

  await open(page, '.time-zone-settings'); await page.locator('#sky-zone-kind').selectOption('fixed');
  await page.locator('#sky-zone-offset').fill('+08:00'); await page.locator('#sky-zone-form button').click();
  await page.locator('#sky-astronomical-date').check(); await date.fill('0-01-01'); await time.fill('00:00:00');
  await page.locator('.apply-time').click(); await paired(page); await expect(page.locator('.era-readout')).toContainText('公元前 1 年');
  await page.locator('#sky-astronomical-date').click(); await expect(page.locator('#sky-astronomical-date')).toBeChecked();
  await expect(date).toHaveValue('0000-01-01');
  await page.locator('#sky-use-device').click(); await page.waitForFunction(() => document.querySelector('#sky-device-location-status').textContent.includes('定位精度'));
  await paired(page); await page.locator('#sky-astronomical-date').uncheck(); await expect(date).toHaveAttribute('type', 'date');
  await page.locator('[data-action="realtime"]').click(); assert.equal((await state(page)).observer.displayZone.name, 'Asia/Tokyo');
  await page.evaluate(() => window.skyApp.pause()); await paired(page);
  report.checks.push('Astronomical year zero remains available; native calendar cannot silently erase BCE input; device reset/realtime restore device zone.');

  // A saved/shared scene is authoritative and must not initiate a location request.
  const saved = await state(page); saved.time.utDaysJ2000 = 9753; saved.observer.name = '分享地点';
  const shared = await browser.newContext({ timezoneId: 'America/New_York' });
  await shared.addInitScript(() => { window.locationCalls = 0; navigator.geolocation.getCurrentPosition = () => { window.locationCalls++; }; });
  const linked = await shared.newPage(); observe(linked); await linked.goto(url + '#scene=' + encodeURIComponent(JSON.stringify(saved))); await paired(linked);
  assert.equal(await linked.evaluate(() => window.locationCalls), 0); assert.deepEqual(await state(linked), saved);
  await shared.close(); report.checks.push('Share-link state and timezone are preserved; no automatic geolocation request.');

  const delayed = await browser.newContext({ timezoneId: 'America/New_York' });
  await delayed.addInitScript(() => {
    window.pendingLocations = []; navigator.geolocation.getCurrentPosition = (ok, fail) => window.pendingLocations.push({ ok, fail });
  });
  const late = await delayed.newPage(); observe(late); await late.goto(url); await paired(late);
  await expect(late.locator('#sky-use-device')).toBeDisabled();
  await late.locator('#sky-city').selectOption('1'); const manual = await state(late);
  await late.evaluate(() => window.pendingLocations[0].ok({ coords: { latitude: -33.86, longitude: 151.2, altitude: 8, accuracy: 10 } }));
  assert.deepEqual(await state(late), manual);
  await late.locator('#sky-use-device').click();
  await late.evaluate(() => window.pendingLocations.at(-1).fail({ code: 1 }));
  await expect(late.locator('#sky-device-location-status')).toContainText('未获定位权限'); await expect(late.locator('#sky-use-device')).toBeEnabled();
  await late.locator('#sky-use-device').click(); await late.locator('#sky-date').fill('2027-04-10');
  await late.evaluate(() => window.pendingLocations.at(-1).ok({ coords: { latitude: -33.86, longitude: 151.2, altitude: 8, accuracy: 10 } }));
  await expect(late.locator('#sky-date')).toHaveValue('2027-04-10'); assert.equal((await state(late)).observer.latitudeDeg, manual.observer.latitudeDeg);
  await delayed.close(); report.checks.push('Manual location and unsubmitted date drafts cancel late responses; denied permission remains retryable.');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    if (!await page.locator('#sky-control-panel').isVisible()) await page.locator('[data-action="open-time"]').click();
    await date.scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.panel-scroll').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: `${out}/mobile-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#sky-density').selectOption('reference');
  await date.scrollIntoViewIfNeeded(); assert.ok(await page.locator('.panel-scroll').evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${out}/reference.png` });
  report.checks.push('320/390px and reference density retain usable date/time fields without panel horizontal overflow.');
  assert.deepEqual(report.errors, []);
} finally { await browser.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
