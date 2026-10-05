/**
 * Sky simulator implementation contracts, not a runnable application.
 * All science vectors below are right-handed EQJ/J2000 directions unless named otherwise.
 * Matrix adapters must be tested; do not directly copy Astronomy Engine matrix storage.
 */
export type ViewMode = 'ground' | 'space' | 'globe' | 'horizon';
export type PresentationMode = 'observation' | 'explanation';
export type ViewDensity = 'reference' | 'teaching';
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];
export type SolarBody = 'Sun' | 'Moon' | 'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn';
export type ObjectId = `hip:${number}` | `hyg:${number}` | `body:${SolarBody}` | `constellation:${string}`;

export interface TimeState {
  /** Days from JD 2451545.0 on the adapter's UT1≈UTC convention. Not TT. */
  utDaysJ2000: number;
  rateSimSecondsPerRealSecond: number;
  running: boolean;
  mode: 'realtime' | 'simulation';
  calendar: 'proleptic-gregorian';
  eraNumbering: 'astronomical';
}
export type DisplayZone =
  | { kind: 'fixed'; offsetMinutes: number }
  | { kind: 'iana'; name: string; versionNote: string };
export interface ObserverState {
  name: string;
  latitudeDeg: number;
  longitudeDegEast: number;
  heightMeters: number;
  displayZone: DisplayZone;
}
export interface LayerState {
  constellationLines: boolean;
  constellationLabels: boolean;
  brightStarNamesZh: boolean;
  secondaryNames: boolean;
  milkyWay: boolean;
  sunMoon: boolean;
  ecliptic: boolean;
  celestialEquator: boolean;
  celestialPoles: boolean;
  horizon: boolean;
  meridian: boolean;
  atmosphere: boolean;
  terrain: boolean;
  earthDay: boolean;
  earthNightLights: boolean;
  earthClouds: boolean;
  backHemisphere: boolean;
}
export interface EnvironmentState {
  /** An illustrative slider, NOT a calibrated Bortle class or measured luminance. */
  artificialSkyBrightness: number;
  darkSkyLimitingMagnitude: number;
  refraction: 'none' | 'standard';
  moonlightEnabled: boolean;
  pressureHpa: number;
  temperatureC: number;
}
/** Small paired-snapshot description. LUTs remain process-local and are not cloned per frame. */
export interface RefractionDescriptor {
  readonly definitionVersion: string;
  readonly profileVersion: string;
  readonly mode: 'none' | 'standard';
  readonly pressureHpa: number;
  readonly temperatureC: number;
}
export interface GroundCamera {
  kind: 'ground';
  azimuthDegNorthEast: number;
  altitudeDeg: number;
  verticalFovDeg: number;
}
export interface ExternalCamera {
  kind: 'external';
  /** Orthonormal camera orientation, not a science-frame transform. */
  orientationQuaternion: readonly [number, number, number, number];
  distanceDisplayUnits: number;
  verticalFovDeg: number;
  referenceLock: 'inertial' | 'earth-fixed' | 'local-horizon';
}
export interface SimulationState {
  schemaVersion: 1;
  time: TimeState;
  observer: ObserverState;
  viewMode: ViewMode;
  presentation: PresentationMode;
  density: ViewDensity;
  layers: LayerState;
  environment: EnvironmentState;
  selected: ObjectId | null;
  cameras: {
    ground: GroundCamera;
    space: ExternalCamera;
    globe: ExternalCamera;
    horizon: ExternalCamera;
  };
  /** Display scaling must never be used as a physical distance in science functions. */
  illustration: { bodySizeScale: number; distanceCompressed: boolean };
}
export interface BodySnapshot {
  id: SolarBody;
  geocentricEqjAU: Vec3;
  topocentricDirectionEqj: Vec3;
  raHoursOfDate: number;
  decDegOfDate: number;
  geometricAltitudeDeg: number;
  apparentAltitudeDeg: number;
  azimuthDeg: number | null;
  angularDiameterDeg: number;
  visualMagnitude: number;
  /** Null for self-luminous bodies, such as the Sun. */
  illuminatedFraction: number | null;
  /** Direction at this body; needed for a correctly oriented terminator. */
  /** Null for the Sun itself. */
  bodyToSunEqjUnit: Vec3 | null;
  bodyToObserverEqjUnit: Vec3;
  /** Null until a body-specific orientation model is available. */
  bodyFixedToEqj: Mat3 | null;
}
export interface ScienceSnapshot {
  requestId: number;
  utDaysJ2000: number;
  ttDaysJ2000: number;
  gastHours: number;
  lstHours: number;
  eqjToHorizontalGeometric: Mat3;
  /** True ecliptic/equinox of this snapshot's date → mean EQJ, mathematical row-major. */
  eclipticOfDateToEqj: Mat3;
  readonly observerRefraction: RefractionDescriptor;
  earthFixedToEqj: Mat3;
  localZenithEqjUnit: Vec3;
  bodies: readonly BodySnapshot[];
  warnings: readonly string[];
  accuracyTier: 'modern-validated' | 'extended-exploration' | 'unvalidated';
}
export interface SolarDayEvents {
  dateLocal: string;
  definition: string;
  riseUtDaysJ2000: number | null;
  setUtDaysJ2000: number | null;
  minimumGeometricAltitudeDeg: number;
  maximumGeometricAltitudeDeg: number;
  state: 'normal' | 'continuous-daylight' | 'no-sunrise' | 'grazing' | 'search-incomplete';
  twilightSummary: string;
  /** Real local civil-day boundaries, not an assumed 24h interval. End is exclusive. */
  bounds: { startUtDaysJ2000: number; endUtDaysJ2000: number; displayZone: DisplayZone };
  extremaTimes: { minimumUtDaysJ2000: number; maximumUtDaysJ2000: number };
  /** Upper-limb clearance uses exactly the same radius/refraction convention as rise/set. */
  riseSetClearanceRangeDeg: { minimum: number; maximum: number };
  riseSetCrossings: readonly { kind: 'rise' | 'set'; utDaysJ2000: number }[];
  twilight: { civil: SolarTwilightEvents; nautical: SolarTwilightEvents; astronomical: SolarTwilightEvents };
  noEventReason: string | null;
  notes: readonly string[];
}
export interface SolarTwilightEvents {
  thresholdGeometricAltitudeDeg: -6 | -12 | -18;
  dawnUtDaysJ2000: number | null;
  duskUtDaysJ2000: number | null;
  crossings: readonly { kind: 'dawn' | 'dusk'; utDaysJ2000: number }[];
  state: 'events' | 'always-above' | 'always-below' | 'grazing' | 'search-incomplete';
  noEventReason: string | null;
}
export interface MoonAppearance {
  utDaysJ2000: number;
  perspective: 'topocentric' | 'geocentric';
  phaseNameZh: string;
  /** Geocentric ecliptic longitude Moon−Sun: 0=new,90=first,180=full,270=last. */
  phaseLongitudeDeg: number;
  /** Sun−Moon−observer angle; this is NOT phaseLongitudeDeg. */
  phaseAngleDeg: number;
  phaseNameDefinition: string;
  illuminatedFraction: number;
  angularDiameterDeg: number;
  bodyFixedToEqj: Mat3;
  northEqjUnit: Vec3;
  observerDirectionEqjUnit: Vec3;
  sunDirectionEqjUnit: Vec3;
  /** J2000 sky north through sky east; null for a degenerate projected Sun direction. */
  brightLimbPositionAngleDeg: number | null;
  brightLimbReference: string;
  libration: { longitudeDeg: number; latitudeDeg: number; perspective: 'geocentric' };
  subObserver: { longitudeDegEast: number; latitudeDeg: number };
  subSolar: { longitudeDegEast: number; latitudeDeg: number };
  notes: readonly string[];
}
export interface MoonPhaseSequence {
  seedUtDaysJ2000: number;
  complete: boolean;
  events: readonly { phaseLongitudeDeg: 0 | 90 | 180 | 270; utDaysJ2000: number; labelZh: string }[];
  definition: string;
  notes: readonly string[];
}
export interface AstronomyAdapter {
  readonly engineVersion: string;
  computeSnapshot(state: SimulationState, requestId: number): ScienceSnapshot;
  computeSolarDayEvents(state: SimulationState): SolarDayEvents;
  /** Returns UT days. Input is already disambiguated in the explicitly chosen zone. */
  parseCivilInput(input: CivilInput): number;
}
export interface CivilInput {
  astronomicalYear: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  zone: DisplayZone;
  ambiguousTime: 'reject' | 'earlier' | 'later';
}
export interface ViewAdapter {
  readonly mode: ViewMode;
  enter(state: SimulationState): void;
  applySnapshot(snapshot: ScienceSnapshot): void;
  resize(cssWidth: number, cssHeight: number): void;
  leave(): void;
  /** Shared assets are released by their owner, not blindly by every view. */
  dispose(): void;
}
export interface RuntimeMetrics {
  samplingWindowSeconds: number;
  frameMs: { p50: number; p95: number; p99: number };
  drawCallsPerFrame: number;
  visibleLabelCount: number;
  pendingLatestRequestCount: number;
  textureCount: number;
  geometryCount: number;
  appOwnedGpuBytesEstimate: number;
  /** Null when the measurement API or relevant instrumentation is unavailable. */
  mainThreadJsHeapBytes: number | null;
  workerHeapBytes: number | null;
  measurementNotes: readonly string[];
}
