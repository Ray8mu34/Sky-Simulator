import assert from 'node:assert/strict';

const inspect = page => page.evaluate(() => ({ state: window.skyApp.state, teaching: window.skyApp.teachingData, diagnostics: window.skyApp.diagnostics }));
const waitDay = page => page.waitForFunction(() => {
  const app = window.skyApp, day = app.teachingData, service = app.diagnostics.dayEvents;
  return day.solarDayStatus === 'ready' && day.objectDayStatus === 'ready' && service.activeRequestCount === 0 && service.pendingLatestRequestCount === 0;
}, undefined, { timeout: 30_000 });

/** Targeted changed-worker smoke. Earlier service-worker upgrade matrices remain separate. */
export async function runM5aOfflineSmoke({ page, shot, name = 'selected-moon-day-events.png' }) {
  await page.evaluate(() => {
    const state = window.skyApp.state;
    state.time.running = false; state.time.mode = 'simulation';
    state.time.utDaysJ2000 = (Date.parse('2026-09-14T04:00:00Z') - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
    state.observer.latitudeDeg = 30.25; state.observer.longitudeDegEast = 120.15; state.observer.heightMeters = 10;
    state.observer.displayZone = { kind: 'fixed', offsetMinutes: 480 };
    state.selected = 'body:Moon'; window.skyApp.setState(state);
    document.querySelector('#sky-teaching').open = true;
    document.querySelector('#sky-object-day').open = true;
    window.dispatchEvent(new CustomEvent('sky:teaching-visibility'));
    window.dispatchEvent(new CustomEvent('sky:object-day-visibility'));
  });
  await waitDay(page);
  const result = await inspect(page), keys = result.diagnostics.dayEvents.componentKeys;
  assert.equal(result.teaching.solarDayKey, keys.solar); assert.equal(result.teaching.objectDayKey, keys.selected);
  assert.equal(result.teaching.objectDay.id, 'body:Moon'); assert.equal(result.teaching.objectDay.state, 'events');
  assert.ok(result.teaching.objectDay.crossings.length >= 1);
  assert.equal(result.diagnostics.dayEvents.cache.maxEntries, 16); assert.ok(result.diagnostics.dayEvents.cache.cacheEntries <= 16);
  assert.ok(result.diagnostics.workerCount <= 2);
  if (shot) { await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await shot(name); }
  return result;
}

export async function runM5aChecks({ page, report, shot, assertPaired }) {
  const moon = await runM5aOfflineSmoke({ page, shot }); report.moon = moon;
  await page.locator('.object-day-events button[data-object-event-ut]:not([disabled])').first().click();
  await assertPaired(); await waitDay(page);
  const jumped = await inspect(page), event = moon.teaching.objectDay.crossings.find(event => event.jumpAllowed);
  assert.ok(event); assert.equal(jumped.state.time.utDaysJ2000, event.utDaysJ2000);
  assert.deepEqual(jumped.state, { ...moon.state, time: { ...moon.state.time, running: false, utDaysJ2000: event.utDaysJ2000 } });
  report.eventJump = jumped;
  report.assertions.push('The real Moon event button pauses at its returned UT and preserves observer, selection, layers and all four cameras.');
  const beforeSun = await inspect(page);
  await page.locator('#sky-search').fill('Sun'); await page.locator('[data-object-id="body:Sun"]').click(); await waitDay(page);
  const sun = await inspect(page);
  assert.equal(sun.teaching.objectDay.id, 'body:Sun'); assert.equal(sun.teaching.objectDayKey, sun.teaching.objectDay.key);
  assert.deepEqual(sun.teaching.objectDay.crossings.map(({ kind, utDaysJ2000 }) => ({ kind, utDaysJ2000 })),
    sun.teaching.solarDay.riseSetCrossings.map(({ kind, utDaysJ2000 }) => ({ kind, utDaysJ2000 })));
  assert.equal(sun.diagnostics.dayEvents.cache.computations, beforeSun.diagnostics.dayEvents.cache.computations);
  assert.equal(sun.diagnostics.dayEvents.cache.cacheEntries, beforeSun.diagnostics.dayEvents.cache.cacheEntries);
  report.sunSharedCache = sun;
  report.assertions.push('Real search selection of Sun reuses the solar entry without another scientific computation or cache entry.');
  const beforeFold = await inspect(page);
  await page.locator('#sky-object-day > summary').click();
  await page.waitForFunction(() => window.skyApp.diagnostics.dayEvents.componentKeys.selected === null);
  const folded = await inspect(page); assert.equal(folded.diagnostics.dayEvents.componentKeys.solar, beforeFold.diagnostics.dayEvents.componentKeys.solar);
  await page.locator('#sky-object-day > summary').click(); await waitDay(page);
  const reopened = await inspect(page); assert.deepEqual(reopened.teaching.objectDay, beforeFold.teaching.objectDay);
  assert.equal(reopened.diagnostics.dayEvents.startedCount, beforeFold.diagnostics.dayEvents.startedCount);
  report.visibilityReuse = { folded, reopened };
  report.assertions.push('Folding selection removes only its demand; reopening the same key replays the retained result with no new batch.');
  await page.waitForTimeout(350);
  assert.equal((await inspect(page)).diagnostics.dayEvents.startedCount, reopened.diagnostics.dayEvents.startedCount);
  report.status = 'passed-m5a-targeted-browser-checks';
  report.limitations.push('Object crossing accuracy is independently validated by science; the previous milestone update matrix is not repeated here.');
}

export async function recordM5aWorkflow({ page, report, shot, assertPaired }) {
  await runM5aOfflineSmoke({ page, shot, name: 'recording-moon-events.png' }); await page.waitForTimeout(900);
  await page.locator('.object-day-events button[data-object-event-ut]:not([disabled])').first().click(); await assertPaired(); await page.waitForTimeout(900);
  for (const query of ['HIP32349', 'HIP11767']) {
    await page.locator('#sky-search').fill(query); await page.locator(`[data-object-id="hip:${query.slice(3)}"]`).click();
    await page.waitForFunction(() => window.skyApp.teachingData.objectDayStatus === 'ready');
    await page.locator('#sky-object-day').scrollIntoViewIfNeeded(); await page.waitForTimeout(900);
  }
  await page.locator('#sky-search').fill('Cyg'); await page.locator('[data-object-id="constellation:Cyg"]').click();
  await page.waitForFunction(() => window.skyApp.teachingData.objectDayStatus === 'unsupported'); await page.waitForTimeout(900);
  await shot('recording-constellation-unsupported.png'); report.status = 'captured-m5a-native-ui-recording';
}
