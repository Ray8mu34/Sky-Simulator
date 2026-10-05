import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m4b-ui/draft';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page; const checks = [], errors = [];
const expectFailure = process.env.SKY_UI_EXPECT_DRAFT_FAILURE === '1';
const paired = () => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
try {
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/'); await paired();
  await page.locator('.controls-drawer-toggle').click();
  await page.locator('#sky-date').fill('2026-10-01');
  await page.locator('#sky-time').fill('20:30:00');
  // Real users spend longer than the status refresh interval editing the next field.
  await page.waitForTimeout(650);
  const heldDate = await page.locator('#sky-date').inputValue();
  await page.screenshot({ path: `${out}/slow-time-before-submit.png` });
  checks.push({ form: 'time', expected: '2026-10-01', observed: heldDate, retained: heldDate === '2026-10-01' });
  await page.locator('#sky-time-form button').click(); await paired();
  const appliedDate = await page.locator('#sky-date').inputValue();
  checks.push({ form: 'time-applied', expected: '2026-10-01', observed: appliedDate, retained: appliedDate === '2026-10-01' });
  await page.locator('.custom-observer').evaluate(el => { el.open = true; });
  await page.locator('#sky-latitude').fill('25.5');
  await page.locator('#sky-longitude').fill('135.5');
  await page.waitForTimeout(650);
  const heldLatitude = await page.locator('#sky-latitude').inputValue();
  await page.locator('#sky-height').fill('123'); await page.waitForTimeout(650);
  const heldLongitude = await page.locator('#sky-longitude').inputValue();
  await page.screenshot({ path: `${out}/slow-observer-before-submit.png` });
  checks.push({ form: 'observer', expected: ['25.5', '135.5'], observed: [heldLatitude, heldLongitude], retained: heldLatitude === '25.5' && heldLongitude === '135.5' });
  await page.locator('#sky-observer-form button').click(); await paired();
  const observer = await page.evaluate(() => window.skyApp.state.observer);
  checks.push({ form: 'observer-applied', expected: [25.5, 135.5, 123], observed: [observer.latitudeDeg, observer.longitudeDegEast, observer.heightMeters], retained: observer.latitudeDeg === 25.5 && observer.longitudeDegEast === 135.5 && observer.heightMeters === 123 });
  if (!expectFailure) {
    const loaded = await page.evaluate(() => window.skyApp.state);
    await page.locator('#sky-date').fill('2020-01-02');
    await page.locator('[data-action="realtime"]').click();
    await page.evaluate(() => window.skyApp.pause()); await paired();
    assert.notEqual(await page.locator('#sky-date').inputValue(), '2020-01-02');
    await page.locator('#sky-date').fill('2020-01-02');
    await page.locator('.compact-play').click();
    await page.evaluate(() => window.skyApp.pause()); await paired();
    assert.notEqual(await page.locator('#sky-date').inputValue(), '2020-01-02');
    checks.push({ form: 'explicit-realtime', retained: true, detail: 'Realtime and a realtime resume discard old time drafts.' });
    await page.locator('#sky-date').fill('2020-01-02');
    await page.evaluate(state => window.skyApp.setState(state), loaded); await paired();
    assert.equal(await page.locator('#sky-date').inputValue(), '2026-10-01');
    checks.push({ form: 'focused-api-import', retained: true, detail: 'An external complete load refreshes even a focused date field.' });
    await page.locator('#sky-date').fill('2020-01-02');
    await page.locator('#sky-teaching').evaluate(el => { el.open = true; });
    await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
    await page.locator('.solar-day-events [data-event-ut]').first().click(); await paired();
    assert.notEqual(await page.locator('#sky-date').inputValue(), '2020-01-02');
    checks.push({ form: 'explicit-event-jump', retained: true, detail: 'A solar-event jump replaces a pending time draft and pauses.' });
  }
  if (expectFailure) assert.ok(checks.some(check => !check.retained), 'The original draft failure must actually reproduce');
  else assert.ok(checks.every(check => check.retained), JSON.stringify(checks));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ url: process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/', stage: process.env.SKY_UI_QA_STAGE ?? 'development', expectFailure, checks, errors, browserClosed: true }, null, 2));
}
console.log(JSON.stringify({ expectFailure, checks, out, browserClosed: true }));
