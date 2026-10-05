import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5c-ui/development';
await mkdir(out, { recursive: true });
const sources = ['src/ui/controls.ts', 'src/ui/refraction-controls.ts', 'src/ui/teaching-controls.ts', 'src/state.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const beforeHashes = await hashes(), browsers = [], checks = [], errors = [], actualBuilds = [];
let publishedModule;
const s08Path = process.env.SKY_QA_S08_INPUT ?? 'qa/m5c-science/s08-derived-inputs-core-final.json';
const s08Bytes = await readFile(s08Path);
const s08Inputs = JSON.parse(s08Bytes);
const s08Sha256 = createHash('sha256').update(s08Bytes).digest('hex'), s08Rows = [];
let page, noneState, failure = null;
const state = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => {
  const app = window.skyApp, d = app.snapshot?.observerRefraction, e = app.state.environment;
  return app.ready && !app.diagnostics.scienceDirty && app.diagnostics.lastRenderedUt === app.state.time.utDaysJ2000 && d?.mode === e.refraction && d.pressureHpa === e.pressureHpa && d.temperatureC === e.temperatureC;
});
const readyDay = page => page.waitForFunction(() => window.skyApp.teachingData.objectDayStatus === 'ready' && window.skyApp.teachingData.objectDayKey === document.querySelector('#sky-object-day').dataset.objectDayKey);
async function verifyBuild(page, graphics) {
  const value = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content ?? null, entries: [...document.querySelectorAll('script[type="module"][src]')].map(el => el.getAttribute('src')) }));
  if (process.env.SKY_QA_BUILD_ID) assert.equal(value.id, process.env.SKY_QA_BUILD_ID);
  if (process.env.SKY_QA_ENTRY) assert.ok(value.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)));
  const moduleUrl = new URL(value.entries[0], page.url()).href;
  const response = await page.request.get(moduleUrl); assert.ok(response.ok());
  const moduleSha256 = createHash('sha256').update(await response.body()).digest('hex');
  actualBuilds.push({ graphics, ...value, moduleUrl, moduleSha256 });
  if (process.env.SKY_QA_BUILD_ID) {
    if (publishedModule) assert.deepEqual({ id: value.id, entries: value.entries, moduleSha256 }, publishedModule);
    else publishedModule = { id: value.id, entries: value.entries, moduleSha256 };
  }
}
async function search(page, query, id) {
  await page.locator('#sky-search').fill(query); await page.locator('#sky-search').press('Enter');
  assert.equal((await state(page)).selected, id); await readyDay(page);
}
async function openRefraction(page) { await page.locator('#sky-refraction').evaluate(el => { el.open = true; }); }
async function applyRefraction(page, mode, pressure, temperature) {
  await openRefraction(page);
  await page.locator('#sky-refraction-mode').selectOption(mode);
  if (pressure !== undefined) await page.locator('#sky-pressure').fill(String(pressure));
  if (temperature !== undefined) await page.locator('#sky-temperature').fill(String(temperature));
  await page.locator('#sky-apply-refraction').click(); await paired(page);
  assert.equal((await state(page)).environment.refraction, mode);
}
async function readouts(page, bodyId = 'Sun') {
  const snapshot = await page.evaluate(() => window.skyApp.snapshot), sun = snapshot.bodies.find(body => body.id === bodyId);
  const expected = n => `${n.toFixed(1)}°`;
  assert.equal(await page.locator('.object-alt').textContent(), expected(sun.geometricAltitudeDeg));
  assert.equal(await page.locator('.object-apparent-alt').textContent(), expected(sun.apparentAltitudeDeg));
  const solarText = await page.locator(bodyId === 'Sun' ? '.sun-readout' : '.moon-readout').textContent();
  assert.ok(solarText.includes(`几何 ${expected(sun.geometricAltitudeDeg)}`) && solarText.includes(`视高度 ${expected(sun.apparentAltitudeDeg)}`));
  assert.match(await page.locator('.object-visibility').textContent(), /几何地平/);
  return sun;
}
const unchanged = (before, after) => {
  assert.deepEqual(after.time, before.time); assert.deepEqual(after.cameras, before.cameras);
  assert.deepEqual(after.observer, before.observer); assert.equal(after.selected, before.selected);
};
async function runCadenceChecks(page) {
  await search(page, '太阳', 'body:Sun'); await openRefraction(page);
  await page.locator('#sky-rate').selectOption('60'); await page.locator('[data-action="play"]').click();
  const initial = await state(page);
  await page.locator('#sky-pressure').fill('950.25'); await page.waitForTimeout(650);
  await page.locator('#sky-temperature').fill('-25'); await page.waitForTimeout(350);
  assert.equal(await page.locator('#sky-pressure').inputValue(), '950.25');
  assert.equal(await page.locator('#sky-temperature').inputValue(), '-25');
  const playing = await state(page); assert.equal(playing.time.running, true); assert.ok(playing.time.utDaysJ2000 > initial.time.utDaysJ2000);
  assert.deepEqual(playing.environment, initial.environment);
  checks.push('At normal 60x playback, a real P/T draft survives multiple 180ms UI intervals; the clock advances and both environment values remain unapplied until submit.');
  await page.locator('#sky-refraction-mode').selectOption('standard');
  const rebaseBefore = await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount);
  const firstPublished = page.evaluate(() => new Promise(resolve => {
    const observe = () => {
      const snapshot = window.skyApp.snapshot, d = snapshot?.observerRefraction;
      if (d?.mode === 'standard' && d.pressureHpa === 950.25 && d.temperatureC === -25) {
        resolve({ descriptor: d, status: document.querySelector('#sky-refraction').dataset.refractionStatus,
          geometric: document.querySelector('.object-alt').textContent, apparent: document.querySelector('.object-apparent-alt').textContent,
          notes: document.querySelector('.object-notes').textContent });
      } else requestAnimationFrame(observe);
    }; requestAnimationFrame(observe);
  }));
  await page.locator('#sky-apply-refraction').click();
  const first = await firstPublished;
  assert.equal(first.status, 'ready', 'Explicit P/T must be visible on the first observed matching snapshot, without waiting for a later normal UI interval');
  assert.ok(Number.isFinite(Number.parseFloat(first.geometric)) && Number.isFinite(Number.parseFloat(first.apparent)));
  assert.match(first.notes, /标准视高度/);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount), rebaseBefore);
  const committed = await state(page); assert.equal(committed.time.running, true);
  assert.deepEqual(committed.cameras, playing.cameras); assert.deepEqual(committed.observer, playing.observer); assert.equal(committed.selected, playing.selected);
  checks.push('Explicit P/T application while playing publishes ready paired double heights on the first observed matching snapshot, keeps playback/cameras/observer/selection and does not rebase the clock.');
  await page.locator('[data-action="pause"]').click(); await paired(page); await readouts(page);
  const paused = await state(page); assert.equal(paused.time.running, false); assert.match(await page.locator('.playback-status').textContent(), /已暂停/);
  assert.equal((await page.evaluate(() => window.skyApp.snapshot)).utDaysJ2000, paused.time.utDaysJ2000);
  const pausedRebase = await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount);
  await applyRefraction(page, 'standard', 0, -25); const p0 = await readouts(page);
  assert.equal(p0.geometricAltitudeDeg, p0.apparentAltitudeDeg); unchanged(paused, await state(page));
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount), pausedRebase);
  await page.locator('#sky-refraction').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/paused-immediate-p0.png` });
  checks.push('Pause immediately aligns displayed double heights with the authoritative paused snapshot; a further explicit P=0 transaction is immediate, preserves paused UTC/state and gives identical geometric/apparent heights.');
}
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); browsers.push(browser);
  page = await browser.newPage({ viewport: { width: 1152, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page, 'webgl2'); await paired(page);
  if (process.env.SKY_UI_QA_FOCUSED === 'cadence') await runCadenceChecks(page);
  else {
  assert.equal((await state(page)).environment.refraction, 'none');
  assert.equal(await page.locator('#sky-refraction').evaluate(el => el.open), false);
  await search(page, '太阳', 'body:Sun');
  const sunEvents = await page.evaluate(() => window.skyApp.teachingData.objectDay);
  const rising = sunEvents.crossings.find(event => event.kind === 'rise' && event.jumpAllowed);
  assert.ok(rising); await page.locator(`[data-object-event-ut="${rising.utDaysJ2000}"]`).click(); await paired(page); await readyDay(page);
  noneState = await state(page); const noneSun = await readouts(page);
  assert.equal(noneSun.geometricAltitudeDeg, noneSun.apparentAltitudeDeg);
  const dayBefore = await page.evaluate(() => window.skyApp.teachingData.objectDay), diagnosticBefore = await page.evaluate(() => window.skyApp.diagnostics);
  await applyRefraction(page, 'standard'); const standardState = await state(page), standardSun = await readouts(page);
  unchanged(noneState, standardState); assert.equal(standardSun.geometricAltitudeDeg, noneSun.geometricAltitudeDeg); assert.ok(standardSun.apparentAltitudeDeg > noneSun.geometricAltitudeDeg);
  const diagnosticAfter = await page.evaluate(() => window.skyApp.diagnostics);
  assert.equal(diagnosticAfter.clockRebaseCount, diagnosticBefore.clockRebaseCount);
  assert.equal(diagnosticAfter.dayEvents.startedCount, diagnosticBefore.dayEvents.startedCount);
  assert.deepEqual(await page.evaluate(() => window.skyApp.teachingData.objectDay), dayBefore);
  await page.locator('.object-heading').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/desktop-dual-height.png` });
  await page.locator('[data-layer="atmosphere"]').uncheck(); await paired(page);
  assert.deepEqual(await readouts(page), standardSun); await page.locator('[data-layer="atmosphere"]').check();
  await search(page, '月球', 'body:Moon'); await readouts(page, 'Moon');
  await search(page, 'HIP 11767', 'hip:11767');
  const starAlt = Number.parseFloat(await page.locator('.object-alt').textContent()), starApp = Number.parseFloat(await page.locator('.object-apparent-alt').textContent());
  assert.ok(Number.isFinite(starAlt) && Number.isFinite(starApp)); assert.match(await page.locator('.object-notes').textContent(), /视高度.*当前折射设置/);
  await search(page, '太阳', 'body:Sun'); await readouts(page);
  checks.push('A real Sun rise-event jump provides a reproducible low-altitude input; Sun/Moon/star dual heights consume core results, atmosphere is independent, and none/standard leave UTC, observer, cameras, selection, clock anchor and independent day events unchanged.');

  await page.locator('#sky-pressure').fill('950.25');
  await page.locator('[data-action="play"]').click(); await page.waitForTimeout(380);
  await page.locator('#sky-temperature').fill('-25'); await page.waitForTimeout(380);
  assert.equal(await page.locator('#sky-pressure').inputValue(), '950.25'); assert.equal(await page.locator('#sky-temperature').inputValue(), '-25');
  await page.locator('[data-action="pause"]').click(); await paired(page);
  const paused = await state(page); await page.locator('#sky-temperature').fill('81'); await page.locator('#sky-apply-refraction').click();
  assert.deepEqual(await state(page), paused); assert.match(await page.locator('#sky-refraction-status').textContent(), /温度/);
  assert.equal(await page.locator('#sky-pressure').inputValue(), '950.25');
  await page.locator('#sky-temperature').fill('-25'); await page.locator('#sky-apply-refraction').click(); await paired(page);
  assert.equal((await state(page)).environment.pressureHpa, 950.25); assert.equal((await state(page)).environment.temperatureC, -25);
  await applyRefraction(page, 'standard', 0, -25); const p0 = await readouts(page); assert.equal(p0.apparentAltitudeDeg, p0.geometricAltitudeDeg);
  await applyRefraction(page, 'none', 950.25, -25); const noneAgain = await readouts(page); assert.equal(noneAgain.apparentAltitudeDeg, noneAgain.geometricAltitudeDeg);
  await applyRefraction(page, 'standard', 1013.25, 15);
  checks.push('Real slow P/T entry survives playing UI ticks; an invalid second parameter is atomic and keeps the entire draft, a successful retry applies both values, and none/P=0 give identity readouts.');

  const baseline = await state(page);
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await page.locator(`[data-view="${mode}"]`).click(); await paired(page);
    const switched = await state(page); unchanged(baseline, switched); assert.deepEqual(switched.environment, baseline.environment);
    if (mode !== 'ground') {
      assert.match(await page.locator('.mode-note').textContent(), /几何方向示意/);
      assert.match(await page.locator('#sky-refraction-scope').textContent(), /外部图形保持几何方向/);
      assert.match(await page.locator('.object-observer-scope').textContent(), /地点站心.*地心几何方向/);
    }
    await readouts(page);
  }
  await page.locator('#sky-pressure').fill('777'); await page.locator('#sky-import-file').setInputFiles({ name: 'm5c-standard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(baseline)) }); await paired(page);
  assert.deepEqual(await state(page), baseline); assert.equal(await page.locator('#sky-pressure').inputValue(), String(baseline.environment.pressureHpa));
  checks.push('Four views preserve saved standard/P/T, UTC and all cameras; external graphics are explicitly geometric while detail heights are local, and actual JSON-file import round trips the complete state and clears a focused parameter draft.');

  assert.equal(s08Inputs.status, 'derived-production-QA-inputs-not-independent-golden');
  assert.deepEqual(s08Inputs.rows.map(row => row.targetGeometricAltitudeDeg), [0, -6, -12, -18]);
  for (const row of s08Inputs.rows) {
    const input = structuredClone(noneState); input.time.utDaysJ2000 = row.utDaysJ2000;
    input.observer = row.observer; input.environment = row.geometricEnvironment;
    input.cameras.ground = { kind: 'ground', azimuthDegNorthEast: 270, altitudeDeg: 4, verticalFovDeg: 40 };
    await page.locator('#sky-import-file').setInputFiles({ name: `s08-${row.targetGeometricAltitudeDeg}-none.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) }); await paired(page);
    const geometry = await readouts(page); await applyRefraction(page, 'standard'); const apparent = await readouts(page);
    assert.equal(apparent.geometricAltitudeDeg, geometry.geometricAltitudeDeg);
    s08Rows.push({ targetGeometricAltitudeDeg: row.targetGeometricAltitudeDeg, suppliedUtc: row.utc, suppliedUt: row.utDaysJ2000, actualUt: (await state(page)).time.utDaysJ2000, actualGeometricAltitudeDeg: apparent.geometricAltitudeDeg, actualApparentAltitudeDeg: apparent.apparentAltitudeDeg });
    assert.equal(s08Rows.at(-1).actualUt, row.utDaysJ2000);
    if (row.targetGeometricAltitudeDeg === 0) { await page.locator('.object-heading').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/s08-zero-sun-dual-height.png` }); }
  }
  await page.locator('#sky-import-file').setInputFiles({ name: 'restore-m5c-standard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(baseline)) }); await paired(page);
  checks.push('Original S08 seed-derived production inputs at four descending solar thresholds load their exact saved UTs and show none/standard dual heights; the source fixture/hash is recorded as derived setup, never independent golden accuracy.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.controls-compact [aria-controls="sky-control-panel"]').click();
  await page.locator('.object-heading').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/390-dual-height.png` });
  await openRefraction(page);
  await page.locator('#sky-refraction').scrollIntoViewIfNeeded();
  for (const selector of ['#sky-refraction-mode', '#sky-pressure', '#sky-temperature', '#sky-apply-refraction']) assert.ok((await page.locator(selector).boundingBox()).height >= 44);
  assert.equal(await page.locator('#sky-control-panel').getAttribute('data-sky-dock'), 'bottom');
  assert.ok(await page.locator('#sky-control-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: `${out}/390-refraction-drawer.png` });
  const mobileBefore = await state(page); await page.locator('#sky-pressure').fill('950.25'); await page.locator('#sky-temperature').fill('81'); await page.locator('#sky-apply-refraction').click();
  assert.deepEqual(await state(page), mobileBefore); assert.equal(await page.locator('#sky-pressure').inputValue(), '950.25'); assert.equal(await page.locator('#sky-temperature').inputValue(), '81');
  assert.match(await page.locator('#sky-refraction-status').textContent(), /温度.*80/);
  await page.locator('#sky-refraction-status').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/390-error-draft.png` });
  await page.locator('#sky-temperature').fill('15'); await page.locator('#sky-apply-refraction').click(); await paired(page);
  await page.locator('#sky-teaching').evaluate(el => { el.open = true; }); await page.locator('#sky-moon-loupe-toggle').click();
  await page.locator('#sky-moon-loupe').waitFor({ state: 'visible' });
  assert.match(await page.locator('.moon-loupe-definition').textContent(), /科学月盘.*不含画面折射/);
  await page.screenshot({ path: `${out}/390-scientific-moon-loupe.png` }); await page.locator('#sky-moon-loupe-close').click();
  checks.push('At 390px the existing bottom drawer shows dual heights, the opened P/T form and a retained atomic error draft with 44px targets and no horizontal overflow; the loupe remains closable and marks a scientific Moon disc without display refraction.');
  await browser.close(); browsers.pop();

  const noGl = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] }); browsers.push(noGl);
  page = await noGl.newPage({ viewport: { width: 1152, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page, 'canvas2d'); await paired(page);
  const incoming = structuredClone(baseline); incoming.viewMode = 'space';
  await page.locator('#sky-import-file').setInputFiles({ name: 'm5c-canvas-preserved-space.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) }); await paired(page); await readyDay(page);
  assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d'); assert.deepEqual(await state(page), incoming);
  await openRefraction(page); assert.match(await page.locator('#sky-refraction-scope').textContent(), /2D方位图采用所选口径/);
  assert.doesNotMatch(await page.locator('.refraction-heading').textContent(), /外部保持几何/);
  assert.equal(await page.locator('.object-observer-scope').isVisible(), false); await readouts(page);
  const beforeCanvas = await state(page); await applyRefraction(page, 'none'); const afterCanvas = await state(page);
  unchanged(beforeCanvas, afterCanvas); assert.equal(afterCanvas.viewMode, 'space');
  await applyRefraction(page, 'standard'); await page.locator('.object-heading').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/canvas-local-height-preserved-space.png` });
  checks.push('Genuine no-WebGL Canvas uses local observer refraction semantics while keeping saved space/cameras; standard/none editing changes only environment and shows the same local dual-height values.');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await hashes(), beforeHashes, 'UI/state source must remain stable throughout the frozen UI test');
  if (publishedModule) {
    const response = await page.request.get(actualBuilds[0].moduleUrl); assert.ok(response.ok());
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), publishedModule.moduleSha256, 'The served frozen module must remain unchanged through the final step');
  }
} catch (error) { failure = error.stack ?? String(error); if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); throw error; }
finally {
  await Promise.all(browsers.map(browser => browser.close()));
  const afterHashes = await hashes();
  await writeFile(`${out}/report.json`, JSON.stringify({ url, stage: process.env.SKY_UI_QA_STAGE ?? 'development', focused: process.env.SKY_UI_QA_FOCUSED ?? null, actualBuilds, beforeHashes, afterHashes, sourceChanged: JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes), s08Inputs: { path: s08Path, sha256: s08Sha256, status: s08Inputs.status, originalSeedUtc: s08Inputs.originalSeedUtc, rows: s08Rows }, checks, errors, failure, browserClosed: true, limits: ['UI consumer/transaction semantics only; actual pixel mapping, inverse picking and model precision are validated by their owners.', 'No FPS, physical-phone or 30-minute claim.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
