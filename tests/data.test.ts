import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
type StarRecord = [string, number, number | null, number, number, number, number | null,
  string | null, string | null, string[], number, number, number, number | null, number | null,
  [number, number, number], string | null, number | null, number | null, number, number, string];
const records: StarRecord[] = json('assets/runtime/star-meta.json');
const figures: { constellations: { id: string; nameZh: string; lineStart: number; lineCount: number; directionEqj: number[] }[];
  lineIndices: number[]; lineWeights: number[] } = json('assets/runtime/constellation-meta.json');
const source = { constellations: read('assets/source/stellarium244/modern/constellationship.fab').split(/\r?\n/)
  .filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const fields = line.trim().split(/\s+/); const points = fields.slice(2).map(Number);
    assert.equal(points.length, Number(fields[1]) * 2);
    return { iau: fields[0], lines: Array.from({ length: points.length / 2 }, (_, i) => points.slice(i * 2, i * 2 + 2)) };
  }) };
const binary = readFileSync('assets/runtime/stars.bin');

function csvRow(line: string): string[] {
  const values: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { values.push(value); value = ''; }
    else value += c;
  }
  values.push(value); assert.equal(quoted, false); return values;
}
const csvLines = read('assets/source/hyg/hyg/CURRENT/hygdata_v41.csv').trim().split(/\r?\n/);
const fields = csvRow(csvLines[0]);
const rawSelected = csvLines.slice(1).map(csvRow).filter(row => Number(row[0]) !== 0 && Number(row[fields.indexOf('mag')]) <= 6.5);

test('every raw upstream snapshot and every generated release asset has its recorded real SHA256', () => {
  const lock = json('assets/source-lock.json');
  for (const file of lock.files) assert.equal(sha(file.path), file.sourceSha256, file.path);
  const manifest = json('assets/assets-manifest.json');
  for (const asset of manifest.assets) {
    assert.ok(asset.license && asset.credit && asset.processingCommand && asset.source);
    for (const output of asset.outputs) assert.equal(sha(output.path), output.sha256, output.path);
  }
});

test('the exact HYG4.1 magnitude subset is complete, excludes the Sun, and has stable unique IDs', () => {
  assert.equal(csvLines.length - 1, 119626);
  assert.equal(rawSelected.length, 8920);
  assert.equal(records.length, rawSelected.length + 1);
  assert.deepEqual(records.filter(row => row[5] <= 6.5).map(row => row[1]), rawSelected.map(row => Number(row[0])));
  assert.deepEqual(records.filter(row => row[5] > 6.5).map(row => row[0]), ['hip:33165']);
  assert.equal(new Set(records.map(row => row[0])).size, records.length);
  for (const row of records) { assert.notEqual(row[1], 0); assert.match(row[0], /^(hip|hyg):\d+$/); }
});

test('compact binary reconstructs all right-handed J2000 RA-hours directions and preserves magnitudes', () => {
  assert.equal(binary.byteLength, 8921 * 32);
  assert.deepEqual(Buffer.from(read('assets/runtime/stars.b64.txt'), 'base64'), binary);
  for (let i = 0; i < records.length; i++) {
    const row = records[i]; const ra = row[3] * Math.PI / 12; const dec = row[4] * Math.PI / 180;
    const expected = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    const v = expected.map((_, axis) => binary.readFloatLE(i * 32 + axis * 4));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(v[axis] - expected[axis]) < 3.1e-8);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 5e-8);
    assert.ok(Math.abs(binary.readFloatLE(i * 32 + 12) - row[5]) < 3e-7);
  }
});

test('all 88 licensed v24.4 western figures and all 692 real HIP endpoints survive filtering', () => {
  assert.equal(figures.constellations.length, 88);
  assert.equal(new Set(figures.constellations.map(c => c.id)).size, 88);
  assert.equal(figures.lineIndices.length, 1352);
  const byHip = new Map(records.map((row, i) => [row[2], i]));
  const hips = new Set<number>(); const expected: number[] = [];
  for (const culture of source.constellations) {
    const figure = figures.constellations.find(c => c.id === culture.iau)!;
    const first = expected.length / 2;
    for (const polyline of culture.lines) {
      const points = polyline.filter((p): p is number => typeof p === 'number');
      for (const hip of points) { hips.add(hip); assert.ok(byHip.has(hip), `HIP ${hip}`); }
      for (let i = 1; i < points.length; i++) expected.push(byHip.get(points[i - 1])!, byHip.get(points[i])!);
    }
    assert.equal(figure.lineStart, first); assert.equal(figure.lineCount, expected.length / 2 - first);
    assert.ok(figure.nameZh.endsWith('座')); assert.ok(Math.abs(Math.hypot(...figure.directionEqj) - 1) < 1e-12);
  }
  assert.equal(hips.size, 692); assert.deepEqual(figures.lineIndices, expected);
  assert.ok(figures.lineWeights.every(weight => weight === 1));
  assert.ok(figures.lineIndices.every(index => index >= 0 && index < records.length));
});

test('unknown colour and dubious distance keep explicit quality flags instead of fabricated values', () => {
  const unknown = records.filter(row => row[6] === null); assert.equal(unknown.length, 40);
  for (const row of unknown) {
    const i = records.indexOf(row); assert.ok(row[12] & 1); assert.ok(Number.isNaN(binary.readFloatLE(i * 32 + 28)));
    for (let channel = 0; channel < 3; channel++) assert.equal(binary.readFloatLE(i * 32 + 16 + channel * 4), 1);
  }
  assert.equal(records.filter(row => row[13] === null).length, 207);
  for (const row of records) {
    assert.equal(Boolean(row[12] & 2), row[13] === null);
    assert.equal(Boolean(row[12] & 4), row[14] === null);
    if (row[13] !== null) assert.ok(row[13] > 0 && row[13] < 100000);
  }
});

test('proper motion mu_alpha includes cos(dec), verified against independent Cartesian velocity fields at Polaris and Vega', () => {
  const masPerRad = 180 / Math.PI * 3600 * 1000;
  for (const hip of [11767, 91262, 32349]) {
    const row = records.find(r => r[2] === hip)!;
    const ra = row[3] * Math.PI / 12; const dec = row[4] * Math.PI / 180; const distance = row[13]!;
    const eastMotion = (-Math.sin(ra) * row[15][0] + Math.cos(ra) * row[15][1]) / distance * masPerRad;
    assert.ok(Math.abs(eastMotion - row[10]) < 0.3, `HIP ${hip}`);
    assert.ok(Math.abs(eastMotion - row[10] * Math.cos(dec)) > 20, `HIP ${hip} discriminates the cos(dec) convention`);
  }
  assert.match(read('assets/source/esa/hipparcos-ReadMe.html'), /mu_alpha.cos\(delta\)/);
});

test('every Chinese bright-star name resolves to the confirmed v24.4 source HIP and exact full-name translation', () => {
  const names = json('assets/names-zh-evidence.json');
  const chinese = read('assets/source/stellarium244/chinese/star_names.fab').split(/\r?\n/);
  const byId = new Map(records.map(row => [row[0], row]));
  assert.equal(records.filter(row => row[8]).length, 176);
  assert.equal(names.length, 198);
  for (const evidence of names) {
    assert.ok(byId.has(evidence.id)); assert.equal(byId.get(evidence.id)![2], evidence.hip);
    assert.equal(chinese[evidence.sourceLine - 1].trim(), `${evidence.hip}|_("${evidence.english}") 1`);
    assert.ok(read(`assets/source/${evidence.translationSource}`).includes(`msgid "${evidence.translationKey}"`));
    assert.ok(evidence.ordinal === null || evidence.ordinal > 0);
  }
  assert.equal(records.find(row => row[2] === 32349)![8], '天狼');
  assert.equal(records.find(row => row[2] === 11767)![8], '北极星');
  assert.equal(records.find(row => row[2] === 24436)![8], '参宿七');
  assert.equal(records.find(row => row[2] === 27989)![8], '参宿四');
});

test('the three active textures fit the 2K/1K budget and are included through static inline URLs', () => {
  const report = json('assets/texture-report.json');
  assert.deepEqual(report.files['assets/runtime/earth-day-2k.webp'].dimensions, [2048, 1024]);
  assert.deepEqual(report.files['assets/runtime/earth-night-1k.webp'].dimensions, [1024, 512]);
  assert.deepEqual(report.files['assets/runtime/earth-clouds-1k.webp'].dimensions, [1024, 512]);
  assert.match(report.cloudRole, /NASA.*2002.*not current weather/);
  assert.match(read('src/data/textures.ts'), /earth-day-2k\.webp\?inline/);
  assert.match(read('src/data/textures.ts'), /earth-night-1k\.webp\?inline/);
  assert.match(read('src/data/textures.ts'), /earth-clouds-1k\.webp\?inline/);
  assert.doesNotMatch(read('src/data/catalog.ts'), /fetch\s*\(/);
});

test('the shipped HYG4.1 and Stellarium v24.4 data families carry explicitly numbered CC BY-SA4.0 licenses', () => {
  assert.match(read('assets/source/hyg/hyg/README.md'), /Attribution-ShareAlike 4.0/);
  assert.match(read('assets/source/stellarium244/modern/info.ini'), /CC BY-SA 4.0 International Public License/);
  assert.match(read('assets/source/stellarium244/chinese/info.ini'), /CC BY-SA 4.0 International Public License/);
  const manifest = json('assets/assets-manifest.json');
  for (const id of ['western-constellations', 'chinese-star-aliases']) {
    const asset = manifest.assets.find((item: { id: string }) => item.id === id);
    assert.equal(asset.license, 'CC-BY-SA-4.0');
    assert.equal(asset.revision, 'ab961cbde42eec8121be0df6ff48292f8d492b54');
  }
  assert.match(read('assets/licenses/STELLARIUM-NOTICE.md'), /v24.4/);
  assert.match(read('assets/licenses/NASA-NOTICE.md'), /Robert Simmon/);
  assert.match(read('assets/licenses/NASA-NOTICE.md'), /2012/);
});
