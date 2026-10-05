/** Developer-only retrieval; tests never call the network. JPL requests are sequential. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const target = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
await mkdir(target, { recursive: true });
const instants = ['1900-01-01T00:00:00Z', '2000-01-01T12:00:00Z', '2026-09-14T14:00:00Z', '2100-12-31T23:59:59Z'];
const epochs = instants.map(iso => (new Date(iso).getTime() - 946728000000) / 86400000 + 2451545);
const parameters = {
  format: 'json', OBJ_DATA: 'YES', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER',
  CENTER: 'coord@399', COORD_TYPE: 'GEODETIC', SITE_COORD: '120.17,30.25,0.02',
  TLIST: epochs.join(','), TLIST_TYPE: 'JD', TIME_TYPE: 'UT',
  QUANTITIES: '2,4,10,13,20', REF_SYSTEM: 'ICRF', CAL_TYPE: 'GREGORIAN',
  CAL_FORMAT: 'BOTH', ANG_FORMAT: 'DEG', APPARENT: 'AIRLESS',
  RANGE_UNITS: 'AU', TIME_DIGITS: 'SECONDS', EXTRA_PREC: 'YES', CSV_FORMAT: 'YES',
};
const fixture = {
  schemaVersion: 1,
  source: 'JPL Horizons observer ephemeris API',
  documentation: 'https://ssd-api.jpl.nasa.gov/doc/horizons.html',
  manual: 'https://ssd.jpl.nasa.gov/horizons/manual.html',
  retrievedAtUtc: new Date().toISOString(),
  observer: { name: '杭州教学预设', latitudeDeg: 30.25, longitudeDegEast: 120.17, heightMeters: 20 },
  conventions: {
    time: 'UT output: UTC from 1962 onward, UT1 before 1962; adapter uses UT1≈UTC. Gregorian calendar explicitly pinned.',
    angles: 'Q2 apparent topocentric RA/Dec: true equator/equinox of date, light-time, aberration and JPL light bending; Q4 azimuth east of north and airless elevation.',
    phase: 'Q10 illuminated fraction; Q13 apparent angular diameter; Q20 light-time-corrected observer distance.',
    differences: 'Astronomy Engine has its own ΔT and approximate ephemerides; no real-time EOP or gravitational light bending. At 2100-12-31 AE default TT−UT≈205.008s whereas Horizons extrapolates last known leap seconds (TT−UTC=69.184s); do not silently replace the production ΔT model. This limited fixture does not certify the entire modern interval.',
  },
  tolerances: { directionDeg: 2 / 60, altitudeDeg: 2 / 60, diameterDeg: 0.0005, illuminatedFraction: 0.002 },
  toleranceBasis: 'Implementation plan §12.1: Sun/Moon ≤2 arcmin at altitude >5°, aligned topocentric apparent/airless conventions. This fixture also probes below-horizon cases; the 1 arcmin stellar criterion is separate.',
  initialProbe: { thresholdArcmin: 1, failure: 'Moon 2100-12-31T23:59:59Z direction=1.3828064179 arcmin; diagnosed ΔT convention mismatch, not hidden by replacing the engine model.' },
  responses: [],
  rows: [],
};
for (const [body, command] of [['Sun', '10'], ['Moon', '301']]) {
  const request = { ...parameters, COMMAND: command };
  const url = new URL('https://ssd.jpl.nasa.gov/api/horizons.api');
  for (const [key, value] of Object.entries(request)) url.searchParams.set(key, key === 'format' ? value : `'${value}'`);
  let result;
  if (process.platform === 'win32') {
    // Use Windows' configured HTTP stack/proxy rather than Node's direct socket route.
    const temporary = `${target}horizons-${body.toLowerCase()}-response.json`;
    await promisify(execFile)('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./fetch-science-http.ps1', import.meta.url)), '-Url', url.toString(), '-Destination', temporary]);
    result = JSON.parse(await readFile(temporary, 'utf8'));
    await unlink(temporary);
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Horizons ${body}: HTTP ${response.status}`);
    result = await response.json();
  }
  if (result.error) throw new Error(`Horizons ${body}: ${result.error}`);
  if (!result.result?.includes('$$SOE')) throw new Error(`Horizons ${body}: no ephemeris table`);
  const raw = result.result;
  const rawName = `horizons-${body.toLowerCase()}.txt`;
  await writeFile(`${target}${rawName}`, raw, 'utf8');
  fixture.responses.push({ body, requestUrl: url.toString(), parameters: request, signature: result.signature,
    rawFile: rawName, sha256: createHash('sha256').update(raw).digest('hex') });
  const table = raw.split('$$SOE')[1].split('$$EOE')[0].trim();
  const rows = table.split(/\r?\n/).filter(Boolean);
  if (rows.length !== instants.length) throw new Error(`Horizons ${body}: unexpected row count ${rows.length}`);
  for (let index = 0; index < rows.length; index++) {
    const fields = rows[index].split(',').map(field => field.trim());
    // Q2 RA/Dec, Q4 AZ/EL, Q10 illum%, Q13 diameter arcsec, Q20 range AU and range-rate.
    const numeric = fields.slice(4).filter(Boolean).map(Number);
    if (numeric.length !== 8 || numeric.some(value => !Number.isFinite(value))) throw new Error(`Unexpected Horizons CSV: ${rows[index]}`);
    fixture.rows.push({ body, utc: instants[index], utDaysJ2000: epochs[index] - 2451545,
      raHoursOfDate: numeric[0] / 15, decDegOfDate: numeric[1], azimuthDeg: numeric[2], altitudeDeg: numeric[3],
      illuminatedFraction: body === 'Sun' ? null : numeric[4] / 100,
      angularDiameterDeg: numeric[5] / 3600, observerDistanceAU: numeric[6] });
  }
  console.log(`${body}: ${rows.length} independent reference rows stored`);
}
await writeFile(`${target}horizons-sun-moon.json`, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log('Fixture: tests/fixtures/horizons-sun-moon.json (offline tests only)');
