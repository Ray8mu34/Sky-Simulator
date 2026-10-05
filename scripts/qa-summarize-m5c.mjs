import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('qa/final-m5c'), portable = resolve('dist-portable/三维全景夜空.html');
const sha256 = createHash('sha256').update(await readFile(portable)).digest('hex');
const html = await readFile('dist/index.html', 'utf8');
const buildId = html.match(/name="sky-build-id" content="([^"]+)"/)?.[1];
const entry = html.match(/src="\.\/assets\/([^"]+\.js)"/)?.[1];
assert.ok(buildId && entry);
const browsers = [];
for (const name of ['chrome', 'edge', 'firefox']) {
  const path = resolve(root, `${name}-offline/report.json`), report = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(report.status, 'passed-targeted-offline-refraction-checks'); assert.equal(report.artifact.sha256, sha256);
  assert.equal(report.browserClosed, true); assert.equal(report.headless, false);
  assert.deepEqual(report.httpRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
  const native = report.paths.find(path => !path.forceFallback), fallback = report.paths.find(path => path.forceFallback);
  assert.equal(native.contextRecovery.groundRestored.probe.created, 2);
  assert.equal(fallback.contextRecovery.groundRestored.probe.created, 0);
  for (const path of report.paths) {
    assert.equal(path.freshContextOfflineBeforeFirstOpen, true);
    assert.equal(path.contextRecovery.groundRestored.graphicsProbe.uniqueSuccessfulContexts, 1);
    assert.equal(path.contextRecovery.groundRestored.renderer.refraction.textureBytes, 32768);
    assert.equal(path.contextRecovery.groundRestored.renderer.refraction.residentTextureCount, 1);
  }
  browsers.push({ name, report: path, browserVersion: report.browserVersion, headed: !report.headless,
    bytes: report.artifact.bytes, sampleModes: native.samples.map(sample => sample.snapshot.observerRefraction),
    maxNativeSnapshotJsonBytes: Math.max(...native.contextRecovery.groundRestored.probe.replies.map(reply => reply.jsonBytes)),
    nativeWorkerCount: 2, forcedFallbackWorkerCount: 0, actualContextLossRestoreCycles: report.paths.length,
    originalWebglContextsPerPath: 1, residentRefractionTextureBytes: 32768,
    renderer: report.environment, screenshots: report.screenshots });
}
const index = { status: 'passed-platform-targeted-offline-acceptance', generatedAt: new Date().toISOString(),
  webArtifactIdentityFromDisk: { buildId, entry, scope: 'HTML disk identity; production visual/GPU tests belong to their separate owners.' },
  portableArtifact: { path: portable, sha256, bytes: browsers[0].bytes }, browsers,
  development: resolve('qa/m5c-platform/development/report.json'),
  localTests: resolve('qa/m5c-platform/local-tests-confirmed.txt'),
  retainedQaFailure: resolve('qa/m5c-platform/local-tests.txt'),
  earlierFirefoxBaseline: resolve('qa/m5c-platform/firefox-m5b-baseline/report.json'),
  limits: ['No FPS/GPU numeric-error/30-minute claim from these targeted offline checks.', 'Firefox Windows is not macSafari; physical phones/mobile OS PWA and public HTTPS deployments are not covered.'] };
const path = resolve(root, 'evidence-index.json'); await writeFile(path, JSON.stringify(index, null, 2));
console.log(JSON.stringify({ status: index.status, path, buildId, entry, sha256 }));
