import type { SimulationState } from './contracts';
import { dateToUt, formatCivil } from './core/time';
import {
  acceptanceScenes, loadAcceptanceScene, loadSkyTeachingScene, parseState,
  skyTeachingScenes, StateValidationError,
} from './state';
import type { AcceptanceSceneId, SkyTeachingSceneId } from './state';

export type TeachingPresetId = AcceptanceSceneId | SkyTeachingSceneId
  | 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'B01';
export type TeachingPresetTopic = 'diurnal' | 'latitude' | 'polar' | 'season'
  | 'earth-sun' | 'moon-phase' | 'ecliptic' | 'light-pollution' | 'birthday';
export interface TeachingPresetMetadata {
  readonly id: TeachingPresetId;
  readonly title: string;
  readonly topic: TeachingPresetTopic;
  readonly description: string;
  readonly source: 'acceptance-input' | 'm3-input' | 'm4b-derived';
  readonly sourceNote: string;
  /** Explicit initial civil time, chosen zone and geographic position. */
  readonly timePlaceNote: string;
  /** Related fixed presets; these IDs do not run an animation or change the clock. */
  readonly variants: readonly TeachingPresetId[];
  /** Only S09 has the original, explicit quarter-event search seed. */
  readonly moonPhaseSeedUtDaysJ2000: number | null;
}

export const teachingPresetTopics: readonly Readonly<{ id: TeachingPresetTopic; title: string }>[] = Object.freeze([
  { id: 'diurnal', title: '日周运动' }, { id: 'latitude', title: '南北纬对比' },
  { id: 'polar', title: '极昼极夜' }, { id: 'season', title: '季节星空' },
  { id: 'earth-sun', title: '日地关系' }, { id: 'moon-phase', title: '月相' },
  { id: 'ecliptic', title: '黄道' }, { id: 'light-pollution', title: '光污染' },
  { id: 'birthday', title: '生日星空' },
].map(topic => Object.freeze(topic) as Readonly<{ id: TeachingPresetTopic; title: string }>));

type Definition = Omit<TeachingPresetMetadata, 'timePlaceNote' | 'moonPhaseSeedUtDaysJ2000'> & {
  create: () => SimulationState;
};
const polarVariants: readonly TeachingPresetId[] = ['S05', 'S06', 'S07'];
const seasonVariants: readonly TeachingPresetId[] = ['T04', 'T05', 'T06', 'T07'];
const pollutionVariants: readonly TeachingPresetId[] = ['G01', 'G02', 'G03'];

/** Derive from the existing versioned complete state, never a parallel defaults object. */
function derive(base: AcceptanceSceneId, change: (state: SimulationState) => void): SimulationState {
  const state = loadAcceptanceScene(base);
  state.density = 'teaching';
  change(state);
  return state;
}
function atUtc(state: SimulationState, utc: string): void {
  state.time.utDaysJ2000 = dateToUt(new Date(utc));
}
function latitudePreset(latitudeDeg: number): SimulationState {
  return derive('V04', state => {
    atUtc(state, '2026-09-23T22:00:00Z');
    state.observer = {
      name: `${latitudeDeg > 0 ? '北' : '南'}纬30°对比点`, latitudeDeg,
      longitudeDegEast: 0, heightMeters: 0, displayZone: { kind: 'fixed', offsetMinutes: 0 },
    };
    state.layers.celestialEquator = true;
    state.cameras.ground.azimuthDegNorthEast = latitudeDeg > 0 ? 0 : 180;
    state.cameras.ground.altitudeDeg = 30;
  });
}
function seasonPreset(utc: string): SimulationState {
  return derive('V01', state => {
    atUtc(state, utc);
    state.presentation = 'observation';
    state.cameras.ground = {
      kind: 'ground', azimuthDegNorthEast: 180, altitudeDeg: 45, verticalFovDeg: 85,
    };
  });
}

const legacyNotes: Record<AcceptanceSceneId, {
  topic: TeachingPresetTopic; description: string; variants: readonly TeachingPresetId[];
}> = {
  V01: { topic: 'diurnal', description: '朝向杭州的北方天空，播放时间，观察恒星绕北天极转动。', variants: ['V01', 'T01'] },
  V02: { topic: 'earth-sun', description: '从太空观察地球的昼夜分界，切换日景、夜灯和云层。', variants: ['V02'] },
  V03: { topic: 'ecliptic', description: '从外部观察天球，辨认天赤道、黄道与南北天极。', variants: ['V03', 'T08'] },
  V04: { topic: 'latitude', description: '对比南北纬，观察地平线、天顶和可见天极的变化。', variants: ['V04', 'T02', 'T03'] },
  S05: { topic: 'polar', description: '北纬70°的夏至前后，观察太阳整日停留在地平线上方。', variants: polarVariants },
  S06: { topic: 'polar', description: '北纬70°的冬至前后，太阳整日位于地平线下，中午仍可见暮光。', variants: polarVariants },
  S07: { topic: 'polar', description: '将同一天的地点切换到南纬70°，对比南北半球的极昼与极夜。', variants: polarVariants },
  S09: { topic: 'moon-phase', description: '查看新月、上弦、满月和下弦的时刻，跳转观察月面变化。', variants: ['S09'] },
  S16: { topic: 'moon-phase', description: '对照农历日期与月相变化。农历按北京时间显示。', variants: ['S16', 'S09'] },
};

const definitions: readonly Definition[] = [
  ...acceptanceScenes.map(scene => ({
    id: scene.id, title: ({ V01: '杭州北方夜空', V02: '太空中的地球', V03: '天球与星座', V04: '地平线与天极', S05: '北极圈极昼', S06: '北极圈极夜', S07: '南北半球的极昼极夜', S09: '四种月相', S16: '农历与月相' })[scene.id], ...legacyNotes[scene.id],
    source: 'acceptance-input' as const,
    sourceNote: '复用原04验收包固定输入；是可复现场景，不代表原视频的已知拍摄时间或验收已通过。',
    create: () => loadAcceptanceScene(scene.id),
  })),
  ...skyTeachingScenes.map(scene => ({
    id: scene.id, title: scene.title.replace(/^新增 · /, '').replace('示例', '星空'), topic: 'light-pollution' as const,
    description: '对比同一片夜空在暗夜、郊外和城市中的变化，寻找逐渐隐去的暗星与银河。',
    source: 'm3-input' as const,
    sourceNote: '复用M3新增G场景固定输入；滑条是视觉示意，不能当作SQM、Bortle等级或当地实测天气。',
    variants: pollutionVariants, create: () => loadSkyTeachingScene(scene.id),
  })),
  {
    id: 'T01', title: '日周运动：固定地平参考', topic: 'diurnal',
    description: '播放时间，观察恒星绕天极转动；切换参考系，对比地球自转与星空运动。',
    source: 'm4b-derived', sourceNote: '从V04完整状态派生的教学示例；时间、地点与参考系均可修改。',
    variants: ['T01', 'V01'], create: () => derive('V04', state => { state.layers.celestialEquator = true; }),
  },
  {
    id: 'T02', title: '南北纬对比：北纬30°', topic: 'latitude',
    description: '北纬30°，北天极高约30°。与南纬30°对照，观察可见天空的差异。',
    source: 'm4b-derived', sourceNote: '从V04派生的假想地理对比点，经度0°、显示时区固定UTC；不是政治时区推断。',
    variants: ['T02', 'T03'], create: () => latitudePreset(30),
  },
  {
    id: 'T03', title: '南北纬对比：南纬30°', topic: 'latitude',
    description: '南纬30°，南天极高约30°。与北纬30°对照，观察可见天空的差异。',
    source: 'm4b-derived', sourceNote: '从V04派生的假想地理对比点，经度0°、显示时区固定UTC；不是政治时区推断。',
    variants: ['T02', 'T03'], create: () => latitudePreset(-30),
  },
  ...([
    ['T04', '春季夜空', '2026-03-20T14:00:00Z'],
    ['T05', '夏季夜空', '2026-06-21T14:00:00Z'],
    ['T06', '秋季夜空', '2026-09-23T14:00:00Z'],
    ['T07', '冬季夜空', '2026-12-21T14:00:00Z'],
  ] as const).map(([id, title, utc]) => ({
    id, title: `季节比较：${title}`, topic: 'season' as const,
    description: '在杭州晚上22:00朝南观看，对比春夏秋冬的星座与银河。',
    source: 'm4b-derived' as const, sourceNote: '从V01完整状态派生的固定夜空示例；同地点、固定UTC+8、同相机，不轮播不同星图。',
    variants: seasonVariants, create: () => seasonPreset(utc),
  })),
  {
    id: 'T08', title: '黄道：太阳与天赤道', topic: 'ecliptic',
    description: '观察冬至前后的太阳位置，比较黄道与天赤道的夹角。更改日期，追踪太阳的周年运动。',
    source: 'm4b-derived', sourceNote: '从V03完整状态派生的方向教学示例；球壳不是太阳或恒星真实距离。',
    variants: ['T08', 'V03'], create: () => derive('V03', state => {
      atUtc(state, '2026-12-21T14:00:00Z');
      state.layers.ecliptic = true; state.layers.celestialEquator = true; state.layers.celestialPoles = true;
      state.selected = 'body:Sun';
    }),
  },
  {
    id: 'B01', title: '生日星空', topic: 'birthday',
    description: '选择生日、时间和地点，重现那一刻的星空。初始时间为杭州晚上22:00。',
    source: 'm4b-derived', sourceNote: '从V01完整状态派生的生日天空输入示例；22:00是明确选择的演示时刻，不是个人出生资料。',
    variants: ['B01'], create: () => derive('V01', () => {}),
  },
];

function describeTimePlace(state: SimulationState): string {
  const observer = state.observer, zone = observer.displayZone;
  const zoneNote = zone.kind === 'fixed'
    ? `固定UTC${zone.offsetMinutes >= 0 ? '+' : ''}${zone.offsetMinutes / 60}`
    : zone.name;
  return `${formatCivil(state.time.utDaysJ2000, zone)}，${zoneNote}；${observer.name}，纬度${observer.latitudeDeg}°、东经${observer.longitudeDegEast}°、海拔${observer.heightMeters}米`;
}

/** Metadata contains no persistent SimulationState or mutable camera objects. */
export const teachingPresets: readonly TeachingPresetMetadata[] = Object.freeze(definitions.map(({ create, ...metadata }) => {
  const state = create();
  return Object.freeze({
    ...metadata, variants: Object.freeze([...metadata.variants]), timePlaceNote: describeTimePlace(state),
    moonPhaseSeedUtDaysJ2000: acceptanceScenes.find(scene => scene.id === metadata.id)?.moonPhaseSeedUtDaysJ2000 ?? null,
  });
}));
const metadataById = new Map(teachingPresets.map(preset => [preset.id, preset]));
const definitionById = new Map(definitions.map(preset => [preset.id, preset]));

export function getPreset(id: string): TeachingPresetMetadata | null {
  return metadataById.get(id as TeachingPresetId) ?? null;
}

/** Pure factory: no global state, storage, clock, ephemeris search or playback side effects. */
export function loadPreset(id: TeachingPresetId | string): SimulationState {
  const definition = definitionById.get(id as TeachingPresetId);
  if (!definition) throw new StateValidationError(`未知教学预设：${id}`);
  const state = definition.create();
  state.time.mode = 'simulation';
  state.time.running = false;
  return parseState(state);
}
