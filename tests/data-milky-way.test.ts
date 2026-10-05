import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const read = (path: string) => readFileSync(path, 'utf8');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const result = await build({ entryPoints: ['src/data/milky-way.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'static-texture-test', setup(builder) {
    builder.onResolve({ filter: /\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -7)), namespace: 'inline' }));
    builder.onLoad({ filter: /.*/, namespace: 'inline' }, args => ({ contents: `data:image/webp;base64,${readFileSync(args.path).toString('base64')}`, loader: 'text' }));
  } }] });
const data = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`) as typeof import('../src/data/milky-way');

test('Milky Way source is the actual fixed NASA2020 celestial background-only EXR, not fullstar or galactic', () => {
  const report = data.metadata;
  assert.equal(report.sourceSha256, '2eb802d6e68d170b410f766c7fec07f7518619f6b6708fdc81e9302d93e74fdb');
  assert.equal(sha(report.sourceFile), report.sourceSha256);
  assert.deepEqual(report.sourceDimensions, [4096, 2048]);
  assert.ok(report.sourceFile.endsWith('/milkyway_2020_4k.exr'));
  const official = read('assets/source/nasa/deep-star-maps-4851.html');
  for (const evidence of ['ICRF/J2000', 'omits the bright (Hipparcos and Tycho) stars', 'magnitude 8.0', '11.5'])
    assert.ok(official.includes(evidence), evidence);
  assert.deepEqual(report.brightStarSeparation.omittedForegroundCatalogs, ['Hipparcos-2', 'Tycho-2']);
  assert.ok(report.brightStarSeparation.photometricGap.includes('6.5..11.5'));
  assert.ok(report.brightStarSeparation.limitation.includes('not a custom6.5mag'));
});

test('actual Milky Way EQJ helper obeys all axis anchors and RA12 wrap with north at image top', () => {
  for (const [direction, expected] of [
    [[1, 0, 0], [.5, .5]], [[0, 1, 0], [.25, .5]], [[-1, 0, 0], [0, .5]],
    [[0, -1, 0], [.75, .5]], [[0, 0, 1], [.5, 0]], [[0, 0, -1], [.5, 1]],
  ] as const) {
    const actual = data.eqjToMilkyWayImageUv(direction);
    assert.ok(actual.every((coordinate, i) => Math.abs(coordinate - expected[i]) < 1e-12));
  }
  const before = data.eqjToMilkyWayImageUv([-1, 1e-10, 0]);
  const after = data.eqjToMilkyWayImageUv([-1, -1e-10, 0]);
  assert.ok(before[0] < 1e-8 && after[0] > 1 - 1e-8);
  assert.equal(data.metadata.seamRaHours, 12);
  assert.throws(() => data.eqjToMilkyWayImageUv([0, 0, 0]), RangeError);
});

test('SgrA*, Deneb/Cygnus, Acrux/Crux andBetelgeuse/Orion UV agree with independent SIMBAD J2000 references', () => {
  const fixtures = json('qa/m3b-review/fixtures/coordinate-directions.json');
  for (const fixture of fixtures.rows) {
    assert.equal(sha(fixture.rawPath), fixture.rawSha256);
    const ra = fixture.raHours * Math.PI / 12; const dec = fixture.decDeg * Math.PI / 180;
    const direction: readonly [number, number, number] = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    const actual = data.eqjToMilkyWayImageUv(direction);
    assert.ok(actual.every((coordinate, i) => Math.abs(coordinate - fixture.sourceUvImageTopDown[i]) < 1e-12));
    const anchor = fixture.hip === null ? data.directionSamples.find(a => a.id === 'galactic-center-sgra')
      : data.directionSamples.find(a => 'starId' in a && a.starId === `hip:${fixture.hip}`);
    assert.ok(anchor);
    // Chandra galactic-centre reference is rounded to one second; HYG HIP coordinates
    // can differ slightly from SIMBAD component coordinates. Require<0.01 desktoppixel.
    assert.ok(Math.abs(anchor.imageUv[0] - fixture.sourceUvImageTopDown[0]) * 2048 < .01);
    assert.ok(Math.abs(anchor.imageUv[1] - fixture.sourceUvImageTopDown[1]) * 1024 < .01);
    assert.ok(anchor.threeFlipYSamplerUv.every((coordinate, i) => Math.abs(coordinate - (i === 0 ? anchor.imageUv[0] : 1 - anchor.imageUv[1])) < 1e-12));
  }
  assert.equal(fixtures.rows.length, 4);
});

test('2K/1K images use matched fixed tone mapping, budgeted output and real inline URLs', () => {
  assert.equal(data.metadata.toneMapping.exposure, 1);
  assert.ok(data.metadata.toneMapping.operator.includes('Reinhard'));
  assert.ok(data.metadata.toneMapping.resampling.includes('no per-resolution normalization'));
  assert.equal(data.metadata.colorSpace, 'sRGB');
  for (const [index, dimensions, uri] of [[0, [2048, 1024], data.desktopUrl], [1, [1024, 512], data.mobileUrl]] as const) {
    const record = data.metadata.outputs[index];
    assert.deepEqual(record.dimensions, dimensions);
    assert.equal(record.sha256, sha(record.path));
    assert.ok(record.bytes < (index === 0 ? 500000 : 100000));
    assert.ok(uri.startsWith('data:image/webp;base64,'));
    const decoded = Buffer.from(uri.split(',')[1], 'base64');
    assert.equal(createHash('sha256').update(decoded).digest('hex'), record.sha256);
  }
  assert.ok(!read('src/data/milky-way.ts').includes('fetch('));
});

test('known bright-star regions exhibit foreground removal in independent official preview layers', () => {
  const checks = data.metadata.brightStarPreviewChecks;
  assert.deepEqual(checks.map(check => check.starId), ['hip:102098', 'hip:60718', 'hip:27989']);
  for (const check of checks) assert.ok(check.officialForegroundPreviewPeak > check.officialBackgroundPreviewPeak);
  // These are distinct upstream layers, not differently named copies of the full map.
  assert.notEqual(sha('assets/source/nasa/milkyway_2020_4k_print.jpg'), sha('assets/source/nasa/starmap_2020_4k_print.jpg'));
  assert.notEqual(sha('assets/source/nasa/milkyway_2020_4k_print.jpg'), sha('assets/source/nasa/hiptyc_2020_4k_print.jpg'));
});
