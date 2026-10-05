import type { SimulationState } from '../../src/contracts';
import { dateToUt } from '../../src/core/time';

/** Complete state fixture independent from UI defaults. */
export function scienceState(utc = '2026-09-14T14:00:00Z', latitude = 30.25, longitude = 120.17): SimulationState {
  const camera = { kind: 'external' as const, orientationQuaternion: [0, 0, 0, 1] as const, distanceDisplayUnits: 4, verticalFovDeg: 50, referenceLock: 'inertial' as const };
  return {
    schemaVersion: 1,
    time: { utDaysJ2000: dateToUt(new Date(utc)), rateSimSecondsPerRealSecond: 1, running: false, mode: 'simulation', calendar: 'proleptic-gregorian', eraNumbering: 'astronomical' },
    observer: { name: '杭州教学预设', latitudeDeg: latitude, longitudeDegEast: longitude, heightMeters: 20, displayZone: { kind: 'fixed', offsetMinutes: 480 } },
    viewMode: 'ground', presentation: 'explanation', density: 'teaching', selected: null,
    layers: { constellationLines: true, constellationLabels: true, brightStarNamesZh: true, secondaryNames: false, milkyWay: false, sunMoon: true, ecliptic: true, celestialEquator: true, celestialPoles: true, horizon: true, meridian: true, atmosphere: false, terrain: true, earthDay: true, earthNightLights: true, earthClouds: true, backHemisphere: false },
    environment: { artificialSkyBrightness: 0, darkSkyLimitingMagnitude: 6.5, refraction: 'none', moonlightEnabled: true, pressureHpa: 1010, temperatureC: 10 },
    cameras: { ground: { kind: 'ground', azimuthDegNorthEast: 0, altitudeDeg: 25, verticalFovDeg: 65 }, space: { ...camera }, globe: { ...camera }, horizon: { ...camera } },
    illustration: { bodySizeScale: 1, distanceCompressed: false },
  };
}
