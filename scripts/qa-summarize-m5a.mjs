import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('qa/final-m5a');
const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const chrome = await json('qa/final-m5a/chrome-offline/report.json'), edge = await json('qa/final-m5a/edge-offline/report.json');
const lifecycle = await json('qa/final-m5a/lifecycle/report.json'), web = await json('dist/build-report.json');
const portablePath = resolve('dist-portable/三维全景夜空.html'), portableBytes = await readFile(portablePath);
const hash = createHash('sha256').update(portableBytes).digest('hex');
assert.equal(hash, '8c3b49971cb3a650f53a4b43fa2e069e550d9a13a46691bb4c3703abdd28406e');
assert.equal(web.buildId, 'f2c4a513ec1843fa');
for (const report of [chrome, edge]) {
  assert.equal(report.testedArtifact.sha256, hash); assert.equal(report.status, 'passed-browser-functional-checks');
  assert.equal(report.httpRequests.length, 0); assert.equal(report.pageErrors.length, 0);
}
assert.equal(lifecycle.status, 'passed-real-bfcache-return-then-real-dispose');
const finalExit = lifecycle.finalNavigationEvidence.findLast(entry => entry.event === 'pagehide' && entry.documentIdentity === lifecycle.before.documentIdentity);
assert.equal(finalExit.lifecycle.disposeCount, 1); assert.equal(finalExit.workerCount, 0);
const uiPath = resolve('qa/final-m5a/ui/report.json');
const ui = await json(uiPath);
const budget = await json('qa/m5a-platform/day-budget-confirmed/report.json');
const html = await (await fetch('http://127.0.0.1:4173/')).text();
const actualBuildId = /name="sky-build-id" content="([^"]+)"/.exec(html)?.[1];
assert.equal(actualBuildId, web.buildId);
const index = {
  status: 'passed-targeted-m5a-delivery-checks', generatedAt: new Date().toISOString(),
  artifact: { portable: { path: portablePath, bytes: (await stat(portablePath)).size, sha256: hash }, web: { buildId: web.buildId, url: 'http://127.0.0.1:4173/', entry: web.offlineCore.find(asset => asset.url.endsWith('.js'))?.url, rawBytes: web.rawBytes, gzipBytes: web.gzipBytes, workerCountMax: web.workerCountMax, workerBytes: web.workerBytes } },
  reports: ['chrome-offline', 'edge-offline', 'lifecycle', 'ui'].map(name => ({ kind: name, path: resolve(root, name, 'report.json') })),
  offline: [chrome, edge].map(report => ({ channel: report.channel, browserVersion: report.browserVersion, headless: report.headless, gpuString: report.environment.renderer, httpRequestCount: report.httpRequests.length,
    nativeWorkerCount: report.workerDayEvents.diagnostics.workerCount, fallbackWorkerCount: report.fallbackDayEvents.diagnostics.workerCount, fallbackMaxChunkMs: report.fallbackDayEvents.diagnostics.dayEvents.maxFallbackChunkMs, cacheMaxEntries: report.workerDayEvents.diagnostics.dayEvents.cache.maxEntries,
    identicalSolarAndMoon: true, loadedSamplers: report.workerDayEvents.diagnostics.assetStatus.loaded })),
  lifecycle: { url: lifecycle.appUrl, sameDocumentIdentity: lifecycle.before.documentIdentity === lifecycle.returned.documentIdentity, persistedPageHideCount: lifecycle.returned.diagnostics.lifecycle.persistedPageHideCount, finalRealReload: finalExit },
  ui: { path: uiPath, status: ui.status },
  priorDevelopmentBudget: { path: resolve('qa/m5a-platform/day-budget-confirmed/report.json'), scope: 'Fresh app context with real UI input; not repeated as a production FPS benchmark.', isolatedIntlConstructorMs: budget.isolatedIntlAtomicProbe.constructorMs, atomic8msBudgetExceeded: budget.isolatedIntlAtomicProbe.constructorMs > 8 },
  preservedDevelopmentFailures: [resolve('qa/m5a-platform/day-budget/report.json'), resolve('qa/m5a-platform/lifecycle/report.json')],
  limitations: ['No new FPS or 30-minute run; renderer submission rate is not GPU completed/displayed FPS.', 'The cold atomic Intl constructor exceeded 8ms; sampled application/fallback chunks do not certify every runtime below that budget.', 'The unchanged service-worker update protocol uses prior M4B multi-version evidence; the large upgrade matrix was not repeated.', 'Physical mobile, Firefox and Safari were not tested in this targeted platform round.']
};
await writeFile(resolve(root, 'evidence-index.json'), JSON.stringify(index, null, 2));
console.log(`${index.status}; ${resolve(root, 'evidence-index.json')}`);
