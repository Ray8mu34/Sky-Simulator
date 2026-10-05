import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('Moon color map is the fixedNASA2019 official image, with real hashes and1K inline import', () => {
  const report = json('assets/moon-report.json');
  const source = 'assets/source/nasa/lroc_color_poles_1k.jpg';
  assert.equal(sha(source), 'b246064f217f8d479df78c49c7c8595a8f5fbda008a72fd539978d2e121e0109');
  assert.equal(report.sourceSha256, sha(source));
  const asset = report.outputs[0]; assert.equal(asset.sha256, sha(asset.path));
  assert.deepEqual(asset.dimensions, [1024, 512]); assert.ok(asset.bytes < 160000);
  assert.ok(readFileSync('src/data/moon.ts', 'utf8').includes('moon-color-1k.webp?inline'));
  assert.ok(readFileSync('assets/source/nasa/cgi-moon-kit-4720.html', 'utf8').includes('The 2019 color map'));
  assert.ok(readFileSync('assets/licenses/NASA-MOON-NOTICE.md', 'utf8').includes('optimized for aesthetics'));
});

test('Moon UV contract preserves0-degree center, north top andeast right with independent named features', () => {
  const report = json('assets/moon-report.json');
  assert.deepEqual(report.uvSamples, [0, .25, .5, .75, 1]);
  assert.deepEqual(report.uvLongitudeEastDeg, [-180, -90, 0, 90, 180]);
  assert.deepEqual(report.imageRowLatitudeNorthDeg, [90, 0, -90]);
  assert.equal(report.colorSpace, 'sRGB');
  for (const file of ['usgs-mare-crisium.html', 'usgs-tycho.html'])
    assert.ok(readFileSync(`assets/source/nasa/${file}`, 'utf8').includes('Center Longitude'));
  assert.ok(readFileSync('assets/source/nasa/usgs-mare-crisium.html', 'utf8').includes('59.1'));
  assert.ok(readFileSync('assets/source/nasa/usgs-tycho.html', 'utf8').includes('-11.36'));
});
