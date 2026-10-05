/** Recompute a local validation report; this script uses no network. */
import { readFileSync, writeFileSync } from 'node:fs';
import { computeSnapshot } from '../src/core/astronomy';
import { compareFixedDeltaT } from '../src/core/diagnostics';
import { angularSeparationDeg, raDecToVector } from '../src/core/math';
import { scienceState } from '../tests/fixtures/science-state';

const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/horizons-sun-moon.json', import.meta.url), 'utf8'));
const rows = fixture.rows.map((row: { body: string; utc: string; raHoursOfDate: number; decDegOfDate: number; altitudeDeg: number; angularDiameterDeg: number; illuminatedFraction: number | null }) => {
  const snapshot = computeSnapshot(scienceState(row.utc), 0);
  const body = snapshot.bodies.find(body => body.id === row.body)!;
  return {
    body: row.body, utc: row.utc, referenceAltitudeDeg: row.altitudeDeg, aboveFiveDegrees: row.altitudeDeg > 5,
    directionErrorArcmin: angularSeparationDeg(raDecToVector(body.raHoursOfDate, body.decDegOfDate), raDecToVector(row.raHoursOfDate, row.decDegOfDate)) * 60,
    altitudeErrorArcmin: Math.abs(body.geometricAltitudeDeg - row.altitudeDeg) * 60,
    diameterErrorDeg: Math.abs(body.angularDiameterDeg - row.angularDiameterDeg),
    illuminatedFractionError: row.illuminatedFraction === null ? null : Math.abs(body.illuminatedFraction! - row.illuminatedFraction),
    engineDeltaTSeconds: (snapshot.ttDaysJ2000 - snapshot.utDaysJ2000) * 86400,
  };
});
const reference = fixture.rows.find((row: { body: string; utc: string }) => row.body === 'Moon' && row.utc.startsWith('2100'));
const comparison = compareFixedDeltaT(scienceState(reference.utc), 69.184);
const alignedMoon = comparison.aligned.bodies.find(body => body.id === 'Moon')!;
const packageVersion = JSON.parse(readFileSync(new URL('../node_modules/astronomy-engine/package.json', import.meta.url), 'utf8')).version;
const report = {
  generatedAtUtc: new Date().toISOString(), engineVersion: packageVersion,
  environment: { node: process.version, icu: process.versions.icu, tz: process.versions.tz, intlDefaultZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  references: fixture.responses.map((response: { body: string; sha256: string }) => ({ body: response.body, rawSha256: response.sha256 })),
  coverage: { allPoints: rows.length, aboveFiveDegreesPoints: rows.filter((row: { aboveFiveDegrees: boolean }) => row.aboveFiveDegrees).length,
    claim: 'Limited local regression points and analytic invariants; not full modern-range validation.' },
  deltaTDiagnostic: { utc: reference.utc, horizonsAssumedTtMinusUtcSeconds: 69.184,
    productionDirectionErrorArcmin: rows.find((row: { body: string; utc: string }) => row.body === 'Moon' && row.utc.startsWith('2100')).directionErrorArcmin,
    alignedDirectionErrorArcmin: angularSeparationDeg(raDecToVector(alignedMoon.raHoursOfDate, alignedMoon.decDegOfDate), raDecToVector(reference.raHoursOfDate, reference.decDegOfDate)) * 60,
    productionModelRestored: JSON.stringify(computeSnapshot(scienceState(reference.utc), 0)) === JSON.stringify(comparison.production) },
  rows,
};
writeFileSync(new URL('../tests/fixtures/science-validation-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
