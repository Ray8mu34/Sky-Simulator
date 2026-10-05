import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

// Functional interactions only; performance testing is run separately by platform.
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m3b-ui/final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1152, height: 720 }, acceptDownloads: true });
const assertions = [], errors = [], startedAt = new Date().toISOString();
const stage = process.env.SKY_UI_QA_STAGE ?? 'development';
page.on('pageerror', error => errors.push(error.message));
const state = () => page.evaluate(() => window.skyApp.state);
const paired = () => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.skyAppearance && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000 && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode);
const drawAfter = count => page.waitForFunction(value => window.skyApp.diagnostics.renderCount > value && !window.skyApp.diagnostics.scienceDirty, count);
const shot = name => page.screenshot({ path: `${out}/${name}.png` });
async function openAppearance() {
  await page.locator('.layer-section').evaluate(el => { el.open = true; });
  await page.locator('.appearance-controls').evaluate(el => { el.open = true; });
  await page.locator('#sky-artificial-light').scrollIntoViewIfNeeded();
}
async function scene(id) {
  await page.locator('.scene-section').evaluate(el => { el.open = true; });
  await page.locator(`[data-sky-scene="${id}"]`).click(); await paired();
  await page.locator('.scene-section').evaluate(el => { el.open = false; });
  await openAppearance();
}
async function selectMode(viewMode, presentation = 'observation') {
  const before = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.evaluate(({ viewMode, presentation }) => { const next = window.skyApp.state; next.viewMode = viewMode; next.presentation = presentation; window.skyApp.setState(next); }, { viewMode, presentation });
  await drawAfter(before); await paired();
}
try {
  await page.goto(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/'); await paired();
  assert.equal((await state()).layers.milkyWay, true);
  assert.equal(await page.locator('.appearance-controls').evaluate(el => el.open), false);
  await scene('G01');
  assert.equal(await page.locator('input[data-layer="milkyWay"]').isChecked(), true);
  assert.match(await page.locator('#sky-appearance-scope').textContent(), /定性观察/);
  const seed = await state();
  assert.equal(new Date(946728000000 + seed.time.utDaysJ2000 * 86400000).toISOString(), '2026-08-14T14:00:00.000Z');
  const models = [];
  for (const [value, name] of [[0, 'g01-dark-night'], [.5, 'g02-suburban'], [1, 'g03-city']]) {
    const before = await page.evaluate(() => ({ render: window.skyApp.diagnostics.renderCount, requests: window.skyApp.diagnostics.scienceRequestCount, rebases: window.skyApp.diagnostics.clockRebaseCount }));
    await page.locator(`[data-sky-light="${value}"]`).click(); await drawAfter(before.render);
    const after = await page.evaluate(() => ({ state: window.skyApp.state, appearance: window.skyApp.skyAppearance, diagnostics: window.skyApp.diagnostics }));
    const expected = structuredClone(seed); expected.environment.artificialSkyBrightness = value;
    assert.deepEqual(after.state, expected);
    assert.equal(after.diagnostics.scienceRequestCount, before.requests);
    assert.equal(after.diagnostics.clockRebaseCount, before.rebases);
    assert.equal(after.appearance.visibilityApplied, true);
    assert.equal(after.appearance.moonlightStrength, 0);
    assert.match(await page.locator('#sky-appearance-values').textContent(), new RegExp(after.appearance.limitingMagnitude.toFixed(1).replace('.', '\\.')));
    models.push(after.appearance);
    await shot(name);
  }
  assert.ok(models[0].limitingMagnitude > models[1].limitingMagnitude && models[1].limitingMagnitude > models[2].limitingMagnitude);
  assert.ok(models[0].milkyWayContrast > models[1].milkyWayContrast && models[1].milkyWayContrast > models[2].milkyWayContrast);
  assert.ok(models[0].skyBrightness < models[1].skyBrightness && models[1].skyBrightness < models[2].skyBrightness);
  assertions.push('Default galaxy is enabled; G01 has fixed night inputs; 0/.5/1 presets preserve every other state field and change the shared model monotonically without science requests or clock rebases.');

  for (const running of [false, true]) {
    const batch = await page.evaluate(running => {
      if (running) window.skyApp.play();
      const before = { state: window.skyApp.state, requests: window.skyApp.diagnostics.scienceRequestCount, rebases: window.skyApp.diagnostics.clockRebaseCount };
      const slider = document.querySelector('#sky-artificial-light');
      for (let i = 0; i < 40; i++) { slider.value = String(i / 100); slider.dispatchEvent(new Event('input', { bubbles: true })); }
      return { before, after: { state: window.skyApp.state, requests: window.skyApp.diagnostics.scienceRequestCount, rebases: window.skyApp.diagnostics.clockRebaseCount } };
    }, running);
    const expected = structuredClone(batch.before.state); expected.environment.artificialSkyBrightness = .39;
    assert.deepEqual(batch.after.state, expected);
    assert.equal(batch.after.requests, batch.before.requests); assert.equal(batch.after.rebases, batch.before.rebases);
    if (running) { await page.evaluate(() => window.skyApp.pause()); await paired(); }
  }
  assertions.push('Forty synchronous range input events in paused and playing states preserve the sole clock and all non-environment state, with no additional science requests.');

  await scene('G01');
  const beforeLayer = await state();
  await page.locator('input[data-layer="milkyWay"]').uncheck();
  const disabled = await state(); const expectedLayer = structuredClone(beforeLayer); expectedLayer.layers.milkyWay = false;
  assert.deepEqual(disabled, expectedLayer);
  const downloading = page.waitForEvent('download'); await page.locator('.scene-section').evaluate(el => { el.open = true; });
  await page.locator('[data-action="export"]').click();
  const download = await downloading; await download.saveAs(`${out}/galaxy-disabled-scene.json`);
  const exported = JSON.parse(await readFile(`${out}/galaxy-disabled-scene.json`, 'utf8'));
  assert.deepEqual(exported, disabled);
  await page.locator('[data-sky-scene="G03"]').click(); await paired();
  await page.locator('#sky-import-file').setInputFiles(`${out}/galaxy-disabled-scene.json`); await paired();
  assert.deepEqual(await state(), disabled);
  await page.locator('.scene-section').evaluate(el => { el.open = false; }); await openAppearance();
  assertions.push('Galaxy toggling changes only its layer; real JSON export/import retains false under the new true default and restores the complete state.');

  await scene('G03');
  await selectMode('ground', 'explanation');
  assert.equal(await page.evaluate(() => window.skyApp.skyAppearance.visibilityApplied), false);
  assert.match(await page.locator('.mode-note').textContent(), /忽略肉眼可见性/);
  assert.match(await page.locator('#sky-appearance-scope').textContent(), /原理示意/);
  await shot('ground-explanation');
  for (const view of ['space', 'globe', 'horizon']) {
    await selectMode(view);
    assert.equal(await page.evaluate(() => window.skyApp.skyAppearance.reason), 'external-diagram');
    assert.match(await page.locator('#sky-appearance-scope').textContent(), /方向示意/);
    assert.match(await page.locator('.mode-note').textContent(), /忽略当地可见性/);
  }
  await shot('horizon-direction-diagram');
  const beforeObserve = await state();
  await page.locator('#sky-observe-appearance').click(); await paired();
  const observed = await state();
  assert.deepEqual(observed.time, beforeObserve.time); assert.deepEqual(observed.observer, beforeObserve.observer);
  assert.deepEqual(observed.cameras, beforeObserve.cameras); assert.equal(observed.selected, beforeObserve.selected);
  assert.equal(observed.viewMode, 'ground'); assert.equal(observed.presentation, 'observation'); assert.equal(observed.layers.atmosphere, true);
  const beforeAtmosphere = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.locator('input[data-layer="atmosphere"]').uncheck(); await drawAfter(beforeAtmosphere); await paired();
  assert.equal(await page.evaluate(() => window.skyApp.skyAppearance.reason), 'atmosphere-disabled');
  assert.equal(await page.evaluate(() => window.skyApp.skyAppearance.artificialLightStrength), 0);
  assert.match(await page.locator('#sky-appearance-scope').textContent(), /大气关闭/);
  await shot('atmosphere-disabled');
  assertions.push('Explanation/external/atmosphere-off modes explicitly bypass local visibility; one-click ground observation with atmosphere preserves UTC, observer, selection and four cameras.');

  await scene('G01');
  await page.locator('#sky-moonlight').uncheck();
  const withoutMoonlight = await state();
  assert.equal(withoutMoonlight.environment.moonlightEnabled, false);
  await page.locator('input[data-layer="sunMoon"]').uncheck();
  await page.locator('#sky-moonlight').check();
  const hiddenBody = await state(); assert.equal(hiddenBody.layers.sunMoon, false); assert.equal(hiddenBody.environment.moonlightEnabled, true);
  const pending = await page.evaluate(() => {
    const next = window.skyApp.state;
    next.time.utDaysJ2000 = (Date.parse('2026-09-26T14:00:00Z') - 946728000000) / 86400000;
    window.skyApp.setState(next);
    return { appearance: window.skyApp.skyAppearance, text: document.querySelector('#sky-appearance-values').textContent };
  });
  if (pending.appearance === null) assert.match(pending.text, /等待/);
  await paired();
  const moonModel = await page.evaluate(() => window.skyApp.skyAppearance);
  assert.ok(moonModel.moonAltitudeDeg > 0 && moonModel.moonIlluminatedFraction > .9);
  assert.ok(moonModel.moonlightStrength > 0);
  assertions.push('Moonlight is an independent environment option; hiding Sun/Moon leaves it enabled and the shared model uses actual snapshot geometry.');

  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100);
  assert.equal(await page.locator('.sky-control-panel').isVisible(), false);
  await shot('mobile-sky-default');
  await page.locator('.controls-drawer-toggle').click(); await openAppearance();
  for (const selector of ['#sky-artificial-light', '[data-sky-light="0"]', '[data-sky-light="0.5"]', '[data-sky-light="1"]', '#sky-moonlight']) {
    const rect = await page.locator(selector).evaluate(el => (el.matches('input[type="checkbox"]') ? el.closest('label') : el).getBoundingClientRect().toJSON());
    assert.ok(rect.height >= 44, `${selector}: 44px mobile touch height`);
  }
  assert.equal(await page.locator('input[data-layer="milkyWay"]').count(), 1);
  await page.locator('.appearance-controls').evaluate(el => {
    const panel = el.closest('.panel-scroll');
    panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
  });
  await shot('mobile-appearance-controls');
  assertions.push('Desktop resize to mobile auto-collapses the drawer, leaves the sky and compact controls visible, and all new interaction targets have 44px heights.');

  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'passed', stage, startedAt, endedAt: new Date().toISOString(), assertions, errors, limits: 'Functional Chrome UI QA only; no FPS benchmark, physical touch-device claim or 30-minute run. Development evidence does not certify the final production build.' }, null, 2));
  console.log(`Passed ${assertions.length} UI groups; evidence: ${out}`);
} catch (error) {
  await shot('failure').catch(() => {});
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'failed', stage, startedAt, assertions, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
