import assert from 'node:assert/strict';

const libraryKey = 'panoramic-night-sky:scene-library:v1';
const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics, snapshot: window.skyApp.snapshot,
  teaching: window.skyApp.teachingData, offline: window.skyApp.offlineStatus, graphics: window.skyApp.graphicsStatus }));
async function openScenes(page) {
  await page.locator('.scene-section').evaluate(element => { element.open = true; });
  await page.locator('.scene-library-section').evaluate(element => { element.open = true; });
}
export async function runM4bPortableSmoke({ page, report, shot }) {
  await openScenes(page); await page.locator('#sky-share-scene').click();
  await page.waitForFunction(() => document.querySelector('#sky-share-value')?.value.startsWith('{'));
  const share = await page.locator('#sky-share-value').inputValue();
  assert.deepEqual(JSON.parse(share), await page.evaluate(() => window.skyApp.state));
  assert.ok(!share.includes('file://')); assert.equal(await page.evaluate(() => window.skyApp.offlineStatus.phase), 'portable');
  const rejected = await page.evaluate(() => { try { window.skyApp.shareHash(); return false; } catch { return true; } });
  assert.equal(rejected, true);
  report.portableShare = { mode: 'JSON', bytes: Buffer.byteLength(share), message: await page.locator('.share-message').textContent(), nativeFilePathShared: false };
  await shot('portable-json-share.png');
  report.assertions.push('First offline file open provides the complete validated scene JSON; the public link method rejects local file paths.');
}
export async function runM4bChecks({ page, context, outDir, report, shot, assertPaired }) {
  await page.evaluate(() => {
    const state = window.skyApp.state; state.time.running = false; state.time.mode = 'simulation';
    state.viewMode = 'space'; state.selected = 'hip:91262'; state.layers.earthDay = false;
    state.cameras.ground.azimuthDegNorthEast = 137; state.cameras.ground.altitudeDeg = 26; window.skyApp.setState(state);
  }); await assertPaired();
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready', undefined, { timeout: 30_000 });
  const before = await inspect(page);
  await page.locator('.time-zone-settings').evaluate(element => { element.open = true; });
  await page.locator('#sky-zone-kind').selectOption('fixed'); await page.locator('#sky-zone-offset').fill('+05:45');
  await page.locator('#sky-zone-form button[type="submit"]').click(); await assertPaired();
  await page.waitForFunction(key => window.skyApp.teachingData.solarDayStatus === 'ready' && window.skyApp.diagnostics.solarDayKey !== key,
    before.diagnostics.solarDayKey, { timeout: 30_000 });
  const zoned = await inspect(page);
  assert.deepEqual(zoned.state, { ...before.state, observer: { ...before.state.observer, displayZone: { kind: 'fixed', offsetMinutes: 345 } } });
  assert.equal(zoned.diagnostics.clockRebaseCount, before.diagnostics.clockRebaseCount);
  assert.equal(zoned.diagnostics.scienceRequestCount, before.diagnostics.scienceRequestCount);
  assert.equal(zoned.snapshot.requestId, before.snapshot.requestId);
  assert.deepEqual(zoned.teaching.lunarCalendar, before.teaching.lunarCalendar);
  report.displayZone = { before, after: zoned };
  await shot('zone-change-same-sky-new-civil-day.png');
  report.assertions.push('A real display-zone form submission preserves UTC, selection and all cameras, with no clock rebase or new instantaneous astronomy request; only civil-day teaching is recomputed.');

  await openScenes(page); await page.locator('#sky-scene-name').fill('完整场景 · +05:45'); await page.locator('#sky-save-scene').click();
  const stored = await page.evaluate(key => localStorage.getItem(key), libraryKey);
  const saved = JSON.parse(stored).scenes.at(-1); assert.deepEqual(saved.state, zoned.state);
  // Fault injection checks UI atomic failure; it does not claim the physical browser quota was exhausted.
  await page.evaluate(key => {
    window.__qaOriginalStorageSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) { if (name === key) throw new DOMException('Injected quota failure', 'QuotaExceededError'); return window.__qaOriginalStorageSet.call(this, name, value); };
  }, libraryKey);
  try {
    await page.locator('#sky-scene-name').fill('拒绝写入的场景'); await page.locator('#sky-save-scene').click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), libraryKey), stored);
    assert.match(await page.locator('.scene-library-status').textContent(), /配额.*原有场景未被修改/);
  } finally { await page.evaluate(() => { Storage.prototype.setItem = window.__qaOriginalStorageSet; delete window.__qaOriginalStorageSet; }); }
  await page.evaluate(() => { const state = window.skyApp.state; state.layers.earthDay = true; state.selected = null; state.viewMode = 'ground'; state.cameras.ground.azimuthDegNorthEast = 42; window.skyApp.setState(state); });
  await assertPaired(); await page.locator('#sky-saved-scenes').selectOption(saved.id); await page.locator('#sky-load-saved-scene').click(); await assertPaired();
  assert.deepEqual(await page.evaluate(() => window.skyApp.state), zoned.state);
  report.sceneLibrary = { id: saved.id, persistedBytes: Buffer.byteLength(stored), quotaFailure: 'injected Storage.setItem rejection; unchanged real localStorage bytes', roundTripState: await page.evaluate(() => window.skyApp.state) };
  await shot('saved-scene-restored.png');
  report.assertions.push('Actual UI save/load restores the full state, and an injected native Storage write failure leaves prior bytes untouched with an explicit error.');

  await page.locator('#sky-share-scene').click(); await page.waitForFunction(() => document.querySelector('#sky-share-value')?.value.startsWith('http'));
  const url = await page.locator('#sky-share-value').inputValue(), shared = JSON.parse(decodeURIComponent(new URL(url).hash.slice('#scene='.length)));
  assert.deepEqual(shared, zoned.state); assert.equal(new URL(url).pathname, new URL(page.url()).pathname);
  const peer = await context.newPage();
  try {
    await peer.goto(url, { waitUntil: 'load' });
    await peer.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000, undefined, { timeout: 30_000 });
    assert.deepEqual(await peer.evaluate(() => window.skyApp.state), zoned.state);
    report.webShare = { urlLength: url.length, copiedOrManualMessage: await page.locator('.share-message').textContent(), restoredState: await peer.evaluate(() => window.skyApp.state) };
  } finally { await peer.close(); }
  report.assertions.push('The actual share button produces a complete Web hash; a separate real page loads the exact state including four cameras and earthDay.');
  await shot('web-share-complete-state.png');
  report.status = 'passed-m4b-browser-functional-checks';
}

export async function recordM4bWorkflow({ page, report, shot, assertPaired }) {
  await openScenes(page); await page.locator('#sky-preset').selectOption('V01'); await page.locator('#sky-load-preset').click(); await assertPaired();
  await page.waitForTimeout(700);
  await page.locator('.time-zone-settings').evaluate(element => { element.open = true; });
  await page.locator('#sky-zone-kind').selectOption('fixed'); await page.locator('#sky-zone-offset').fill('+05:45'); await page.locator('#sky-zone-form button[type="submit"]').click();
  await page.locator('#sky-time-span').selectOption('hour'); await page.locator('[data-time-step="1"]').click(); await assertPaired();
  await page.waitForTimeout(700);
  await page.locator('[data-view="space"]').click(); await page.waitForTimeout(500);
  await openScenes(page); await page.locator('#sky-scene-name').fill('我的教学起点'); await page.locator('#sky-save-scene').click();
  const expected = await page.evaluate(() => window.skyApp.state), id = await page.locator('#sky-saved-scenes').inputValue();
  await page.waitForTimeout(800);
  await page.locator('[data-view="ground"]').click(); await page.locator('[data-time-step="1"]').click(); await assertPaired(); await page.waitForTimeout(800);
  await page.locator('#sky-saved-scenes').selectOption(id); await page.locator('#sky-load-saved-scene').click(); await assertPaired();
  assert.deepEqual(await page.evaluate(() => window.skyApp.state), expected); await page.waitForTimeout(800);
  await page.locator('#sky-share-scene').click(); await page.waitForFunction(() => document.querySelector('#sky-share-value')?.value.startsWith('http')); await page.waitForTimeout(1000);
  await shot('recording-desktop-shared-scene.png');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(700);
  await page.locator('[data-action="open-time"]').click();
  await page.locator('#sky-time-span').selectOption('day'); await page.locator('[data-time-step="1"]').click(); await assertPaired(); await page.waitForTimeout(800);
  await openScenes(page); await page.locator('#sky-saved-scenes').selectOption(id); await page.locator('#sky-load-saved-scene').click(); await assertPaired();
  assert.deepEqual(await page.evaluate(() => window.skyApp.state), expected); await page.waitForTimeout(800);
  await shot('recording-mobile-bottom-drawer.png');
  await page.locator('[data-action="close"]').click(); await page.waitForTimeout(1000);
  await shot('recording-mobile-restored-sky.png');
  report.recordingScope = 'Actual browser viewport frames and full UI: preset, display zone, hour step, named save/change/load, Web share, 390px bottom drawer day step and restore. Resized viewport is fitted into the fixed recording frame; no synthetic images.';
  report.recordedScene = expected; report.status = 'recorded-awaiting-human-review';
}
