import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit2 = vector => Math.hypot(...vector) < 1e-10 ? null : vector.map(value => value / Math.hypot(...vector));
function inverseQuaternionRotate(vector, quaternion) {
  const axis = quaternion.slice(0, 3).map(value => -value), t = cross(axis, vector).map(value => 2 * value), extra = cross(axis, t);
  return vector.map((value, i) => value + quaternion[3] * t[i] + extra[i]);
}
function independentLimbProjection(diagnostics) {
  const basis = diagnostics.displayBasis;
  const observer = basis.map(row => row[2]);
  const sun = diagnostics.scienceToDisplayBasis.map(row => dot(row, diagnostics.sunDirectionEqjUnit));
  const tangent = sun.map((value, i) => value - dot(sun, observer) * observer[i]);
  const orthographic = unit2([dot(tangent, basis.map(row => row[0])), dot(tangent, basis.map(row => row[1]))]);
  const cameraPoint = diagnostics.mainMoonPositionDisplay.map((value, i) => value - diagnostics.mainCameraPositionDisplay[i]);
  const epsilon = Math.max(1, Math.hypot(...cameraPoint)) * 1e-5;
  // Two actual nearby points, transformed independently by camera quaternion and perspective division.
  // In CSS pixels the x/y focal factors are equal: width/aspect == height. They cancel in direction.
  const project = sign => {
    const p = inverseQuaternionRotate(cameraPoint.map((value, i) => value + sign * epsilon * tangent[i]), diagnostics.mainCameraOrientationQuaternion);
    if (p[2] >= -1e-10) return null;
    return [-p[0] / p[2], -p[1] / p[2]];
  };
  const plus = project(1), minus = project(-1);
  const perspective = plus && minus ? unit2(plus.map((value, i) => value - minus[i])) : null;
  return { perspective, orthographic };
}

/** Browser workflows only. Scientific reference validation remains in the core/data suites. */
export async function runM3Checks({ page, outDir, report, shot, assertPaired }) {
  const stable = async (events = true) => {
    await assertPaired();
    await page.waitForFunction(() => window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode && window.skyApp.diagnostics.pendingInteractionCount === 0);
    if (events && await page.evaluate(() => window.skyApp.diagnostics.solarDay.enabled)) {
      await page.waitForFunction(() => {
        const data = window.skyApp.teachingData;
        return data.solarDayStatus === 'ready' && data.solarDayKey === window.skyApp.diagnostics.solarDayKey;
      }, undefined, { timeout: 30_000 });
    }
  };
  const openTeaching = async () => {
    if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
    await page.waitForFunction(() => window.skyApp.diagnostics.solarDay.enabled);
    await stable();
  };
  const apply = async values => {
    await page.evaluate(values => {
      const state = window.skyApp.state;
      state.time.running = false; state.time.mode = 'simulation';
      if (values.utc) state.time.utDaysJ2000 = (new Date(values.utc).getTime() - 946728000000) / 86400000;
      if (values.ut !== undefined) state.time.utDaysJ2000 = values.ut;
      if (values.latitude !== undefined) state.observer.latitudeDeg = values.latitude;
      if (values.longitude !== undefined) state.observer.longitudeDegEast = values.longitude;
      if (values.zone) state.observer.displayZone = values.zone;
      if (values.mode) state.viewMode = values.mode;
      if (values.selected !== undefined) state.selected = values.selected;
      window.skyApp.setState(state);
    }, values);
    await stable();
  };
  const loupe = async () => {
    await openTeaching();
    if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#sky-moon-loupe-toggle').click();
    await page.waitForFunction(() => {
      const app = window.skyApp, d = app.moonLoupeDiagnostics;
      return d?.open && d.status === 'ready' && d.textureLoaded && d.loupeDiameterCssPx > 0 && d.utDaysJ2000 === app.snapshot.utDaysJ2000;
    });
  };
  const focusMoon = async () => {
    await page.locator('#sky-search').fill('Moon');
    await page.locator('#sky-search').press('Enter'); await stable();
    const before = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.locator('[data-action="focus-selection"]').click();
    await page.waitForFunction(before => window.skyApp.diagnostics.renderCount > before, before);
    await stable();
  };
  const moonEvidence = async () => {
    const record = await page.evaluate(() => ({ state: window.skyApp.state, data: window.skyApp.teachingData, loupe: window.skyApp.moonLoupeDiagnostics, app: window.skyApp.diagnostics }));
    assert.equal(record.loupe.utDaysJ2000, record.state.time.utDaysJ2000);
    assert.equal(record.data.moon.utDaysJ2000, record.loupe.utDaysJ2000);
    assert.equal(record.loupe.illuminatedFraction, record.data.moon.illuminatedFraction);
    assert.deepEqual(record.loupe.bodyFixedToEqj, record.data.moon.bodyFixedToEqj);
    assert.deepEqual(record.loupe.sunDirectionEqjUnit, record.data.moon.sunDirectionEqjUnit);
    assert.deepEqual(record.loupe.observerDirectionEqjUnit, record.data.moon.observerDirectionEqjUnit);
    assert.equal(record.loupe.mainMoonMaterialId, record.loupe.loupeMoonMaterialId);
    assert.equal(record.loupe.mainMoonGeometryId, record.loupe.loupeMoonGeometryId);
    assert.equal(record.loupe.perspective, record.state.viewMode === 'ground' ? 'topocentric' : 'geocentric');
    const main = record.loupe.mainBrightLimbScreenUnit, inset = record.loupe.loupeBrightLimbScreenUnit;
    const oracle = independentLimbProjection(record.loupe);
    report.moonComparisonChecks ??= [];
    const mainError = main && oracle.perspective ? Math.hypot(main[0] - oracle.perspective[0], main[1] - oracle.perspective[1]) : null;
    const loupeError = inset && oracle.orthographic ? Math.hypot(inset[0] - oracle.orthographic[0], inset[1] - oracle.orthographic[1]) : null;
    report.moonComparisonChecks.push({ ut: record.loupe.utDaysJ2000, view: record.state.viewMode, phase: record.data.moon.phaseLongitudeDeg, main, inset, oracle, mainError, loupeError });
    assert.equal(Boolean(main), Boolean(oracle.perspective)); assert.equal(Boolean(inset), Boolean(oracle.orthographic));
    if (mainError !== null) assert.ok(mainError < 1e-6, '主图实际透视投影必须与独立两点投影一致');
    if (loupeError !== null) assert.ok(loupeError < 1e-6, '放大镜正交投影必须与独立物理切面basis一致');
    if (record.state.viewMode === 'ground' && main && inset) assert.ok(Math.hypot(main[0] - inset[0], main[1] - inset[1]) < 1e-6, '地表focus居中时主图与放大镜亮边一致');
    assert.ok(record.app.workerCount <= 2);
    return record;
  };
  report.moonEvidence = []; report.solarEvidence = []; report.calendarEvidence = [];
  await page.locator('.scene-section > summary').click();
  await page.locator('[data-scene="S09"]').click();
  await openTeaching();
  await page.locator('#sky-quarter-search').click();
  await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  const sequence = await page.evaluate(() => window.skyApp.teachingData.moonPhases);
  assert.equal(sequence.seedUtDaysJ2000, (Date.parse('2026-09-01T00:00:00Z') - 946728000000) / 86400000);
  assert.equal(sequence.events.length, 4);
  assert.deepEqual([...sequence.events.map(event => event.phaseLongitudeDeg)].sort((a, b) => a - b), [0, 90, 180, 270]);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#sky-quarter-export').click();
  const download = await downloadPromise;
  const phasePath = resolve(outDir, 'derived-moon-phases.json'); await download.saveAs(phasePath);
  const exported = JSON.parse(await readFile(phasePath, 'utf8'));
  assert.deepEqual(exported.events.map(({ utc, ...event }) => event), sequence.events);
  report.moonSequence = sequence; report.moonSequenceExport = phasePath;
  const eventUt = Number(await page.locator('.moon-quarter-events [data-event-ut]').first().getAttribute('data-event-ut'));
  const beforeJump = await page.evaluate(() => window.skyApp.state);
  await page.locator('.moon-quarter-events [data-event-ut]').first().click(); await stable();
  const afterJump = await page.evaluate(() => window.skyApp.state);
  assert.equal(afterJump.time.utDaysJ2000, eventUt); assert.equal(afterJump.time.running, false);
  assert.deepEqual(afterJump.observer, beforeJump.observer); assert.deepEqual(afterJump.cameras, beforeJump.cameras);
  await loupe();
  for (const event of sequence.events) {
    await apply({ ut: event.utDaysJ2000, mode: 'ground', latitude: 30.25, longitude: 120.17, selected: 'body:Moon' });
    await focusMoon(); await loupe();
    const record = await moonEvidence();
    const phaseError = Math.abs(((record.data.moon.phaseLongitudeDeg - event.phaseLongitudeDeg + 540) % 360) - 180);
    assert.ok(phaseError < .001);
    if (event.phaseLongitudeDeg === 0) assert.ok(record.data.moon.illuminatedFraction < .01);
    if (event.phaseLongitudeDeg === 180) assert.ok(record.data.moon.illuminatedFraction > .99);
    if (event.phaseLongitudeDeg === 90 || event.phaseLongitudeDeg === 270) assert.ok(Math.abs(record.data.moon.illuminatedFraction - .5) < .03);
    report.moonEvidence.push({ event, hemisphere: 'north', ...record });
    await shot(`moon-north-${event.phaseLongitudeDeg}.png`);
    if (event.phaseLongitudeDeg === 90 || event.phaseLongitudeDeg === 270) {
      await apply({ ut: event.utDaysJ2000, mode: 'ground', latitude: -30.25, longitude: 120.17, selected: 'body:Moon' });
      await focusMoon(); await loupe();
      report.moonEvidence.push({ event, hemisphere: 'south', ...await moonEvidence() });
      await shot(`moon-south-${event.phaseLongitudeDeg}.png`);
    }
  }
  const quarter = sequence.events.find(event => event.phaseLongitudeDeg === 90);
  await apply({ ut: quarter.utDaysJ2000, latitude: 30.25, mode: 'ground', selected: 'body:Moon' });
  const invariant = await page.evaluate(() => ({ ut: window.skyApp.state.time.utDaysJ2000, observer: window.skyApp.state.observer }));
  for (const mode of ['ground', 'space', 'globe', 'horizon']) {
    await page.locator(`[data-view="${mode}"]`).click(); await stable();
    await focusMoon(); await loupe();
    const record = await moonEvidence();
    assert.equal(record.state.time.utDaysJ2000, invariant.ut); assert.deepEqual(record.state.observer, invariant.observer);
    report.moonEvidence.push({ mode, ...record });
    await shot(`moon-quarter-${mode}.png`);
  }
  report.assertions.push('S09 searches four adjacent quarter events once from its explicit seed, exports actual derived UTC instants, and an event button pauses the one clock without changing observer/cameras.', 'North/south ground and all four views use the current snapshot MoonAppearance. Main/loupe share real material/geometry and physical directions; an independent two-point perspective oracle and an orthographic tangent-basis oracle validate their distinct screen projections. Ground focus retains equal bright-limb directions.');
  for (const [utc, expected] of [['2026-06-21T12:00:00Z', 'continuous-daylight'], ['2026-12-21T12:00:00Z', 'no-sunrise']]) {
    await apply({ utc, latitude: 69.65, longitude: 18.96, mode: 'horizon', zone: { kind: 'iana', name: 'Europe/Oslo', versionNote: 'QA host ICU/timezone database, browser version recorded separately' } });
    const data = await page.evaluate(() => window.skyApp.teachingData);
    assert.equal(data.solarDay.state, expected);
    assert.equal(data.solarDay.riseUtDaysJ2000, null); assert.equal(data.solarDay.setUtDaysJ2000, null);
    assert.ok(data.solarDay.noEventReason);
    assert.equal(await page.locator('.twilight-row').count(), 3);
    assert.ok(!await page.locator('.solar-day-section').textContent().then(text => /NaN|Invalid Date|undefined/.test(text)));
    report.solarEvidence.push(data);
    await page.locator('.solar-day-heading').scrollIntoViewIfNeeded();
    await shot(`solar-tromso-${expected}.png`);
  }
  await apply({ utc: '2026-03-08T12:00:00Z', latitude: 40.7128, longitude: -74.006, zone: { kind: 'iana', name: 'America/New_York', versionNote: 'QA host ICU/timezone database' } });
  const dst = await page.evaluate(() => window.skyApp.teachingData.solarDay);
  assert.ok(Math.abs((dst.bounds.endUtDaysJ2000 - dst.bounds.startUtDaysJ2000) * 24 - 23) < 1e-7);
  report.solarEvidence.push(dst);
  const solarUt = Number(await page.locator('.solar-day-events [data-event-ut]').first().getAttribute('data-event-ut'));
  await page.locator('.solar-day-events [data-event-ut]').first().click(); await stable();
  assert.equal(await page.evaluate(() => window.skyApp.state.time.utDaysJ2000), solarUt);
  report.assertions.push('Tromsø summer/winter present explicit no-rise/set reasons and all three twilight thresholds; New York DST civil-day bounds last 23 hours and a solar event button jumps to its exact UTC.');
  await apply({ utc: '2026-09-14T14:00:00Z', zone: { kind: 'fixed', offsetMinutes: 480 } });
  const calendar = await page.evaluate(() => window.skyApp.teachingData.lunarCalendar);
  await apply({ zone: { kind: 'fixed', offsetMinutes: -300 } });
  assert.deepEqual(await page.evaluate(() => window.skyApp.teachingData.lunarCalendar), calendar);
  for (const [utc, available] of [['1900-12-31T15:59:59Z', false], ['1900-12-31T16:00:00Z', true], ['2100-12-31T15:59:59Z', true], ['2100-12-31T16:00:00Z', false], ['2057-10-01T12:00:00Z', true]]) {
    await apply({ utc });
    const info = await page.evaluate(() => window.skyApp.teachingData.lunarCalendar);
    assert.equal(info.available, available);
    if (!available) assert.equal(info.label, '未提供已验证农历');
    if (utc.startsWith('2057')) { assert.equal(info.uncertain, true); assert.ok((await page.locator('.lunar-calendar-readout').getAttribute('title')).includes('差异')); }
    report.calendarEvidence.push({ utc, ...info });
  }
  report.assertions.push('Lunar-calendar civil date stays UTC+8 when observer zone changes; 1901–2100 boundaries and the retained 2057 HKO uncertainty are visible.');
  await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => !window.skyApp.diagnostics.solarDay.enabled);
  const closedCount = await page.evaluate(() => window.skyApp.diagnostics.solarDay.startedCount);
  await page.evaluate(() => { const state = window.skyApp.state; state.time.utDaysJ2000 = (Date.parse('2026-09-14T14:00:00Z') - 946728000000) / 86400000; for (let i = 0; i < 20; i++) { state.time.utDaysJ2000 += 1; state.observer.latitudeDeg = i; window.skyApp.setState(state); } });
  await stable(false); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.solarDay.startedCount), closedCount);
  await openTeaching();
  await page.evaluate(() => { const state = window.skyApp.state; for (let i = 0; i < 20; i++) { state.time.utDaysJ2000 += 1; state.observer.longitudeDegEast = i; window.skyApp.setState(state); } });
  await stable();
  const latest = await page.evaluate(() => ({ state: window.skyApp.state, data: window.skyApp.teachingData, d: window.skyApp.diagnostics }));
  assert.equal(latest.state.observer.longitudeDegEast, 19);
  assert.equal(latest.data.solarDayKey, latest.d.solarDayKey);
  assert.ok(latest.d.solarDay.activeRequestCount <= 1 && latest.d.solarDay.pendingLatestRequestCount <= 1);
  report.latestSolarDayEvidence = latest;
  for (let i = 0; i < 18; i++) { await page.evaluate(() => { const state = window.skyApp.state; state.time.utDaysJ2000 += 1; window.skyApp.setState(state); }); await stable(); }
  const bounded = await page.evaluate(() => window.skyApp.diagnostics.solarDay);
  assert.ok(bounded.cache.cacheEntries <= 16); assert.ok(bounded.cache.cacheEvictions > 0);
  const sameDayCount = bounded.startedCount;
  await page.locator('[data-step="3600"]').click(); await stable();
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.solarDay.startedCount), sameDayCount);
  const paused = await page.evaluate(() => window.skyApp.diagnostics);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), paused.renderCount);
  report.boundedSolarDayCache = bounded;
  report.assertions.push('Closed teaching area starts no day searches; rapid date/location changes converge to the latest key with bounded queues. More than 16 days evict cache entries, same-day +1h does not resubmit, and paused idle stops rendering.');
  await apply({ utc: '2026-09-18T12:00:00Z', latitude: 30.25, longitude: 120.17, zone: { kind: 'fixed', offsetMinutes: 480 }, mode: 'ground', selected: 'body:Moon' });
  await focusMoon(); await loupe(); await shot('m3-workflow-final.png');
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.locator('#controls').evaluate(element => element.classList.contains('drawer-open'))) await page.locator('.controls-drawer-toggle').click();
  if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') === 'true') await page.locator('#sky-moon-loupe-close').click();
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.loupeDiameterCssPx > 0);
  await assertPaired(); await page.waitForTimeout(350); await shot('mobile-moon-loupe-390x844.png');
  report.mobileMoonEvidence = await page.evaluate(() => ({ state: window.skyApp.state, moon: window.skyApp.moonLoupeDiagnostics, teachingVisible: window.skyApp.diagnostics.solarDay.enabled }));
  assert.equal(report.mobileMoonEvidence.teachingVisible, false, 'mobile放大镜独立可见，收起教学drawer停止事件请求');
  if (process.env.SKY_QA_PORTABLE === '1') report.assertions.push('The same M3 workflow ran from the standalone file artifact.');
  report.limitations.push('This batch covers Moon/lunar calendar/solar events. Milky Way and full light-pollution work remain a separate M3 batch.', 'Browser viewport and screenshots do not certify physical mobile hardware, GPU completed displayed FPS, or historical event accuracy.');
  report.status = 'passed-m3-first-batch-browser-functional-checks';
}

/** Representative M3 scene for final short diagnostics, with Moon and teaching work enabled. */
export async function prepareM3Scene(page) {
  await page.evaluate(() => {
    const state = window.skyApp.state;
    state.time.running = false; state.time.mode = 'simulation'; state.time.rateSimSecondsPerRealSecond = 600;
    state.time.utDaysJ2000 = (Date.parse('2026-09-18T12:00:00Z') - 946728000000) / 86400000;
    state.observer.latitudeDeg = 30.25; state.observer.longitudeDegEast = 120.17; state.observer.heightMeters = 20;
    state.observer.displayZone = { kind: 'fixed', offsetMinutes: 480 };
    state.viewMode = 'ground'; state.selected = 'body:Moon'; state.illustration.bodySizeScale = 1;
    state.layers.sunMoon = true; state.layers.constellationLines = true; state.layers.constellationLabels = true; state.layers.brightStarNamesZh = true;
    window.skyApp.setState(state);
  });
  await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.loupeDiameterCssPx > 0);
  await page.locator('[data-action="focus-selection"]').click();
  await page.waitForFunction(() => window.skyApp.diagnostics.pendingInteractionCount === 0 && window.skyApp.diagnostics.lastFocusSucceeded === true);
  return page.evaluate(() => ({ state: window.skyApp.state, moonLoupe: window.skyApp.moonLoupeDiagnostics, teachingData: window.skyApp.teachingData, events: window.skyApp.diagnostics.solarDay }));
}

export async function recordM3Workflow({ page, report, shot, assertPaired }) {
  report.representativeScene = await prepareM3Scene(page);
  assert.equal(report.representativeScene.state.illustration.bodySizeScale, 1);
  await page.locator('#sky-quarter-search').click();
  await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  await page.waitForTimeout(1000);
  await page.mouse.move(620, 410); await page.mouse.down();
  for (let index = 0; index < 30; index++) { await page.mouse.move(620 + index * 3, 410 + index); await page.waitForTimeout(35); }
  await page.mouse.up();
  await page.locator('[data-action="play"]').click(); await page.waitForTimeout(2500);
  await page.locator('[data-action="pause"]').click(); await assertPaired(); await page.waitForTimeout(500);
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await page.locator(`[data-view="${mode}"]`).click(); await assertPaired();
    await page.locator('[data-action="focus-selection"]').click();
    await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.utDaysJ2000 === window.skyApp.snapshot.utDaysJ2000);
    await page.waitForTimeout(1000);
  }
  if (!await page.locator('.scene-section').evaluate(element => element.open)) await page.locator('.scene-section > summary').click();
  for (const scene of ['S05', 'S06']) {
    await page.locator(`[data-scene="${scene}"]`).click(); await assertPaired();
    await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
    await page.locator('.solar-day-heading').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
  }
  report.finalTeachingData = await page.evaluate(() => window.skyApp.teachingData);
  await shot('recording-m3-final.png');
  report.assertions.push('Actual browser video shows ordinary labels, scale1 Sun/Moon with the shared Moon loupe, native ground drag, 600x playback, four views and explicit summer/winter polar-event results.', 'The quarter-search control uses the existing single clock; captured frames are browser frames with the full UI.');
  report.status = 'recorded-awaiting-human-review';
  report.recordingScope = 'Playwright viewport video with actual rendering and full UI; no generated or composite frames.';
}

export async function runM3OfflineSmoke({ page, shot, name }) {
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.loupeDiameterCssPx > 0);
  await page.locator('#sky-quarter-search').click();
  await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  const evidence = await page.evaluate(() => ({ teaching: window.skyApp.teachingData, moon: window.skyApp.moonLoupeDiagnostics, diagnostics: window.skyApp.diagnostics }));
  assert.ok(evidence.diagnostics.assetStatus.loaded.includes('uMoon'));
  assert.equal(evidence.moon.utDaysJ2000, evidence.teaching.moon.utDaysJ2000);
  assert.equal(evidence.teaching.solarDayKey, evidence.diagnostics.solarDayKey);
  assert.equal(evidence.teaching.lunarCalendar.calendarZone, 'UTC+08:00');
  assert.equal(evidence.teaching.moonPhases.events.length, 4);
  await shot(name);
  return evidence;
}
