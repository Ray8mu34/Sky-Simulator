import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5b-ui/development';
const cases = [
  { query: 'HIP 32349', name: 'sirius', model: 'linear-space' },
  { query: 'HIP 11767', name: 'polaris', model: 'linear-space' },
  // Normalization has already mapped source zero RV to null; the UI must not reconstruct raw fields.
  { query: 'HIP 103527', name: 'zero-rv', model: 'tangent', reasonsExact: ['radial-velocity-unavailable', 'radial-velocity-flag-unavailable'] },
  { query: 'HIP 17851', name: 'hip-source-conflict', model: 'tangent', reason: 'source-field-inconsistent' },
  { query: 'HYG 119623', name: 'hyg-source-conflict', model: 'tangent', reason: 'source-field-inconsistent' },
];
const files = ['src/core/stars.ts', 'src/core/object-details.ts', 'src/core/object-day-events.ts', 'src/data/object-day-target.ts', 'src/ui/controls.ts', 'src/ui/object-day-controls.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
await mkdir(out, { recursive: true });
const beforeHashes = await hashes(), browsers = [], checks = [], records = [], errors = []; let page;
const actualBuilds = [];
async function verifyBuild(page, graphics) {
  const value = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.getAttribute('content') ?? null, entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  actualBuilds.push({ graphics, ...value });
  if (process.env.SKY_QA_BUILD_ID) assert.equal(value.id, process.env.SKY_QA_BUILD_ID);
  if (process.env.SKY_QA_ENTRY) assert.ok(value.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)), JSON.stringify(value));
}
const current = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const ready = page => page.waitForFunction(() => {
  const t = window.skyApp.teachingData;
  return t.objectDayStatus === 'ready' && t.objectDay?.key === t.objectDayKey && document.querySelector('#sky-object-day').dataset.objectDayKey === t.objectDayKey;
});
async function select(page, item) {
  await page.locator('#sky-search').fill(item.query); await page.locator('#sky-search').press('Enter');
  const state = await current(page); assert.ok(state.selected?.startsWith(item.query.startsWith('HIP') ? 'hip:' : 'hyg:'));
  await ready(page);
  const day = await page.evaluate(() => window.skyApp.teachingData.objectDay);
  assert.equal(day.id, state.selected); assert.equal(day.starMotion?.model, item.model);
  if (item.reason) assert.ok(day.starMotion.fallbackReasons.includes(item.reason));
  if (item.reasonsExact) assert.deepEqual(day.starMotion.fallbackReasons, item.reasonsExact);
  return day;
}
async function inspect(page, motion, previous) {
  await page.locator('.object-notes-details').evaluate(el => { el.open = true; });
  await page.locator('.object-day-definition-details').evaluate(el => { el.open = true; });
  const details = await page.locator('.object-notes').textContent(), events = await page.locator('.object-day-notes').textContent();
  for (const note of motion.notes) { assert.ok(details.includes(note), note); assert.ok(events.includes(note), note); }
  for (const obsolete of previous?.notes.filter(note => !motion.notes.includes(note)) ?? []) { assert.ok(!details.includes(obsolete), 'Previous detail model note cleared'); assert.ok(!events.includes(obsolete), 'Previous event model note cleared'); }
  assert.ok(motion.notes.some(note => note.includes('扩展年代仅作探索')));
  assert.doesNotMatch(details + events, /未加入[^；。]*完整六维空间运动|无年度光行差、视差或6D/);
  if (motion.model === 'linear-space') { assert.match(details, /来源字段一致候选/); assert.match(details, /不是观测测量可靠性认证/); }
  else assert.match(details, /切面角自行近似/);
  return { details, events };
}
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); browsers.push(browser);
  page = await browser.newPage({ viewport: { width: 1152, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page, 'webgl2'); await paired(page);
  let previous;
  for (const item of cases) {
    const day = await select(page, item), baseline = await current(page), text = await inspect(page, day.starMotion, previous);
    for (const mode of ['space', 'globe', 'horizon', 'ground']) {
      await page.locator(`[data-view="${mode}"]`).click(); await paired(page); await ready(page);
      const visibleDay = await page.evaluate(() => window.skyApp.teachingData.objectDay);
      assert.equal(visibleDay.key, day.key); assert.deepEqual(visibleDay.starMotion, day.starMotion);
      await inspect(page, day.starMotion, previous);
      assert.deepEqual((await current(page)).cameras, baseline.cameras); assert.equal((await current(page)).time.utDaysJ2000, baseline.time.utDaysJ2000);
    }
    await page.locator('.object-notes').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/${item.name}-details.png` });
    await page.locator('.object-day-notes').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/${item.name}-day-notes.png` });
    records.push({ query: item.query, id: day.id, motion: day.starMotion, text }); previous = day.starMotion;
  }
  checks.push('Five real targets expose the core candidate/tangent identities, including ambiguous zero RV and both source-conflict policies; details and day-event notes contain exactly the same core model explanations.');
  checks.push('Changing target clears previous unique model/reason notes; no obsolete universal no-6D claim remains, and source-consistency candidates are explicitly not measurement certification.');
  checks.push('All four views retain the same model/policy/version/reason identity, UT and cameras; extended-year limitations remain in the reused explanation area.');
  await browser.close(); browsers.pop();
  const noGl = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] }); browsers.push(noGl);
  page = await noGl.newPage({ viewport: { width: 1152, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await verifyBuild(page, 'canvas2d'); await paired(page); assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'canvas2d');
  previous = undefined;
  for (const [index, item] of cases.entries()) {
    const day = await select(page, item); assert.deepEqual(day.starMotion, records[index].motion);
    await inspect(page, day.starMotion, previous); previous = day.starMotion;
  }
  await page.locator('.object-notes').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/canvas-fallback-notes.png` });
  checks.push('Genuine Canvas2D startup shows the same five core model identities and explanation notes, without UI distance/RV/quality-bit classification.');
  assert.deepEqual(errors, []);
} catch (error) { if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); throw error; }
finally {
  await Promise.all(browsers.map(browser => browser.close()));
  const afterHashes = await hashes();
  await writeFile(`${out}/report.json`, JSON.stringify({ url, stage: process.env.SKY_UI_QA_STAGE ?? 'development', actualBuilds, beforeHashes, afterHashes, sourceChanged: JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes), checks, records, errors, browserClosed: true, limits: ['Model display and consumer consistency, not independent astronomical or measurement accuracy certification.', 'No physical-phone, FPS or 30-minute result.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
