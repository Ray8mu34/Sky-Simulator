import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { Mat3, ObjectId, ScienceSnapshot, Vec3 } from '../src/contracts';
import type { ConstellationMeta, StarCatalog, StarMeta } from '../src/data/types';
import { resolveCatalogStar, searchObjects } from '../src/data/search';
import { resolveDisplayDirectionEqj, resolveObjectDetails, resolveObjectDirectionEqj } from '../src/core/object-details';
import { computeSnapshot } from '../src/core/astronomy';
import { angularSeparationDeg, applyMatrix, normalize, raDecToVector, vectorToHorizontal } from '../src/core/math';
import { propagateStarDirection } from '../src/core/stars';
import { scienceState } from './fixtures/science-state';
import { createRefractionDescriptor } from '../src/core/refraction';

const identity: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const close = (a: number, b: number, tolerance = 1e-10): void => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b}`);
const vecClose = (a: Vec3, b: Vec3): void => a.forEach((value, i) => close(value, b[i]!));
function star(index: number, id: StarMeta['id'], raHours: number, decDeg: number, overrides: Partial<StarMeta> = {}): StarMeta {
  return { index, id, hygId: 101 + index, hip: id.startsWith('hip:') ? Number(id.slice(4)) : null,
    raHours, decDeg, magnitude: 1, colorIndex: null, aliases: [], pmRaMasYr: 0, pmRaCosDecMasYr: 0, pmDecMasYr: 0,
    qualityFlags: 7, distancePc: null, radialVelocityKmS: null, spaceVelocityEqjPcYr: [0, 0, 0], variableName: null,
    variableMagnitudeRange: [null, null], component: 1, componentPrimaryHygId: 101 + index, constellationId: 'Tri', ...overrides };
}
function makeCatalog(stars: StarMeta[], lineIndices: number[] = [], constellations: ConstellationMeta[] = []): StarCatalog {
  return { stars, directionsEqj: Float32Array.from(stars.flatMap(star => [...raDecToVector(star.raHours, star.decDeg)])),
    magnitudes: Float32Array.from(stars.map(star => star.magnitude)), colors: new Float32Array(stars.length * 3), colorIndices: new Float32Array(stars.length),
    lineIndices: Uint16Array.from(lineIndices), constellations };
}
const namedCatalog = (): StarCatalog => makeCatalog([
  star(0, 'hip:2', 0, 0, { nameZh: '共同名', nameEn: 'Beta Sample', aliases: ['共同别名', '样本星'] }),
  star(1, 'hip:1', 6, 0, { nameZh: '共同名', nameEn: 'Alpha Sample', aliases: ['共同别名', '样本星'] }),
  star(2, 'hyg:103', 0, 60, { nameZh: '共同名', nameEn: 'Gamma Sample', magnitude: 0.5, aliases: ['样本星'] }),
  star(3, 'hip:11767', 2.52975, 89.264109, { hygId: 11734, nameZh: '北极星', nameEn: 'Polaris', aliases: ['勾陈一', '1Alp UMi'], pmRaCosDecMasYr: 44.22, pmDecMasYr: -11.74 }),
], [0, 1, 1, 2], [{ id: 'Tri', nameZh: '三角座', nameEn: 'Triangulum', directionEqj: [0, 0, -1], lineStart: 0, lineCount: 2 }]);
function emptySnapshot(ut = 0): ScienceSnapshot {
  return { requestId: 0, utDaysJ2000: ut, ttDaysJ2000: ut + 0.001, gastHours: 0, lstHours: 0, eqjToHorizontalGeometric: identity,
    eclipticOfDateToEqj: identity, observerRefraction: createRefractionDescriptor(scienceState().environment),
    earthFixedToEqj: identity, localZenithEqjUnit: [0, 0, 1], bodies: [], warnings: [], accuracyTier: 'unvalidated' };
}

test('search supports Chinese, supplied aliases, English and constellation abbreviation without fetching assets', () => {
  const catalog = namedCatalog();
  for (const query of ['北极星', '勾陈一', 'POLARIS', '  pol aris  ']) assert.equal(searchObjects(catalog, query)[0]?.id, 'hip:11767');
  for (const query of ['Tri', 'TRI', 'constellation:tri', '三角座', 'Triangulum']) assert.equal(searchObjects(catalog, query)[0]?.id, 'constellation:Tri');
  assert.deepEqual(searchObjects(catalog, '不存在的星'), []);
});

test('HIP/HYG numeric aliases map to the same canonical star including full-width and leading zeros', () => {
  const catalog = namedCatalog();
  for (const query of ['HIP11767', 'hip:11767', 'HIP 011767', 'ＨＩＰ １１７６７', 'HYG11734', 'hyg:11734', 'HYG 11734', '11734']) {
    assert.equal(searchObjects(catalog, query)[0]?.id, 'hip:11767', query);
  }
  assert.equal(resolveObjectDetails(catalog, 'hyg:11734', emptySnapshot())?.id, 'hip:11767');
  for (const query of ['HIP-1', 'HYG0', 'HIP1.5', 'HIP9007199254740993']) assert.deepEqual(searchObjects(catalog, query), []);
});

test('same names and equal magnitudes have deterministic brightness/identifier ordering independent of catalog order', () => {
  const catalog = namedCatalog(), reversed = { ...catalog, stars: [...catalog.stars].reverse() };
  const result = searchObjects(catalog, '共同名');
  assert.deepEqual(result.map(row => row.id), ['hyg:103', 'hip:1', 'hip:2']);
  assert.deepEqual(searchObjects(reversed, '共同名'), result);
  assert.ok(result[1]!.secondary.includes('HIP 1') && result[1]!.secondary.includes('HYG 102'));
  assert.equal(new Set(result.map(row => row.id)).size, result.length);
});

test('exact names beat prefix/substrings and bare numeric namespaces stay deterministic', () => {
  const catalog = makeCatalog([
    star(0, 'hip:9', 0, 0, { nameEn: 'Needle', magnitude: 6 }),
    star(1, 'hip:10', 0, 0, { nameEn: 'Needle Extended', magnitude: -1 }),
    star(2, 'hip:11', 0, 0, { nameEn: 'The Needle', magnitude: -2 }),
    star(3, 'hyg:9', 0, 0, { hygId: 9, magnitude: 3 }),
  ]);
  assert.deepEqual(searchObjects(catalog, 'Needle').map(row => row.id), ['hip:9', 'hip:10', 'hip:11']);
  assert.deepEqual(searchObjects(catalog, '9').map(row => row.id), ['hyg:9', 'hip:9']);
});

test('a shared HIP selects its explicit canonical record before a brighter companion and never chooses an arbitrary component', () => {
  const primary = star(0, 'hip:100', 0, 0, { hip: 100, hygId: 1, magnitude: 5 });
  const companion = star(1, 'hyg:2', 6, 0, { hip: 100, hygId: 2, magnitude: -1 });
  const catalog = makeCatalog([companion, primary]);
  assert.deepEqual(searchObjects(catalog, 'HIP100').map(row => row.id), ['hip:100', 'hyg:2']);
  assert.equal(resolveCatalogStar(catalog, 'hip:100'), primary);
  assert.equal(resolveObjectDetails(catalog, 'hyg:2', emptySnapshot())?.id, 'hyg:2');
  const ambiguous = makeCatalog([companion, star(2, 'hyg:3', 12, 0, { hip: 100, hygId: 3 })]);
  assert.equal(resolveCatalogStar(ambiguous, 'hip:100'), null);
  assert.equal(searchObjects(ambiguous, 'HIP100').length, 2);
});

test('search limits bound public output and reject empty, non-finite and oversized requests', () => {
  const catalog = makeCatalog(Array.from({ length: 100 }, (_, index) => star(index, `hip:${index + 1}`, 0, 0, { nameZh: '样本' })));
  assert.equal(searchObjects(catalog, '样本').length, 12);
  assert.equal(searchObjects(catalog, '样本', 3.9).length, 3);
  assert.equal(searchObjects(catalog, '样本', 10000).length, 64);
  for (const limit of [0, -1, NaN, Infinity]) assert.deepEqual(searchObjects(catalog, '样本', limit), []);
  for (const query of ['', '  \n ', 'a'.repeat(513)]) assert.deepEqual(searchObjects(catalog, query), []);
});

test('only the displayed Sun and Moon are searchable and resolvable solar bodies', () => {
  const catalog = namedCatalog();
  for (const query of ['太阳', 'Sun', 'BODY:SUN']) assert.equal(searchObjects(catalog, query)[0]?.id, 'body:Sun');
  for (const query of ['月亮', '月球', 'Moon', 'body:Moon']) assert.equal(searchObjects(catalog, query)[0]?.id, 'body:Moon');
  for (const query of ['Mars', '火星', 'body:Mars', 'Venus', '木星']) assert.deepEqual(searchObjects(catalog, query), []);
  const snapshot = computeSnapshot(scienceState(), 1);
  assert.equal(resolveObjectDetails(catalog, 'body:Mars', snapshot), null);
  assert.equal(resolveDisplayDirectionEqj(catalog, 'body:Mars', snapshot, 'space'), null);
});

test('star details use actual snapshot proper-motion time and truthful coordinate epoch labels', () => {
  const catalog = namedCatalog(), snapshot = emptySnapshot(400 * 365.25);
  const original = catalog.stars[3]!, details = resolveObjectDetails(catalog, original.id, snapshot)!;
  assert.ok(details.coordinateEpochLabel.includes('J2000') && details.coordinateEpochLabel.includes('当前'));
  vecClose(details.directionEqj, propagateStarDirection(original, snapshot.utDaysJ2000));
  assert.ok(angularSeparationDeg(details.directionEqj, raDecToVector(original.raHours, original.decDeg)) > 0.001);
  vecClose(raDecToVector(details.raHours!, details.decDeg), details.directionEqj);
  assert.ok(details.notes.some(note => note.includes('不是星表2000.0')));
  const changed = resolveObjectDetails(catalog, original.id, emptySnapshot(snapshot.utDaysJ2000 + 365.25))!;
  assert.ok(angularSeparationDeg(details.directionEqj, changed.directionEqj) > 0);
});

test('details transform the same direction through snapshot ENU and say below-horizon without a rise/set prediction', () => {
  const catalog = makeCatalog([star(0, 'hip:5', 3, -30, { nameZh: '样本星' })]);
  const snapshot = emptySnapshot(), details = resolveObjectDetails(catalog, 'hip:5', snapshot)!;
  close(details.geometricAltitudeDeg, -30); close(details.azimuthDeg!, 45);
  assert.equal(details.visibilityText, '当前在几何地平线下方');
  assert.ok(details.notes.some(note => note.includes('不是升落预报')));
  snapshot.eqjToHorizontalGeometric = [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
  const rotated = resolveObjectDetails(catalog, 'hip:5', snapshot)!;
  const horizontal = vectorToHorizontal(applyMatrix(snapshot.eqjToHorizontalGeometric, details.directionEqj));
  close(rotated.geometricAltitudeDeg, horizontal.altitudeDeg); close(rotated.azimuthDeg!, horizontal.azimuthDeg!);
  assert.notEqual(rotated.geometricAltitudeDeg, details.geometricAltitudeDeg);
});

test('zenith/nadir have null azimuth and celestial poles have null RA with explicit undefined notes', () => {
  const catalog = makeCatalog([star(0, 'hip:1', 5, 90), star(1, 'hip:2', 7, -90)]);
  const north = resolveObjectDetails(catalog, 'hip:1', emptySnapshot())!, south = resolveObjectDetails(catalog, 'hip:2', emptySnapshot())!;
  assert.equal(north.azimuthDeg, null); assert.equal(south.azimuthDeg, null);
  close(north.geometricAltitudeDeg, 90); close(south.geometricAltitudeDeg, -90);
  assert.equal(north.raHours, null); assert.equal(south.raHours, null);
  assert.ok(north.notes.some(note => note.includes('赤经无定义')));
});

test('constellation anchor averages unique propagated endpoints, not static metadata or duplicate segment weighting', () => {
  const catalog = namedCatalog(), details = resolveObjectDetails(catalog, 'constellation:tri', emptySnapshot())!;
  const expected = normalize([1 + 0.5, 1, Math.sqrt(3) / 2]);
  vecClose(details.directionEqj, expected);
  assert.equal(details.id, 'constellation:Tri'); assert.equal(details.magnitude, null);
  assert.ok(details.notes.some(note => note.includes('锚点')) && details.notes.some(note => note.includes('没有物理视星等')));
  const movingStars = catalog.stars.map((row, index) => index === 0 ? { ...row, pmRaCosDecMasYr: 10000 } : row);
  const moving = { ...catalog, stars: movingStars }, time = emptySnapshot(100 * 365.25);
  const later = resolveObjectDetails(moving, 'constellation:Tri', time)!;
  const vectors = [0, 1, 2].map(index => propagateStarDirection(movingStars[index]!, time.utDaysJ2000));
  const sum: Vec3 = [vectors.reduce((value, vector) => value + vector[0], 0), vectors.reduce((value, vector) => value + vector[1], 0), vectors.reduce((value, vector) => value + vector[2], 0)];
  vecClose(later.directionEqj, normalize(sum));
  assert.ok(angularSeparationDeg(later.directionEqj, details.directionEqj) > 0);
});

test('missing, invalid, empty and cancelling constellation directions produce no fabricated details', () => {
  const catalog = namedCatalog(), snapshot = emptySnapshot();
  for (const id of [null, 'hip:999999', 'hyg:999999', 'constellation:Unknown', 'body:Moon'] as (ObjectId | null)[]) assert.equal(resolveObjectDetails(catalog, id, snapshot), null);
  assert.equal(resolveObjectDirectionEqj(catalog, null, snapshot), null);
  const figure = catalog.constellations[0]!;
  assert.equal(resolveObjectDetails({ ...catalog, constellations: [{ ...figure, lineCount: 0 }] }, 'constellation:Tri', snapshot), null);
  assert.equal(resolveObjectDetails({ ...catalog, lineIndices: Uint16Array.from([0, 999, 1, 2]) }, 'constellation:Tri', snapshot), null);
  const opposing = makeCatalog([star(0, 'hip:1', 0, 0), star(1, 'hip:2', 12, 0)], [0, 1], [{ ...figure, lineCount: 1 }]);
  assert.equal(resolveObjectDetails(opposing, 'constellation:Tri', snapshot), null);
  assert.equal(resolveObjectDetails(catalog, 'hip:1', { ...snapshot, utDaysJ2000: NaN }), null);
  assert.equal(resolveObjectDetails(catalog, 'hip:1', { ...snapshot, eqjToHorizontalGeometric: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }), null);
  assert.equal(resolveObjectDetails(catalog, 'hip:1', { ...snapshot, eqjToHorizontalGeometric: [[NaN, 0, 0], [0, 1, 0], [0, 0, 1]] }), null);
  assert.equal(resolveObjectDetails(catalog, 'hip:1', { ...snapshot, eqjToHorizontalGeometric: [[Infinity, 0, 0], [0, 1, 0], [0, 0, 1]] }), null);
});

test('missing stellar names and magnitudes use an identifier and null magnitude rather than fabricated values', () => {
  const catalog = makeCatalog([star(0, 'hyg:101', 0, 0, { magnitude: NaN })]);
  const details = resolveObjectDetails(catalog, 'hyg:101', emptySnapshot())!;
  assert.equal(details.label, 'HYG:101'); assert.equal(details.magnitude, null);
  assert.ok(details.notes.some(note => note.includes('未提供有效视星等')));
});

test('Sun/Moon detail readouts use snapshot topocentric of-date coordinates while external focus uses geocentric display', () => {
  const snapshot = computeSnapshot(scienceState('2026-09-14T14:00:00Z'), 1), catalog = namedCatalog();
  for (const id of ['body:Sun', 'body:Moon'] as const) {
    const body = snapshot.bodies.find(body => `body:${body.id}` === id)!, details = resolveObjectDetails(catalog, id, snapshot)!;
    vecClose(details.directionEqj, body.topocentricDirectionEqj);
    close(details.raHours!, body.raHoursOfDate); close(details.decDeg, body.decDegOfDate);
    close(details.geometricAltitudeDeg, body.geometricAltitudeDeg); close(details.azimuthDeg!, body.azimuthDeg!);
    assert.ok(details.coordinateEpochLabel.includes('当日真赤道') && details.coordinateEpochLabel.includes('站心'));
    assert.ok(details.notes.some(note => note.includes('地心方向展示')));
    vecClose(resolveDisplayDirectionEqj(catalog, id, snapshot, 'ground')!, body.topocentricDirectionEqj);
    for (const mode of ['space', 'globe', 'horizon'] as const) vecClose(resolveDisplayDirectionEqj(catalog, id, snapshot, mode)!, normalize(body.geocentricEqjAU));
  }
  const moon = snapshot.bodies.find(body => body.id === 'Moon')!;
  assert.ok(angularSeparationDeg(moon.topocentricDirectionEqj, moon.geocentricEqjAU) > 0.1, 'fixture must meaningfully exercise lunar parallax');
});

test('star and constellation display direction stay common across every view', () => {
  const catalog = namedCatalog(), snapshot = emptySnapshot(100 * 365.25);
  for (const id of ['hip:11767', 'constellation:Tri'] as const) {
    const observer = resolveObjectDirectionEqj(catalog, id, snapshot)!;
    for (const mode of ['ground', 'space', 'globe', 'horizon'] as const) vecClose(resolveDisplayDirectionEqj(catalog, id, snapshot, mode)!, observer);
  }
});

test('real offline catalog Chinese/English/HIP/HYG aliases resolve Polaris to one canonical item', () => {
  const records = JSON.parse(readFileSync(new URL('../assets/runtime/star-meta.json', import.meta.url), 'utf8')) as unknown[][];
  const record = records.find(record => record[0] === 'hip:11767')!;
  assert.ok(record, 'real Polaris metadata must be present');
  const polaris = star(0, record[0] as StarMeta['id'], record[3] as number, record[4] as number, {
    hygId: record[1] as number, hip: record[2] as number, magnitude: record[5] as number, nameEn: record[7] as string, nameZh: record[8] as string,
    aliases: record[9] as string[], pmRaCosDecMasYr: record[10] as number, pmDecMasYr: record[11] as number,
  });
  const catalog = makeCatalog([polaris]);
  for (const query of ['北极星', '勾陈一', 'Polaris', 'HIP11767', `HYG${record[1]}`]) assert.equal(searchObjects(catalog, query)[0]?.id, 'hip:11767');
});
