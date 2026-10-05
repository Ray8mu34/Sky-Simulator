/** Original-input QA preparation/driver. No browser is imported unless --browser is explicit. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page, BrowserContext, Browser } from '@playwright/test';
import type { CivilInput, Mat3, ScienceSnapshot, SimulationState, Vec3 } from '../src/contracts';
import { createDefaultState, parseState, serializeState } from '../src/state';
import { dateToUt, formatEraYear, localCivilParts, parseCivilInput, utToDate } from '../src/core/time';
import { computeSnapshot, computeSolarDayEvents } from '../src/core/astronomy';
import { computeMoonQuarterSequence } from '../src/core/moon';
import { propagateStarDirection } from '../src/core/stars';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KIT_PATH = 'tests/fixtures/acceptance-scenes.json';
const KIT_SHA = '10abb4805763c7646edd4c0c0d92b4a2dbf0db7a360c7f354d93515073452fbd';
const HORIZONS_ROWS = 'qa/science-reference-prep/horizons-observer-rows.json';
const HORIZONS_ROWS_SHA = '34b7a7a1cdf6fc3f8e9a3d83eaaafd41c60b00a0215a5cd0e87820082b89608b';
export const PRIORITY_SCENE_IDS = ['V01', 'V02', 'V03', 'V04', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S10'] as const;
export const REMAINING_SCENE_IDS = ['S08', 'S09', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'D01', 'U01', 'P01', 'O01', 'O02'] as const;
const RAD = Math.PI / 180;
type TimeInput = { kind: 'utc-iso'; value: string } | { kind: 'civil'; value: CivilInput };
type SourceScene = {
  id: string; title: string; group: string;
  inputs: { time: TimeInput; observer: SimulationState['observer']; viewMode: SimulationState['viewMode'];
    presentation: SimulationState['presentation']; density: SimulationState['density']; viewportCssPx: [number, number]; groundCamera: SimulationState['cameras']['ground'] };
  assertions: { status: string; requirement: string }[];
  comparisonObservers?: SimulationState['observer'][];
  additionalTimes?: TimeInput[];
  timeSelection?: Record<string, unknown>;
  sequence?: Record<string, unknown>[];
  cameraCalibration?: Record<string, unknown>;
  [key: string]: unknown;
};
type HorizonRow = { body: string; siteId: string; jdUT: number; calendarUT: string; azimuthDegNorthEast: number;
  airlessAltitudeDeg: number; illuminatedPercent: number; rawReferenceId: string; rawSha256: string; [key: string]: unknown };
export type FinalSceneCase = {
  id: string; source: SourceScene; state: SimulationState;
  timeResolution: { kind: 'resolved' | 'expected-native-rejection'; input: TimeInput; error?: string };
  comparisons: { observer: SimulationState['observer']; state: SimulationState }[];
  additionalTimes: { input: TimeInput; state: SimulationState | null; error?: string }[];
  setupNote: string | null;
  independentReference: { row: HorizonRow; paths: { path: string; sha256: string }[]; scoring: string } | null;
  calibrationProposal: { radius: number; targetRatio: number; distance: number; scope: string } | null;
  executionPlan: { cpu: string; native: string; oracle: string; record: string; open: string };
};
export type FinalSceneManifest = {
  schemaVersion: 1; kind: 'final-acceptance-input-manifest'; createdAtUtc: string;
  source: { path: string; sha256: string; originalStatus: string; sceneCount: number; assertionCount: number };
  defaults: { schemaVersion: number; state: SimulationState; serializedSha256: string; sourceSha256: string };
  sourceFingerprints: { path: string; sha256: string }[];
  runtime: { node: string; icu: string | undefined; tz: string | undefined };
  scenes: FinalSceneCase[];
  limitations: string[];
};

const bytes = (path: string) => readFileSync(resolve(ROOT, path));
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(bytes(path).toString('utf8'));
const clone = <T>(value: T): T => structuredClone(value);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const multiply = (m: Mat3, v: readonly number[]) => m.map(row => dot(row, v)) as [number, number, number];
const transposeMultiply = (m: Mat3, v: readonly number[]) => [0, 1, 2].map(i => m.reduce((sum, row, j) => sum + row[i]! * v[j]!, 0));
const norm = (v: readonly number[]) => Math.hypot(...v);
const unit = (v: readonly number[]) => v.map(n => n / norm(v));
const angularDeg = (a: readonly number[], b: readonly number[]) => Math.atan2(norm(cross(a, b)), dot(a, b)) / RAD;
const enu = (alt: number, az: number) => [Math.cos(alt * RAD) * Math.sin(az * RAD), Math.cos(alt * RAD) * Math.cos(az * RAD), Math.sin(alt * RAD)];
const mod = (v: number, d: number) => (v % d + d) % d;

/** Explicit remaining-assertion plans are executable ownership boundaries, not success claims. */
export function getFinalSceneExecutionPlan(id: string): FinalSceneCase['executionPlan'] {
  const plans: Record<string, FinalSceneCase['executionPlan']> = {
    S08: { cpu: 'deriveFinalSceneTimes: first descending centre-geometric0/−6/−12/−18 after original seed; save all UTC/residuals', native: 'Real UTC civil input for each saved instant; none/standard/P0 forms; Sun search, screenshots of both altitudes', oracle: 'Original exact altitude targets; existing USNO civil end twilight minute table at same lat/lon, sea-level distinction retained; M5C independent profile/pixel suite', record: 'derived-times.json + four states/snapshots/none/standard/P0 screenshots in full browser video', open: 'GPU low-disc/line/label/native-pick accuracy still requires dedicated M5C pixel oracle; no fabricated independent all-threshold event table' },
    S09: { cpu: 'computeMoonQuarterSequence from original seed; hash fixed USNO reference and compare all four≤120s', native: 'Load actual S09 preset; click quarter search/export; event buttons pause; record four phases and north/south quarters', oracle: 'Fixed USNO web-capture provenance, not original HTTP bytes; physical illumination/phase semantics; existing NASA/LunarDisc oracle', record: 'Actual derived export, four event UTC/readouts/screenshots and north/south quarter snapshots/video', open: 'Moon raster/bright-limb accuracy relies on dedicated physical/pixel oracle, not fraction-only pass' },
    S11: { cpu: 'Original three UTC; fixed JPL endpoint rows; Gregorian1900/2000/2100; retain old2100 ΔT failure diagnostic', native: 'Real fixedUTC0 date form then restore original observer UTC+8; screenshot each date/notice', oracle: 'Original local JPL raw/hash; formal2′ only h>5; no independent Feb29 row invented', record: 'Original three states/UTC/altitudes/accuracy notices', open: 'Unverified quantities never globally modern-validated' },
    S12: { cpu: 'Year0 Jan1 exact input; −1/0/1 civil continuity and explicit BCE labels', native: 'Input original year0 using actual fixedUTC0 form, restore observer UTC+8', oracle: 'Independent Gregorian/BCE definitions; finite outputs are numerical diagnostics', record: 'Year0 input/state/notice/lunar-unavailable screenshot', open: 'No astronomical accuracy guarantee in extended eras' },
    S13: { cpu: 'Original−2000/+4000 Jun21 finite snapshots; catalogue source-scalar motion readout identity', native: 'Input both original civil dates and search actual Polaris; screenshot extension/static-MW notices', oracle: 'Source p0/v and prior whole-domain motion bounds; modern SOFA not promoted to extended ephemeris accuracy', record: 'Both complete states, endpoint directions/readouts/screenshots', open: 'Static Milky Way is approximate; historical absolute sky accuracy unverified' },
    S14: { cpu: 'Original ±180/h0/UTC±12; same instant/matrix, dates15th/14th', native: 'Real longitude form and ±12 zone form; no clock reset; screenshots', oracle: 'Independent east-longitude/UTC-offset arithmetic', record: 'Before/after UTC, cameras, source/actual observer names and local civil labels', open: 'Display-only local-day event caches need not be identical' },
    S15: { cpu: 'Exact fold reject/earlier/later05:30Z/06:30Z and exact gap reject; record Intl identity', native: 'Actual IANA/name/fold-choice/date forms; error-state atomicity, restore original observer fixedUTC+8', oracle: 'Original DST policy and fixed host rules; expected ambiguity choice never inferred', record: 'All wall inputs/errors, two actual UTCs, before/after states/screenshots', open: 'Browser Intl version is host-specific; no bundled universal political rule promise' },
    S16: { cpu: 'Execute existing data-lunar.test.ts unchanged: 73049HKO days/30retained differences/hash/range', native: 'Four Gregorian UTC+8 boundary instants,2033 leap11 and uncertain2057/2089/2097; change observer zone only', oracle: 'Fixed MIT table generator/HKO source and PDF missing-row proof', record: 'Boundary/leap/uncertain lookup objects and visible screenshots', open: 'Future uncertainty retained; unsupported dates unavailable' },
    D01: { cpu: 'Execute existing data.test.ts/data-milky-way.test.ts and science-star-motion.test.ts unchanged', native: 'All88 Chinese searches and canonical ids; near-shell focus/highlight reuse; actual Milky Way off/on screenshots', oracle: 'Fixed HYG/Stellarium source maps, ESO cos-dec evidence, independent SIMBAD UV; existing M5B model gates', record: '88 bounded id/line/resource samples plus actual layer screenshots', open: 'Background pixel direction uses dedicated M5C ray oracle; no brightness-photometry claim' },
    U01: { cpu: 'Complete source-state parser roundtrip and schema rejection', native: 'Moon/fourviews/native export/import; malformed-schema file rejected; reverse/play/pause/realtime controls', oracle: 'Independent unchanged-state/canonical JSON/clock direction predicates; host systemUTC for realtime', record: 'Real exported file/hash, invalid input/error, before/after complete states and video', open: 'Touch uses existing M4a CDP workflow; physical phone remains separate' },
    P01: { cpu: 'Plan only; no GPU or long-duration claim', native: 'Exact5warm cycles+100 actual drawn view switches, same final state; record resource counters; paused-idle counter', oracle: 'Stable app-owned resource counts and bounded cache; heap/GPU estimates scoped; no exact driver VRAM', record: 'Warm/pre/post same-state metrics, switch count, screenshot/video', open: 'Original30min explicitly not-executed-by-user; FPS sampling/physical devices remain separately coordinated' },
    O01: { cpu: 'Closure/provenance tests unchanged; no browser execution in CPU mode', native: 'Existing SW-ready close/offline/newpage pattern, originalB restore, fourviews/JSON; reuse M3/M3b/M5b offline smoke', oracle: 'Actual response.fromServiceWorker/status/network logs/buildId; reuse qa-updates.mjs for upgrade faults', record: 'Reopen responses, exact state, smoke variant states and screenshots/video', open: 'True HTTPS deployment/OS installation external-unverified; upgrade rollback needs dedicated existing driver, not assumed' },
    O02: { cpu: 'Single-file hash/entry plan only', native: 'Fresh privatecontext offline-before-file firstload; M5b worker/explicitfallback equality; separate actualWorkerconstructor fault; fresh blockedWebGL2 context and existing M4a fault workflow', oracle: 'Zero attemptedHTTP, file hash and real Worker/getContext/WEBGL_lose_context probes; identical same-core values are transport, not absolute accuracy', record: 'Firstload/worker/explicitfallback/constructor-fault/2D/loss/restored states and native capture/screenshots/video', open: 'Android/iOS file-manager execution external-unverified; no desktop viewport substitution' },
  };
  return clone(plans[id] ?? { cpu: 'Priority coordinate/input checks', native: 'Original state and explicit priority-native sequence', oracle: 'Independent scalar identities/existing fixed reference where present', record: 'State/snapshot/screenshot/video', open: 'See FINAL-ACCEPTANCE-MATRIX.md for every unexecuted clause' });
}

/** Perspective silhouette of a sphere centred on the optical axis, independently derived from tangent geometry. */
export function sphereSilhouetteRatio(radius: number, cameraDistance: number, verticalFovDeg: number): number {
  if (![radius, cameraDistance, verticalFovDeg].every(Number.isFinite) || radius <= 0 || cameraDistance <= radius || verticalFovDeg <= 0 || verticalFovDeg >= 180) throw new RangeError('Invalid silhouette input');
  return radius / Math.sqrt(cameraDistance ** 2 - radius ** 2) / Math.tan(verticalFovDeg * RAD / 2);
}
export function sphereFitDistance(radius: number, ratio: number, verticalFovDeg: number): number {
  if (!(radius > 0 && ratio > 0 && verticalFovDeg > 0 && verticalFovDeg < 180) || ![radius, ratio, verticalFovDeg].every(Number.isFinite)) throw new RangeError('Invalid fit input');
  return Math.hypot(radius, radius / (ratio * Math.tan(verticalFovDeg * RAD / 2)));
}

function timeUt(input: TimeInput): number {
  if (input.kind === 'utc-iso') return dateToUt(new Date(input.value));
  if (input.kind === 'civil') return parseCivilInput(clone(input.value));
  throw new Error('Unknown original time input kind');
}
/** Reuse canonical complete defaults and parser; overlay ONLY fields explicitly present in original inputs. */
function normalizeScene(scene: SourceScene): FinalSceneCase {
  assert.deepEqual(Object.keys(scene.inputs).sort(), ['density', 'groundCamera', 'observer', 'presentation', 'time', 'viewMode', 'viewportCssPx'].sort());
  const state = clone(createDefaultState());
  state.observer = clone(scene.inputs.observer); state.viewMode = scene.inputs.viewMode;
  state.presentation = scene.inputs.presentation; state.density = scene.inputs.density;
  state.cameras.ground = clone(scene.inputs.groundCamera);
  let timeResolution: FinalSceneCase['timeResolution'];
  try { state.time.utDaysJ2000 = timeUt(scene.inputs.time); timeResolution = { kind: 'resolved', input: clone(scene.inputs.time) }; }
  catch (error) {
    // S15 intentionally cannot produce a valid state until a human makes the explicit ambiguity choice.
    if (scene.id !== 'S15' || scene.inputs.time.kind !== 'civil' || scene.inputs.time.value.ambiguousTime !== 'reject') throw error;
    timeResolution = { kind: 'expected-native-rejection', input: clone(scene.inputs.time), error: String(error) };
  }
  const normalized = parseState(state);
  const comparisons = (scene.comparisonObservers ?? []).map(observer => {
    const other = clone(normalized); other.observer = clone(observer);
    return { observer: clone(observer), state: parseState(other) };
  });
  const additionalTimes = (scene.additionalTimes ?? []).map(input => {
    const other = clone(normalized);
    try { other.time.utDaysJ2000 = timeUt(input); return { input: clone(input), state: parseState(other) }; }
    catch (error) { if (scene.id !== 'S15') throw error; return { input: clone(input), state: null, error: String(error) }; }
  });
  const calibrationProposal = ['V02', 'V03'].includes(scene.id) ? {
    radius: 1, targetRatio: scene.id === 'V02' ? Number(scene.cameraCalibration?.diameterFractionOfStageHeight) : .83,
    distance: 0, scope: 'Analytic camera proposal only; actual GPU silhouette and visual orientation require separate review.',
  } : null;
  if (calibrationProposal) calibrationProposal.distance = sphereFitDistance(1, calibrationProposal.targetRatio, normalized.cameras[scene.id === 'V02' ? 'space' : 'globe'].verticalFovDeg);
  return { id: scene.id, source: clone(scene), state: normalized, timeResolution, comparisons, additionalTimes,
    setupNote: timeResolution.kind === 'expected-native-rejection' ? 'State retains canonical default UTC as pre-input state; original ambiguous/gap civil input is kept separately and MUST reject natively.' : null,
    independentReference: null, calibrationProposal, executionPlan: getFinalSceneExecutionPlan(scene.id) };
}

function sourceFingerprints(): FinalSceneManifest['sourceFingerprints'] {
  const paths: string[] = ['package.json', 'pnpm-lock.yaml', 'scripts/qa-final-scenes.ts', 'scripts/build-portable.mjs', 'scripts/build-web.mjs', 'scripts/qa-m3.mjs', 'scripts/qa-m3b.mjs', 'scripts/qa-m4a.mjs', 'scripts/qa-m5a.mjs', 'scripts/qa-m5b.mjs', 'scripts/qa-updates.mjs',
    'tests/data-lunar.test.ts', 'tests/data.test.ts', 'tests/data-milky-way.test.ts', 'tests/science-star-motion.test.ts', 'tests/qa-final-scenes.test.ts', 'tests/final-scenes.test.ts'];
  function walk(relative: string) {
    for (const item of readdirSync(resolve(ROOT, relative), { withFileTypes: true })) {
      const path = `${relative}/${item.name}`;
      if (item.isDirectory()) walk(path); else if (/\.(ts|json|css)$/.test(item.name)) paths.push(path);
    }
  }
  walk('src');
  return paths.sort().map(path => ({ path, sha256: sha(bytes(path)) }));
}

/** Fix S10 from previously acquired EXTERNAL rows before inspecting production output. No adaptive cherry-picking. */
function attachLowMoonReference(scene: FinalSceneCase): void {
  assert.equal(sha(bytes(HORIZONS_ROWS)), HORIZONS_ROWS_SHA, 'Pinned external row table changed');
  const rows: HorizonRow[] = json(HORIZONS_ROWS);
  const row = rows.find(row => row.body === 'Moon' && row.siteId === 'hangzhou' && row.jdUT === 2461299);
  assert.ok(row); assert.equal(row.calendarUT, '2026-Sep-15 12:00:00.000');
  assert.ok(row.airlessAltitudeDeg > 0 && row.airlessAltitudeDeg < 5);
  const sites = json('qa/science-reference-prep/horizons-planned-sites.json');
  const site = sites.find((s: any) => s.id === row.siteId);
  assert.deepEqual([site.lat, site.lon, site.heightKm * 1000], [scene.state.observer.latitudeDeg, scene.state.observer.longitudeDegEast, scene.state.observer.heightMeters]);
  const rawPath = `qa/science-reference-prep/${row.rawReferenceId}.raw`;
  assert.equal(sha(bytes(rawPath)), row.rawSha256);
  const response = json(rawPath), [prefix, suffix] = response.result.split('$$SOE');
  const header = prefix.split(/\r?\n/).findLast((line: string) => line.trimStart().startsWith('Date__(UT)'));
  assert.ok(header && suffix);
  const split = (line: string) => { assert.ok(!line.includes('"'), 'Unexpected quoted CSV'); return line.split(',').map(s => s.trim()); };
  const columns = split(header), values = suffix.split('$$EOE')[0].trim().split(/\r?\n/).map(split).find((v: string[]) => Number(v[1]) === row.jdUT);
  assert.ok(values); assert.equal(values.length, columns.length);
  const raw = Object.fromEntries(columns.map((name: string, i: number) => [name, values[i]]));
  assert.equal(Number(raw['Elevation_(a-app)']), row.airlessAltitudeDeg);
  assert.equal(Number(raw['Azimuth_(a-app)']), row.azimuthDegNorthEast);
  assert.equal(Number(raw['Illu%']), row.illuminatedPercent);
  scene.state.time.utDaysJ2000 = row.jdUT - 2451545;
  scene.state = parseState(scene.state);
  scene.setupNote = 'S10 has no fixed UTC in original kit. Fixed once from existing JPL row at original Hangzhou/20m: 2026-09-15T12:00:00Z; h=1.822635608°. Not selected by production error.';
  scene.independentReference = { row: clone(row), paths: [{ path: HORIZONS_ROWS, sha256: HORIZONS_ROWS_SHA },
    { path: rawPath, sha256: row.rawSha256 }, { path: 'qa/science-reference-prep/horizons-planned-sites.json', sha256: sha(bytes('qa/science-reference-prep/horizons-planned-sites.json')) }],
    scoring: 'AIRLESS topocentric JPL vs geometric production; h<5° direction is diagnostic, not a formal above5° 2-arcminute pass. Fraction gate remains |Δ|≤0.005.' };
}

export function createFinalSceneManifest(ids?: readonly string[]): FinalSceneManifest {
  const original = bytes(KIT_PATH); assert.equal(sha(original), KIT_SHA, 'Original input pack changed');
  const kit = JSON.parse(original.toString('utf8')); assert.equal(kit.scenes.length, 25);
  const wanted = ids ? new Set(ids) : null;
  if (wanted) assert.ok(wanted.size > 0, 'Zero scenes cannot be reported as an executed QA run');
  if (wanted) for (const id of wanted) assert.ok(kit.scenes.some((s: SourceScene) => s.id === id), `Unknown scene ${id}`);
  const scenes: FinalSceneCase[] = kit.scenes.filter((scene: SourceScene) => !wanted || wanted.has(scene.id)).map(normalizeScene);
  const moon = scenes.find(s => s.id === 'S10'); if (moon) attachLowMoonReference(moon);
  const defaults = parseState(createDefaultState());
  return { schemaVersion: 1, kind: 'final-acceptance-input-manifest', createdAtUtc: new Date().toISOString(),
    source: { path: KIT_PATH, sha256: KIT_SHA, originalStatus: kit.status, sceneCount: kit.scenes.length, assertionCount: kit.scenes.reduce((n: number, scene: SourceScene) => n + scene.assertions.length, 0) },
    defaults: { schemaVersion: defaults.schemaVersion, state: clone(defaults), serializedSha256: sha(serializeState(defaults)), sourceSha256: sha(bytes('src/state.ts')) },
    sourceFingerprints: sourceFingerprints(), runtime: { node: process.version, icu: process.versions.icu, tz: process.versions.tz }, scenes,
    limitations: ['Original assertion statuses remain untouched. Results are separate and individual checks never imply every clause passed.',
      'Production state/time parsing is used only to construct inputs. Coordinate identities, fixed external responses and independent source-scalar motion form expectations.',
      'No synthetic star enters the runtime catalog. Camera fit is an analytic proposal; texture/pixel aesthetics remain manual review.',
      '30-minute P01 is explicitly not executed by user instruction. Physical devices/full performance and upgrade rollback remain separate; existing offline helpers are reused only when --browser is explicit.'] };
}

type Check = { name: string; assertionIndex: number | null; status: 'passed-check' | 'failed-check' | 'observable' | 'not-executed'; scope: string; value?: unknown; error?: string };
type SceneResult = { id: string; originalAssertions: SourceScene['assertions']; state: SimulationState; checks: Check[]; observations: unknown[]; status: string };
const resultFor = (s: FinalSceneCase): SceneResult => ({ id: s.id, originalAssertions: clone(s.source.assertions), state: clone(s.state), checks: [], observations: [], status: 'not-executed' });
function check(result: SceneResult, name: string, assertionIndex: number | null, scope: string, operation: () => unknown) {
  try { result.checks.push({ name, assertionIndex, scope, status: 'passed-check', value: operation() }); }
  catch (error) { result.checks.push({ name, assertionIndex, scope, status: 'failed-check', error: String(error) }); }
}
function observable(result: SceneResult, name: string, assertionIndex: number | null, value: unknown, scope = 'Recorded measurement; not a whole-assertion accuracy or pixel pass') {
  result.checks.push({ name, assertionIndex, status: 'observable', scope, value });
}
function expectedEnuFromAngles(raHours: number, decDeg: number, lstHours: number, latitude: number): Vec3 {
  const h = (lstHours - raHours) * 15 * RAD, d = decDeg * RAD, p = latitude * RAD;
  return [-Math.cos(d) * Math.sin(h), Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(h), Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h)];
}
/** Independent geographic scalar basis, consuming an epoch Earth-frame direction as an INPUT. */
function geographicEnu(vEarth: readonly number[], lat: number, lon: number): Vec3 {
  const p = lat * RAD, l = lon * RAD;
  return [dot([-Math.sin(l), Math.cos(l), 0], vEarth), dot([-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)], vEarth),
    dot([Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)], vEarth)];
}
function verifySnapshot(result: SceneResult, state: SimulationState, snapshot: ScienceSnapshot) {
  check(result, 'Finite right-handed epoch frames', null, 'Coordinate invariant, not independent ephemeris accuracy', () => {
    for (const m of [snapshot.earthFixedToEqj, snapshot.eqjToHorizontalGeometric]) {
      assert.ok(m.flat().every(Number.isFinite)); assert.ok(Math.abs(dot(m[0], cross(m[1], m[2])) - 1) < 1e-11);
    }
    const values = snapshot.bodies.flatMap(b => [...b.geocentricEqjAU, ...b.topocentricDirectionEqj, b.geometricAltitudeDeg, b.apparentAltitudeDeg]);
    assert.ok(values.every(Number.isFinite)); assert.equal(snapshot.utDaysJ2000, state.time.utDaysJ2000);
    return { utc: utToDate(snapshot.utDaysJ2000).toISOString(), accuracyTier: snapshot.accuracyTier };
  });
  check(result, 'Independent scalar hour-angle ENU', null, 'Given production of-date RA/Dec and GAST; verifies frame/longitude convention, NOT absolute sky accuracy', () => {
    const expectedLst = mod(snapshot.gastHours + state.observer.longitudeDegEast / 15, 24);
    assert.ok(Math.abs(mod(snapshot.lstHours - expectedLst + 12, 24) - 12) < 1e-11);
    const deltas = snapshot.bodies.filter(b => b.id === 'Sun' || b.id === 'Moon').map(body => {
      const expected = expectedEnuFromAngles(body.raHoursOfDate, body.decDegOfDate, expectedLst, state.observer.latitudeDeg);
      const actual = multiply(snapshot.eqjToHorizontalGeometric, body.topocentricDirectionEqj), error = norm(actual.map((v, i) => v - expected[i]!));
      assert.ok(error < 2e-11); return { body: body.id, expected, actual, error };
    }); return deltas;
  });
}

function checkedReference(name: string) {
  const path = `tests/fixtures/${name}.json`, metadataPath = `tests/fixtures/${name}.metadata.json`, metadata = json(metadataPath);
  assert.equal(sha(bytes(path)), metadata.sha256, `Reference bytes changed: ${name}`);
  return { path, metadataPath, sha256: metadata.sha256, metadata, data: json(path) };
}

/** Original selectors are SETUP, not goldens. Fixed dusk branch and bounded search are saved before browser execution. */
export function deriveFinalSceneTimes(scene: FinalSceneCase) {
  const seed = Number(scene.source.timeSelection?.seedUtc ? dateToUt(new Date(String(scene.source.timeSelection.seedUtc))) : NaN);
  assert.ok(Number.isFinite(seed));
  if (scene.id === 'S09') {
    const sequence = computeMoonQuarterSequence(seed);
    return { kind: 'actual-core-derived-lunar-quarters', sourceSelector: clone(scene.source.timeSelection), seedUtDaysJ2000: seed,
      events: sequence.events.map(e => ({ ...e, utc: utToDate(e.utDaysJ2000).toISOString() })), complete: sequence.complete, notes: sequence.notes,
      scope: 'These computed instants are setup inputs. Independent USNO comparison is a separate check.' };
  }
  assert.equal(scene.id, 'S08');
  const angles = scene.source.timeSelection!.anglesDeg as number[];
  assert.deepEqual(angles, [0, -6, -12, -18]);
  const state = clone(scene.state), cache = new Map<number, number>();
  const evaluate = (ut: number) => {
    if (!cache.has(ut)) { state.time.utDaysJ2000 = ut; cache.set(ut, computeSnapshot(state, 0).bodies.find(b => b.id === 'Sun')!.geometricAltitudeDeg); }
    return cache.get(ut)!;
  };
  const events = angles.map(targetGeometricAltitudeDeg => {
    let left = seed, right = seed, found = false;
    for (let hour = 1; hour <= 24; hour++) {
      right = seed + hour / 24;
      if (evaluate(left) >= targetGeometricAltitudeDeg && evaluate(right) < targetGeometricAltitudeDeg) { found = true; break; }
      left = right;
    }
    assert.ok(found, `No descending setup bracket for ${targetGeometricAltitudeDeg}°`);
    const originalBracket = [left, right];
    for (let i = 0; i < 48 && (right - left) * 86400 > .005; i++) {
      const middle = (left + right) / 2;
      if (evaluate(middle) >= targetGeometricAltitudeDeg) left = middle; else right = middle;
    }
    const utDaysJ2000 = (left + right) / 2, geometricAltitudeDeg = evaluate(utDaysJ2000);
    assert.ok(Math.abs(geometricAltitudeDeg - targetGeometricAltitudeDeg) < .00005);
    return { targetGeometricAltitudeDeg, utDaysJ2000, utc: utToDate(utDaysJ2000).toISOString(), geometricAltitudeDeg,
      residualDeg: geometricAltitudeDeg - targetGeometricAltitudeDeg, branch: 'first-descending-after-seed', originalBracketUt: originalBracket };
  });
  return { kind: 'actual-core-derived-geometric-solar-altitudes', sourceSelector: clone(scene.source.timeSelection), seedUtDaysJ2000: seed,
    events, complete: events.length === 4, notes: ['Explicit first descending branch in seed..seed+1day. Centre0° is NOT upper-limb sunrise/set.'],
    scope: 'QA setup search over the existing computeSnapshot core, not a second runtime engine or independent ephemeris oracle.' };
}

function existingCpuSuite(paths: string[]) {
  const command = [process.execPath, '--import', 'tsx', '--test', ...paths];
  const run = spawnSync(command[0]!, command.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const record = { command, sourceHashes: paths.map(path => ({ path, sha256: sha(bytes(path)) })), status: run.status,
    signal: run.signal, error: run.error ? String(run.error) : null, stdout: run.stdout, stderr: run.stderr, scope: 'Reuses unchanged existing CPU test files; no production build/browser/GPU' };
  assert.ok(run.status === 0 && !run.error, JSON.stringify(record)); return record;
}

function runRemainingCpu(scene: FinalSceneCase, result: SceneResult, snapshot: ScienceSnapshot) {
  if (scene.id === 'S08') {
    check(result, 'All four original solar setup UTCs saved', 1, 'Original exact geometric thresholds; setup residual is consistency, not independent event-time accuracy', () => deriveFinalSceneTimes(scene));
    check(result, 'Independent USNO civil dusk reference', 1, 'Same lat/lon, independent minute-rounded sea-level−6° reference; original20m distinction retained', () => {
      const setup = deriveFinalSceneTimes(scene), reference = checkedReference('usno-hangzhou-2026-09-14');
      const row = reference.data.properties.data.sundata.find((r: any) => r.phen === 'End Civil Twilight'); assert.ok(row);
      const [hour, minute] = row.time.split(':').map(Number);
      const expectedUt = parseCivilInput({ astronomicalYear: 2026, month: 9, day: 14, hour, minute, second: 0, zone: { kind: 'fixed', offsetMinutes: 480 }, ambiguousTime: 'reject' });
      const event = setup.events.find((e: any) => e.targetGeometricAltitudeDeg === -6)! as any;
      const errorSeconds = (event.utDaysJ2000 - expectedUt) * 86400; assert.ok(Math.abs(errorSeconds) <= 120);
      return { reference, expectedUt, actualUt: event.utDaysJ2000, errorSeconds, sourceHeightMeters: 0, originalHeightMeters: scene.state.observer.heightMeters };
    });
  }
  if (scene.id === 'S09') {
    check(result, 'All original four quarter events vs fixed USNO', 1, 'Independent minute-rounded Universal Time capture; provenance explicitly not originalHTTPbytes', () => {
      const setup = deriveFinalSceneTimes(scene), reference = checkedReference('usno-phase-2026-09-web-capture'); assert.equal(setup.complete, true);
      const expectedAngles = [270, 0, 90, 180];
      return setup.events.map((event: any, i: number) => {
        const row = reference.data.phasedata[i], [hour, minute] = row.time.split(':').map(Number);
        const expectedUt = parseCivilInput({ astronomicalYear: row.year, month: row.month, day: row.day, hour, minute, second: 0, zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject' });
        const errorSeconds = (event.utDaysJ2000 - expectedUt) * 86400;
        assert.equal(event.phaseLongitudeDeg, expectedAngles[i]); assert.ok(Math.abs(errorSeconds) <= 120);
        return { event, referenceRow: row, referencePath: reference.path, referenceSha256: reference.sha256, acquisition: reference.metadata.acquisition, expectedUt, errorSeconds };
      });
    });
  }
  if (scene.id === 'S11') {
    check(result, 'No unscoped modern validation claim', 3, 'Global snapshot tier remains unvalidated; selected fixed rows do not certify every body/quantity', () => { assert.equal(snapshot.accuracyTier, 'unvalidated'); return snapshot.accuracyTier; });
    check(result, 'Gregorian century dates from original cases', 2, 'Independent proleptic-Gregorian rules', () => {
      for (const year of [1900, 2100]) assert.throws(() => parseCivilInput({ astronomicalYear: year, month: 2, day: 29, hour: 12, minute: 0, second: 0, zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject' }));
      assert.equal(utToDate(timeUt(scene.source.additionalTimes![0]!)).toISOString(), '2000-02-29T12:00:00.000Z'); return clone(scene.additionalTimes);
    });
    const fixture = json('tests/fixtures/horizons-sun-moon.json');
    for (const response of fixture.responses) assert.equal(sha(bytes(`tests/fixtures/${response.rawFile}`)), response.sha256);
    for (const state of [scene.state, ...scene.additionalTimes.map(t => t.state!)]) {
      const snap = computeSnapshot(state, 0), utc = utToDate(state.time.utDaysJ2000).toISOString().replace('.000Z', 'Z');
      const rows = fixture.rows.filter((r: any) => r.utc === utc);
      if (!rows.length) { observable(result, 'No independent fixed row at original extra UTC', 1, { utc, snapshot: snap }); continue; }
      for (const row of rows) {
        const body = snap.bodies.find(b => b.id === row.body)!, directionErrorArcmin = angularDeg(multiply(snap.eqjToHorizontalGeometric, body.topocentricDirectionEqj), enu(row.altitudeDeg, row.azimuthDeg)) * 60;
        if (row.altitudeDeg > 5) check(result, `Fixed JPL ${row.body} ${utc}`, 1, 'Original airless station/UTC; formal2′ only referenceh>5; defaultDeltaT retained', () => { assert.ok(directionErrorArcmin <= 2); return { row, directionErrorArcmin, fixtureConventions: fixture.conventions }; });
        else observable(result, `Fixed low-altitude JPL ${row.body} ${utc}`, 1, { row, directionErrorArcmin, fixtureConventions: fixture.conventions });
      }
    }
  }
  if (scene.id === 'S12') check(result, 'Astronomical year0 exact label/continuity/no1900 remapping', 1, 'Independent BCE/Gregorian identities', () => {
    assert.equal(formatEraYear(0), '公元前 1 年'); assert.equal(formatEraYear(-1), '公元前 2 年'); assert.equal(formatEraYear(1), '公元 1 年');
    const c = (year: number) => parseCivilInput({ astronomicalYear: year, month: 1, day: 1, hour: 12, minute: 0, second: 0, zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject' });
    assert.equal(c(0) - c(-1), 365); assert.equal(c(1) - c(0), 366); assert.equal(utToDate(scene.state.time.utDaysJ2000).getUTCFullYear(), 0);
    return { input: scene.source.inputs.time, utc: utToDate(scene.state.time.utDaysJ2000).toISOString(), label: formatEraYear(0), accuracyTier: snapshot.accuracyTier };
  });
  if (scene.id === 'S13') check(result, 'Both original extended UTCs and high-proper-motion source endpoints', 3, 'Independent locked p0/v direction oracle; extended absolute ephemeris remains diagnostic', () => {
    const sourcePath = 'qa/science-reference-prep/motion-cache-bound-records.json'; assert.equal(sha(bytes(sourcePath)), '49189cee810a3e3b927991540f46bf3c0e7c52970cb433aae2a0023f67a7bd24');
    const frozen = json(sourcePath).find((r: any) => r.id === 'hip:57939'), row = json('assets/runtime/star-meta.json').find((r: any[]) => r[0] === 'hip:57939');
    const astrometry = { id: 'hip:57939' as const, raHours: row[3], decDeg: row[4], pmRaCosDecMasYr: row[10], pmDecMasYr: row[11], qualityFlags: row[12], distancePc: row[13], radialVelocityKmS: row[14] };
    return [scene.state, scene.additionalTimes[0]!.state!].map(state => {
      const s = computeSnapshot(state, 0), expected = unit(frozen.p0.map((p: number, i: number) => p + state.time.utDaysJ2000 / 365.25 * frozen.vPerJulianYear[i])), actual = propagateStarDirection(astrometry, state.time.utDaysJ2000);
      const errorArcsec = angularDeg(actual, expected) * 3600; assert.ok(errorArcsec < 1e-8); assert.equal(s.accuracyTier, 'extended-exploration');
      return { utc: utToDate(state.time.utDaysJ2000).toISOString(), expected, actual, errorArcsec, snapshot: s, sourceSha256: sha(bytes(sourcePath)) };
    });
  });
  if (scene.id === 'S14') check(result, 'Exact original±180/UTC±12 geometry and independent civil dates', 1, 'Physical meridian equivalence and arithmetic local-day difference', () => {
    const other = scene.comparisons[0]!.state; assert.deepEqual(computeSnapshot(other, 0), snapshot);
    const plus = localCivilParts(scene.state.time.utDaysJ2000, scene.state.observer.displayZone), minus = localCivilParts(other.time.utDaysJ2000, other.observer.displayZone);
    assert.deepEqual([plus.year, plus.month, plus.day, plus.hour, plus.minute], [2026, 9, 15, 6, 30]); assert.deepEqual([minus.year, minus.month, minus.day, minus.hour, minus.minute], [2026, 9, 14, 6, 30]); return { plus, minus, states: [scene.state, other] };
  });
  if (scene.id === 'S15') check(result, 'Original fold/gap reject and explicit earlier/later', 1, 'Original declared policy, fixed2026 host-IANA rule identities; no longitude inference', () => {
    assert.equal(scene.source.inputs.time.kind, 'civil'); const input = (scene.source.inputs.time as { kind: 'civil'; value: CivilInput }).value;
    assert.throws(() => parseCivilInput(clone(input)), /重复/);
    const earlier = parseCivilInput({ ...clone(input), ambiguousTime: 'earlier' }), later = parseCivilInput({ ...clone(input), ambiguousTime: 'later' });
    assert.equal(utToDate(earlier).toISOString(), '2026-11-01T05:30:00.000Z'); assert.equal(utToDate(later).toISOString(), '2026-11-01T06:30:00.000Z');
    assert.throws(() => timeUt(scene.source.additionalTimes![0]!), /不存在/); return { earlier, later, utc: [utToDate(earlier).toISOString(), utToDate(later).toISOString()], runtime: { node: process.version, icu: process.versions.icu, tz: process.versions.tz } };
  });
  if (scene.id === 'S16') check(result, 'Unchanged independent HKO/runtime lunar suite', null, 'Four existing tests include73049rows/30differences/range/UTC+8/generatorhash; actualruntime compiled only in-memory by existing test', () => existingCpuSuite(['tests/data-lunar.test.ts']));
  if (scene.id === 'D01') check(result, 'Unchanged full data/UV/motion suites', null, 'Existing fixed source/HIP/Chinese/hash/SIMBAD/space-availability tests; not GPU acceptance', () => existingCpuSuite(['tests/data.test.ts', 'tests/data-milky-way.test.ts', 'tests/science-star-motion.test.ts']));
  if (scene.id === 'U01') check(result, 'Full source-state parser roundtrip and unsupported version rejection', 2, 'Actual canonical parser, source state expected unchanged', () => {
    const state = clone(scene.state); state.selected = 'body:Moon'; assert.deepEqual(parseState(serializeState(state)), state);
    const before = serializeState(state); assert.throws(() => parseState({ ...clone(state), schemaVersion: 999 })); assert.equal(serializeState(state), before); return state;
  });
  if (['P01', 'O01', 'O02'].includes(scene.id)) observable(result, 'Specialised native/offline/resource entry, not CPU-executed', null, scene.executionPlan);
}

export function runFinalSceneCpu(manifest: FinalSceneManifest): SceneResult[] {
  const results = manifest.scenes.map(resultFor);
  for (const scene of manifest.scenes) {
    const result = results.find(r => r.id === scene.id)!, state = clone(scene.state);
    let snapshot: ScienceSnapshot;
    try { snapshot = computeSnapshot(state, 0); }
    catch (error) { result.checks.push({ name: 'Initial snapshot computation', assertionIndex: null, status: 'failed-check', scope: 'Original scene input; failure retained', error: String(error) }); result.status = 'failed-checks-retained'; continue; }
    verifySnapshot(result, state, snapshot);
    if (scene.id === 'S01') {
      check(result, 'Equator zenith/east/west original vectors', 1, 'Expected ENU is geometric algebra; EarthFixedToEqj only constructs epoch test inputs. Does not certify PN/GAST absolute accuracy.', () => {
        const cases = [{ ha: 0, earth: [1, 0, 0], expected: [0, 0, 1], az: null }, { ha: -90, earth: [0, 1, 0], expected: [1, 0, 0], az: 90 }, { ha: 90, earth: [0, -1, 0], expected: [-1, 0, 0], az: 270 }];
        return cases.map(c => { const eqj = multiply(snapshot.earthFixedToEqj, c.earth), actual = multiply(snapshot.eqjToHorizontalGeometric, eqj);
          assert.ok(norm(actual.map((v, i) => v - c.expected[i]!)) < 1e-12);
          const az = Math.hypot(actual[0], actual[1]) < 1e-12 ? null : mod(Math.atan2(actual[0], actual[1]) / RAD, 360);
          if (c.az === null) assert.equal(az, null); else assert.ok(Math.abs(az! - c.az) < 1e-10);
          return { hourAngleDeg: c.ha, decDegOfDate: 0, eqj, actual, expected: c.expected, azimuthDeg: az }; });
      });
      observable(result, 'Synthetic directions not runtime records', 3, { runtimeCatalogSha256: sha(bytes('assets/runtime/star-meta.json')), testOnly: true });
    }
    if (scene.id === 'S02') {
      const after = clone(state); after.time.utDaysJ2000 += 20 * 600 / 86400;
      const later = computeSnapshot(after, 1);
      check(result, 'Original nominal 20s×600 crosses local midnight', 2, 'Deterministic nominal input, not browser elapsed timing', () => {
        assert.equal(localCivilParts(state.time.utDaysJ2000, state.observer.displayZone).day, 14);
        const date = localCivilParts(after.time.utDaysJ2000, after.observer.displayZone); assert.equal(date.day, 15); assert.equal(date.hour, 1); assert.equal(date.minute, 20); return date;
      });
      const path = 'qa/science-reference-prep/motion-cache-bound-records.json';
      check(result, 'Vega independent source-scalar motion at both endpoints', 1, 'Locked QA p0/v, not calling production to construct expected; does not independently validate Earth orientation', () => {
        assert.equal(sha(bytes(path)), '49189cee810a3e3b927991540f46bf3c0e7c52970cb433aae2a0023f67a7bd24');
        assert.equal(sha(bytes('assets/runtime/star-meta.json')), '46dd05ad8aa40b284e32efd929002d067bed89e3e39d7c885be5a7ae43af3dd1');
        const frozen = json(path).find((r: any) => r.id === 'hip:91262'), meta = json('assets/runtime/star-meta.json').find((r: any[]) => r[0] === 'hip:91262');
        assert.ok(frozen && meta); const star = { id: 'hip:91262' as const, raHours: meta[3], decDeg: meta[4], pmRaCosDecMasYr: meta[10], pmDecMasYr: meta[11], qualityFlags: meta[12], distancePc: meta[13], radialVelocityKmS: meta[14] };
        return [state.time.utDaysJ2000, after.time.utDaysJ2000].map(ut => { const expected = unit(frozen.p0.map((p: number, i: number) => p + ut / 365.25 * frozen.vPerJulianYear[i]));
          const actual = propagateStarDirection(star, ut), errorArcsec = angularDeg(actual, expected) * 3600; assert.ok(errorArcsec < 1e-8); return { ut, expected, actual, errorArcsec, sourceSha256: sha(bytes(path)) }; });
      });
      observable(result, 'Sidereal phase before/after nominal advance', 1, { before: snapshot.lstHours, after: later.lstHours, deltaDeg: mod(later.lstHours - snapshot.lstHours, 24) * 15 });
    }
    if (scene.id === 'S03') {
      const samples = scene.comparisons.map(c => ({ state: c.state, snapshot: computeSnapshot(c.state, 0) }));
      check(result, 'A/B/C same geocentric bodies and positive-east six-hour phase', 1, 'Independent required invariants, not external ephemeris accuracy', () => {
        assert.equal(samples.length, 3);
        for (const id of ['Sun', 'Moon']) for (const sample of samples.slice(1)) assert.deepEqual(sample.snapshot.bodies.find(b => b.id === id)!.geocentricEqjAU, samples[0]!.snapshot.bodies.find(b => b.id === id)!.geocentricEqjAU);
        assert.ok(Math.abs(mod(samples[1]!.snapshot.lstHours - samples[0]!.snapshot.lstHours, 24) - 6) < 1e-11);
        assert.ok(Math.abs(samples[2]!.snapshot.lstHours - samples[0]!.snapshot.lstHours) < 1e-11);
        return samples.map(s => ({ observer: s.state.observer, lstHours: s.snapshot.lstHours, bodies: s.snapshot.bodies.filter(b => b.id === 'Sun' || b.id === 'Moon') }));
      });
      check(result, 'Zone-only change preserves instantaneous geometry', 3, 'Time-zone input is separate from longitude', () => {
        const changed = clone(state); changed.observer.displayZone = { kind: 'fixed', offsetMinutes: -720 };
        assert.deepEqual(computeSnapshot(changed, 0), snapshot); return changed.observer.displayZone;
      });
    }
    if (scene.id === 'S04') {
      check(result, 'Exact geographic poles retain ENU handedness and epoch pole zenith', 2, 'Independent geographic basis from given epoch Earth orientation', () => {
        return [state, ...scene.comparisons.map(c => c.state)].map(s => {
          const snap = computeSnapshot(s, 0), pole = multiply(snap.earthFixedToEqj, [0, 0, Math.sign(s.observer.latitudeDeg)]), actual = multiply(snap.eqjToHorizontalGeometric, pole);
          assert.ok(norm(actual.map((v, i) => v - [0, 0, 1][i]!)) < 1e-12);
          const input = unit([.3, .7, -.2]), earth = transposeMultiply(snap.earthFixedToEqj, input), expected = geographicEnu(earth, s.observer.latitudeDeg, 0), horizontal = multiply(snap.eqjToHorizontalGeometric, input);
          assert.ok(norm(horizontal.map((v, i) => v - expected[i]!)) < 1e-12); return { observer: s.observer, pole, actual, expected, horizontal };
        });
      });
    }
    if (['S05', 'S06', 'S07'].includes(scene.id)) {
      const states = [state]; if (scene.id === 'S07') { const opposite = clone(state); opposite.time.utDaysJ2000 = dateToUt(new Date('2026-06-21T12:00:00Z')); states.push(opposite); }
      states.forEach((s, i) => check(result, `Original complete polar day ${i + 1}`, i ? 2 : 1, 'Expected seasonal classification from original requirements; numerical outputs alone are not independent event-time accuracy', () => {
        const event = computeSolarDayEvents(s), summer = scene.id === 'S05' || (scene.id === 'S07' && i === 0);
        assert.equal(event.state, summer ? 'continuous-daylight' : 'no-sunrise'); assert.equal(event.riseUtDaysJ2000, null); assert.equal(event.setUtDaysJ2000, null);
        if (summer) assert.ok(event.minimumGeometricAltitudeDeg > 0); else { assert.ok(event.maximumGeometricAltitudeDeg > -6 && event.maximumGeometricAltitudeDeg < 0); assert.ok(event.twilight.civil.dawnUtDaysJ2000 !== null); }
        return { state: s, event };
      }));
    }
    if (scene.id === 'S10') {
      const row = scene.independentReference!.row, moon = snapshot.bodies.find(b => b.id === 'Moon')!;
      const refEnu = enu(row.airlessAltitudeDeg, row.azimuthDegNorthEast), actual = multiply(snapshot.eqjToHorizontalGeometric, moon.topocentricDirectionEqj);
      observable(result, 'Low Moon JPL AIRLESS direction error', 2, { reference: scene.independentReference, expectedEnu: refEnu, actualEnu: actual,
        directionErrorArcmin: angularDeg(actual, refEnu) * 60, geometricAltitudeDeg: moon.geometricAltitudeDeg, apparentAltitudeDeg: moon.apparentAltitudeDeg,
        geocentricEqjAU: moon.geocentricEqjAU, topocentricDirectionEqj: moon.topocentricDirectionEqj, parallaxDeg: angularDeg(moon.geocentricEqjAU, moon.topocentricDirectionEqj) }, scene.independentReference!.scoring);
      check(result, 'Low Moon illumination external fraction', 2, 'Original fraction gate; independent JPL Q10 physical observer at same UTC/site', () => {
        const delta = Math.abs(moon.illuminatedFraction! - row.illuminatedPercent / 100); assert.ok(delta <= .005); return { expected: row.illuminatedPercent / 100, actual: moon.illuminatedFraction, delta };
      });
    }
    try { runRemainingCpu(scene, result, snapshot); }
    catch (error) { result.checks.push({ name: 'Remaining-scene reference preparation', assertionIndex: null, status: 'failed-check', scope: 'Failure retained; subsequent scenes still execute', error: String(error) }); }
    result.observations.push({ input: state, snapshot });
    result.status = result.checks.some(c => c.status === 'failed-check') ? 'failed-checks-retained' : 'completed-cpu-checks-with-open-native-and-visual-observations';
  }
  return results;
}

const browserRead = (page: Page) => page.evaluate(() => {
  const app = (window as any).skyApp, d = app.rendererDiagnostics;
  return { state: app.state, snapshot: app.snapshot, details: app.selectedDetails, diagnostics: app.diagnostics,
    graphicsStatus: app.graphicsStatus, metrics: app.metrics, appearance: app.skyAppearance, teaching: app.teachingData, moonLoupe: app.moonLoupeDiagnostics,
    interaction: d ? Object.fromEntries(['selectedId', 'canonicalSelectedId', 'selectedDirectionEqj', 'selectedMarkerDirectionEqj', 'selectedProjectedNdc', 'selectedVisible', 'cameraOrientationQuaternion', 'cameraPositionDisplay', 'viewForwardEqj', 'finiteSphereRadius', 'labelHitBoxes', 'labelCache', 'labelOcclusionRects', 'runtimeQualityConsumption', 'bodyHitTargets', 'earthLayers', 'chartViewport', 'refraction', 'sphericalArcs', 'highlightedConstellationIds', 'highlightGeometryId', 'highlightIndexAttributeId', 'highlightPositionAttributeIsShared', 'starMotion', 'stageInputEnabled'].map(key => [key, d[key]])) : null,
    performanceNowMs: performance.now(), ui: { date: (document.querySelector('#sky-date') as HTMLInputElement)?.value, time: (document.querySelector('#sky-time') as HTMLInputElement)?.value,
      notice: document.querySelector('.science-notice')?.textContent, message: document.querySelector('.ui-message')?.textContent } };
});
async function paired(page: Page) {
  await page.waitForFunction(() => {
    const app = (window as any).skyApp, d = app?.diagnostics;
    return app?.ready && !app.state.time.running && !d.scienceDirty && d.pendingInteractionCount === 0 && d.lastRenderedUt === app.snapshot?.utDaysJ2000
      && d.lastRenderedUt === app.state.time.utDaysJ2000 && d.lastRenderedMode === app.state.viewMode && d.lastRenderedSelection === app.state.selected;
  }, undefined, { timeout: 30_000 });
}
export type FinalSceneInteractionInput = {
  ready: boolean;
  state: { time: { running: boolean; utDaysJ2000: number }; viewMode: string; selected: string | null };
  snapshot: { utDaysJ2000: number } | null;
  diagnostics: { scienceDirty: boolean; pendingInteractionCount: number; lastRenderedUt: number | null;
    lastRenderedMode: string | null; lastRenderedSelection: string | null;
    viewTransition: { phase: string; ticket: unknown; handleCount: number } | null };
  rendererDiagnostics: { stageInputEnabled: boolean } | null;
};
/** Closure-free: the same predicate is CPU-tested and passed directly to Playwright. */
export function isFinalSceneInteractionReady(app: FinalSceneInteractionInput | undefined = (globalThis as unknown as { skyApp?: FinalSceneInteractionInput }).skyApp): boolean {
  const d = app?.diagnostics, t = d?.viewTransition;
  return !!(app?.ready && !app.state.time.running && !d?.scienceDirty && d?.pendingInteractionCount === 0
    && d.lastRenderedUt === app.snapshot?.utDaysJ2000 && d.lastRenderedUt === app.state.time.utDaysJ2000
    && d.lastRenderedMode === app.state.viewMode && d.lastRenderedSelection === app.state.selected
    && t?.phase === 'idle' && t.ticket === null && t.handleCount === 0 && app.rendererDiagnostics?.stageInputEnabled === true);
}
async function waitInteractionReady(page: Page) {
  await page.waitForFunction(isFinalSceneInteractionReady, undefined, { timeout: 30_000 });
}
async function apply(page: Page, state: SimulationState) { await page.evaluate(state => (window as any).skyApp.setState(state), state); await paired(page); }
async function nativeView(page: Page, mode: string) { await page.locator(`[data-view="${mode}"]`).click(); await paired(page); }
async function nativeSelect(page: Page, query: string) { await page.locator('#sky-search').fill(query); await page.locator('#sky-search').press('Enter'); await paired(page); }
async function nativeDrag(page: Page) {
  await waitInteractionReady(page);
  const point = await page.evaluate(() => {
    const rect = document.querySelector('#sky-stage')!.getBoundingClientRect();
    const blocked = [...document.querySelectorAll('#sky-control-panel,.controls-compact,.compact-mode-note,#runtime-status,[data-sky-occlusion]')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
    for (const fx of [.75, .65, .85]) for (const fy of [.4, .5, .6]) {
      const x = rect.x + rect.width * fx, y = rect.y + rect.height * fy, endX = x + 60, endY = y + 24;
      if (endX < rect.right && endY < rect.bottom && blocked.every(r => !(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) && !(endX >= r.left && endX <= r.right && endY >= r.top && endY <= r.bottom))) return { x, y, endX, endY };
    } throw new Error('No unoccluded native drag route');
  });
  const readiness = await browserRead(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.endX, point.endY, { steps: 14 }); await page.mouse.up(); await paired(page); return { ...point, readiness };
}
async function openTeaching(page: Page) {
  if (!await page.locator('#sky-teaching').evaluate((e: HTMLDetailsElement) => e.open)) await page.locator('#sky-teaching > summary').click();
  await page.waitForFunction(() => (window as any).skyApp.teachingData.solarDayStatus === 'ready', undefined, { timeout: 30_000 });
}
function atomicJson(path: string, value: unknown) { const temporary = `${path}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path); }
async function screenshot(page: Page, out: string, name: string) { const path = join(out, `${name}.png`); await waitInteractionReady(page); await page.screenshot({ path }); return path; }

/** Strip only the transport sequence number; every scientific value/warning/epoch remains part of equality. */
export function scientificSnapshotFields(snapshot: ScienceSnapshot): Omit<ScienceSnapshot, 'requestId'> {
  const { requestId: _transportRequestId, ...truth } = snapshot; return truth;
}
async function s09NativeMoonLoupe(page: Page) {
  await waitInteractionReady(page);
  const before = await browserRead(page), toggle = page.locator('#sky-moon-loupe-toggle');
  const alreadyOpen = await toggle.getAttribute('aria-pressed') === 'true';
  if (!alreadyOpen) await toggle.click();
  await page.waitForFunction(utDaysJ2000 => {
    const loupe = (window as any).skyApp.moonLoupeDiagnostics;
    return loupe?.status === 'ready' && loupe.open && loupe.textureLoaded
      && loupe.utDaysJ2000 === utDaysJ2000 && loupe.loupeDiameterCssPx > 0;
  }, before.state.time.utDaysJ2000, { timeout: 30_000 });
  await waitInteractionReady(page);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  const displayed = await browserRead(page);
  assert.deepEqual(displayed.state, before.state);
  assert.deepEqual(scientificSnapshotFields(displayed.snapshot), scientificSnapshotFields(before.snapshot));
  assert.deepEqual(displayed.interaction?.cameraOrientationQuaternion, before.interaction?.cameraOrientationQuaternion);
  const moon = displayed.snapshot.bodies.find((body: any) => body.id === 'Moon');
  assert.ok(moon && Number.isFinite(moon.geometricAltitudeDeg));
  const phaseNameRawText = await page.locator('.moon-phase-name').textContent();
  assert.equal(phaseNameRawText, displayed.teaching.moon.phaseNameZh);
  return { displayed, evidence: { alreadyOpen, nativeToggleOpened: !alreadyOpen,
    phaseNameRawText, phaseNameTeachingData: displayed.teaching.moon.phaseNameZh,
    mainProjectedCenterAvailable: displayed.moonLoupe.mainUnmagnifiedDiameterCssPx !== null,
    mainUnmagnifiedDiameterCssPx: displayed.moonLoupe.mainUnmagnifiedDiameterCssPx,
    mainMoonHitTarget: displayed.interaction?.bodyHitTargets?.find((body: any) => body.id === 'body:Moon') ?? null,
    geometricAltitudeDeg: moon.geometricAltitudeDeg, apparentAltitudeDeg: moon.apparentAltitudeDeg,
    belowGeometricHorizon: moon.geometricAltitudeDeg < 0,
    visibleLoupeCaption: await page.locator('#sky-moon-loupe').innerText(),
    scope: 'Native teaching loupe at unchanged UTC, observer, state and camera. Main projected-center availability and geometric horizon are recorded separately; the loupe is neither proof of Moon visibility in the main view nor actual sky visibility, and is not an independent raster accuracy pass.' } };
}
async function showNativeLayerControls(page: Page) {
  for (const detail of ['.layer-section', '.advanced-layers']) if (!await page.locator(detail).evaluate((e: HTMLDetailsElement) => e.open)) await page.locator(`${detail} > summary`).click();
}
async function visualAssertionSupplement(scene: FinalSceneCase, result: SceneResult, page: Page, out: string) {
  if (scene.id !== 'V03' && scene.id !== 'V04') return;
  const key = scene.id === 'V03' ? 'backHemisphere' : 'celestialPoles'; await showNativeLayerControls(page);
  const before = await browserRead(page); assert.equal(before.state.layers[key], false);
  await page.locator(`input[data-layer="${key}"]`).setChecked(true); await paired(page);
  const path = await screenshot(page, out, `${scene.id}-${key}-supplement-before-drag`), enabled = await browserRead(page);
  assert.deepEqual(enabled.state, { ...before.state, layers: { ...before.state.layers, [key]: true } });
  assert.deepEqual(scientificSnapshotFields(enabled.snapshot), scientificSnapshotFields(before.snapshot));
  assert.deepEqual(enabled.interaction?.cameraOrientationQuaternion, before.interaction?.cameraOrientationQuaternion);
  const baselineLabels: any[] = before.interaction?.labelHitBoxes ?? [], enabledLabels: any[] = enabled.interaction?.labelHitBoxes ?? [];
  const baselineIds = new Set(baselineLabels.map(label => label.id)), enabledIds = new Set(enabledLabels.map(label => label.id));
  let axes: unknown = null;
  if (scene.id === 'V04') {
    const northPoleEqj = unit(multiply(enabled.snapshot.earthFixedToEqj, [0, 0, 1])), zenithEqj = enabled.snapshot.localZenithEqjUnit;
    const separationDeg = angularDeg(northPoleEqj, zenithEqj), expectedSeparationDeg = 90 - enabled.state.observer.latitudeDeg;
    assert.ok(Math.abs(separationDeg - expectedSeparationDeg) < 1e-10);
    axes = { northPoleEqj, zenithEqj, northPoleEnu: multiply(enabled.snapshot.eqjToHorizontalGeometric, northPoleEqj),
      zenithEnu: multiply(enabled.snapshot.eqjToHorizontalGeometric, zenithEqj), separationDeg, expectedSeparationDeg,
      actualAxisLabels: enabledLabels.filter(label => /^(pole:|direction:Z)/.test(label.id)), scope: 'Given epoch frame axes; geographic distinction, not independent PN accuracy' };
  }
  result.observations.push({ label: 'explicit-original-assertion-display-supplement-before-drag', layerOnlyDifference: { [key]: true },
    before, enabled, screenshot: path, axes, nearBackLabelComparison: { baselineLabels, enabledLabels,
      newlyVisibleIds: [...enabledIds].filter(id => !baselineIds.has(id)), noLongerVisibleIds: [...baselineIds].filter(id => !enabledIds.has(id)),
      baselineCache: before.interaction?.labelCache, enabledCache: enabled.interaction?.labelCache,
      scope: 'Actual glyph boxes/layout delta with identical camera; per-glyph facing/alpha is not exported, so no synthetic facing/alpha field or automatic pixel pass.' } });
  await page.locator(`input[data-layer="${key}"]`).setChecked(false); await paired(page);
  assert.deepEqual((await browserRead(page)).state, before.state);
  result.checks.push({ name: `Native ${key} display supplement restores original before-drag state`, assertionIndex: 2, status: 'passed-check',
    scope: 'Only a layer changed/restored; original baseline and subsequent drag intact; actual raster relation remains reviewable observation', value: { path, axes } });
}

async function nativeZone(page: Page, zone: SimulationState['observer']['displayZone']) {
  const detail = page.locator('.time-zone-settings');
  if (!await detail.evaluate((e: HTMLDetailsElement) => e.open)) await detail.locator('summary').click();
  await page.locator('#sky-zone-kind').selectOption(zone.kind);
  if (zone.kind === 'iana') await page.locator('#sky-zone-name').fill(zone.name);
  else { const n = Math.abs(zone.offsetMinutes); await page.locator('#sky-zone-offset').fill(`${zone.offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`); }
  await page.locator('#sky-zone-form button[type="submit"]').click(); await paired(page);
}
async function nativeWallInput(page: Page, civil: Omit<CivilInput, 'zone' | 'ambiguousTime'>, ambiguity?: 'reject' | 'earlier' | 'later') {
  if (ambiguity) await page.locator('#sky-time-ambiguity').selectOption(ambiguity);
  const two = (n: number) => String(n).padStart(2, '0');
  await page.locator('#sky-date').fill(`${civil.astronomicalYear}-${two(civil.month)}-${two(civil.day)}`);
  await page.locator('#sky-time').fill(`${two(civil.hour)}:${two(civil.minute)}:${two(civil.second)}`);
  await page.locator('.apply-time').click(); await paired(page);
}
/** Parse-zone and original observer display-zone are independently honoured through actual controls. */
async function nativeOriginalTime(page: Page, input: TimeInput, observerZone: SimulationState['observer']['displayZone']) {
  const c = input.kind === 'civil' ? input.value : (() => { const ut = timeUt(input), p = localCivilParts(ut, { kind: 'fixed', offsetMinutes: 0 }); return { astronomicalYear: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second + utToDate(ut).getUTCMilliseconds() / 1000, zone: { kind: 'fixed' as const, offsetMinutes: 0 }, ambiguousTime: 'reject' as const }; })();
  await nativeZone(page, c.zone); await nativeWallInput(page, c, c.zone.kind === 'iana' ? c.ambiguousTime : undefined);
  assert.equal((await browserRead(page)).state.time.utDaysJ2000, timeUt(input));
  await nativeZone(page, observerZone); return browserRead(page);
}
async function nativeRefraction(page: Page, mode: 'none' | 'standard', pressure: number, temperature: number) {
  const root = page.locator('#sky-refraction'); if (!await root.evaluate((e: HTMLDetailsElement) => e.open)) await root.locator('summary').click();
  await page.locator('#sky-refraction-mode').selectOption(mode); await page.locator('#sky-pressure').fill(String(pressure)); await page.locator('#sky-temperature').fill(String(temperature));
  await page.locator('#sky-apply-refraction').click(); await paired(page); return browserRead(page);
}

async function nativeTouchControls(scene: FinalSceneCase, result: SceneResult, page: Page, context: BrowserContext) {
  if (context.browser()?.browserType().name() !== 'chromium') {
    result.checks.push({ name: 'Native touch controls', assertionIndex: 3, status: 'not-executed', scope: 'Chromium CDP native input entry required; no DOM dispatch substitution for Firefox' }); return;
  }
  const cdp = await context.newCDPSession(page), taps: unknown[] = [];
  const tap = async (selector: string) => {
    const target = page.locator(selector); await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    assert.ok(await target.evaluate((e, p) => e.contains(document.elementFromPoint(p.x, p.y)), { x, y }), `Touch target is occluded: ${selector}`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); taps.push({ selector, x, y });
  };
  try {
    const baseline = clone(scene.state); baseline.selected = 'body:Moon'; await apply(page, baseline);
    await tap('[data-action="reverse"]'); await paired(page); const reversed = await browserRead(page); assert.ok(reversed.state.time.rateSimSecondsPerRealSecond < 0);
    await tap('[data-action="play"]'); await page.waitForTimeout(500); await tap('[data-action="pause"]'); await paired(page); const backward = await browserRead(page); assert.ok(backward.state.time.utDaysJ2000 < reversed.state.time.utDaysJ2000);
    await apply(page, baseline); const start = await browserRead(page);
    await tap('[data-action="play"]'); await page.waitForTimeout(20_000); await tap('[data-action="pause"]'); await paired(page); const midnight = await browserRead(page);
    assert.equal(midnight.ui.date, '2026-09-15'); assert.deepEqual(midnight.state.cameras, start.state.cameras); assert.deepEqual(midnight.state.observer, start.state.observer);
    await tap('[data-action="realtime"]'); await page.waitForTimeout(700); await tap('[data-action="pause"]'); await paired(page); const realtime = await browserRead(page);
    assert.ok(Math.abs((realtime.state.time.utDaysJ2000 - dateToUt(new Date())) * 86400) < 2);
    await page.locator('#sky-search').fill(''); await tap('#sky-search'); await cdp.send('Input.insertText', { text: 'Sun' });
    await page.locator('[data-object-id="body:Sun"]').waitFor({ state: 'visible' }); await tap('[data-object-id="body:Sun"]'); await paired(page); const searched = await browserRead(page); assert.equal(searched.state.selected, 'body:Sun');
    result.checks.push({ name: 'Native CDP touch reverse/play/pause/midnight/realtime/search', assertionIndex: 3, status: 'passed-check', scope: 'Actual Chromium engine touch+text insertion; original600× and20s supplement; no physical-phone or OS device claim', value: { taps, start, reversed, backward, midnight, realtime, searched, advanceSimSeconds: (midnight.state.time.utDaysJ2000 - start.state.time.utDaysJ2000) * 86400 } });
  } finally { await cdp.detach(); }
}

async function remainingNative(scene: FinalSceneCase, result: SceneResult, page: Page, context: BrowserContext, out: string) {
  if (scene.id === 'S08') {
    const setup = deriveFinalSceneTimes(scene); atomicJson(join(out, 'S08-derived-times.json'), setup);
    for (const event of setup.events as any[]) {
      await apply(page, scene.state); await nativeOriginalTime(page, { kind: 'utc-iso', value: event.utc }, scene.state.observer.displayZone);
      await nativeSelect(page, 'Sun'); const records = [];
      for (const [mode, pressure] of [['none', scene.state.environment.pressureHpa], ['standard', scene.state.environment.pressureHpa], ['standard', 0]] as const) {
        const before = await browserRead(page), after = await nativeRefraction(page, mode, pressure, scene.state.environment.temperatureC);
        assert.equal(after.state.time.utDaysJ2000, before.state.time.utDaysJ2000); assert.deepEqual(after.state.cameras, before.state.cameras);
        const sun = after.snapshot.bodies.find((b: any) => b.id === 'Sun'); assert.ok(Math.abs(sun.geometricAltitudeDeg - event.targetGeometricAltitudeDeg) < .00005);
        if (mode === 'none' || pressure === 0) assert.equal(sun.apparentAltitudeDeg, sun.geometricAltitudeDeg);
        records.push({ mode, pressure, ...after, screenshot: await screenshot(page, out, `S08-${-event.targetGeometricAltitudeDeg}-${mode}-${pressure === 0 ? 'P0' : 'Pnormal'}`) });
      }
      observable(result, `Derived${event.targetGeometricAltitudeDeg}° true/app/display records`, 3, { event, records }, 'Actual native form/state/HUD records; pixel/label/pick/warped-disc accuracy remains dedicated M5C oracle');
    }
  }
  if (scene.id === 'S09') {
    if (!await page.locator('.scene-section').evaluate((e: HTMLDetailsElement) => e.open)) await page.locator('.scene-section > summary').click();
    await page.locator('#sky-preset').selectOption('S09'); await page.locator('#sky-load-preset').click(); await paired(page);
    assert.deepEqual((await browserRead(page)).state, scene.state);
    await openTeaching(page); await page.locator('#sky-quarter-search').click();
    await page.waitForFunction(() => (window as any).skyApp.teachingData.moonPhaseStatus === 'ready');
    const sequence = (await browserRead(page)).teaching.moonPhases; assert.equal(sequence.seedUtDaysJ2000, dateToUt(new Date(String(scene.source.timeSelection!.seedUtc)))); assert.equal(sequence.events.length, 4);
    const downloading = page.waitForEvent('download'); await page.locator('#sky-quarter-export').click(); const download = await downloading;
    const path = join(out, 'S09-native-derived-moon-phases.json'); await download.saveAs(path);
    const saved = JSON.parse(readFileSync(path, 'utf8')); assert.deepEqual(saved.events.map((e: any) => e.utDaysJ2000), sequence.events.map((e: any) => e.utDaysJ2000));
    for (let i = 0; i < sequence.events.length; i++) {
      // Imports/observer supplements legitimately invalidate phase results. Restore the original seed and create fresh real buttons each time.
      await page.locator('#sky-preset').selectOption('S09'); await page.locator('#sky-load-preset').click(); await paired(page);
      assert.deepEqual((await browserRead(page)).state, scene.state);
      await openTeaching(page); await page.locator('#sky-quarter-search').click();
      await page.waitForFunction(() => (window as any).skyApp.teachingData.moonPhaseStatus === 'ready');
      const freshSequence = (await browserRead(page)).teaching.moonPhases; assert.deepEqual(freshSequence, sequence);
      const before = await browserRead(page); await page.locator('.moon-quarter-events [data-event-ut]').nth(i).click(); await paired(page); const after = await browserRead(page);
      assert.equal(after.state.time.utDaysJ2000, sequence.events[i].utDaysJ2000); assert.equal(after.state.time.running, false); assert.deepEqual(after.state.observer, before.state.observer); assert.deepEqual(after.state.cameras, before.state.cameras);
      const event = sequence.events[i], moon = after.teaching.moon;
      if (event.phaseLongitudeDeg === 0) assert.ok(moon.illuminatedFraction < .01); if (event.phaseLongitudeDeg === 180) assert.ok(moon.illuminatedFraction > .99);
      const northLoupe = await s09NativeMoonLoupe(page);
      result.observations.push({ event, perspective: 'original-north', ...northLoupe.displayed, moonVisualEvidence: northLoupe.evidence, screenshot: await screenshot(page, out, `S09-north-${event.phaseLongitudeDeg}`) });
      if (event.phaseLongitudeDeg === 90 || event.phaseLongitudeDeg === 270) {
        const southern = clone(after.state); southern.observer.latitudeDeg = -scene.state.observer.latitudeDeg; await apply(page, southern);
        const southLoupe = await s09NativeMoonLoupe(page);
        result.observations.push({ event, supplement: 'sameUTC opposite-latitude quarter projection', ...southLoupe.displayed, moonVisualEvidence: southLoupe.evidence, screenshot: await screenshot(page, out, `S09-south-${event.phaseLongitudeDeg}`) });
        await apply(page, after.state);
      }
    }
    result.checks.push({ name: 'Original seed native search/export/jump pause invariants', assertionIndex: 1, status: 'passed-check', scope: 'Actual event controls; phase raster/bright-limb validation separate', value: { path, sha256: sha(readFileSync(path)), sequence } });
  }
  if (['S11', 'S12', 'S13'].includes(scene.id)) {
    const sharedStarBuffers: unknown[] = []; let sharedPositionAttributeId: unknown = null;
    for (const [i, input] of [scene.source.inputs.time, ...(scene.source.additionalTimes ?? [])].entries()) {
      await apply(page, scene.state); const record = await nativeOriginalTime(page, input, scene.state.observer.displayZone);
      if (scene.id === 'S12' || scene.id === 'S13') { assert.equal(record.teaching.lunarCalendar.available, false); assert.match(record.ui.notice ?? '', /扩展|长期|近似/); }
      if (scene.id === 'S13' && record.graphicsStatus.kind === 'webgl2') {
        const motion = record.interaction?.starMotion; assert.ok(motion);
        assert.equal(motion.pointLinePositionShared, true); assert.equal(motion.pointHighlightPositionShared, true);
        assert.ok(typeof motion.positionAttributeId === 'string' ? motion.positionAttributeId.length > 0 : Number.isFinite(motion.positionAttributeId) && motion.positionAttributeId > 0);
        if (sharedPositionAttributeId === null) sharedPositionAttributeId = motion.positionAttributeId;
        else assert.equal(motion.positionAttributeId, sharedPositionAttributeId, 'Original S13 dates must reuse one position attribute');
        assert.equal(motion.cacheStepDays, 30); assert.equal(motion.cachedUtDaysJ2000, Math.round(record.state.time.utDaysJ2000 / 30) * 30);
        assert.equal(motion.constellationAnchorUtDaysJ2000, motion.cachedUtDaysJ2000);
        sharedStarBuffers.push({ input, actualUtDaysJ2000: record.state.time.utDaysJ2000, motion });
      }
      result.observations.push({ input, ...record, screenshot: await screenshot(page, out, `${scene.id}-native-time-${i + 1}`) });
      if (scene.id === 'S13') { await nativeSelect(page, '北极星'); result.observations.push({ input, selectedStar: await browserRead(page), screenshot: await screenshot(page, out, `S13-star-${i + 1}`) }); }
    }
    if (scene.id === 'S13') result.checks.push({ name: 'Original two-date shared star/line/highlight attribute and30day epoch contract', assertionIndex: 3,
      status: sharedStarBuffers.length === 2 ? 'passed-check' : 'not-executed', scope: 'WebGL buffer ownership/epoch only; independent source-scalar endpoint accuracy is separate, Canvas2D has no shared GPU attribute', value: sharedStarBuffers });
    result.checks.push({ name: 'Original date/civil inputs through actual controls and restored displayzone', assertionIndex: null, status: 'passed-check', scope: 'No astronomical accuracy promotion; snapshot/lunar/extension notices are retained observations' });
  }
  if (scene.id === 'S14') {
    const before = await browserRead(page); await nativeZone(page, { kind: 'fixed', offsetMinutes: -720 }); const zoned = await browserRead(page);
    assert.equal(zoned.state.time.utDaysJ2000, before.state.time.utDaysJ2000); assert.deepEqual(zoned.state.cameras, before.state.cameras); assert.deepEqual(scientificSnapshotFields(zoned.snapshot), scientificSnapshotFields(before.snapshot));
    const detail = page.locator('.custom-observer'); if (!await detail.evaluate((e: HTMLDetailsElement) => e.open)) await detail.locator('summary').click();
    await page.locator('#sky-latitude').fill('0'); await page.locator('#sky-longitude').fill('-180'); await page.locator('#sky-height').fill('0'); await page.locator('#sky-observer-form button[type="submit"]').click(); await paired(page);
    const minus = await browserRead(page); assert.deepEqual(scientificSnapshotFields(minus.snapshot), scientificSnapshotFields(before.snapshot)); assert.equal(minus.ui.date, '2026-09-14'); assert.match(minus.ui.time, /^06:30/);
    await nativeZone(page, { kind: 'fixed', offsetMinutes: 720 }); const plus = await browserRead(page);
    assert.equal(plus.state.time.utDaysJ2000, before.state.time.utDaysJ2000); assert.deepEqual(plus.state.cameras, before.state.cameras);
    assert.deepEqual(scientificSnapshotFields(plus.snapshot), scientificSnapshotFields(before.snapshot)); assert.equal(plus.ui.date, '2026-09-15'); assert.match(plus.ui.time, /^06:30/);
    result.checks.push({ name: 'Real longitude/zone controls preserve instant at dateline', assertionIndex: 1, status: 'passed-check', scope: 'Only transport requestId excluded from truth equality; all original raw snapshots/counters remain; actual custom observer name retained', value: { before, zoned, minus, plus,
      transport: [before, zoned, minus, plus].map(record => ({ requestId: record.snapshot.requestId, scienceRequestCount: record.diagnostics.scienceRequestCount })), screenshot: await screenshot(page, out, 'S14-native-dateline') } });
  }
  if (scene.id === 'S15') {
    const civil = (scene.source.inputs.time as { kind: 'civil'; value: CivilInput }).value;
    await nativeZone(page, civil.zone); const before = await browserRead(page);
    await nativeWallInput(page, civil, 'reject'); const rejected = await browserRead(page); assert.deepEqual(rejected.state, before.state); assert.match(rejected.ui.message ?? '', /重复/);
    await screenshot(page, out, 'S15-fold-rejected');
    const choices = [];
    for (const [policy, utc] of [['earlier', '2026-11-01T05:30:00Z'], ['later', '2026-11-01T06:30:00Z']] as const) {
      await nativeWallInput(page, civil, policy); const selected = await browserRead(page); assert.equal(selected.state.time.utDaysJ2000, dateToUt(new Date(utc)));
      choices.push({ policy, expectedUtc: utc, ...selected, screenshot: await screenshot(page, out, `S15-${policy}`) });
    }
    const gap = (scene.source.additionalTimes![0] as { kind: 'civil'; value: CivilInput }).value, beforeGap = await browserRead(page);
    await nativeWallInput(page, gap, 'reject'); const rejectedGap = await browserRead(page); assert.deepEqual(rejectedGap.state, beforeGap.state); assert.match(rejectedGap.ui.message ?? '', /不存在/);
    await screenshot(page, out, 'S15-gap-rejected'); await nativeZone(page, scene.state.observer.displayZone);
    result.checks.push({ name: 'Native fold/gap rejection atomicity and explicit choices', assertionIndex: 1, status: 'passed-check', scope: 'Actual browser Intl; no political zone inference or silent time shift', value: { before, rejected, choices, beforeGap, rejectedGap } });
  }
  if (scene.id === 'S16') {
    const cases: [string, boolean, number?, number?, number?, boolean?][] = [
      ['1900-12-31T15:59:59.999Z', false], ['1900-12-31T16:00:00Z', true, 1900, 11, 11, false],
      ['2100-12-31T15:59:59.999Z', true, 2100, 12, 1, false], ['2100-12-31T16:00:00Z', false],
      ['2033-12-22T04:00:00Z', true, 2033, 11, 1, true], ['2057-10-01T04:00:00Z', true], ['2089-09-04T04:00:00Z', true], ['2097-08-07T04:00:00Z', true],
    ];
    for (const [i, c] of cases.entries()) {
      const state = clone(scene.state); state.time.utDaysJ2000 = dateToUt(new Date(c[0])); await apply(page, state); const record = await browserRead(page), lunar = record.teaching.lunarCalendar;
      assert.equal(lunar.available, c[1]); if (c[2] !== undefined) assert.deepEqual([lunar.year, lunar.month, lunar.day, lunar.isLeapMonth], c.slice(2));
      if (/^(2057|2089|2097)/.test(c[0])) assert.equal(lunar.uncertain, true);
      const before = record; await nativeZone(page, { kind: 'fixed', offsetMinutes: -720 }); const other = await browserRead(page); assert.equal(other.state.time.utDaysJ2000, before.state.time.utDaysJ2000); assert.deepEqual(other.teaching.lunarCalendar, before.teaching.lunarCalendar);
      result.observations.push({ case: c, ...record, zoneChanged: other, screenshot: await screenshot(page, out, `S16-calendar-${i + 1}`) });
    }
    result.checks.push({ name: 'Actual runtime calendar bounds/leap/uncertainty/zone independence', assertionIndex: 1, status: 'passed-check', scope: 'HKO expected boundary/leap cases; retained2057differences and future uncertainty unchanged' });
  }
  if (scene.id === 'D01' && (await browserRead(page)).graphicsStatus.kind === 'webgl2') {
    await nativeView(page, 'globe'); const samples = [], figures = json('assets/runtime/constellation-meta.json').constellations;
    for (const figure of figures) {
      await nativeSelect(page, figure.nameZh); const record = await browserRead(page); assert.equal(record.interaction?.canonicalSelectedId, `constellation:${figure.id}`);
      await page.locator('[data-action="focus-selection"]').click(); await paired(page); const focused = await browserRead(page); assert.deepEqual(focused.interaction?.highlightedConstellationIds, [figure.id]);
      samples.push({ id: figure.id, canonical: focused.interaction!.canonicalSelectedId, lineCount: figure.lineCount, resources: focused.metrics,
        geometryId: focused.interaction!.highlightGeometryId, indexId: focused.interaction!.highlightIndexAttributeId });
    }
    assert.equal(samples.length, 88); assert.equal(new Set(samples.map(s => s.geometryId)).size, 1); assert.equal(new Set(samples.map(s => s.indexId)).size, 1);
    result.checks.push({ name: 'All88 actual Chinese searches and reused selected-figure resources', assertionIndex: 1, status: 'passed-check', scope: 'CPU source/HIP correctness separately tested; actual short-arc pixel direction remains specialised oracle', value: samples });
    for (const enabled of [false, true]) { await page.locator('input[data-layer="milkyWay"]').setChecked(enabled); await paired(page); result.observations.push({ enabled, ...await browserRead(page), screenshot: await screenshot(page, out, `D01-milkyway-${enabled ? 'on' : 'off'}`) }); }
  }
  if (scene.id === 'P01' && (await browserRead(page)).graphicsStatus.kind === 'webgl2') {
    for (let cycle = 0; cycle < 5; cycle++) for (const mode of ['ground', 'space', 'globe', 'horizon']) await nativeView(page, mode);
    await nativeView(page, scene.state.viewMode); await waitInteractionReady(page); const before = await browserRead(page);
    const switches = [];
    for (let i = 0; i < 100; i++) {
      const mode = ['space', 'globe', 'horizon', 'ground'][i % 4]!, prior = await browserRead(page); assert.notEqual(mode, prior.state.viewMode);
      await nativeView(page, mode); const drawn = await browserRead(page); assert.ok(drawn.diagnostics.renderCount > prior.diagnostics.renderCount);
      switches.push({ index: i + 1, mode, renderCount: drawn.diagnostics.renderCount });
    }
    await waitInteractionReady(page); const after = await browserRead(page); assert.deepEqual(after.state, before.state);
    assert.equal(after.metrics.textureCount, before.metrics.textureCount); assert.equal(after.metrics.geometryCount, before.metrics.geometryCount); assert.equal(after.diagnostics.workerCount, before.diagnostics.workerCount);
    await page.waitForTimeout(400); const idle = (await browserRead(page)).diagnostics.renderCount; await page.waitForTimeout(400); assert.equal((await browserRead(page)).diagnostics.renderCount, idle);
    result.checks.push({ name: 'Original5warm/100actualdrawn same-state resource and idle check', assertionIndex: 1, status: 'passed-check', scope: 'Counts/app-estimates/mainheap scoped; not GPU completion FPS or30min endurance', value: { warmupCycles: 5, viewSwitchCount: 100, switches, before, after, screenshot: await screenshot(page, out, 'P01-resource-short') } });
    result.checks.push({ name: 'Original30minute continuous playback', assertionIndex: 3, status: 'not-executed', scope: 'Explicitly deferred by user; this driver never runs it' });
  }
  if (scene.id === 'U01') {
    const before = await browserRead(page), path = join(out, 'U01-unsupported-schema.json'); atomicJson(path, { ...clone(before.state), schemaVersion: 999 });
    await page.locator('#sky-import-file').setInputFiles(path); await page.waitForFunction(() => /schemaVersion|版本/.test(document.querySelector('.ui-message')?.textContent ?? '')); await paired(page); const rejected = await browserRead(page); assert.deepEqual(rejected.state, before.state);
    await page.locator('[data-action="reverse"]').click(); await paired(page); const reversed = await browserRead(page); assert.ok(reversed.state.time.rateSimSecondsPerRealSecond < 0);
    await page.locator('[data-action="play"]').click(); await page.waitForTimeout(500); await page.locator('[data-action="pause"]').click(); await paired(page); const reversePaused = await browserRead(page); assert.ok(reversePaused.state.time.utDaysJ2000 < reversed.state.time.utDaysJ2000);
    await page.locator('[data-action="realtime"]').click(); await page.waitForTimeout(700); await page.locator('[data-action="pause"]').click(); await paired(page); const realtime = await browserRead(page);
    assert.ok(Math.abs((realtime.state.time.utDaysJ2000 - dateToUt(new Date())) * 86400) < 2); assert.deepEqual(realtime.state.cameras, before.state.cameras); assert.equal(realtime.state.selected, before.state.selected);
    result.checks.push({ name: 'Native unsupported-schema atomic rejection/reverse/realtime', assertionIndex: 2, status: 'passed-check', scope: 'Actual file-input and control operations; realtime compared with host clock, not ephemeris golden', value: { path, before, rejected, reversed, reversePaused, realtime } });
    await nativeTouchControls(scene, result, page, context);
  }
  // The existing offline functions mutate supplementary test states intentionally. Preserve their actual states and hashes.
  void context;
}

async function existingOfflineSmoke(page: Page, out: string, prefix: string) {
  const path3 = './qa-m3.mjs', path3b = './qa-m3b.mjs', path5b = './qa-m5b.mjs';
  const [m3, m3b, m5b] = await Promise.all([import(path3), import(path3b), import(path5b)]);
  const shot = (name: string) => screenshot(page, out, name);
  if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') === 'true') await page.locator('#sky-moon-loupe-close').click();
  return { lunarMoonSolar: await m3.runM3OfflineSmoke({ page, shot, name: `${prefix}-m3.png` }),
    galaxy: await m3b.runM3bOfflineSmoke({ page, shot, name: `${prefix}-galaxy.png` }), starMotion: await m5b.runM5bOfflineSmoke({ page, shot, prefix: `${prefix}-star` }),
    scope: 'Reused existing functional smoke variants; actual supplementary observer/time/state recorded, not silently substituted for originalB' };
}
async function webOfflineReopen(scene: FinalSceneCase, result: SceneResult, page: Page, context: BrowserContext, url: string, out: string, buildId: string | null): Promise<Page> {
  await page.waitForFunction(() => (window as any).skyApp.offlineStatus?.phase === 'ready' || document.querySelector('#runtime-status')?.textContent?.includes('离线资源已就绪'), undefined, { timeout: 30_000 });
  const original = await browserRead(page); await page.close(); await context.setOffline(true); const reopened = await context.newPage();
  const responses: unknown[] = [], failures: unknown[] = [], requests: string[] = [];
  reopened.on('request', r => requests.push(r.url()));
  reopened.on('response', r => responses.push({ url: r.url(), status: r.status(), fromServiceWorker: r.fromServiceWorker() })); reopened.on('requestfailed', r => failures.push({ url: r.url(), failure: r.failure() }));
  await reopened.goto(url); await reopened.waitForFunction(() => (window as any).skyApp?.ready); await apply(reopened, scene.state);
  if (buildId) assert.equal(await reopened.locator('meta[name="sky-build-id"]').getAttribute('content'), buildId);
  assert.ok(responses.length >= 3 && (responses as any[]).filter(r => /^https?:/.test(r.url)).every(r => r.fromServiceWorker && r.status === 200));
  assert.ok(requests.filter(u => /^https?:/.test(u)).every(u => new URL(u).origin === new URL(url).origin), 'External HTTP resource attempted during offline reopen');
  const smoke = await existingOfflineSmoke(reopened, out, 'O01-reopen'); await apply(reopened, scene.state);
  for (const mode of ['space', 'globe', 'horizon', 'ground']) { await nativeView(reopened, mode); result.observations.push({ mode, ...await browserRead(reopened), screenshot: await screenshot(reopened, out, `O01-${mode}`) }); }
  await nativeSelect(reopened, '天鹅座'); assert.equal((await browserRead(reopened)).state.selected, 'constellation:Cyg');
  const layerRecords = [], beforeLayerViews = await browserRead(reopened); await showNativeLayerControls(reopened);
  for (const [key, enabled] of Object.entries(scene.state.layers)) {
    const input = reopened.locator(`input[data-layer="${key}"]`);
    if (await input.isDisabled()) { layerRecords.push({ key, status: 'not-executed-disabled-capability' }); continue; }
    if (!await input.isVisible()) for (const mode of ['space', 'globe', 'horizon', 'ground']) {
      if (mode !== (await browserRead(reopened)).state.viewMode) await nativeView(reopened, mode);
      if (await input.isVisible()) break;
    }
    assert.ok(await input.isVisible(), `No actual available view exposes enabled layer ${key}`);
    for (const value of [!enabled, enabled]) {
      const before = await browserRead(reopened); await input.setChecked(value); await paired(reopened); const record = await browserRead(reopened);
      assert.deepEqual(record.state, { ...before.state, layers: { ...before.state.layers, [key]: value } });
      assert.deepEqual(scientificSnapshotFields(record.snapshot), scientificSnapshotFields(before.snapshot));
      assert.equal(record.state.time.utDaysJ2000, scene.state.time.utDaysJ2000); layerRecords.push({ key, value, actualView: record.state.viewMode, actualState: record.state, renderCount: record.diagnostics.renderCount });
    }
  }
  await nativeView(reopened, beforeLayerViews.state.viewMode); assert.deepEqual((await browserRead(reopened)).state, beforeLayerViews.state);
  if (!await reopened.locator('.scene-section').evaluate((e: HTMLDetailsElement) => e.open)) await reopened.locator('.scene-section > summary').click();
  const beforeExport = await browserRead(reopened), downloading = reopened.waitForEvent('download'); await reopened.locator('[data-action="export"]').click();
  const download = await downloading, exportPath = join(out, 'O01-offline-native-export.json'); await download.saveAs(exportPath); assert.deepEqual(parseState(readFileSync(exportPath, 'utf8')), beforeExport.state);
  await reopened.locator('[data-action="clear-selection"]').click(); await paired(reopened); await reopened.locator('#sky-import-file').setInputFiles(exportPath); await paired(reopened); assert.deepEqual((await browserRead(reopened)).state, beforeExport.state);
  const fold = createFinalSceneManifest(['S15']).scenes[0]!, offlineFold = resultFor(fold); await apply(reopened, fold.state); await remainingNative(fold, offlineFold, reopened, context, out); await apply(reopened, scene.state);
  assert.ok(requests.filter(u => /^https?:/.test(u)).every(u => new URL(u).origin === new URL(url).origin), 'External HTTP resource attempted during offline functional smoke');
  assert.equal(failures.length, 0, 'A page resource failed during offline reopen/smoke');
  result.checks.push({ name: 'Original offline-ready/close/reopen and native core smoke', assertionIndex: 1, status: 'passed-check', scope: 'Localhost secure-context SW; page requests only, browser background SW upgrade fetches are separate; not HTTPS deployment or physical OS installation proof', value: { original, responses, failures, requests, smoke } });
  result.checks.push({ name: 'Actual offline constellation/layer/export/import and declaredIANA policy', assertionIndex: 2, status: 'passed-check', scope: 'Supplemental S15 raw wall inputs retained; no network timezone download or political inference', value: { layerRecords, exportPath, exportedSha256: sha(readFileSync(exportPath)), offlineFold } });
  observable(result, 'Offline upgrade rollback entry', 3, { entry: 'node scripts/qa-updates.mjs', report: 'qa/final-m4b/updates-passive/report.json', unchangedSourceSha256: sha(bytes('scripts/qa-updates.mjs')) }, 'Existing dedicated candidate-fault/dual-scope/activation driver still required after SW-affecting changes; no upgrade pass inferred from reopen');
  await context.setOffline(false); return reopened;
}

/** A portable document may issue only its one HTML navigation and embedded Blob/data resources. */
export function portableResourceAllowed(requestUrl: string, documentUrl: string): boolean {
  const request = new URL(requestUrl), document = new URL(documentUrl);
  return request.protocol === 'blob:' || request.protocol === 'data:' ||
    (request.protocol === 'file:' && document.protocol === 'file:' && request.host === document.host && request.pathname === document.pathname);
}
function auditPortableRequests(page: Page, url: string) {
  const requests: { url: string; allowed: boolean }[] = [];
  page.on('request', r => requests.push({ url: r.url(), allowed: portableResourceAllowed(r.url(), url) }));
  return requests;
}
export type FinalPortableIdentity = { path: string; sha256: string; bytes: number; expectedSha256: string | null;
  htmlBuildMeta: string | null; format: 'classic-iife'; buildReportPath: string; buildReportSha256: string;
  buildScriptSha256: string; builtAt: string; scope: string };
/** Portable has its own content hash. The production builder does NOT inject the Web/SW buildId. */
export function inspectFinalPortableArtifact(options: { path?: string; buildReportPath?: string; expectedSha256?: string | null } = {}): FinalPortableIdentity {
  const path = resolve(ROOT, options.path ?? 'dist-portable/三维全景夜空.html'), buildReportPath = resolve(ROOT, options.buildReportPath ?? 'dist-portable/build-report.json');
  const artifact = readFileSync(path), html = artifact.toString('utf8'), digest = sha(artifact), reportBytes = readFileSync(buildReportPath), report = JSON.parse(reportBytes.toString('utf8'));
  assert.equal(report.sha256, digest, 'Portable build-report hash differs from actual HTML bytes');
  assert.equal(report.bytes, artifact.byteLength, 'Portable build-report size differs from actual HTML bytes');
  assert.equal(report.format, 'classic-iife', 'Unexpected portable format');
  const expectedSha256 = options.expectedSha256 ?? null;
  if (expectedSha256 !== null) { assert.match(expectedSha256, /^[a-f0-9]{64}$/, 'Expected portable SHA256 must be lowercase64hex'); assert.equal(digest, expectedSha256, 'Unexpected frozen portable artifact'); }
  const htmlBuildMeta = html.match(/<meta\b(?=[^>]*\bname=["']sky-build-id["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i)?.[1] ?? null;
  return { path, sha256: digest, bytes: artifact.byteLength, expectedSha256, htmlBuildMeta, format: report.format,
    buildReportPath, buildReportSha256: sha(reportBytes), buildScriptSha256: sha(bytes('scripts/build-portable.mjs')), builtAt: report.builtAt,
    scope: 'Portable HTML bytes/SHA/report identity only; Web meta/SW buildId is a separate artifact identity, not an equality oracle.' };
}
function inspectLocalArtifactIdentities(webBuildId: string | null, portableSha256: string | null) {
  const webHtmlPath = resolve(ROOT, 'dist/index.html'), webReportPath = resolve(ROOT, 'dist/build-report.json');
  let web: unknown = { status: 'not-built-locally', path: webHtmlPath };
  if (existsSync(webHtmlPath) && existsSync(webReportPath)) {
    const htmlBytes = readFileSync(webHtmlPath), html = htmlBytes.toString('utf8'), reportBytes = readFileSync(webReportPath), report = JSON.parse(reportBytes.toString('utf8'));
    const actualMeta = html.match(/<meta\b(?=[^>]*\bname=["']sky-build-id["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i)?.[1] ?? null;
    assert.equal(actualMeta, report.buildId, 'Local Web meta differs from build report');
    const indexEntry = report.offlineCore.find((entry: any) => entry.url === './index.html'); assert.ok(indexEntry);
    assert.equal(indexEntry.sha256, sha(htmlBytes), 'Local Web HTML differs from SHA-locked offline core');
    if (webBuildId) assert.equal(actualMeta, webBuildId, 'Unexpected local Web artifact');
    web = { path: webHtmlPath, buildId: actualMeta, expectedBuildId: webBuildId, htmlSha256: sha(htmlBytes), buildReportPath: webReportPath,
      buildReportSha256: sha(reportBytes), modules: [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]), builtAt: report.builtAt };
  }
  const portable = existsSync(resolve(ROOT, 'dist-portable/三维全景夜空.html')) && existsSync(resolve(ROOT, 'dist-portable/build-report.json'))
    ? inspectFinalPortableArtifact({ expectedSha256: portableSha256 }) : { status: 'not-built-locally' };
  return { measuredAtUtc: new Date().toISOString(), browserExecuted: false, web, portable,
    scope: 'Local bytes/report identity preflight only; no rendering, package browser acceptance, deployment or Web/portable identity equivalence claim.' };
}
async function portableFirstOpen(scene: FinalSceneCase, result: SceneResult, browser: Browser, out: string, identity: FinalPortableIdentity, webBuildId: string | null) {
  const current = inspectFinalPortableArtifact({ path: identity.path, buildReportPath: identity.buildReportPath, expectedSha256: identity.sha256 });
  assert.deepEqual(current, { ...identity, expectedSha256: identity.sha256 }, 'Portable artifact/report changed since driver preflight');
  const path = identity.path, url = pathToFileURL(path).href, artifactSha256 = identity.sha256;
  const m4path = './qa-m4a.mjs', m5path = './qa-m5b.mjs', m4 = await import(m4path), m5 = await import(m5path);
  let workerReference: any;
  const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, acceptDownloads: true, recordVideo: { dir: join(out, 'portable-video'), size: { width: 1152, height: 720 } } });
  try {
    await m5.installDayEventTransferProbe(context);
    await context.setOffline(true); const page = await context.newPage(), requests = auditPortableRequests(page, url);
    await page.goto(url); await page.waitForFunction(() => (window as any).skyApp?.ready); await apply(page, scene.state);
    const initial = await browserRead(page); assert.ok(requests.every(r => r.allowed), 'Portable document attempted an external resource');
    const actualPortableMeta = await page.locator('meta[name="sky-build-id"]').evaluateAll(nodes => nodes[0]?.getAttribute('content') ?? null);
    assert.equal(actualPortableMeta, identity.htmlBuildMeta, 'Portable DOM meta must match its own fixed HTML bytes');
    const worker = await existingOfflineSmoke(page, out, 'O02-first-worker'); workerReference = worker.starMotion;
    await page.goto(`${url}?worker=off`); await page.waitForFunction(() => (window as any).skyApp?.ready); await apply(page, scene.state);
    const fallback = await existingOfflineSmoke(page, out, 'O02-first-fallback'); m5.compareM5bWorkerFallback(worker.starMotion, fallback.starMotion); assert.ok(requests.every(r => r.allowed));
    result.checks.push({ name: 'Fresh private-context offline-before-firstfile/workerfallback', assertionIndex: 1, status: 'passed-check', scope: 'Desktop privatecontext cache isolation; independent absolute accuracy not inferred from samecore equality', value: { identity, webBuildId, actualPortableMeta, path, artifactSha256, url, requests, initial, worker, fallback } });
  } finally { await context.close(); }
  const workerFault = await browser.newContext({ viewport: { width: 1152, height: 720 }, acceptDownloads: true, recordVideo: { dir: join(out, 'worker-fault-video'), size: { width: 1152, height: 720 } } });
  try {
    await m5.installDayEventTransferProbe(workerFault);
    await workerFault.addInitScript(() => { (window as any).__qaWorkerFaultCalls = 0; window.Worker = new Proxy(Worker, { construct() { (window as any).__qaWorkerFaultCalls++; throw new DOMException('QA Blob Worker construction fault', 'SecurityError'); } }); });
    await workerFault.setOffline(true); const page = await workerFault.newPage(), requests = auditPortableRequests(page, url);
    await page.goto(url); await page.waitForFunction(() => (window as any).skyApp?.ready); await apply(page, scene.state);
    const faultSmoke = await existingOfflineSmoke(page, out, 'O02-native-worker-fault'), calls = await page.evaluate(() => (window as any).__qaWorkerFaultCalls);
    assert.ok(calls >= 1); assert.equal(faultSmoke.starMotion.samples[0].diagnostics.workerCount, 0); assert.ok(requests.every(r => r.allowed)); m5.compareM5bWorkerFallback(workerReference, faultSmoke.starMotion);
    result.checks.push({ name: 'Actual Worker construction failure retains offline core display/events', assertionIndex: 2, status: 'passed-check', scope: 'Native global Worker construction throws before firstfile; queryflag fallback is recorded separately', value: { artifactSha256, calls, requests, faultSmoke } });
  } finally { await workerFault.close(); }
  const faultOut = join(out, 'portable-fault'); mkdirSync(faultOut, { recursive: true });
  const fault = await browser.newContext({ viewport: { width: 1152, height: 720 }, hasTouch: true, acceptDownloads: true, recordVideo: { dir: join(faultOut, 'video'), size: { width: 1152, height: 720 } } });
  try {
    await m4.installGraphicsProbe(fault, true); await fault.setOffline(true); const page = await fault.newPage(), requests = auditPortableRequests(page, url);
    await page.goto(url); await page.waitForFunction(() => (window as any).skyApp?.ready); await apply(page, scene.state);
    const probeReport: any = { assertions: [], limitations: [] }, shot = (name: string) => screenshot(page, faultOut, name);
    await m4.runM4aChecks({ page, context: fault, outDir: faultOut, report: probeReport, shot, assertPaired: () => waitInteractionReady(page) }); assert.ok(requests.every(r => r.allowed));
    result.checks.push({ name: 'Firstfile deniedWebGL2 and actual loss/restore/native capture', assertionIndex: 4, status: 'passed-check', scope: 'Reused real getContext/WEBGL_lose_context/CDP workflow; physical mobilefile execution remains unverified', value: { artifactSha256, requests, probeReport } });
  } finally { await fault.close(); }
  assert.equal(sha(readFileSync(path)), identity.sha256, 'Portable artifact changed during file workflows');
  result.checks.push({ name: 'Android/iOS file-manager execution', assertionIndex: 3, status: 'not-executed', scope: 'External physicalOS/device; desktopfile/privatecontext and CDP touch are not substitutes' });
}

/** Actual browser entry. Called only by explicit --browser after release freeze. Always closes its contexts/browser. */
export async function runFinalSceneBrowser(manifest: FinalSceneManifest, options: { url: string; buildId: string | null; portableSha256: string | null; allowDevelopment: boolean; channel: string; headless: boolean; out: string }) {
  assert.ok(options.buildId || options.allowDevelopment, 'Final browser run requires --build-id; use --allow-development only for explicitly labelled source diagnostics');
  const hasPortable = manifest.scenes.some(scene => scene.id === 'O02');
  if (hasPortable && !options.allowDevelopment) assert.ok(options.portableSha256, 'Production O02 requires explicit --portable-sha256; portable identity is separate from Web buildId');
  const portableIdentity = hasPortable ? inspectFinalPortableArtifact({ expectedSha256: options.portableSha256 }) : null;
  const { chromium, firefox } = await import('@playwright/test');
  const browser = await (options.channel === 'firefox' ? firefox : chromium).launch({ headless: options.headless, ...(options.channel === 'firefox' ? {} : { channel: options.channel }) });
  let context: BrowserContext | undefined;
  const results: SceneResult[] = [], errors: string[] = [];
  const report: any = { schemaVersion: 1, kind: 'final-original-scene-driver', startedAtUtc: new Date().toISOString(),
    status: 'running', url: options.url, expectedBuildId: options.buildId, portableIdentity, stage: options.allowDevelopment ? 'development-explicitly-labelled' : 'production-artifact-identities-checked',
    channel: options.channel, browserVersion: browser.version(), headless: options.headless, source: manifest.source, defaults: manifest.defaults,
    sourceBefore: manifest.sourceFingerprints, scenes: results, errors, limitations: [...manifest.limitations, 'Native browser input is not a physical phone; no FPS or GPU-completion measurement.'] };
  try {
    context = await browser.newContext({ viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true,
      recordVideo: { dir: join(options.out, 'video'), size: { width: 1152, height: 720 } } });
    const m5path = './qa-m5b.mjs'; await (await import(m5path)).installDayEventTransferProbe(context);
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(options.url); await page.waitForFunction(() => (window as any).skyApp?.ready);
    const buildId = await page.locator('meta[name="sky-build-id"]').getAttribute('content').catch(() => null);
    if (options.buildId) assert.equal(buildId, options.buildId, 'Unexpected final package identity');
    report.actualBuildId = buildId; report.pageUrl = page.url(); report.modules = await page.locator('script[type="module"][src]').evaluateAll(nodes => nodes.map(node => (node as HTMLScriptElement).src));
    report.environment = await page.evaluate(() => {
      const canvas = document.querySelector('#sky-stage canvas') as HTMLCanvasElement, gl = canvas?.getContext('webgl2'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, platform: navigator.platform, viewport: [innerWidth, innerHeight], devicePixelRatio, gpuString: debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        scope: 'GPU identity string only; no physical-display FPS/VRAM claim' };
    });
    for (const scene of manifest.scenes) {
      const result = resultFor(scene); results.push(result);
      try {
        if (scene.id === 'O02') {
          assert.notEqual(options.channel, 'firefox', 'O02 native CDP fault workflow requires Chromium Chrome/Edge; do not substitute synthetic touch');
          assert.ok(context, 'Web guard context must be available before fresh portable context');
          await context.close(); context = undefined;
          assert.ok(portableIdentity); await portableFirstOpen(scene, result, browser, options.out, portableIdentity, options.buildId);
          observable(result, 'Original portable assertion clauses requiring physical-device review', null, scene.source.assertions, scene.executionPlan.open);
          result.status = 'completed-native-checks-with-open-observations';
          atomicJson(join(options.out, 'browser-report.json'), report); continue;
        }
        assert.ok(context, 'Main browser context must remain open until O02');
        await page.setViewportSize({ width: scene.source.inputs.viewportCssPx[0], height: scene.source.inputs.viewportCssPx[1] });
        await apply(page, scene.state);
        await page.waitForFunction(() => { const assets = (window as any).skyApp.diagnostics.assetStatus; return assets && assets.pending.length === 0 && assets.errors.length === 0; });
        const initial = await browserRead(page); result.observations.push({ label: 'original-state-loaded', ...initial });
        assert.deepEqual(initial.state, scene.state, 'Original complete input changed at load');
        const actual3d = initial.graphicsStatus.kind === 'webgl2';
        if (!actual3d) result.checks.push({ name: '3D native/camera clauses', assertionIndex: null, status: 'not-executed', scope: 'Active renderer is Canvas2D; fixed overview is not a substitute for four3D camera assertions', value: initial.graphicsStatus });
        if (scene.calibrationProposal && actual3d) {
          const calibrated = clone(scene.state), mode = scene.id === 'V02' ? 'space' : 'globe';
          calibrated.cameras[mode].distanceDisplayUnits = scene.calibrationProposal.distance;
          await apply(page, parseState(calibrated));
          const fitted = await browserRead(page); assert.ok(fitted.interaction?.cameraPositionDisplay, '3D camera diagnostic missing');
          const position = fitted.interaction!.cameraPositionDisplay;
          const ratio = sphereSilhouetteRatio(1, norm(position), calibrated.cameras[mode].verticalFovDeg);
          assert.ok(ratio >= (mode === 'space' ? .45 : .78) && ratio <= (mode === 'space' ? .55 : .88));
          const cameraPath = join(options.out, `${scene.id}-calibration.json`);
          atomicJson(cameraPath, { source: manifest.source, buildId, state: fitted.state, actualCameraPosition: position, analyticDiameterFraction: ratio,
            calibration: scene.calibrationProposal, original: scene.source.cameraCalibration ?? null,
            status: 'analytic-fit-saved-awaiting-actual-pixel-and-human-orientation-review' });
          observable(result, 'Saved camera / analytic silhouette', 1, { ratio, cameraPath, stage: await page.locator('#sky-stage').boundingBox(), camera: calibrated.cameras[mode] }, scene.calibrationProposal.scope);
        }
        const beforeNative = await browserRead(page);
        if (['V01', 'V02', 'V03', 'V04'].includes(scene.id)) {
          const baselineScreenshot = await screenshot(page, options.out, `${scene.id}-baseline`), baseline = await browserRead(page);
          assert.deepEqual(baseline.state, beforeNative.state); assert.deepEqual(baseline.snapshot, beforeNative.snapshot);
          result.observations.push({ label: scene.calibrationProposal ? 'calibrated-baseline-before-native-drag' : 'original-baseline-before-native-drag',
            ...baseline, screenshot: baselineScreenshot, stateSha256: sha(serializeState(baseline.state)), calibrationProposal: scene.calibrationProposal });
        }
        if (actual3d) await visualAssertionSupplement(scene, result, page, options.out);
        if (['V01', 'V02', 'V03', 'V04', 'S04'].includes(scene.id) && actual3d) {
          const route = await nativeDrag(page), after = await browserRead(page);
          assert.notDeepEqual(after.state.cameras[after.state.viewMode], beforeNative.state.cameras[beforeNative.state.viewMode]);
          assert.deepEqual(after.state.time, beforeNative.state.time); assert.deepEqual(after.state.observer, beforeNative.state.observer);
          for (const mode of ['ground', 'space', 'globe', 'horizon']) if (mode !== after.state.viewMode) assert.deepEqual(after.state.cameras[mode], beforeNative.state.cameras[mode]);
          result.checks.push({ name: 'Actual unoccluded drag preserves scientific input and inactive cameras', assertionIndex: scene.id === 'S04' ? 1 : null, status: 'passed-check', scope: 'Native mouse input; visual behaviour separate', value: { route, before: beforeNative.state, after: after.state } });
        }
        if (scene.id === 'V04' && actual3d) {
          const locks = [];
          for (const lock of ['inertial', 'local-horizon']) {
            const before = await browserRead(page); await page.locator('#sky-reference-lock').selectOption(lock); await paired(page); const after = await browserRead(page);
            assert.deepEqual(after.state.time, before.state.time); assert.deepEqual(after.snapshot, before.snapshot);
            assert.ok(after.interaction?.viewForwardEqj && before.interaction?.viewForwardEqj, '3D lock diagnostic missing');
            assert.ok(angularDeg(after.interaction!.viewForwardEqj, before.interaction!.viewForwardEqj) < 1e-5); locks.push({ lock, before, after });
          }
          result.checks.push({ name: 'Native reference lock preserves instant physical view', assertionIndex: 3, status: 'passed-check', scope: 'No absolute frame accuracy claim', value: locks });
        }
        if (scene.id === 'S02' && actual3d) {
          await nativeSelect(page, '北极星'); await page.locator('#sky-rate').selectOption('600'); await paired(page);
          const before = await browserRead(page); await page.locator('[data-action="play"]').click();
          await page.waitForTimeout(20_000); await page.locator('[data-action="pause"]').click(); await paired(page);
          const after = await browserRead(page); assert.deepEqual(after.state.cameras, before.state.cameras); assert.deepEqual(after.state.observer, before.state.observer);
          assert.equal(after.state.selected, before.state.selected); assert.equal(after.state.time.rateSimSecondsPerRealSecond, 600);
          assert.equal(after.ui.date, '2026-09-15');
          const elapsed = (after.performanceNowMs - before.performanceNowMs) / 1000, simulated = (after.state.time.utDaysJ2000 - before.state.time.utDaysJ2000) * 86400;
          const switches = [];
          for (const mode of ['space', 'globe', 'horizon', 'ground']) { const prior = await browserRead(page); await nativeView(page, mode); const current = await browserRead(page); assert.deepEqual(current.snapshot, prior.snapshot); assert.deepEqual(current.state.cameras, prior.state.cameras); switches.push(current); }
          result.checks.push({ name: 'Original native20s×600 crosses midnight and four views preserve state', assertionIndex: 2, status: 'passed-check', scope: 'Actual elapsed/simulation recorded; no invented exact wall-clock timing tolerance', value: { before, after, elapsedRealSeconds: elapsed, advanceSimSeconds: simulated, nominalSimSeconds: 12000, measuredRate: simulated / elapsed, switches } });
          observable(result, 'Observer visible hemisphere', 3, switches.map(s => ({ mode: s.state.viewMode, snapshot: s.snapshot, details: s.details })), 'Same snapshot invariant is checked; all-catalog visibility/pixel hemisphere remains an explicit observation');
        }
        if (['S03', 'S04'].includes(scene.id)) {
          for (const comparison of scene.comparisons) {
            await apply(page, comparison.state); const before = await browserRead(page);
            if (scene.id === 'S04' && actual3d) { await nativeDrag(page); const after = await browserRead(page); assert.deepEqual(after.state.time, before.state.time); assert.deepEqual(after.state.observer, before.state.observer); result.observations.push({ label: 'pole-native-drag', before, after }); }
            else result.observations.push({ label: 'original-comparison-observer', ...before });
            await screenshot(page, options.out, `${scene.id}-observer-${comparison.observer.name}`);
          }
          await apply(page, scene.state);
        }
        if (['S05', 'S06', 'S07'].includes(scene.id)) {
          await openTeaching(page); result.observations.push({ label: 'original-polar-day-teaching', ...await browserRead(page) });
          if (scene.id === 'S05') { const midnight = clone(scene.state); midnight.time.utDaysJ2000 = dateToUt(new Date('2026-06-21T00:00:00Z')); await apply(page, midnight); result.observations.push({ label: 'same-local-day-midnight-not-forced-black', ...await browserRead(page) }); }
          if (scene.id === 'S07') { const winter = clone(scene.state); winter.time.utDaysJ2000 = dateToUt(new Date('2026-06-21T12:00:00Z')); await apply(page, winter); await openTeaching(page); result.observations.push({ label: 'south-June-original-assertion', ...await browserRead(page) }); }
          observable(result, 'Exact original polar UI states/ranges and sky colours', scene.id === 'S05' ? 3 : 2, { screenshot: await screenshot(page, options.out, `${scene.id}-polar-teaching`) });
        }
        if (scene.id === 'S10') {
          await nativeSelect(page, 'Moon'); const selected = await browserRead(page); assert.equal(selected.state.selected, 'body:Moon');
          if (actual3d) {
            await page.locator('[data-action="focus-selection"]').click(); await paired(page); await openTeaching(page);
            if (await page.locator('#sky-moon-loupe-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#sky-moon-loupe-toggle').click();
            await page.waitForFunction(() => (window as any).skyApp.moonLoupeDiagnostics?.status === 'ready');
            const opened = await browserRead(page); assert.deepEqual(opened.snapshot, selected.snapshot);
            await page.locator('#sky-moon-loupe-close').click(); await paired(page); const closed = await browserRead(page); assert.deepEqual(closed.snapshot, opened.snapshot);
            result.checks.push({ name: 'Native Moon search/focus/loupe leaves physical snapshot unchanged', assertionIndex: 3, status: 'passed-check', scope: 'Loupe scientific invariance, not low-altitude raster accuracy', value: { selected, opened, closed } });
          } else observable(result, 'Moon loupe unavailable in 2D', 3, selected.graphicsStatus);
        }
        if (scene.id === 'U01' && actual3d) {
          await nativeSelect(page, 'Moon'); const selected = await browserRead(page);
          for (const mode of ['space', 'globe', 'horizon', 'ground']) { await nativeView(page, mode); const current = await browserRead(page); assert.deepEqual(current.state, { ...selected.state, viewMode: mode }); }
          if (!await page.locator('.scene-section').evaluate((e: HTMLDetailsElement) => e.open)) await page.locator('.scene-section > summary').click();
          const exporting = await browserRead(page), downloadPromise = page.waitForEvent('download'); await page.locator('[data-action="export"]').click();
          const download = await downloadPromise, path = join(options.out, 'U01-native-export.json'); await download.saveAs(path); assert.deepEqual(parseState(readFileSync(path, 'utf8')), exporting.state);
          await page.locator('[data-action="clear-selection"]').click(); await paired(page); await page.locator('#sky-import-file').setInputFiles(path); await paired(page); const imported = await browserRead(page); assert.deepEqual(imported.state, exporting.state);
          result.checks.push({ name: 'Original native Moon/fourviews/download/file-input roundtrip', assertionIndex: 1, status: 'passed-check', scope: 'Full canonical state including four cameras', value: { path, exportedSha256: sha(readFileSync(path)), imported } });
        }
        await remainingNative(scene, result, page, context, options.out);
        if (scene.id === 'O01') {
          page = await webOfflineReopen(scene, result, page, context, options.url, options.out, options.buildId);
          page.on('pageerror', error => errors.push(error.message));
        }
        result.observations.push({ label: 'final-native-state', ...await browserRead(page), screenshot: await screenshot(page, options.out, `${scene.id}-final`) });
        observable(result, 'Original assertion clauses still requiring specialised/visual review', null, scene.source.assertions,
          'This driver never marks a whole scene PASS from successful loading, invariance checks, analytic silhouette or screenshots. See FINAL-ACCEPTANCE-MATRIX.md.');
        result.status = 'completed-native-checks-with-open-observations';
      } catch (error) { result.checks.push({ name: 'Scene execution', assertionIndex: null, status: 'failed-check', scope: 'Failure retained; subsequent scenes still run', error: String(error) }); result.status = 'failed-checks-retained'; }
      atomicJson(join(options.out, 'browser-report.json'), report);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    report.status = results.some(r => r.status === 'failed-checks-retained') ? 'failed-checks-retained' : 'completed-checks-with-open-observations';
  } catch (error) { report.status = 'failed-driver'; report.error = String(error); }
  finally {
    report.contextClosed = !context; report.browserClosed = false;
    if (context) { try { await context.close(); report.contextClosed = true; } catch (error) { errors.push(String(error)); } }
    try { await browser.close(); report.browserClosed = true; } catch (error) { errors.push(String(error)); }
    if (!report.contextClosed || !report.browserClosed) report.status = 'failed-cleanup';
    report.finishedAtUtc = new Date().toISOString(); report.sourceAfter = sourceFingerprints();
    if (JSON.stringify(report.sourceAfter) !== JSON.stringify(report.sourceBefore)) { report.status = 'source-changed-during-run'; }
    atomicJson(join(options.out, 'browser-report.json'), report);
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2), value = (key: string) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
  if (args.includes('--help')) { console.log('node --import tsx scripts/qa-final-scenes.ts --manifest|--cpu|--browser [--remaining|--all|--ids V01,S01] [--out qa/new-run] [--url http://127.0.0.1:4173/ --build-id ID --portable-sha256 SHA --channel chrome] [--allow-development] [--headless]\nDefault: manifest only, all25. CPU/browser default: 12 priority scenes; --remaining selects13, --all selects25. Browser is explicit with Web build-id guard; production O02 separately requires portable SHA256. P01 short100-switch flow and O01/O02 execute only when selected in browser mode. Original30min never runs; physical devices/upgrade rollback remain separate.'); return; }
  const modes = ['--manifest', '--cpu', '--browser'].filter(mode => args.includes(mode)); assert.ok(modes.length <= 1, 'Choose one mode'); const mode = modes[0] ?? '--manifest';
  const scopes = ['--remaining', '--all', '--ids'].filter(scope => args.includes(scope)); assert.ok(scopes.length <= 1, 'Choose only one scene selector');
  const ids = value('--ids')?.split(',').map(id => id.trim()).filter(Boolean) ?? (args.includes('--remaining') ? [...REMAINING_SCENE_IDS] : args.includes('--all') || mode === '--manifest' ? undefined : [...PRIORITY_SCENE_IDS]);
  if (mode === '--browser') { assert.ok(value('--url'), '--browser requires explicit --url'); assert.ok(value('--build-id') || args.includes('--allow-development'), 'Require --build-id or explicitly labelled --allow-development'); }
  const manifest = createFinalSceneManifest(ids);
  const out = resolve(ROOT, value('--out') ?? `qa/final-scenes-prep/${new Date().toISOString().replace(/[-:.]/g, '')}`);
  assert.ok(!existsSync(out), `Preserve prior evidence: output directory already exists (${out})`); mkdirSync(out, { recursive: true });
  atomicJson(join(out, 'scene-manifest.json'), manifest);
  writeFileSync(join(out, 'driver-source.ts'), bytes('scripts/qa-final-scenes.ts'));
  atomicJson(join(out, 'driver-source.json'), { path: 'scripts/qa-final-scenes.ts', sha256: sha(bytes('scripts/qa-final-scenes.ts')), mode, args, manifestSha256: sha(readFileSync(join(out, 'scene-manifest.json'))) });
  if (mode === '--cpu') {
    atomicJson(join(out, 'artifact-preflight.json'), inspectLocalArtifactIdentities(value('--build-id'), value('--portable-sha256')));
    const results = runFinalSceneCpu(manifest), sourceAfter = sourceFingerprints(), sourceChanged = JSON.stringify(sourceAfter) !== JSON.stringify(manifest.sourceFingerprints);
    for (const result of results.filter(r => ['S08', 'S09'].includes(r.id))) {
      const setup = result.checks.find(c => c.name === 'All four original solar setup UTCs saved');
      if (setup?.status === 'passed-check') atomicJson(join(out, `${result.id}-derived-times.json`), setup.value);
      if (result.id === 'S09') {
        const record = result.checks.find(c => c.name === 'All original four quarter events vs fixed USNO');
        if (record?.status === 'passed-check') atomicJson(join(out, 'S09-derived-times.json'), { kind: 'actual-core-derived-lunar-quarters-with-independent-reference', rows: record.value, scope: record.scope });
      }
    }
    atomicJson(join(out, 'cpu-report.json'), { schemaVersion: 1, kind: 'final-scene-cpu-input-and-invariant-checks', measuredAtUtc: new Date().toISOString(), manifestSha256: sha(readFileSync(join(out, 'scene-manifest.json'))), scenes: results,
      sourceBefore: manifest.sourceFingerprints, sourceAfter,
      status: sourceChanged ? 'source-changed-during-run' : results.some(r => r.checks.some(c => c.status === 'failed-check')) ? 'failed-checks-retained' : 'completed-cpu-checks-with-open-observations', limitations: manifest.limitations });
    if (sourceChanged || results.some(r => r.checks.some(c => c.status === 'failed-check'))) process.exitCode = 1;
  } else if (mode === '--browser') {
    const report = await runFinalSceneBrowser(manifest, { url: value('--url')!, buildId: value('--build-id'), portableSha256: value('--portable-sha256'), allowDevelopment: args.includes('--allow-development'), channel: value('--channel') ?? 'chrome', headless: args.includes('--headless'), out });
    if (!report.status.startsWith('completed-')) process.exitCode = 1;
  }
  console.log(JSON.stringify({ mode, out, sourceScenes: manifest.source.sceneCount, originalAssertions: manifest.source.assertionCount, selectedScenes: manifest.scenes.map(s => s.id), browserExecuted: mode === '--browser' }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
