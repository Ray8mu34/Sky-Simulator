import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Run against `pnpm dev`; this is browser interaction evidence, not an FPS test.
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m2-ui/final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1152, height: 720 } });
const assertions = [], errors = [];
const startedAt = new Date().toISOString();
await writeFile(`${out}/report.json`, JSON.stringify({ status: 'running', startedAt }, null, 2));
page.on('pageerror', error => errors.push(error.message));
const settled = () => page.waitForFunction(() => {
  const app = window.skyApp, state = app.state, diagnostic = app.diagnostics;
  return app.ready && !diagnostic.scienceDirty && diagnostic.pendingInteractionCount === 0 && diagnostic.lastRenderedMode === state.viewMode && diagnostic.lastRenderedSelection === state.selected && diagnostic.lastRenderedReferenceLock === (state.viewMode === 'ground' ? null : state.cameras[state.viewMode].referenceLock);
});
const state = () => page.evaluate(() => window.skyApp.state);
const shot = name => page.screenshot({ path: `${out}/${name}.png` });
try {
  await page.goto(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/');
  await settled();
  const initial = await state();
  const search = page.locator('#sky-search');
  await search.fill('北极星'); await search.press('Enter');
  const selected = await state();
  assert.ok(selected.selected?.startsWith('hip:'));
  assert.equal(selected.time.utDaysJ2000, initial.time.utDaysJ2000);
  assert.deepEqual(selected.cameras, initial.cameras);
  assert.match(await page.locator('.object-epoch').textContent(), /J2000/);
  assert.match(await page.locator('.object-visibility').textContent(), /当前.*地平线/);
  assertions.push('Keyboard search selects a real star and changes neither UTC nor any camera.');
  await shot('ground-polestar-details');
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await page.locator(`[data-view="${mode}"]`).click(); await settled();
    const current = await state();
    assert.equal(current.selected, selected.selected);
    assert.equal(current.time.utDaysJ2000, initial.time.utDaysJ2000);
    assert.deepEqual(current.observer, initial.observer);
    assert.deepEqual(current.cameras, initial.cameras);
  }
  assertions.push('Selection, UTC, observer and saved camera poses survive all four view switches.');
  await search.fill('猎户座'); await search.press('Enter');
  assert.match((await state()).selected, /^constellation:/);
  assert.match(await page.locator('.object-magnitude').textContent(), /星座方向锚点/);
  assertions.push('Constellation results show a direction anchor rather than a fabricated star magnitude.');
  await search.fill('月球'); await search.press('Enter');
  assert.equal((await state()).selected, 'body:Moon');
  assert.match(await page.locator('.object-epoch').textContent(), /当日.*站心/);
  await page.locator('[data-view="space"]').click(); await settled();
  const forwardBeforeLock = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
  await page.locator('#sky-reference-lock').selectOption('earth-fixed'); await settled();
  const forwardAfterLock = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
  assert.ok(Math.hypot(...forwardBeforeLock.map((value, index) => value - forwardAfterLock[index])) < 1e-8);
  assert.equal((await state()).cameras.space.referenceLock, 'earth-fixed');
  assert.equal((await state()).time.utDaysJ2000, initial.time.utDaysJ2000);
  await page.evaluate(() => { window.uiFocusEventCount = 0; window.addEventListener('sky:focus-selection', () => window.uiFocusEventCount++); });
  const beforeFocus = await state();
  const renderedBeforeFocus = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.locator('[data-action="focus-selection"]').click();
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, renderedBeforeFocus);
  await settled();
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.lastFocusSucceeded), true);
  assert.notDeepEqual((await state()).cameras.space, beforeFocus.cameras.space);
  const focused = await page.evaluate(() => window.skyApp.rendererDiagnostics);
  assert.equal(focused.selectedVisible, true);
  assert.ok(focused.selectedProjectedNdc && Math.abs(focused.selectedProjectedNdc[0]) < 1 && Math.abs(focused.selectedProjectedNdc[1]) < 1);
  assert.equal(await page.evaluate(() => window.uiFocusEventCount), 1);
  assert.equal((await state()).selected, 'body:Moon');
  assert.equal((await state()).time.utDaysJ2000, initial.time.utDaysJ2000);
  assertions.push('A real renderer focus changes the space camera, finishes drawing the selection, and preserves object and UTC.');
  await shot('space-moon-reference-lock');
  for (const mode of ['globe', 'horizon']) {
    await page.locator(`[data-view="${mode}"]`).click(); await settled();
    const forwardBefore = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
    await page.locator('#sky-reference-lock').selectOption(mode === 'horizon' ? 'inertial' : 'earth-fixed'); await settled();
    const forwardAfter = await page.evaluate(() => window.skyApp.rendererDiagnostics.viewForwardEqj);
    assert.ok(Math.hypot(...forwardBefore.map((value, index) => value - forwardAfter[index])) < 1e-8);
    const renderedBefore = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.locator('[data-action="focus-selection"]').click();
    await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count, renderedBefore); await settled();
    const finiteFocus = await page.evaluate(() => window.skyApp.rendererDiagnostics);
    assert.equal(finiteFocus.selectedOnNearHemisphere, true);
    assert.equal(finiteFocus.selectedVisible, true);
    assert.ok(Math.hypot(...finiteFocus.selectedProjectedNdc) < 1e-5);
    assert.equal((await state()).time.utDaysJ2000, initial.time.utDaysJ2000);
    await shot(`${mode}-moon-focused`);
  }
  assertions.push('All external lock changes preserve EQJ viewing direction; finite focus brings the Moon to the near hemisphere and centre.');
  await page.evaluate(() => { const next = window.skyApp.state; next.selected = 'hip:9999999'; window.skyApp.setState(next); }); await settled();
  assert.equal(await page.locator('[data-action="focus-selection"]').isDisabled(), true);
  assert.match(await page.locator('.object-epoch').textContent(), /没有该对象的坐标/);
  assertions.push('An unknown imported ID has no invented coordinates and cannot be focused.');
  await search.fill('a');
  assert.ok(await page.locator('[data-object-id]').count() <= 12);
  await search.press('ArrowDown'); await search.press('Enter');
  assert.equal(await page.locator('#sky-search-results').isVisible(), false);
  await search.fill('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#sky-search-results img').count(), 0);
  await search.press('Escape');
  assert.equal(await page.locator('#sky-search-results').isVisible(), false);
  assertions.push('Search results stay bounded, accept keyboard navigation and treat query text as text.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#controls').classList.contains('controls-collapsed'));
  await shot('mobile-compact-search');
  const compact = await page.locator('.controls-compact').boundingBox();
  assert.ok(compact.height <= 60 && compact.width <= 370);
  await page.locator('[data-action="open-search"]').click();
  assert.equal(await page.locator('.sky-control-panel').isVisible(), true);
  await search.fill('月球'); await search.press('Enter');
  await shot('mobile-moon-details');
  for (const locator of ['[data-action="open-search"]', '[data-action="focus-selection"]', '[data-action="clear-selection"]']) {
    const rect = await page.locator(locator).boundingBox();
    if (rect) assert.ok(rect.height >= 44);
  }
  assertions.push('Mobile keeps a low compact search entry and reachable 44px object actions.');
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'passed', startedAt, browser: browser.version(), assertions, errors, scope: 'Headless Chrome interaction and screenshots; no physical touchscreen or hardware FPS claim.' }, null, 2));
  console.log(`M2 UI: ${assertions.length} interaction groups passed; screenshots in ${out}.`);
} catch (error) {
  await writeFile(`${out}/report.json`, JSON.stringify({ status: 'failed', startedAt, assertions, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
