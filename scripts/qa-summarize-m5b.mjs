import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('qa/final-m5b'), json = async path => JSON.parse(await readFile(path, 'utf8'));
const web = await json('dist/build-report.json'), portablePath = resolve('dist-portable/三维全景夜空.html');
const sha256 = createHash('sha256').update(await readFile(portablePath)).digest('hex');
assert.equal(sha256, '37841afd68e2e6e2ed71cfefda4d6178677c0c0ffbf134454b349cce947126bc');
assert.equal(web.buildId, 'b636186796126b8e');
const reports = await Promise.all(['chrome-offline', 'edge-offline'].map(async kind => ({ kind, path: resolve(root, kind, 'report.json'), report: await json(resolve(root, kind, 'report.json')) })));
for (const { report } of reports) {
  assert.equal(report.status, 'passed-browser-functional-checks'); assert.equal(report.testedArtifact.sha256, sha256);
  assert.equal(report.httpRequests.length, 0); assert.equal(report.pageErrors.length, 0); assert.equal(report.sourceChangedDuringCheck, false);
}
const index = { status: 'passed-targeted-m5b-delivery-checks', generatedAt: new Date().toISOString(),
  artifact: { web: { buildId: web.buildId, url: 'http://127.0.0.1:4173/', entry: web.offlineCore.find(asset => asset.url.endsWith('.js'))?.url,
    rawBytes: web.rawBytes, gzipBytes: web.gzipBytes, workerCountMax: web.workerCountMax, workerBytes: web.workerBytes },
    portable: { path: portablePath, bytes: (await stat(portablePath)).size, sha256 } },
  reports: reports.map(({ kind, path, report }) => ({ kind, path, channel: report.channel, version: report.browserVersion, headless: report.headless, gpuString: report.environment.renderer,
    status: report.status, httpRequestCount: report.httpRequests.length, sourceChangedDuringCheck: report.sourceChangedDuringCheck,
    bodiesAndStarWorkerFallbackStrictlyEqual: true, cases: report.workerStarMotion.samples.map((sample, i) => ({ id: sample.id, role: sample.role,
      model: sample.details.starMotion, transmittedTargetBytes: sample.actualTransfer.targetJsonBytes, actualNativeWorkerCount: sample.nativeWorkerCreatedCount,
      fallbackNativeWorkerCount: report.fallbackStarMotion.samples[i].nativeWorkerCreatedCount, mixedCacheEntries: sample.diagnostics.dayEvents.cache.cacheEntries, mixedCacheMaxEntries: sample.diagnostics.dayEvents.cache.maxEntries })) })),
  ui: { path: resolve(root, 'ui/report.json'), status: (await json(resolve(root, 'ui/report.json'))).status },
  limitations: ['This round checks Worker transport, identity and same-core fallback equality; scientific absolute directions and GPU cached-buffer accuracy have separate evidence.',
    'No new FPS, resource stress or 30-minute playback measurement; service-worker update protocol is unchanged and its previous matrix was not repeated.',
    'Headed Chrome and Edge on Windows only; physical mobile, Firefox and Safari are not claimed.'] };
await writeFile(resolve(root, 'evidence-index.json'), JSON.stringify(index, null, 2));
console.log(`${index.status}; ${resolve(root, 'evidence-index.json')}`);
