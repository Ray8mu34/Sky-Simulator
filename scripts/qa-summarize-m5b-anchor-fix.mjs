import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('qa/final-m5b-anchor-fix'), json = async path => JSON.parse(await readFile(path, 'utf8'));
const artifactPath = resolve('dist-portable/三维全景夜空.html'), bytes = await readFile(artifactPath);
const sha256 = createHash('sha256').update(bytes).digest('hex'), web = await json('dist/build-report.json');
assert.equal(sha256, '704787a3614d1323fe141a00b189b5ce90044117ddfc1c24166573277ddd3842');
assert.equal(web.buildId, 'faac0427bb2b8f1b');
const reports = await Promise.all(['chrome-offline', 'edge-offline'].map(async kind => ({ kind, path: resolve(root, kind, 'report.json'), report: await json(resolve(root, kind, 'report.json')) })));
for (const { report } of reports) {
  assert.equal(report.status, 'passed-browser-functional-checks'); assert.equal(report.testedArtifact.sha256, sha256);
  assert.equal(report.httpRequests.length, 0); assert.equal(report.pageErrors.length, 0); assert.equal(report.sourceChangedDuringCheck, false);
}
const rendererPath = resolve(root, 'render/report.json'), renderer = await json(rendererPath);
const index = { status: 'passed-m5b-anchor-fix-targeted-delivery-checks', generatedAt: new Date().toISOString(),
  artifact: { portable: { path: artifactPath, bytes: (await stat(artifactPath)).size, sha256 }, web: { buildId: web.buildId,
    entry: web.offlineCore.find(asset => asset.url.endsWith('.js'))?.url, rawBytes: web.rawBytes, gzipBytes: web.gzipBytes, workerBytes: web.workerBytes, workerCountMax: web.workerCountMax } },
  offline: reports.map(({ kind, path, report }) => ({ kind, path, status: report.status, browserVersion: report.browserVersion, headless: report.headless,
    identicalSolarMoonAndFourStars: true, httpRequests: report.httpRequests.length, nativeWorkerCount: report.workerStarMotion.samples[0].nativeWorkerCreatedCount,
    fallbackWorkerCount: report.fallbackStarMotion.samples[0].nativeWorkerCreatedCount, singleTargetBytes: report.workerStarMotion.samples.map(sample => sample.actualTransfer.targetJsonBytes),
    models: report.workerStarMotion.samples.map(sample => ({ id: sample.id, model: sample.details.starMotion.model, reasons: sample.details.starMotion.fallbackReasons })) })),
  rendererOwnerEvidence: { path: rendererPath, status: renderer.status },
  retainedPriorPackageReports: resolve('qa/final-m5b/evidence-index.json'),
  limitations: ['Offline regression covers the four star representatives and Sun/Moon; 88 constellation cached-anchor validation is separate renderer-owner evidence.',
    'No new FPS, long test or unchanged service-worker upgrade matrix.'] };
await writeFile(resolve(root, 'evidence-index.json'), JSON.stringify(index, null, 2));
console.log(`${index.status}; ${resolve(root, 'evidence-index.json')}`);
