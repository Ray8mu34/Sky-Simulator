/** Offline M3 evidence report. Wall-clock measurement does not feed astronomical calculations. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { computeSnapshot } from '../src/core/astronomy';
import { brightLimbPositionAngle, computeMoonAppearance, computeMoonQuarterSequence } from '../src/core/moon';
import { computeSolarDayEvents, solarDaySteps } from '../src/core/solar-events';
import { createSolarDayService } from '../src/core/teaching';
import { dateToUt, parseCivilInput, utToDate } from '../src/core/time';
import { normalize } from '../src/core/math';
import { scienceState } from '../tests/fixtures/science-state';

const nasa = JSON.parse(readFileSync(new URL('../tests/fixtures/nasa-moon-2026-09-01.json', import.meta.url), 'utf8'));
const snap = computeSnapshot(scienceState(`${nasa.time}:00Z`), 0);
const appearance = computeMoonAppearance(snap, 'geocentric')!;
const moon = snap.bodies.find(body => body.id === 'Moon')!;
const phaseStart = performance.now();
const sequence = computeMoonQuarterSequence(dateToUt(new Date('2026-09-01T00:00:00Z')));
const phaseMs = performance.now() - phaseStart;
const samples = [
  { name: 'Hangzhou', state: scienceState('2026-09-14T14:00:00Z') },
  { name: '70N summer', state: scienceState('2026-06-21T12:00:00Z', 70, 0) },
  { name: '70N winter', state: scienceState('2026-12-21T12:00:00Z', 70, 0) },
  { name: 'year -2000', state: scienceState('-002000-06-21T12:00:00Z', 30, 120) },
  { name: 'year 4000', state: scienceState('4000-12-31T12:00:00Z', 30, 120) },
];
const eventSamples = samples.map(({ name, state }) => {
  state.observer.heightMeters = 0; state.observer.displayZone = { kind: 'fixed', offsetMinutes: name === 'Hangzhou' ? 480 : 0 };
  const start = performance.now(), events = computeSolarDayEvents(state), totalMs = performance.now() - start;
  const steps = solarDaySteps(state); let chunks = 0, largestChunkMs = 0;
  for (;;) { const begin = performance.now(), result = steps.next(); largestChunkMs = Math.max(largestChunkMs, performance.now() - begin); chunks++; if (result.done) break; }
  return { name, totalMs, largestChunkMs, chunks, state: events.state, min: events.minimumGeometricAltitudeDeg, max: events.maximumGeometricAltitudeDeg };
});
const hangzhouPath = new URL('../tests/fixtures/usno-hangzhou-2026-09-14.json', import.meta.url);
const raw = readFileSync(hangzhouPath);
const ordinary = computeSolarDayEvents(samples[0]!.state);
const usno = JSON.parse(raw.toString('utf8'));
const ordinaryFields: Record<string, number | null> = { Rise: ordinary.riseUtDaysJ2000, Set: ordinary.setUtDaysJ2000,
  'Begin Civil Twilight': ordinary.twilight.civil.dawnUtDaysJ2000, 'End Civil Twilight': ordinary.twilight.civil.duskUtDaysJ2000 };
const ordinaryErrors = usno.properties.data.sundata.filter((row: { phen: string }) => row.phen in ordinaryFields).map((row: { phen: string; time: string }) => {
  const [hour, minute] = row.time.split(':').map(Number);
  const referenceUt = parseCivilInput({ astronomicalYear: 2026, month: 9, day: 14, hour: hour!, minute: minute!, second: 0, zone: { kind: 'fixed', offsetMinutes: 480 }, ambiguousTime: 'reject' });
  return { event: row.phen, sourceLocalTime: row.time, actualUtc: utToDate(ordinaryFields[row.phen]!).toISOString(), errorSeconds: (ordinaryFields[row.phen]! - referenceUt) * 86400 };
});
const phaseReference = JSON.parse(readFileSync(new URL('../tests/fixtures/usno-phase-2026-09-web-capture.json', import.meta.url), 'utf8'));
const quarterErrors = sequence.events.map((event, index) => {
  const row = phaseReference.phasedata[index];
  const referenceUt = dateToUt(new Date(`${row.year}-${String(row.month).padStart(2, '0')}-${String(row.day).padStart(2, '0')}T${row.time}:00Z`));
  return { labelZh: event.labelZh, actualUtc: utToDate(event.utDaysJ2000).toISOString(), errorSeconds: (event.utDaysJ2000 - referenceUt) * 86400 };
});
writeFileSync(new URL('../tests/fixtures/usno-hangzhou-2026-09-14.metadata.json', import.meta.url), `${JSON.stringify({
  sourceUrl: 'https://aa.usno.navy.mil/api/rstt/oneday?date=2026-09-14&coords=30.25,120.17&tz=8&dst=false',
  retrievedAtUtc: statSync(hangzhouPath).mtime.toISOString(), rawFile: 'usno-hangzhou-2026-09-14.json', sha256: createHash('sha256').update(raw).digest('hex'),
  acquisition: 'Original HTTP response saved by PowerShell Invoke-WebRequest with normal certificate validation.',
  definition: 'USNO geometric solar centre −50 arcmin (nominal 16 arcmin radius +34 arcmin refraction); civil centre −6deg. Sea-level reference; minute rounding.',
}, null, 2)}\n`);
const report = { generatedAtUtc: new Date().toISOString(), engineVersion: '2.1.19', environment: { node: process.version, icu: process.versions.icu, tz: process.versions.tz },
  nasaGeocentricComparison: { returnedTime: nasa.time, actual: appearance, polePositionAngleDeg: brightLimbPositionAngle(normalize(moon.geocentricEqjAU), appearance.northEqjUnit), reference: {
    illuminatedFraction: nasa.phase / 100, subObserver: { longitudeDegEast: nasa.subearth_lon, latitudeDeg: nasa.subearth_lat }, subSolar: { longitudeDegEast: nasa.subsolar_lon, latitudeDeg: nasa.subsolar_lat }, angularDiameterDeg: nasa.diameter / 3600, polePositionAngleDeg: nasa.posangle } },
  quarterSequence: sequence, quarterSequenceCostMs: phaseMs, quarterErrors, ordinarySolarErrors: ordinaryErrors, eventSamples,
  cacheInitial: createSolarDayService({ maxEntries: 16 }).diagnostics(),
  note: 'Finite local probes on this Node runtime, not browser/hardware performance certification; neither 30-minute acceptance nor full-modern-range validation.',
};
writeFileSync(new URL('../tests/fixtures/science-m3-validation-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
