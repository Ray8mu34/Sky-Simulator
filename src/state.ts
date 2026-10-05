import type { SimulationState, ViewMode } from './contracts';
import { dateToUt, utToDate } from './core/time';
import acceptanceInput from './ui/acceptance-scenes.json';
import skyTeachingInput from './ui/sky-teaching-scenes.json';
import { EXTERNAL_CAMERA_LIMITS } from './camera-limits';

/** One mutable state is shared by the clock, renderer and controls. */
export function createDefaultState(): SimulationState {
  return {
    schemaVersion: 1,
    time: {
      utDaysJ2000: dateToUt(new Date('2026-09-14T14:00:00Z')),
      rateSimSecondsPerRealSecond: 600,
      running: false,
      mode: 'simulation',
      calendar: 'proleptic-gregorian',
      eraNumbering: 'astronomical',
    },
    observer: {
      name: '杭州教学预设', latitudeDeg: 30.25, longitudeDegEast: 120.17,
      heightMeters: 20, displayZone: { kind: 'fixed', offsetMinutes: 480 },
    },
    viewMode: 'ground', presentation: 'explanation', density: 'teaching',
    layers: {
      constellationLines: true, constellationLabels: true, brightStarNamesZh: true,
      secondaryNames: false, milkyWay: true, sunMoon: true, ecliptic: false,
      celestialEquator: false, celestialPoles: false, horizon: true, meridian: false,
      atmosphere: true, terrain: true, earthDay: true, earthNightLights: true, earthClouds: true,
      backHemisphere: false,
    },
    environment: {
      artificialSkyBrightness: 0, darkSkyLimitingMagnitude: 6.5,
      refraction: 'none', moonlightEnabled: true, pressureHpa: 1013.25,
      temperatureC: 15,
    },
    selected: null,
    cameras: {
      ground: { kind: 'ground', azimuthDegNorthEast: 0, altitudeDeg: 25, verticalFovDeg: 65 },
      space: externalCamera(9.5, 'inertial'),
      globe: externalCamera(3.1, 'inertial'),
      horizon: {
        ...externalCamera(3.1, 'local-horizon'),
        orientationQuaternion: [-0.25881904510252074, 0, 0, 0.9659258262890683],
      },
    },
    illustration: { bodySizeScale: 1, distanceCompressed: false },
  };
}

function externalCamera(distance: number, lock: 'inertial' | 'earth-fixed' | 'local-horizon') {
  return {
    kind: 'external' as const, orientationQuaternion: [0, 0, 0, 1] as const,
    distanceDisplayUnits: distance, verticalFovDeg: 45, referenceLock: lock,
  };
}

export class StateValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'StateValidationError'; }
}

type Dict = Record<string, unknown>;
function record(value: unknown, path: string): Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StateValidationError(`${path} 必须是对象。`);
  }
  return value as Dict;
}
function number(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new StateValidationError(`${path} 必须是 ${min} 至 ${max} 的${integer ? '整数' : '有限数值'}。`);
  }
  return value;
}
function oneOf(value: unknown, path: string, values: readonly unknown[]): void {
  if (!values.includes(value)) throw new StateValidationError(`${path} 的值不受支持。`);
}
function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new StateValidationError(`${path} 必须是布尔值。`);
}
function string(value: unknown, path: string, maxLength = 120): void {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new StateValidationError(`${path} 必须是非空文字，最多 ${maxLength} 字符。`);
  }
}
function fields(value: Dict, required: readonly string[], path: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new StateValidationError(`${path}.${key} 缺失。`);
  for (const key of Object.keys(value)) if (!required.includes(key)) throw new StateValidationError(`${path}.${key} 是当前版本不支持的字段。`);
}

/** Validate the entire contract before applying any imported field. No silent clamping. */
export function validateState(value: unknown): asserts value is SimulationState {
  const root = record(value, '场景');
  fields(root, ['schemaVersion', 'time', 'observer', 'viewMode', 'presentation', 'density', 'layers', 'environment', 'selected', 'cameras', 'illustration'], '场景');
  if (root.schemaVersion !== 1) throw new StateValidationError('场景版本不受支持；本版本只接受 schemaVersion 1。');
  const time = record(root.time, 'time');
  fields(time, ['utDaysJ2000', 'rateSimSecondsPerRealSecond', 'running', 'mode', 'calendar', 'eraNumbering'], 'time');
  const ut = number(time.utDaysJ2000, 'time.utDaysJ2000', -1500000, 1500000);
  const year = utToDate(ut).getUTCFullYear();
  number(year, 'UTC 年份', -2000, 4000, true);
  number(time.rateSimSecondsPerRealSecond, 'time.rateSimSecondsPerRealSecond', -86400, 86400);
  boolean(time.running, 'time.running');
  oneOf(time.mode, 'time.mode', ['realtime', 'simulation']);
  oneOf(time.calendar, 'time.calendar', ['proleptic-gregorian']);
  oneOf(time.eraNumbering, 'time.eraNumbering', ['astronomical']);
  const observer = record(root.observer, 'observer');
  fields(observer, ['name', 'latitudeDeg', 'longitudeDegEast', 'heightMeters', 'displayZone'], 'observer');
  string(observer.name, 'observer.name');
  number(observer.latitudeDeg, '纬度', -90, 90);
  number(observer.longitudeDegEast, '东经', -180, 180);
  number(observer.heightMeters, '海拔 / m', -500, 100000);
  const zone = record(observer.displayZone, 'observer.displayZone');
  oneOf(zone.kind, 'displayZone.kind', ['fixed', 'iana']);
  if (zone.kind === 'fixed') {
    fields(zone, ['kind', 'offsetMinutes'], 'displayZone');
    number(zone.offsetMinutes, '时区偏移 / min', -840, 840, true);
  } else {
    fields(zone, ['kind', 'name', 'versionNote'], 'displayZone');
    string(zone.name, '时区名称'); string(zone.versionNote, '时区规则版本', 500);
    try { new Intl.DateTimeFormat('en', { timeZone: zone.name as string }).format(); }
    catch { throw new StateValidationError('IANA 时区名称无效或当前浏览器不支持。'); }
  }
  oneOf(root.viewMode, 'viewMode', ['ground', 'space', 'globe', 'horizon']);
  oneOf(root.presentation, 'presentation', ['observation', 'explanation']);
  oneOf(root.density, 'density', ['reference', 'teaching']);
  const layers = record(root.layers, 'layers');
  const layerNames = ['constellationLines', 'constellationLabels', 'brightStarNamesZh', 'secondaryNames', 'milkyWay', 'sunMoon', 'ecliptic', 'celestialEquator', 'celestialPoles', 'horizon', 'meridian', 'atmosphere', 'terrain', 'earthDay', 'earthNightLights', 'earthClouds', 'backHemisphere'];
  fields(layers, layerNames, 'layers');
  for (const name of layerNames) boolean(layers[name], `layers.${name}`);
  const environment = record(root.environment, 'environment');
  fields(environment, ['artificialSkyBrightness', 'darkSkyLimitingMagnitude', 'refraction', 'moonlightEnabled', 'pressureHpa', 'temperatureC'], 'environment');
  number(environment.artificialSkyBrightness, '示意天空亮度', 0, 1);
  number(environment.darkSkyLimitingMagnitude, '暗空极限星等', -2, 12);
  oneOf(environment.refraction, 'refraction', ['none', 'standard']);
  boolean(environment.moonlightEnabled, 'moonlightEnabled');
  number(environment.pressureHpa, '气压 / hPa', 0, 1200);
  number(environment.temperatureC, '温度 / °C', -100, 80);
  if (root.selected !== null && (typeof root.selected !== 'string' || !/^(?:(?:hip|hyg):[1-9]\d*|body:(?:Sun|Moon|Mercury|Venus|Mars|Jupiter|Saturn)|constellation:[A-Za-z][A-Za-z0-9_-]{0,29})$/.test(root.selected))) {
    throw new StateValidationError('selected 不是可识别的天体或星座标识符。');
  }
  const cameras = record(root.cameras, 'cameras');
  fields(cameras, ['ground', 'space', 'globe', 'horizon'], 'cameras');
  const ground = record(cameras.ground, 'cameras.ground');
  fields(ground, ['kind', 'azimuthDegNorthEast', 'altitudeDeg', 'verticalFovDeg'], 'cameras.ground');
  oneOf(ground.kind, 'ground.kind', ['ground']);
  number(ground.azimuthDegNorthEast, '地表方位 / °', 0, 360);
  number(ground.altitudeDeg, '地表高度 / °', -90, 90);
  number(ground.verticalFovDeg, '地表视场 / °', 20, 100);
  for (const mode of ['space', 'globe', 'horizon'] as const) {
    const camera = record(cameras[mode], `cameras.${mode}`);
    fields(camera, ['kind', 'orientationQuaternion', 'distanceDisplayUnits', 'verticalFovDeg', 'referenceLock'], `cameras.${mode}`);
    oneOf(camera.kind, `${mode}.kind`, ['external']);
    const quaternion = camera.orientationQuaternion;
    if (!Array.isArray(quaternion) || quaternion.length !== 4) throw new StateValidationError(`${mode} 相机四元数需要四个数值。`);
    quaternion.forEach((v, i) => number(v, `${mode}.quaternion[${i}]`, -1, 1));
    if (Math.abs(Math.hypot(...quaternion) - 1) > 0.001) throw new StateValidationError(`${mode} 相机四元数必须归一化。`);
    const limits = EXTERNAL_CAMERA_LIMITS[mode];
    number(camera.distanceDisplayUnits, `${mode}.distanceDisplayUnits`, limits.minDistance, limits.maxDistance);
    number(camera.verticalFovDeg, `${mode}.verticalFovDeg`, 20, 100);
    oneOf(camera.referenceLock, `${mode}.referenceLock`, ['inertial', 'earth-fixed', 'local-horizon']);
  }
  const illustration = record(root.illustration, 'illustration');
  fields(illustration, ['bodySizeScale', 'distanceCompressed'], 'illustration');
  number(illustration.bodySizeScale, 'illustration.bodySizeScale', 0.01, 10000);
  boolean(illustration.distanceCompressed, 'illustration.distanceCompressed');
}

export function parseState(input: string | unknown): SimulationState {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (input.length > 100000) throw new StateValidationError('场景文件过大；最大 100 KB。');
    try { value = JSON.parse(input); }
    catch { throw new StateValidationError('场景文件不是有效的 JSON。'); }
  }
  // One explicit schema-1 migration. Never mutate imported objects or coerce explicit values.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const root = value as Dict, layers = root.layers;
    if (root.schemaVersion === 1 && typeof layers === 'object' && layers !== null && !Array.isArray(layers)
      && !Object.hasOwn(layers, 'earthDay')) value = { ...root, layers: { ...layers, earthDay: true } };
  }
  validateState(value);
  return JSON.parse(JSON.stringify(value)) as SimulationState;
}

export function serializeState(state: SimulationState): string {
  validateState(state);
  return JSON.stringify(state, null, 2);
}

/** Preserve the top-level identity used by the renderer and clock. */
export function applyState(target: SimulationState, incoming: unknown): void {
  const validated = parseState(incoming);
  Object.assign(target, validated);
}

export type AcceptanceSceneId = 'V01' | 'V02' | 'V03' | 'V04' | 'S05' | 'S06' | 'S07' | 'S09' | 'S16';
export const acceptanceScenes = acceptanceInput.map((scene) => ({
  id: scene.id as AcceptanceSceneId, title: scene.title,
  moonPhaseSeedUtDaysJ2000: 'timeSelection' in scene && scene.timeSelection?.kind === 'search-four-lunar-quarters' ? dateToUt(new Date(scene.timeSelection.seedUtc)) : null,
}));

/** Inputs are copied from 04; these are reproducible scenes, not claims of passed acceptance. */
export function loadAcceptanceScene(id: AcceptanceSceneId): SimulationState {
  const scene = acceptanceInput.find((entry) => entry.id === id);
  if (!scene) throw new StateValidationError(`未知教学场景：${id}`);
  const next = createDefaultState();
  next.time.utDaysJ2000 = dateToUt(new Date(scene.inputs.time.value));
  next.observer = structuredClone(scene.inputs.observer) as SimulationState['observer'];
  next.viewMode = scene.inputs.viewMode as ViewMode;
  next.presentation = scene.inputs.presentation as SimulationState['presentation'];
  next.density = scene.inputs.density as SimulationState['density'];
  next.cameras.ground = structuredClone(scene.inputs.groundCamera) as SimulationState['cameras']['ground'];
  if (id === 'V02') next.cameras.space.distanceDisplayUnits = 5;
  if (id === 'V04') {
    next.layers.celestialPoles = true;
    next.layers.meridian = true;
  }
  validateState(next);
  return next;
}

export type SkyTeachingSceneId = 'G01' | 'G02' | 'G03';
export const skyTeachingScenes = skyTeachingInput.scenes.map(scene => ({ id: scene.id as SkyTeachingSceneId, title: scene.title }));

/** New reproducible teaching inputs, explicitly separate from the original acceptance bundle. */
export function loadSkyTeachingScene(id: SkyTeachingSceneId): SimulationState {
  const scene = skyTeachingInput.scenes.find(entry => entry.id === id);
  if (!scene) throw new StateValidationError(`未知银河教学场景：${id}`);
  const baseline = skyTeachingInput.baseline;
  const next = createDefaultState();
  next.time.utDaysJ2000 = dateToUt(new Date(baseline.utc));
  next.observer = structuredClone(baseline.observer) as SimulationState['observer'];
  next.cameras.ground = structuredClone(baseline.groundCamera) as SimulationState['cameras']['ground'];
  next.viewMode = baseline.viewMode as ViewMode;
  next.presentation = baseline.presentation as SimulationState['presentation'];
  next.layers.atmosphere = baseline.atmosphere;
  next.layers.milkyWay = baseline.milkyWay;
  next.environment.moonlightEnabled = baseline.moonlightEnabled;
  next.environment.darkSkyLimitingMagnitude = baseline.darkSkyLimitingMagnitude;
  next.environment.artificialSkyBrightness = scene.artificialSkyBrightness;
  validateState(next);
  return next;
}
