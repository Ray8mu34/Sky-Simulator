import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const result = await build({ entryPoints: ['src/data/lunar.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'static-raw-test', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    builder.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  } }] });
const lunar = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`) as typeof import('../src/data/lunar');
const utc8Noon = (iso: string) => Date.parse(`${iso}T04:00:00Z`);
const lookup = lunar.lookupLunarCalendar;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('UTC+8 Gregorian endpoints retain lunar1900 start and2101 sentinel, with exact midnight bounds', () => {
  assert.equal(lookup(Date.parse('1900-12-31T15:59:59.999Z')).available, false);
  const first = lookup(Date.parse('1900-12-31T16:00:00Z'));
  assert.ok(first.available);
  assert.deepEqual([first.civilDate, first.year, first.month, first.day], ['1901-01-01', 1900, 11, 11]);
  const last = lookup(Date.parse('2100-12-31T15:59:59.999Z'));
  assert.ok(last.available);
  assert.deepEqual([last.civilDate, last.year, last.month, last.day], ['2100-12-31', 2100, 12, 1]);
  assert.equal(lookup(Date.parse('2100-12-31T16:00:00Z')).available, false);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const value = lookup(invalid); assert.ok(!value.available); assert.equal(value.reason, 'invalid-time');
  }
  assert.equal(lookup(1e100).available, false);
  assert.ok(lunar.lunarCalendarMetadata.recordFirst.civilDate < '1901-01-01');
  assert.ok(lunar.lunarCalendarMetadata.recordLast.civilDate >= '2101-01-01');
});

test('HKO independent month/year/leap fixtures include2033 leap11 andUTC+8 day rollover', () => {
  const fixtures: [string, number, number, number, boolean][] = [
    ['1901-02-19', 1901, 1, 1, false], ['2026-02-17', 2026, 1, 1, false],
    ['2023-03-22', 2023, 2, 1, true], ['2033-12-22', 2033, 11, 1, true],
    ['2034-01-01', 2033, 11, 11, true], ['2034-01-20', 2033, 12, 1, false],
  ];
  for (const [iso, year, month, day, leap] of fixtures) {
    const value = lookup(utc8Noon(iso)); assert.ok(value.available);
    assert.deepEqual([value.year, value.month, value.day, value.isLeapMonth], [year, month, day, leap]);
  }
  const before = lookup(Date.parse('2023-03-21T15:59:59Z'));
  const after = lookup(Date.parse('2023-03-21T16:00:00Z'));
  assert.ok(before.available && after.available);
  assert.deepEqual([before.isLeapMonth, before.day, after.isLeapMonth, after.day], [false, 30, true, 1]);
  assert.equal(after.label, '闰二月初一');
  assert.equal(after.calendarZone, 'UTC+08:00');
});

test('actual runtime lookup independently matches all73049 HKO days except the30 retained2057 convention differences', () => {
  let lunarYear = 1900; let lunarMonth = 11; let leap = false;
  const rows = new Map<string, [number, number, number, boolean]>();
  for (let y = 1901; y <= 2100; y++) {
    const text = readFileSync(`assets/source/hko/T${y}e.txt`, 'latin1');
    const pattern = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d+(?:st|nd|rd|th)\s+Lunar\s+month|\d+)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/gim;
    for (const entry of text.matchAll(pattern)) {
      const iso = `${entry[1]}-${entry[2].padStart(2, '0')}-${entry[3].padStart(2, '0')}`;
      const heading = /Lunar/i.test(entry[4]); let day = Number(entry[4]);
      if (heading) {
        const month = Number.parseInt(entry[4]); leap = month === lunarMonth;
        if (month === 1 && !leap) lunarYear++;
        lunarMonth = month; day = 1;
      }
      assert.equal(rows.has(iso), false); rows.set(iso, [lunarYear, lunarMonth, day, leap]);
    }
  }
  assert.equal(rows.size, 73048);
  assert.equal(rows.has('2069-12-30'), false);
  const supplement = json('qa/m3-review/fixtures/hko-2069e.metadata.json');
  assert.equal(sha('assets/source/hko/2069e.pdf'), supplement.sha256);
  assert.deepEqual(supplement.verifiedRow, { lunarDay: 17, gregorianDate: '2069-12-30', isLeapMonth: false, lunarMonth: 11 });
  rows.set('2069-12-30', [2069, 11, 17, false]);
  const differences: string[] = [];
  for (let milliseconds = Date.UTC(1901, 0, 1); milliseconds < Date.UTC(2101, 0, 1); milliseconds += 86400000) {
    const iso = new Date(milliseconds).toISOString().slice(0, 10); const expected = rows.get(iso);
    assert.ok(expected, `Missing independently checked date${iso}`);
    const actual = lookup(milliseconds + 4 * 3600000); assert.ok(actual.available);
    const tuple = [actual.year, actual.month, actual.day, actual.isLeapMonth];
    if (JSON.stringify(tuple) !== JSON.stringify(expected)) differences.push(iso);
    assert.equal(actual.uncertain, [2057, 2089, 2097].includes(Number(iso.slice(0, 4))));
  }
  const retained = json('assets/lunar-hko-mismatches.json').mismatches.map((entry: { civilDate: string }) => entry.civilDate);
  assert.deepEqual(differences, retained);
  assert.equal(differences.length, 30);
  assert.equal(differences[0], '2057-09-28'); assert.equal(differences.at(-1), '2057-10-27');
  assert.equal(lunar.lunarCalendarMetadata.hkoComparison.checkedDays, 73049);
});

test('fixed generator provenance andlicense are retained while runtime includes only compact data', () => {
  const meta = json('assets/source/lunar-typescript/npm-1.8.6.json');
  const packageBytes = readFileSync('assets/source/lunar-typescript/lunar-typescript-1.8.6.tgz');
  assert.equal(meta.version, '1.8.6'); assert.equal(meta.license, 'MIT');
  assert.equal(meta.gitHead, 'a376ec2b8fd1b3069e24c92801bab8707fccd49d');
  assert.equal('sha512-' + createHash('sha512').update(packageBytes).digest('base64'), meta.dist.integrity);
  assert.ok(readFileSync('assets/licenses/LUNAR-TYPESCRIPT-MIT.txt', 'utf8').includes('Copyright (c) 2020 6tail'));
  assert.ok(readFileSync('assets/licenses/HKO-QA-NOTICE.md', 'utf8').includes('strictly prohibited'));
  assert.ok(readFileSync('assets/runtime/lunar-months.bin').byteLength < 21000);
  const packaged = result.outputFiles[0].text;
  assert.ok(!packaged.includes('class LunarYear')); assert.ok(!packaged.includes('getFirstJulianDay'));
});
