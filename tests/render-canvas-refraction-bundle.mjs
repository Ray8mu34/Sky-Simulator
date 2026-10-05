import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This smoke uses public app APIs and fixed accepted dev observer scenes.
// It never imports /src modules, so it also works against an actual built bundle.
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = process.argv[3] ?? 'qa/m5c-canvas/bundle-smoke';
const expectedBuildId = process.argv[4] ?? null, expectedEntry = process.argv[5] ?? null;
const fixturePath = 'qa/m5c-canvas/development/report.json';
const fixtureText = await readFile(fixturePath, 'utf8'), fixture = JSON.parse(fixtureText);
await mkdir(out, { recursive: true });
const report = { url, fixturePath, fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'), samples: [], errors: [],
  scope: 'Small actual-bundle no-WebGL smoke: negative geometric Sirius and Moon native picks/pixels, plus one actual Orion horizon-curve image. Public app API only; no dev /src imports, performance, or repeated full matrix.' };
const sourceFiles = ['src/render/CanvasSkyRenderer.ts', 'src/render/CanvasSkyProjection.ts', 'src/render/SphericalArcBuffer.ts', 'src/core/refraction.ts',
  'src/core/object-details.ts', 'src/main.ts', 'src/state.ts', 'src/ui/controls.ts'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
report.sourceHashesBefore = await sourceHashes();
for (const path of ['src/render/CanvasSkyRenderer.ts', 'src/render/CanvasSkyProjection.ts'])
  assert.equal(report.sourceHashesBefore[path], fixture.sourceHashesAfter[path], 'Canvas source agrees with accepted dev evidence');
report.devModuleRequests = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.5 });
const ready = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.pendingInteractionCount === 0);
const apply = async (page, state) => {
  const count = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.evaluate(state => window.skyApp.setState(state), state);
  await page.waitForFunction(count => window.skyApp.diagnostics.renderCount > count && !window.skyApp.diagnostics.scienceDirty
    && window.skyApp.diagnostics.lastRenderedSelection === window.skyApp.state.selected, count); await ready(page);
};
try {
  await context.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (name, ...args) { return name === 'webgl2' ? null : original.call(this, name, ...args); }; });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (/\/src\/|\/@vite\/|\/node_modules\//.test(request.url())) report.devModuleRequests.push(request.url()); });
  await page.goto(url); await ready(page); assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
  report.actualPage = await page.evaluate(() => ({ buildId: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    qaBuild: document.querySelector('meta[name="sky-qa-build"]')?.content ?? null,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src), title: document.title, href: location.href }));
  assert.ok(report.actualPage.buildId && report.actualPage.entries.length === 1);
  if (expectedBuildId) assert.equal(report.actualPage.buildId, expectedBuildId);
  if (expectedEntry) assert.equal(new URL(report.actualPage.entries[0]).pathname.split('/').at(-1), expectedEntry);
  const entryResponse = await context.request.get(report.actualPage.entries[0]); assert.equal(entryResponse.status(), 200);
  report.actualPage.entrySha256 = createHash('sha256').update(await entryResponse.body()).digest('hex');
  const cases = [
    { id: 'hip:32349', state: fixture.stars.find(sample => sample.targetAltitude < 0).focused.state, label: 'sirius-negative' },
    { id: 'body:Moon', state: fixture.bodies.find(sample => sample.id === 'body:Moon').picked.state, label: 'moon-negative-marker' },
  ];
  for (const sample of cases) {
    const state = structuredClone(sample.state); state.selected = null; await apply(page, state);
    const actual = await page.evaluate(id => {
      const app = window.skyApp, d = app.rendererDiagnostics;
      const point = (id.startsWith('body:') ? d.bodyHitTargets : d.projectedStars).find(point => point.id === id);
      if (!point) throw new Error(`Missing actual target ${id}`);
      const canvas = document.querySelector('.sky-canvas2d-canvas'), scale = canvas.width / canvas.clientWidth;
      const r = Math.ceil((id.startsWith('body:') ? 8 : 3) * scale), size = 2 * r + 1;
      const pixels = canvas.getContext('2d').getImageData(Math.round(point.x * scale) - r, Math.round(point.y * scale) - r, size, size).data;
      let maximum = 0; for (let index = 0; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index], pixels[index + 1], pixels[index + 2]);
      return { point, pixelChannelMaximum: maximum, sameContextReadback: true };
    }, sample.id);
    assert.ok(actual.pixelChannelMaximum > 150);
    const rect = await page.locator('.sky-canvas2d-canvas').boundingBox(); await page.mouse.click(rect.x + actual.point.x, rect.y + actual.point.y);
    await page.waitForFunction(id => window.skyApp.state.selected === id && window.skyApp.diagnostics.lastRenderedSelection === id, sample.id); await ready(page);
    const picked = await page.evaluate(() => ({ state: window.skyApp.state, details: window.skyApp.selectedDetails, diagnostics: window.skyApp.rendererDiagnostics }));
    assert.ok(picked.details.geometricAltitudeDeg < 0 && picked.details.apparentAltitudeDeg > 0);
    assert.equal(picked.diagnostics.selectedGeometricallyAboveHorizon, false); assert.equal(picked.diagnostics.selectedApparentAboveHorizon, true);
    assert.equal(picked.diagnostics.actualDisplayViewMode, 'ground'); assert.equal(picked.state.viewMode, 'space');
    assert.deepEqual(picked.state.cameras, state.cameras); assert.deepEqual(picked.state.time, state.time); assert.deepEqual(picked.state.observer, state.observer);
    assert.ok(picked.diagnostics.labelHitBoxes.some(label => label.id === sample.id));
    await page.screenshot({ path: `${out}/${sample.label}.png` }); report.samples.push({ ...sample, actual, picked });
  }
  const orionState = fixture.layouts[0].state; await apply(page, orionState);
  const orion = await page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.rendererDiagnostics }));
  assert.equal(orion.state.selected, 'constellation:Ori'); assert.ok(orion.diagnostics.sampledConstellationSegments > 0);
  assert.equal(orion.diagnostics.constellationArcSampling.mandatoryKnotBudgetExceededCount, 0);
  await page.screenshot({ path: `${out}/orion-apparent-horizon.png` }); report.samples.push({ id: 'constellation:Ori', ...orion });
  await page.waitForTimeout(350); const idle = await page.evaluate(() => window.skyApp.diagnostics.renderCount);
  await page.waitForTimeout(220); assert.equal(await page.evaluate(() => window.skyApp.diagnostics.renderCount), idle);
  assert.equal(report.errors.length, 0); assert.equal(report.devModuleRequests.length, 0, 'actual bundle never imports /src or Vite development modules');
  report.sourceHashesAfter = await sourceHashes(); assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore, 'source remains frozen during actual-bundle smoke');
  report.browserVersion = browser.version();
} catch (error) { report.failure = error.stack ?? error.message; throw error; }
finally { report.sourceHashesAfter ??= await sourceHashes(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await context.close(); await browser.close(); }
console.log(`${out}/report.json; browser closed`);
