import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m3-ui/final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1152, height: 720 }, acceptDownloads: true });
const assertions = [], errors = [], startedAt = new Date().toISOString();
page.on('pageerror', error => errors.push(error.message));
await writeFile(`${out}/report.json`, JSON.stringify({ status: 'running', startedAt }, null, 2));
const state = () => page.evaluate(() => window.skyApp.state);
const paired = () => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const dayReady = () => page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
const shot = name => page.screenshot({ path: `${out}/${name}.png` });
const scene = async id => {
  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  await page.locator(`[data-scene="${id}"]`).click(); await paired(); await dayReady();
  await page.locator('#sky-teaching').scrollIntoViewIfNeeded();
};
try {
  await page.goto(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/'); await paired();
  assert.equal(await page.locator('#sky-teaching').evaluate(el => el.open), false);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.solarDay.startedCount), 0);
  assert.match(await page.locator('.lunar-calendar-readout').textContent(), /农历（UTC\+8）/);
  await page.locator('#sky-teaching').evaluate(el => { el.open = true; }); await dayReady();
  assert.equal(await page.locator('.twilight-row').count(), 3);
  await shot('teaching-day-and-calendar');
  assertions.push('Teaching is collapsed by default; solar searches start only when opened; calendar clearly uses UTC+8.');

  const beforeZone = await page.evaluate(() => ({ state: window.skyApp.state, body: window.skyApp.snapshot.bodies, lunar: window.skyApp.teachingData.lunarCalendar, day: window.skyApp.teachingData.solarDay }));
  await page.evaluate(() => { const next = window.skyApp.state; next.observer.displayZone = { kind: 'fixed', offsetMinutes: 840 }; window.skyApp.setState(next); }); await paired(); await dayReady();
  const afterZone = await page.evaluate(() => ({ state: window.skyApp.state, body: window.skyApp.snapshot.bodies, lunar: window.skyApp.teachingData.lunarCalendar, day: window.skyApp.teachingData.solarDay }));
  assert.equal(afterZone.state.time.utDaysJ2000, beforeZone.state.time.utDaysJ2000);
  assert.deepEqual(afterZone.body, beforeZone.body);
  assert.deepEqual(afterZone.lunar, beforeZone.lunar);
  assert.notEqual(afterZone.day.dateLocal, beforeZone.day.dateLocal);
  assert.match(await page.locator('.solar-day-heading').textContent(), /UTC\+14:00/);
  const rise = page.locator('.solar-day-events [data-event-ut]').first();
  const expectedUt = Number(await rise.getAttribute('data-event-ut'));
  await rise.click(); await paired();
  const afterJump = await state();
  assert.equal(afterJump.time.utDaysJ2000, expectedUt); assert.equal(afterJump.time.running, false);
  assert.deepEqual(afterJump.cameras, afterZone.state.cameras); assert.deepEqual(afterJump.observer, afterZone.state.observer);
  assert.match(await page.locator('.section-heading').filter({ hasText: '时间' }).textContent(), /固定 UTC\+8/);
  assertions.push('Changing only displayZone moves the event civil-day boundary while UTC, sky and UTC+8 lunar date stay unchanged; event jump pauses and preserves cameras.');

  for (const [id, expected] of [['S05', 'continuous-daylight'], ['S06', 'no-sunrise'], ['S07', 'continuous-daylight']]) {
    await scene(id);
    assert.equal(await page.evaluate(() => window.skyApp.teachingData.solarDay.state), expected);
    assert.equal(await page.locator('.solar-day-events [data-event-ut]').count(), 0);
    assert.match(await page.locator('.solar-day-range').textContent(), /全天太阳几何高度/);
    if (id === 'S06') {
      assert.match(await page.locator('.solar-no-event').textContent(), /晨昏|不代表全天漆黑/);
      assert.ok(await page.locator('.twilight-row [data-event-ut]').count() > 0);
    }
    await shot(`${id.toLowerCase()}-solar-events`);
  }
  assertions.push('North/south polar teaching scenes show continuous daylight or no sunrise, an all-day solar range, and winter twilight rather than empty events.');

  await scene('S09');
  await page.locator('#sky-quarter-search').click();
  await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  assert.equal(await page.locator('.moon-quarter-events [data-event-ut]').count(), 4);
  const sequence = await page.evaluate(() => window.skyApp.teachingData.moonPhases);
  assert.equal(new Date(946728000000 + sequence.seedUtDaysJ2000 * 86400000).toISOString(), '2026-09-01T00:00:00.000Z');
  for (const button of await page.locator('.moon-quarter-events button').all()) assert.match(await button.textContent(), /2026-\d{2}-\d{2} \d{2}:\d{2}/);
  const downloading = page.waitForEvent('download'); await page.locator('#sky-quarter-export').click();
  const download = await downloading; const path = `${out}/derived-moon-phases.json`; await download.saveAs(path);
  const exported = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(exported.events.length, 4); assert.ok(exported.events.every(event => event.utc.endsWith('Z')));
  assertions.push('S09 uses the original explicit seed, displays complete event dates, and saves all derived UTC times with definitions.');

  await page.locator('#sky-search').fill('北极星'); await page.locator('#sky-search').press('Enter');
  const beforeLoupe = await state(); const canvasCount = await page.locator('#sky-stage canvas').count();
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics.open && window.skyApp.moonLoupeDiagnostics.status === 'ready');
  assert.deepEqual(await state(), beforeLoupe);
  assert.equal(await page.locator('#sky-stage canvas').count(), canvasCount);
  assert.match(await page.locator('.moon-loupe-horizon').textContent(), /当前月球在几何地平下/);
  assert.match(await page.locator('.moon-loupe-scale').textContent(), /视场中心角比例/);
  const rect = await page.locator('#sky-moon-loupe-viewport').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + 12, rect.y + 12); await page.mouse.up(); await page.mouse.wheel(0, 120);
  assert.deepEqual((await state()).cameras, beforeLoupe.cameras);
  await shot('moon-loupe-below-horizon');
  await page.locator('#sky-moon-loupe-close').click();
  assert.deepEqual(await state(), beforeLoupe);
  assertions.push('Moon loupe opens/closes without touching science state, shows below-horizon status, reuses canvas count, and intercepts camera gestures.');

  const stable = await state();
  for (let index = 0; index < sequence.events.length; index++) {
    const event = sequence.events[index];
    await page.locator(`.moon-quarter-events [data-event-ut="${event.utDaysJ2000}"]`).click(); await paired();
    const current = await state(); assert.equal(current.time.utDaysJ2000, event.utDaysJ2000); assert.equal(current.time.running, false);
    assert.deepEqual(current.cameras, stable.cameras); assert.deepEqual(current.observer, stable.observer); assert.equal(current.selected, stable.selected);
    await page.locator('#sky-moon-loupe-toggle').click();
    await page.waitForFunction(ut => window.skyApp.moonLoupeDiagnostics.open && window.skyApp.moonLoupeDiagnostics.utDaysJ2000 === ut, event.utDaysJ2000);
    await shot(`phase-${event.phaseLongitudeDeg}`); await page.locator('#sky-moon-loupe-close').click();
  }
  assertions.push('All four explicit moon-phase jumps preserve observer, selected star and four cameras while using the same paused clock and matching loupe snapshot.');

  await page.evaluate(() => { const next = window.skyApp.state; next.time.utDaysJ2000 = (new Date('2057-09-30T00:00:00Z').getTime() - 946728000000) / 86400000; window.skyApp.setState(next); }); await paired();
  assert.match(await page.locator('.lunar-calendar-readout').textContent(), /预报不确定/);
  await page.evaluate(() => { const next = window.skyApp.state; next.time.utDaysJ2000 = (new Date('0000-06-21T12:00:00Z').getTime() - 946728000000) / 86400000; window.skyApp.setState(next); }); await paired();
  assert.match(await page.locator('.lunar-calendar-readout').textContent(), /未提供已验证农历/);
  assertions.push('Calendar uncertainty and unsupported ancient dates are explicit without fabricated lunar dates.');

  await scene('S09'); await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#controls').classList.contains('controls-collapsed'));
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.solarDay.enabled), false);
  await page.locator('.controls-drawer-toggle').click(); await page.locator('#sky-teaching').scrollIntoViewIfNeeded();
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics.open);
  assert.equal(await page.locator('#controls').evaluate(el => el.classList.contains('controls-collapsed')), true);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.solarDay.enabled), false);
  await shot('mobile-moon-loupe');
  const closeRect = await page.locator('#sky-moon-loupe-close').boundingBox(); assert.ok(closeRect.height >= 44 && closeRect.width >= 44);
  await page.locator('#sky-moon-loupe-close').click();
  assertions.push('Mobile loupe closes the drawer, disables hidden solar requests, retains its own 44px close control and leaves most sky visible.');
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'passed', startedAt, browser: browser.version(), assertions, errors, limits: 'Headless Chrome UI checks only; no 30-minute run or physical touchscreen/FPS claim.' }, null, 2));
  console.log(`M3 UI: ${assertions.length} groups passed, screenshots and derived times saved to ${out}.`);
} catch (error) {
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'failed', startedAt, assertions, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
