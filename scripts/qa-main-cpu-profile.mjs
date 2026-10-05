import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/final-m5c-stop-sync/main-cpu-profile');
const reference = JSON.parse(await readFile(process.env.SKY_QA_REFERENCE_REPORT ?? 'qa/final-m5c-stop-sync/fullmain/report.json', 'utf8'));
const url = reference.url, expectedBuild = process.env.SKY_QA_BUILD_ID, expectedEntry = process.env.SKY_QA_ENTRY;
assert.equal(reference.build.id, expectedBuild); assert.ok(expectedEntry);
const paths = ['src/main.ts', 'src/render/SkyRenderer.ts', 'src/core/refraction.ts'];
const hashes = () => Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
await mkdir(out, { recursive: true });
const report = { status: 'running', url, requestedSamplingIntervalMicroseconds: 1000, requestedDurationMs: 3000,
  sourceBefore: await hashes(), errors: [], headless: false,
  limits: ['One sampled main-thread attribution run, not a budget retest, GPU profile or FPS measure.',
    'CDP statistical sampling perturbs execution and can miss short calls; sampled self/inclusive time is not deterministic per-frame cost.',
    'Worker CPU is not included. Idle/program/GC samples remain in the raw profile and denominator. No instrumentation is added to production source.'] };
let browser, context, page, cdp, profile;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1 }); page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message)); await page.goto(url); await page.bringToFront();
  await page.waitForFunction(() => window.skyApp?.ready);
  report.build = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')) }));
  assert.equal(report.build.id, expectedBuild); assert.ok(report.build.entries.some(entry => entry.endsWith(`/assets/${expectedEntry}`)));
  await page.evaluate(state => {
    window.skyApp.setState(state); document.querySelector('#sky-teaching').open = true; document.querySelector('#sky-object-day').open = true;
    window.dispatchEvent(new CustomEvent('sky:teaching-visibility')); window.dispatchEvent(new CustomEvent('sky:object-day-visibility'));
  }, reference.representativeScene.state);
  await page.waitForFunction(() => {
    const app = window.skyApp, d = app.diagnostics;
    return !d.scienceDirty && d.lastRenderedUt === app.state.time.utDaysJ2000 && d.assetStatus.pending.length === 0 && d.assetStatus.errors.length === 0 &&
      app.teachingData.solarDayStatus === 'ready' && app.teachingData.objectDayStatus === 'ready';
  });
  await page.locator('#sky-moon-loupe-toggle').click(); await page.waitForFunction(() => window.skyApp.moonLoupeDiagnostics?.open);
  report.state = await page.evaluate(() => window.skyApp.state); assert.deepEqual(report.state, reference.representativeScene.state);
  await page.evaluate(() => window.skyApp.play()); await page.waitForTimeout(400);
  report.before = await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, hidden: document.hidden }));
  assert.equal(report.before.hidden, false); assert.equal(report.before.diagnostics.workerMode, 'worker');
  cdp = await context.newCDPSession(page); await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start');
  await page.waitForTimeout(3000); profile = (await cdp.send('Profiler.stop')).profile;
  await cdp.send('Profiler.disable'); await cdp.detach(); cdp = null;
  report.after = await page.evaluate(() => ({ diagnostics: window.skyApp.diagnostics, hidden: document.hidden }));
  assert.equal(report.after.hidden, false); await page.evaluate(() => window.skyApp.pause());
  assert.deepEqual(report.errors, []); report.status = 'sampled-main-thread-attribution';
} catch (error) { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  if (cdp) await cdp.detach().catch(() => {}); if (context) await context.close(); if (browser) await browser.close();
  report.browserClosed = true; report.sourceAfter = await hashes(); report.sourceChanged = JSON.stringify(report.sourceBefore) !== JSON.stringify(report.sourceAfter);
}
if (profile) {
  const rawPath = resolve(out, 'main.cpuprofile'); await writeFile(rawPath, JSON.stringify(profile)); report.rawProfile = rawPath;
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), selfUs = new Map(), inclusiveUs = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], us = profile.timeDeltas[i] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + us);
    for (let current = id; current !== undefined; current = parents.get(current)) inclusiveUs.set(current, (inclusiveUs.get(current) ?? 0) + us);
  }
  const sourceLines = (await readFile(`dist/assets/${expectedEntry}`, 'utf8')).split('\n');
  const sampledUs = profile.timeDeltas.reduce((sum, us) => sum + us, 0);
  const row = node => ({ nodeId: node.id, functionName: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url,
    lineNumberZeroBased: node.callFrame.lineNumber, columnNumberZeroBased: node.callFrame.columnNumber,
    sampledSelfMs: (selfUs.get(node.id) ?? 0) / 1000, sampledInclusiveMs: (inclusiveUs.get(node.id) ?? 0) / 1000,
    selfPercentOfAllSamples: sampledUs ? (selfUs.get(node.id) ?? 0) * 100 / sampledUs : null,
    sourceSnippet: node.callFrame.url.endsWith(expectedEntry) ? sourceLines[node.callFrame.lineNumber]?.slice(Math.max(0, node.callFrame.columnNumber - 50), node.callFrame.columnNumber + 250) : null });
  report.profileSummary = { actualProfileDurationMs: (profile.endTime - profile.startTime) / 1000, sampledDurationMs: sampledUs / 1000,
    sampleCount: profile.samples.length, nodeCount: nodes.size, topSelf: [...nodes.values()].map(row).sort((a, b) => b.sampledSelfMs - a.sampledSelfMs).slice(0, 30),
    topInclusive: [...nodes.values()].map(row).filter(item => item.url).sort((a, b) => b.sampledInclusiveMs - a.sampledInclusiveMs).slice(0, 20) };
}
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), rawProfile: report.rawProfile, sourceChanged: report.sourceChanged,
  topSelf: report.profileSummary?.topSelf.slice(0, 8).map(({ functionName, sampledSelfMs, sampledInclusiveMs }) => ({ functionName, sampledSelfMs, sampledInclusiveMs })), failure: report.failure?.message }));
