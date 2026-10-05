import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function waitMilkyWayReady(page, width = 2048) {
  await page.waitForFunction(width => {
    const app = window.skyApp, d = app.skyAppearanceDiagnostics, a = app.diagnostics.assetStatus;
    return d?.textureLoaded && d.textureDimensions[0] === width && d.residentMilkyWayTextureCount === 1
      && a.loaded.includes('uMilkyWay') && a.pending.length === 0 && a.errors.length === 0 && !app.diagnostics.assetWarning;
  }, width, { timeout: 30_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
export async function skyPixelStats(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#sky-stage canvas');
    const copy = document.createElement('canvas'); copy.width = 144; copy.height = 90;
    const ctx = copy.getContext('2d');
    ctx.drawImage(canvas, canvas.width * .3, canvas.height * .15, canvas.width * .5, canvas.height * .5, 0, 0, 144, 90);
    const rgba = ctx.getImageData(0, 0, 144, 90).data, values = [];
    for (let i = 0; i < rgba.length; i += 4) values.push(.2126 * rgba[i] + .7152 * rgba[i + 1] + .0722 * rgba[i + 2]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const rms = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    values.sort((a, b) => a - b);
    return { mean, rms, median: values[Math.floor(values.length / 2)], p90: values[Math.floor(values.length * .9)], samplePixels: values.length, scope: 'Actual WebGL image ROI in display RGB; no calibrated sky luminance or stellar photometry.' };
  });
}
export async function prepareM3bScene(page) {
  if (!await page.locator('.scene-section').evaluate(element => element.open)) await page.locator('.scene-section > summary').click();
  await page.locator('[data-sky-scene="G01"]').click();
  await page.waitForFunction(() => !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000 && window.skyApp.skyAppearanceDiagnostics?.model?.reason === 'ground-observation');
  await waitMilkyWayReady(page);
  if (!await page.locator('.appearance-controls').evaluate(element => element.open)) await page.locator('.appearance-controls > summary').click();
  return page.evaluate(() => ({ state: window.skyApp.state, model: window.skyApp.skyAppearance, renderer: window.skyApp.skyAppearanceDiagnostics, metrics: window.skyApp.metrics }));
}
export async function prepareM3bPerformance(page) {
  const scene = await prepareM3bScene(page);
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#sky-moon-loupe-toggle').click();
  await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open && window.skyApp.moonLoupeDiagnostics.loupeDiameterCssPx > 0);
  return { ...scene, moonLoupe: await page.evaluate(() => window.skyApp.moonLoupeDiagnostics), teachingData: await page.evaluate(() => window.skyApp.teachingData) };
}
export async function runM3bOfflineSmoke({ page, shot, name }) {
  await waitMilkyWayReady(page);
  const utc = await page.evaluate(() => window.skyApp.state.time.utDaysJ2000);
  if (!await page.locator('.appearance-controls').evaluate(element => element.open)) await page.locator('.appearance-controls > summary').click();
  if (await page.locator('#sky-observe-appearance').isVisible()) await page.locator('#sky-observe-appearance').click();
  await page.locator('[data-sky-light="0.5"]').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const evidence = await page.evaluate(() => ({ state: window.skyApp.state, model: window.skyApp.skyAppearance, actual: window.skyApp.skyAppearanceDiagnostics, assets: window.skyApp.diagnostics.assetStatus }));
  assert.equal(evidence.state.time.utDaysJ2000, utc); assert.equal(evidence.actual.model.artificialLightStrength, .5);
  assert.deepEqual(evidence.actual.model, evidence.model); assert.equal(evidence.actual.residentMilkyWayTextureCount, 1);
  assert.ok(['uDay', 'uNight', 'uClouds', 'uMoon', 'uMilkyWay'].every(id => evidence.assets.loaded.includes(id)));
  await shot(name); return evidence;
}
export async function recordM3bWorkflow({ page, report, shot }) {
  report.representativeScene = await prepareM3bScene(page); await page.waitForTimeout(1000);
  for (const value of [.5, 1, 0]) { await page.locator(`[data-sky-light="${value}"]`).click(); await page.waitForTimeout(1400); }
  await page.locator('input[data-layer="milkyWay"]').uncheck(); await page.waitForTimeout(1000);
  await page.locator('input[data-layer="milkyWay"]').check(); await page.waitForTimeout(1000);
  await page.mouse.move(700, 320); await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(700 + i * 3, 320 + i); await page.waitForTimeout(30); } await page.mouse.up();
  await page.locator('[data-sky-light="1"]').click();
  for (const mode of ['space', 'globe', 'horizon']) { await page.locator(`[data-view="${mode}"]`).click(); await page.waitForFunction(mode => window.skyApp.diagnostics.lastRenderedMode === mode, mode); await page.waitForTimeout(1100); }
  await page.locator('#sky-observe-appearance').click();
  await page.locator('#sky-presentation').selectOption('explanation'); await page.waitForTimeout(1400);
  await page.locator('#sky-presentation').selectOption('observation'); await page.locator('[data-sky-light="0"]').click(); await page.waitForTimeout(1000);
  await page.setViewportSize({ width: 390, height: 844 }); await waitMilkyWayReady(page, 1024); await page.waitForTimeout(1500); await shot('mobile-m3b-recording.png');
  await page.setViewportSize({ width: 1152, height: 720 }); await waitMilkyWayReady(page); await page.waitForTimeout(1000); await shot('recording-m3b-final.png');
  report.assertions.push('Real browser video shows native pollution 0/.5/1, Milky Way off/on, sky drag, four actual views and explanation/observation scope.', 'A 390px mobile viewport switches to the actual 1K image and returns to 2K; no generated or composite video frames.');
  report.status = 'recorded-awaiting-human-review'; report.recordingScope = 'Actual Playwright viewport video with full UI; encoded video rate is not GPU displayed FPS.';
}
export async function runM3bChecks({ page, outDir, report, shot, assertPaired }) {
  const records = JSON.parse(await readFile('assets/runtime/star-meta.json', 'utf8'));
  report.baselineM3b = await prepareM3bScene(page);
  const steady = async () => {
    await assertPaired();
    await page.waitForFunction(() => window.skyApp.skyAppearanceDiagnostics?.utDaysJ2000 === window.skyApp.snapshot.utDaysJ2000 && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const changeAndDraw = async action => {
    const before = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await action();
    await page.waitForFunction(before => window.skyApp.diagnostics.renderCount > before, before); await steady();
  };
  const inspect = async () => {
    const result = await page.evaluate(() => ({ state: window.skyApp.state, model: window.skyApp.skyAppearance, renderer: window.skyApp.skyAppearanceDiagnostics, app: window.skyApp.diagnostics, metrics: window.skyApp.metrics }));
    assert.deepEqual(result.renderer.model, result.model);
    for (const [uniform, field] of [['limitingMagnitude', 'limitingMagnitude'], ['starVisibility', 'starVisibility'], ['milkyWayContrast', 'milkyWayContrast'], ['backgroundLinearRgb', 'backgroundLinearRgb'], ['horizonGlowLinearRgb', 'horizonGlowLinearRgb']]) assert.deepEqual(result.renderer.uniforms[uniform], result.model[field]);
    assert.equal(result.renderer.sharedFrameMatchesInverse, true);
    assert.equal(result.app.lastRenderedUt, result.renderer.utDaysJ2000);
    assert.equal(result.renderer.residentMilkyWayTextureCount, 1);
    return result;
  };
  const invariant = await page.evaluate(() => ({ time: window.skyApp.state.time, observer: window.skyApp.state.observer, selected: window.skyApp.state.selected, cameras: window.skyApp.state.cameras }));
  report.pollutionEvidence = [];
  for (const value of [0, .5, 1]) {
    await changeAndDraw(() => page.locator(`[data-sky-light="${value}"]`).click());
    const record = await inspect(); record.pixels = await skyPixelStats(page);
    record.catalogWithinModelLimitCount = records.filter(row => row[5] <= record.model.limitingMagnitude).length;
    assert.equal(record.model.artificialLightStrength, value); assert.equal(record.model.moonlightStrength, 0); assert.equal(record.model.daylightStrength, 0);
    assert.deepEqual({ time: record.state.time, observer: record.state.observer, selected: record.state.selected, cameras: record.state.cameras }, invariant);
    report.pollutionEvidence.push(record); await shot(`ground-pollution-${value}.png`);
  }
  for (let i = 1; i < 3; i++) {
    assert.ok(report.pollutionEvidence[i].model.limitingMagnitude < report.pollutionEvidence[i - 1].model.limitingMagnitude);
    assert.ok(report.pollutionEvidence[i].catalogWithinModelLimitCount < report.pollutionEvidence[i - 1].catalogWithinModelLimitCount);
    assert.ok(report.pollutionEvidence[i].model.milkyWayContrast < report.pollutionEvidence[i - 1].model.milkyWayContrast);
    assert.ok(report.pollutionEvidence[i].pixels.median > report.pollutionEvidence[i - 1].pixels.median, '实际天空ROI应随人工亮度提高');
  }
  report.assertions.push('Native 0/.5/1 controls preserve time, observer, selection and all cameras. Model, actual GPU uniforms, catalog threshold counts and actual background pixels respond together; all numbers remain qualitative.');
  await changeAndDraw(() => page.locator('[data-sky-light="0"]').click());
  report.galaxyViews = [];
  for (const mode of ['ground', 'space', 'globe', 'horizon']) {
    if (await page.evaluate(() => window.skyApp.state.viewMode) !== mode) await changeAndDraw(() => page.locator(`[data-view="${mode}"]`).click());
    const enabled = await inspect(); enabled.pixels = await skyPixelStats(page);
    for (const sample of enabled.renderer.directionSamples) {
      const [x, y, z] = sample.directionEqj, length = Math.hypot(x, y, z);
      const u = ((.5 - Math.atan2(y, x) / (2 * Math.PI)) % 1 + 1) % 1, v = .5 + Math.asin(z / length) / Math.PI;
      assert.ok(Math.abs(sample.uv[0] - u) < 1e-12 && Math.abs(sample.uv[1] - v) < 1e-12);
      const world = enabled.renderer.frameToDisplay.map(row => row.reduce((sum, value, i) => sum + value * sample.directionEqj[i], 0));
      const inverse = enabled.renderer.inverseFrameToEqj.map(row => row.reduce((sum, value, i) => sum + value * world[i], 0));
      assert.ok(Math.hypot(...inverse.map((value, i) => value - sample.directionEqj[i])) < 1e-10);
    }
    await shot(`milky-way-${mode}-on.png`);
    await changeAndDraw(() => page.locator('input[data-layer="milkyWay"]').uncheck());
    const disabled = await inspect(); disabled.pixels = await skyPixelStats(page);
    assert.equal(disabled.renderer.milkyWayEnabled, false);
    assert.ok(Math.abs(enabled.pixels.mean - disabled.pixels.mean) > .01, `${mode}真实画面需要银河开关差异`);
    await shot(`milky-way-${mode}-off.png`);
    await changeAndDraw(() => page.locator('input[data-layer="milkyWay"]').check());
    report.galaxyViews.push({ mode, enabled, disabled });
    if (mode !== 'ground') { assert.equal(enabled.model.reason, 'external-diagram'); assert.equal(enabled.model.artificialLightStrength, 0); }
  }
  report.assertions.push('All four actual views show a Milky Way toggle pixel difference. Every named direction/UV anchor and its shared frame inverse is checked independently.');
  await changeAndDraw(() => page.locator('#sky-observe-appearance').click());
  await changeAndDraw(() => page.locator('[data-sky-light="1"]').click());
  await changeAndDraw(() => page.locator('#sky-presentation').selectOption('explanation'));
  const explanation = await inspect(); assert.equal(explanation.model.reason, 'ground-explanation'); assert.equal(explanation.model.limitingMagnitude, explanation.state.environment.darkSkyLimitingMagnitude);
  assert.equal(explanation.model.milkyWayContrast, 1); assert.equal(explanation.model.artificialLightStrength, 0);
  await shot('explanation-preserves-sky.png');
  await changeAndDraw(() => page.locator('#sky-presentation').selectOption('observation'));
  await changeAndDraw(() => page.locator('input[data-layer="atmosphere"]').uncheck());
  const noAtmosphere = await inspect(); assert.equal(noAtmosphere.model.reason, 'atmosphere-disabled'); assert.equal(noAtmosphere.model.skyBrightness, 0); await shot('atmosphere-disabled.png');
  await changeAndDraw(() => page.locator('#sky-observe-appearance').click());
  report.scopeEvidence = { explanation, noAtmosphere };
  await page.evaluate(() => { const state = window.skyApp.state; state.time.utDaysJ2000 = (Date.parse('2026-09-26T14:00:00Z') - 946728000000) / 86400000; state.environment.artificialSkyBrightness = 0; state.environment.moonlightEnabled = true; window.skyApp.setState(state); }); await steady();
  const moonOn = await inspect(); assert.ok(moonOn.model.moonAltitudeDeg > 0 && moonOn.model.moonlightStrength > 0);
  await changeAndDraw(() => page.locator('#sky-moonlight').uncheck());
  const moonOff = await inspect(); assert.equal(moonOff.model.moonlightStrength, 0); assert.ok(moonOff.model.milkyWayContrast > moonOn.model.milkyWayContrast);
  await changeAndDraw(() => page.locator('#sky-moonlight').check());
  await changeAndDraw(() => page.locator('input[data-layer="sunMoon"]').uncheck());
  assert.equal((await inspect()).model.moonlightStrength, moonOn.model.moonlightStrength);
  report.moonlightEvidence = { moonOn, moonOff };
  for (const utc of ['2026-08-14T21:30:00Z', '2026-08-15T04:00:00Z']) {
    await page.evaluate(utc => { const state = window.skyApp.state; state.time.utDaysJ2000 = (Date.parse(utc) - 946728000000) / 86400000; state.layers.sunMoon = true; window.skyApp.setState(state); }, utc); await steady();
    const twilight = await inspect(); assert.ok(twilight.model.daylightStrength > 0); report.twilightEvidence ??= []; report.twilightEvidence.push(twilight); await shot(`twilight-${report.twilightEvidence.length}.png`);
  }
  const daylightBaseline = await inspect(); assert.equal(daylightBaseline.model.daylightStrength, 1);
  await changeAndDraw(() => page.locator('[data-sky-light="1"]').click());
  const daylightCity = await inspect();
  assert.deepEqual(daylightCity.model.backgroundLinearRgb, daylightBaseline.model.backgroundLinearRgb);
  assert.deepEqual(daylightCity.model.horizonGlowLinearRgb, daylightBaseline.model.horizonGlowLinearRgb);
  report.daylightColorEvidence = { natural: daylightBaseline, artificial: daylightCity };
  await shot('daylight-city-background.png');
  report.assertions.push('At daylight strength 1, artificial illumination adds no background or horizon RGB tint; the same corrected core colors reach actual GPU uniforms.');
  report.assertions.push('Explanation/external/atmosphere-disabled semantics match the shared model. Above-horizon full Moon and twilight affect visibility, while hiding Sun/Moon graphics preserves physical moonlight.');
  await prepareM3bScene(page); await steady();
  const stableCount = await page.evaluate(() => ({ requests: window.skyApp.diagnostics.scienceRequestCount, anchors: window.skyApp.diagnostics.clockRebaseCount }));
  const storm = await page.evaluate(() => { const before = window.skyApp.diagnostics, slider = document.querySelector('#sky-artificial-light'); for (let i = 0; i < 40; i++) { slider.value = String(i / 39); slider.dispatchEvent(new Event('input', { bubbles: true })); } return { before, after: window.skyApp.diagnostics }; });
  assert.equal(storm.after.scienceRequestCount, stableCount.requests); assert.equal(storm.after.clockRebaseCount, stableCount.anchors); await steady();
  await page.waitForTimeout(200); const idleCount = await page.evaluate(() => window.skyApp.diagnostics.renderCount); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), idleCount);
  await page.evaluate(() => window.skyApp.play()); await page.waitForTimeout(200);
  const playingStorm = await page.evaluate(() => { const before = window.skyApp.diagnostics, slider = document.querySelector('#sky-artificial-light'); for (let i = 0; i < 40; i++) { slider.value = String(i / 39); slider.dispatchEvent(new Event('input', { bubbles: true })); } return { before, after: window.skyApp.diagnostics }; });
  assert.equal(playingStorm.after.scienceRequestCount, playingStorm.before.scienceRequestCount); assert.equal(playingStorm.after.clockRebaseCount, playingStorm.before.clockRebaseCount);
  await page.evaluate(() => window.skyApp.pause()); await steady(); report.environmentInputStorm = { storm, playingStorm };
  report.assertions.push('Forty synchronous native environment inputs create no science requests or clock rebases, both paused and playing. Paused redraw converges then becomes idle.');
  await prepareM3bScene(page); await steady();
  report.resizeEvidence = [];
  for (const [width, height, textureWidth] of [[390, 844, 1024], [1152, 720, 2048]]) {
    await page.setViewportSize({ width, height }); await waitMilkyWayReady(page, textureWidth); await steady();
    const resized = await inspect(); resized.pixels = await skyPixelStats(page); assert.equal(resized.renderer.textureDimensions[0], textureWidth); assert.equal(resized.renderer.residentMilkyWayTextureCount, 1); report.resizeEvidence.push(resized); await shot(`texture-${textureWidth}-${width}x${height}.png`);
  }
  for (let i = 0; i < 12; i++) await page.setViewportSize(i % 2 ? { width: 1152, height: 720 } : { width: 390, height: 844 });
  await waitMilkyWayReady(page, 2048); await steady(); await page.waitForTimeout(200);
  const resizedFinal = await inspect(); assert.deepEqual(resizedFinal.renderer.textureDimensions, [2048, 1024]); assert.equal(resizedFinal.renderer.residentMilkyWayTextureCount, 1); report.resizeFinal = resizedFinal;
  report.assertions.push('1152→390→1152 uploads actual 2K→1K→2K images with one resident Milky Way texture. Rapid alternating resize cannot refill an old resolution.');
  // Minimal previous-batch smoke: four explicit phase jumps, one solar-day result and UTC+8 calendar.
  if (!await page.locator('#sky-teaching').evaluate(element => element.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => window.skyApp.teachingData.solarDayStatus === 'ready');
  await page.locator('#sky-quarter-search').click(); await page.waitForFunction(() => window.skyApp.teachingData.moonPhaseStatus === 'ready');
  report.m3Regression = { solarDay: await page.evaluate(() => window.skyApp.teachingData.solarDay), lunar: await page.evaluate(() => window.skyApp.teachingData.lunarCalendar), phases: [] };
  for (let i = 0; i < 4; i++) {
    const button = page.locator('.moon-quarter-events [data-event-ut]').nth(i), ut = Number(await button.getAttribute('data-event-ut'));
    await button.click(); await steady();
    const data = await page.evaluate(() => ({ state: window.skyApp.state, data: window.skyApp.teachingData })); assert.equal(data.state.time.utDaysJ2000, ut); assert.equal(data.state.time.running, false); assert.equal(data.data.moon.utDaysJ2000, ut); report.m3Regression.phases.push(data);
  }
  await prepareM3bScene(page); await steady(); await shot('m3b-final-ground.png');
  report.status = 'passed-m3b-browser-functional-checks';
  report.limitations.push('Pixel ROI statistics use display RGB and include the actual rendered scene; they are not calibrated astronomical photometry. Texture directions are static approximate J2000, not historical Milky Way evolution.', 'Mobile browser viewport is tested; physical mobile hardware and 30-minute continuous playback remain untested.');
}
