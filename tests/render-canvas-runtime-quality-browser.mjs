import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const baseUrl = process.env.SKY_CANVAS_URL ?? 'http://127.0.0.1:5173/';
const url = new URL('qa/m6-canvas/renderer-harness.html', baseUrl).href;
const out = process.env.SKY_CANVAS_OUT ?? 'qa/m6-canvas/development';
await mkdir(out, { recursive: true });
const sources = ['src/render/CanvasSkyRenderer.ts', 'src/render/CanvasRuntimeQuality.ts', 'src/render/CanvasSkyProjection.ts',
  'src/render/LabelLayer.ts', 'src/render/RenderQuality.ts', 'src/platform/runtime-quality-contract.ts',
  'src/core/refraction.ts', 'src/render/SphericalArcBuffer.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const fixture = JSON.parse(await readFile('qa/m5c-canvas/development/report.json', 'utf8')).bodies.find(body => body.id === 'body:Moon').picked.state;
fixture.selected = 'hip:32349'; fixture.density = 'reference'; fixture.layers.secondaryNames = true;
fixture.layers.brightStarNamesZh = true; fixture.layers.constellationLines = true; fixture.layers.constellationLabels = true;
const report = { url, scope: 'Development source, real CanvasSkyRenderer and core snapshot; runtime override consumption, same-context pixels, PNG composition and native input. No main/controller, final-bundle, performance or physical-device claim.',
  sourceBefore: await hashes(), emulation: { viewport: [1152, 720], deviceScaleFactor: 1.5 }, samples: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.5 });
report.browserVersion = browser.version(); let failure;
try {
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto(url); await page.waitForFunction(() => window.canvasQualityQa?.renderCount > 0);
  const setupCount = await page.evaluate(state => { const qa = window.canvasQualityQa, count = qa.renderCount; qa.setState(state); return count; }, fixture);
  await page.waitForFunction(count => window.canvasQualityQa.renderCount > count, setupCount);
  await page.waitForTimeout(120);
  report.identity = await page.evaluate(() => {
    const qa = window.canvasQualityQa; qa.renderNow();
    return { state: JSON.stringify(qa.state), snapshot: JSON.stringify(qa.snapshot), capabilities: qa.diagnostics.runtimeQuality.capabilities,
      selectedMarker: qa.diagnostics.starMotion.cachedSelectedPixel, projectedStars: qa.diagnostics.projectedStars, bodyTargets: qa.diagnostics.bodyHitTargets,
      selectedDirection: qa.diagnostics.selectedDirectionEqj, arcSampling: qa.diagnostics.constellationArcSampling, starBufferBytes: qa.diagnostics.starMotion.directionBufferBytes };
  });
  assert.ok(report.identity.selectedMarker); assert.ok(report.identity.projectedStars.some(star => star.id === 'hip:32349'));
  assert.deepEqual(report.identity.capabilities, { removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false,
    unavailableReasons: { decoration: '二维全天图没有已验有效的装饰简化档。', optionalStars: '当前目录没有独立的额外暗星包。' } });
  const sceneHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const baselineSceneHash = sceneHash([report.identity.projectedStars, report.identity.bodyTargets]);
  delete report.identity.projectedStars; report.identity.projectedDirectionsAndTargetsHash = baselineSceneHash;
  let baselineLabelSize, baselineHeader, baselineProtectedRegions, baselineSecondaryCount, baselineLookupCost, reducedSecondaryCount;
  for (const [name, labels, pixelScale, budget] of [['baseline', false, 1, 1], ['labels', true, 1, .5], ['pixels85', true, .85, .5],
    ['pixels70', true, .70, .5], ['pixels55', true, .55, .5], ['protected-zero-budget', true, .55, 0], ['restored', false, 1, 1]]) {
    const count = await page.evaluate(({ labels, pixelScale, budget }) => { const qa = window.canvasQualityQa, count = qa.renderCount;
      qa.setQuality({ ...qa.defaultQuality, hideOrdinaryBackLabels: labels, hideOrdinarySecondaryLabels: labels, ordinaryLabelBudgetScale: budget, pixelScale }); return count;
    }, { labels, pixelScale, budget });
    if (name !== 'baseline') await page.waitForFunction(count => window.canvasQualityQa.renderCount > count, count);
    const sample = await page.evaluate(({ name }) => {
      const qa = window.canvasQualityQa, before = qa.diagnostics.labelCache; qa.renderNow(); qa.renderNow();
      const d = qa.diagnostics, main = document.querySelector('.sky-canvas2d-canvas'), labels = document.querySelector('.sky-label-canvas');
      const labelCtx = labels.getContext('2d'), ratio = d.runtimeQuality.labelPixelRatio;
      const region = box => { const x = Math.floor(box.left * ratio), y = Math.floor(box.top * ratio), w = Math.ceil((box.right - box.left) * ratio), h = Math.ceil((box.bottom - box.top) * ratio);
        const pixels = labelCtx.getImageData(x, y, w, h).data; let hash = 2166136261, alphaPixels = 0;
        for (let i = 0; i < pixels.length; i++) { hash = Math.imul(hash ^ pixels[i], 16777619); if (i % 4 === 3 && pixels[i] > 0) alphaPixels++; }
        return { backingBox: [x, y, w, h], hash: (hash >>> 0).toString(16), alphaPixels }; };
      const protectedLabels = d.labelHitBoxes.filter(box => ['hip:32349', 'body:Sun', 'body:Moon'].includes(box.id));
      const protectedRegions = Object.fromEntries(protectedLabels.map(box => [box.id, region({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h })]));
      const marker = d.starMotion.cachedSelectedPixel, mr = d.runtimeQuality.mainPixelRatio, radius = Math.ceil(6 * mr), size = radius * 2 + 1;
      const pixelData = main.getContext('2d').getImageData(Math.floor(marker.x * mr) - radius, Math.floor(marker.y * mr) - radius, size, size).data;
      const center = [], nearby = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const distance = Math.hypot(x - radius, y - radius) / mr, i = (y * size + x) * 4;
        const luma = .2126 * pixelData[i] + .7152 * pixelData[i + 1] + .0722 * pixelData[i + 2]; if (distance <= 2) center.push(luma); else if (distance >= 3.5 && distance <= 5) nearby.push(luma); }
      nearby.sort((a, b) => a - b);
      const headerRegion = region(d.fixedHudCaptions.header.box), capture = qa.capture();
      return { name, quality: d.runtimeQuality, state: JSON.stringify(qa.state), snapshot: JSON.stringify(qa.snapshot), mainSize: [main.width, main.height], labelSize: [labels.width, labels.height],
        selectedMarker: marker, selectedDirection: d.selectedDirectionEqj, bodyTargets: d.bodyHitTargets, scene: [d.projectedStars, d.bodyHitTargets],
        labelCache: d.labelCache, protectedLabels, protectedRegions, headerRegion, fixedHudCaptions: d.fixedHudCaptions,
        actualDisplayViewMode: d.actualDisplayViewMode, sourceStateViewMode: d.sourceStateViewMode, arcSampling: d.constellationArcSampling, starBufferBytes: d.starMotion.directionBufferBytes,
        pixel: { maximum: Math.max(...center), nearbyMedian: nearby[Math.floor(nearby.length / 2)], sameContextReadback: true },
        widthLookupDelta: d.labelCache.widthLookupCount - before.widthLookupCount, measuredWidthDelta: d.labelCache.measuredWidthCount - before.measuredWidthCount,
        glyphDelta: d.labelCache.rasterizedGlyphCount - before.rasterizedGlyphCount, capture };
    }, { name });
    assert.equal(sample.state, report.identity.state); assert.equal(sample.snapshot, report.identity.snapshot);
    assert.equal(sceneHash(sample.scene), baselineSceneHash); delete sample.scene; sample.sceneHash = baselineSceneHash;
    assert.deepEqual(sample.selectedMarker, report.identity.selectedMarker); assert.deepEqual(sample.selectedDirection, report.identity.selectedDirection);
    assert.deepEqual(sample.arcSampling, report.identity.arcSampling); assert.equal(sample.starBufferBytes, report.identity.starBufferBytes);
    assert.equal(sample.quality.mainPixelRatio, sample.quality.basePixelRatio * pixelScale); assert.equal(sample.quality.labelPixelRatio, sample.quality.basePixelRatio);
    assert.deepEqual(sample.mainSize, [Math.floor(1152 * sample.quality.mainPixelRatio), Math.floor(720 * sample.quality.mainPixelRatio)]);
    assert.equal(sample.actualDisplayViewMode, 'ground'); assert.equal(sample.sourceStateViewMode, 'space');
    assert.ok(sample.pixel.maximum > sample.pixel.nearbyMedian + 5); assert.ok(sample.headerRegion.alphaPixels > 100);
    for (const id of ['hip:32349', 'body:Sun', 'body:Moon']) { assert.ok(sample.protectedRegions[id], `${name}: ${id} label protected`); assert.ok(sample.protectedRegions[id].alphaPixels > 10); }
    if (name === 'baseline') { baselineLabelSize = sample.labelSize; baselineHeader = sample.headerRegion; baselineSecondaryCount = sample.labelCache.secondaryCandidateCount; baselineLookupCost = sample.widthLookupDelta; }
    assert.deepEqual(sample.labelSize, baselineLabelSize); assert.deepEqual(sample.headerRegion, baselineHeader);
    if (labels) { assert.ok(sample.labelCache.secondaryCandidateCount < baselineSecondaryCount); assert.ok(sample.labelCache.ordinaryVisibleCount <= Math.floor(60 * budget));
      assert.ok(sample.widthLookupDelta < baselineLookupCost); assert.equal(sample.quality.ignoredOrdinaryBackLabels, true); }
    if (name === 'labels') { baselineProtectedRegions = sample.protectedRegions; reducedSecondaryCount = sample.labelCache.secondaryCandidateCount; }
    if (name.startsWith('pixels') || name === 'protected-zero-budget') { assert.deepEqual(sample.protectedRegions, baselineProtectedRegions); assert.equal(sample.labelCache.secondaryCandidateCount, reducedSecondaryCount); }
    const png = Buffer.from(sample.capture.split(',')[1], 'base64'); assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], baselineLabelSize);
    await writeFile(`${out}/${name}-capture.png`, png);
    const pngReadback = await page.evaluate(async ({ capture, marker, ratio, headerBox }) => {
      const image = new Image(); image.src = capture; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const [x, y, w, h] = headerBox, data = ctx.getImageData(x, y, w, h).data; let hash = 2166136261;
      for (const value of data) hash = Math.imul(hash ^ value, 16777619);
      const p = ctx.getImageData(Math.floor(marker.x * ratio) - 4, Math.floor(marker.y * ratio) - 4, 9, 9).data; let maximum = 0;
      for (let i = 0; i < p.length; i += 4) maximum = Math.max(maximum, .2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2]);
      return { size: [image.width, image.height], headerRgbHash: (hash >>> 0).toString(16), selectedCoordinateLumaMaximum: maximum, sameCssCoordinate: true };
    }, { capture: sample.capture, marker: sample.selectedMarker, ratio: sample.quality.basePixelRatio, headerBox: sample.headerRegion.backingBox });
    assert.deepEqual(pngReadback.size, baselineLabelSize); assert.ok(pngReadback.selectedCoordinateLumaMaximum > 30);
    if (name === 'baseline') report.captureHeaderHash = pngReadback.headerRgbHash;
    assert.equal(pngReadback.headerRgbHash, report.captureHeaderHash); sample.png = pngReadback; delete sample.capture;
    if (['baseline', 'pixels55', 'restored'].includes(name)) await page.screenshot({ path: `${out}/${name}-native.png` });
    const marker = report.identity.selectedMarker, box = await page.locator('.sky-canvas2d-canvas').boundingBox();
    await page.mouse.click(box.x + marker.x, box.y + marker.y);
    assert.equal(await page.evaluate(() => window.canvasQualityQa.picks.at(-1)), 'hip:32349'); sample.nativePickId = 'hip:32349';
    report.samples.push(sample);
  }
  await page.waitForTimeout(180);
  const noOpBefore = await page.evaluate(() => { const qa = window.canvasQualityQa; return { count: qa.renderCount, invalidations: qa.invalidations }; });
  await page.evaluate(() => { const qa = window.canvasQualityQa; qa.setQuality({ ...qa.defaultQuality }); }); await page.waitForTimeout(180);
  assert.deepEqual(await page.evaluate(() => ({ count: window.canvasQualityQa.renderCount, invalidations: window.canvasQualityQa.invalidations })), noOpBefore);
  report.identicalOverrideNoOpAndPausedIdle = noOpBefore;
  await page.mouse.move(320, 320); await page.mouse.down();
  const active = await page.evaluate(() => ({ count: window.canvasQualityQa.diagnostics.activePointerCount, capture: window.canvasQualityQa.captureActive }));
  assert.equal(active.count, 1); assert.equal(active.capture, true);
  const guardBefore = await page.evaluate(() => { const qa = window.canvasQualityQa; qa.setStageInputEnabled(false); return { state: JSON.stringify(qa.state), snapshot: JSON.stringify(qa.snapshot), picks: qa.picks.length, active: qa.diagnostics.activePointerCount, capture: qa.captureActive }; });
  assert.equal(guardBefore.active, 0); assert.equal(guardBefore.capture, false);
  await page.mouse.move(360, 330); await page.mouse.up(); await page.mouse.click(report.identity.selectedMarker.x, report.identity.selectedMarker.y);
  await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); await page.locator('#fixture-control').click();
  const guardAfter = await page.evaluate(() => ({ state: JSON.stringify(window.canvasQualityQa.state), snapshot: JSON.stringify(window.canvasQualityQa.snapshot), picks: window.canvasQualityQa.picks.length, controls: window.canvasQualityQa.controlClicks, active: window.canvasQualityQa.diagnostics.activePointerCount }));
  assert.equal(guardAfter.state, guardBefore.state); assert.equal(guardAfter.snapshot, guardBefore.snapshot); assert.equal(guardAfter.picks, guardBefore.picks); assert.equal(guardAfter.controls, 1); assert.equal(guardAfter.active, 0);
  await page.evaluate(() => window.canvasQualityQa.setStageInputEnabled(true)); await page.mouse.click(report.identity.selectedMarker.x, report.identity.selectedMarker.y);
  assert.equal(await page.evaluate(() => window.canvasQualityQa.picks.at(-1)), 'hip:32349');
  report.stageGuard = { active, afterDisable: { active: guardBefore.active, capture: guardBefore.capture }, lateNativeInputsIgnored: true, independentControlWorked: true, nativePickRestored: true };
  const savedViewCount = await page.evaluate(() => { const qa = window.canvasQualityQa, state = qa.state, count = qa.renderCount; state.viewMode = 'globe'; qa.setState(state); return count; });
  await page.waitForFunction(count => window.canvasQualityQa.renderCount > count, savedViewCount);
  report.savedView = await page.evaluate(() => ({ saved: window.canvasQualityQa.state.viewMode, actual: window.canvasQualityQa.diagnostics.actualDisplayViewMode,
    cameras: window.canvasQualityQa.state.cameras, opacity: getComputedStyle(document.querySelector('.sky-canvas2d-canvas')).opacity, activeAnimations: document.getAnimations().length }));
  assert.equal(report.savedView.saved, 'globe'); assert.equal(report.savedView.actual, 'ground'); assert.equal(report.savedView.opacity, '1'); assert.equal(report.savedView.activeAnimations, 0);
  assert.deepEqual(report.savedView.cameras, fixture.cameras);
  await page.setViewportSize({ width: 700, height: 720 });
  await page.waitForFunction(() => window.canvasQualityQa.diagnostics.chartViewport.width === 700);
  report.width700 = await page.evaluate(() => ({ runtimeQuality: window.canvasQualityQa.diagnostics.runtimeQuality, cache: window.canvasQualityQa.diagnostics.labelCache,
    main: [document.querySelector('.sky-canvas2d-canvas').width, document.querySelector('.sky-canvas2d-canvas').height], labels: [document.querySelector('.sky-label-canvas').width, document.querySelector('.sky-label-canvas').height] }));
  assert.equal(report.width700.runtimeQuality.basePixelRatio, 1.25); assert.equal(report.width700.runtimeQuality.ordinaryLabelBudget, 24);
  assert.deepEqual(report.width700.labels, [875, 900]);
  assert.equal(report.errors.length, 0); assert.deepEqual(await hashes(), report.sourceBefore);
  report.status = 'passed-development-canvas-quality-capture-native-input';
} catch (error) { failure = error; report.status = 'failed'; report.failure = error.stack ?? String(error); }
finally {
  for (const page of context.pages()) try { await page.evaluate(() => window.canvasQualityQa?.dispose()); } catch {}
  await context.close(); await browser.close(); report.browserClosed = true; report.sourceAfter = await hashes();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, browserClosed: report.browserClosed, samples: report.samples.length, output: out, failure: report.failure }));
if (failure) throw failure;
