import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = process.env.SKY_RENDER_OUT ?? 'qa/m5b-render/anchor-fix-development';
const url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const metadata = JSON.parse(await readFile('assets/runtime/constellation-meta.json', 'utf8'));
const records = new Map(JSON.parse(await readFile('qa/science-reference-prep/motion-cache-bound-records.json', 'utf8')).map(r => [r.id, r]));
const stars = JSON.parse(await readFile('assets/runtime/star-meta.json', 'utf8'));
function meanDirection(figure, ut) {
  const endpoints = new Set(metadata.lineIndices.slice(figure.lineStart * 2, (figure.lineStart + figure.lineCount) * 2));
  const sum = [0, 0, 0];
  for (const index of endpoints) {
    const record = records.get(stars[index][0]), p = record.p0.map((value, axis) => value + ut / 365.25 * record.vPerJulianYear[axis]);
    const length = Math.hypot(...p); p.forEach((value, axis) => sum[axis] += value / length);
  }
  return sum.map(value => value / Math.hypot(...sum));
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 } });
const errors = [], samples = [];
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && !window.skyApp.diagnostics.assetStatus.pending.length);
  const buildEvidence = await page.evaluate(() => ({ buildId: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    moduleScripts: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src) }));
  if (process.env.SKY_RENDER_EXPECT_BUILD_ID) assert.equal(buildEvidence.buildId, process.env.SKY_RENDER_EXPECT_BUILD_ID);
  if (process.env.SKY_RENDER_EXPECT_MODULE) assert.ok(buildEvidence.moduleScripts.some(src => src.endsWith(process.env.SKY_RENDER_EXPECT_MODULE)));
  const baseline = await page.evaluate(() => window.skyApp.state);
  const apply = async state => {
    const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.evaluate(state => window.skyApp.setState(state), state);
    await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedSelection === window.skyApp.state.selected, count);
  };
  for (const figure of metadata.constellations) {
    const state = structuredClone(baseline); state.time.running = false; state.viewMode = 'globe';
    state.selected = `constellation:${figure.id}`; state.layers.constellationLabels = false; state.layers.brightStarNamesZh = false;
    await apply(state);
    const before = await page.evaluate(() => ({ state: window.skyApp.state, detail: window.skyApp.selectedDetails }));
    const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
    await page.evaluate(() => window.skyApp.focusSelection());
    await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && window.skyApp.diagnostics.lastFocusSucceeded === true, count);
    const after = await page.evaluate(() => ({ state: window.skyApp.state, detail: window.skyApp.selectedDetails, renderer: window.skyApp.rendererDiagnostics }));
    const d = after.renderer;
    assert.equal(d.selectedMarkerUtDaysJ2000, d.starMotion.cachedUtDaysJ2000);
    assert.equal(d.starMotion.constellationAnchorUtDaysJ2000, d.selectedMarkerUtDaysJ2000);
    assert.equal(d.selectedDirectionUtDaysJ2000, after.state.time.utDaysJ2000);
    const expectedCache = meanDirection(figure, d.selectedMarkerUtDaysJ2000), expectedActual = meanDirection(figure, after.state.time.utDaysJ2000);
    d.selectedMarkerDirectionEqj.forEach((value, axis) => assert.ok(Math.abs(value - expectedCache[axis]) < 2e-14));
    d.selectedDirectionEqj.forEach((value, axis) => assert.ok(Math.abs(value - expectedActual[axis]) < 2e-14));
    after.detail.directionEqj.forEach((value, axis) => assert.ok(Math.abs(value - expectedActual[axis]) < 2e-14));
    assert.deepEqual(after.detail, before.detail, 'focus/cache must not alter actual-UT science details');
    assert.deepEqual(d.selectedLabelAnchorPixel, d.selectionMarkerPixel, 'submitted label anchor and drawn ring use one cached projection');
    assert.ok(d.labelHitBoxes.some(label => label.id === state.selected));
    assert.ok(Math.hypot(...d.selectedMarkerProjectedNdc) < 1e-10);
    assert.deepEqual(after.state.time, before.state.time); assert.deepEqual(after.state.observer, before.state.observer); assert.equal(after.state.selected, before.state.selected);
    for (const mode of ['ground', 'space', 'horizon']) assert.deepEqual(after.state.cameras[mode], before.state.cameras[mode]);
    samples.push({ id: state.selected, cachedEpoch: d.selectedMarkerUtDaysJ2000, actualEpoch: after.state.time.utDaysJ2000,
      cachedDirection: d.selectedMarkerDirectionEqj, actualDirection: after.detail.directionEqj, labelAnchorPixel: d.selectedLabelAnchorPixel, markerPixel: d.selectionMarkerPixel,
      geometryId: d.highlightGeometryId, indexId: d.highlightIndexAttributeId });
    if (figure.id === 'Ori') await page.screenshot({ path: `${out}/selected-orion.png` });
  }
  assert.equal(errors.length, 0);
  assert.equal(new Set(samples.map(s => s.geometryId)).size, 1); assert.equal(new Set(samples.map(s => s.indexId)).size, 1);
  await page.waitForTimeout(500); const idleCount = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.waitForTimeout(180); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), idleCount);
  await writeFile(`${out}/report.json`, JSON.stringify({ url, buildEvidence, samples, errors, scope: '88 focused actual WebGL label/ring submissions; source-scalar unique endpoint means at cached and actual UT. No full matrix/performance rerun.' }, null, 2));
} finally { await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
