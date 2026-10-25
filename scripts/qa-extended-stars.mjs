import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { startUpdateServer } from './qa-update-server.mjs';
import { waitGraphicsReady } from './qa-m4a.mjs';

// Short delivery smoke only: two installed desktop browsers and resized windows.
const out = resolve('qa/extended-stars');
await mkdir(out, { recursive: true });
const server = await startUpdateServer({ current: resolve('dist') });
server.select('/app/', 'current');
const report = { startedAt: new Date().toISOString(), browsers: [], errors: [] };
try {
  for (const channel of ['chrome', 'msedge']) {
    const browser = await chromium.launch({ channel, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => report.errors.push(`${channel}: ${error.message}`));
      await page.goto(`${server.origin}/app/`);
      await waitGraphicsReady(page, 'webgl2');
      const sample = { channel, version: browser.version(), screenshots: [] };
      assert.equal(await page.evaluate(() => window.skyApp.rendererDiagnostics.starMotion.catalogStarCount), 108071);
      await page.locator('.appearance-controls > summary').click();
      await page.locator('#sky-star-map-deep').click();
      await page.waitForFunction(() => window.skyApp.skyAppearance.limitingMagnitude === 10);
      await page.locator('#sky-search').fill('HIP87937');
      await page.locator('#sky-search-results [data-object-id="hip:87937"]').click();
      await page.waitForFunction(() => window.skyApp.selectedDetails?.id === 'hip:87937');
      const details = await page.evaluate(() => window.skyApp.selectedDetails);
      assert.ok(Math.abs(details.magnitude - 9.54) < .001);
      await page.locator('[data-action="focus-selection"]').click();
      await page.waitForFunction(() => window.skyApp.diagnostics.lastFocusSucceeded === true);
      // Exercise the existing instrument workflow around the added faint target.
      await page.locator('.course-equipment > summary').click();
      await page.locator('.equipment-tools > summary').click();
      await page.locator('[data-instrument="mode"]').selectOption('camera');
      await page.locator('[data-ce="fit"]').click();
      await page.waitForFunction(() => window.skyApp.state.instrument?.mode === 'camera');
      sample.instrument = await page.evaluate(() => ({ fov: window.skyApp.state.cameras.ground.verticalFovDeg,
        selection: window.skyApp.state.selected, details: window.skyApp.selectedDetails, graphics: window.skyApp.graphicsStatus.kind }));
      await page.locator('[data-action="close"]').click();
      await page.screenshot({ path: resolve(out, `${channel}-instrument.png`) });
      sample.screenshots.push(`${channel}-instrument.png`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-action="open-time"]').click();
      await page.locator('#sky-star-map-depth').scrollIntoViewIfNeeded();
      await page.locator('#sky-star-map-depth').focus();
      await page.keyboard.press('Home');
      await page.waitForFunction(() => window.skyApp.state.environment.darkSkyLimitingMagnitude === 6.5);
      await page.keyboard.press('End');
      await page.waitForFunction(() => window.skyApp.skyAppearance.limitingMagnitude === 10);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(out, `${channel}-narrow.png`) });
      sample.screenshots.push(`${channel}-narrow.png`);
      await page.locator('#sky-observe-appearance').click();
      assert.equal(await page.evaluate(() => window.skyApp.state.environment.darkSkyLimitingMagnitude), 6.5);
      await page.locator('#sky-star-map-deep').click();
      await page.locator('#sky-presentation').selectOption('observation');
      assert.equal(await page.evaluate(() => window.skyApp.state.environment.darkSkyLimitingMagnitude), 6.5);
      sample.success = true;
      report.browsers.push(sample);
      // One local-file load checks that the expanded catalog is actually embedded.
      if (channel === 'chrome') {
        const portable = await browser.newPage();
        portable.on('pageerror', error => report.errors.push(`portable: ${error.message}`));
        await portable.goto(pathToFileURL(resolve('dist-portable/三维全景夜空.html')).href);
        await waitGraphicsReady(portable, 'webgl2');
        assert.equal(await portable.evaluate(() => window.skyApp.rendererDiagnostics.starMotion.catalogStarCount), 108071);
        report.portable = 'Local file loaded with all 108071 stars';
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} finally {
  await server.close();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, browsers: report.browsers.map(({ channel, version, success }) => ({ channel, version, success })), portable: report.portable, errors: report.errors }));
