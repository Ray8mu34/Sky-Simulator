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
  { id: 'birthday', title: '生日天空示例' },
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
  V01: { topic: 'diurnal', description: '杭州固定朝北视野。加载时暂停；播放或步进时间，恒星日周位置由当地恒星时更新，相机不自动追星。', variants: ['V01', 'T01'] },
  V02: { topic: 'earth-sun', description: '从地球外观察真实太阳方向产生的昼夜分界。日景、夜灯、云层和大气可分别开关；天球与地球的显示尺寸不表示恒星距离。', variants: ['V02'] },
  V03: { topic: 'ecliptic', description: '外部天球为方向模型。与黄道场景对比，辨认天赤道、黄道与天极；球壳半径不是恒星距离。', variants: ['V03', 'T08'] },
  V04: { topic: 'latitude', description: '杭州的天顶与地轴方向分离。切换南北纬对比，观察当地地平和可见天极的变化；参考系切换不改变UTC。', variants: ['V04', 'T02', 'T03'] },
  S05: { topic: 'polar', description: '北纬70°六月夏至附近，完整当地日应连续日照。极昼是升落事件状态，不以午夜强制变为黑夜。', variants: polarVariants },
  S06: { topic: 'polar', description: '北纬70°十二月冬至附近全天无日出，但中午仍可能有晨昏光；不把极夜全部称为天文黑夜。', variants: polarVariants },
  S07: { topic: 'polar', description: '同一十二月日期改为南纬70°，南半球处于夏季极昼；与北纬70°同日对照。', variants: polarVariants },
  S09: { topic: 'moon-phase', description: '使用2026-09-01 UTC明确种子搜索四个相邻月相事件，再跳转实际UT。月相来自日月观察者几何，照亮比例不是农历日期。', variants: ['S09'] },
  S16: { topic: 'moon-phase', description: '与月相教学配套比较农历民用日期：本地固定历表采用UTC+8日界，独立于所在地显示时区及月面照亮比例。', variants: ['S16', 'S09'] },
};

const definitions: readonly Definition[] = [
  ...acceptanceScenes.map(scene => ({
    id: scene.id, title: scene.title, ...legacyNotes[scene.id],
    source: 'acceptance-input' as const,
    sourceNote: '复用原04验收包固定输入；是可复现场景，不代表原视频的已知拍摄时间或验收已通过。',
    create: () => loadAcceptanceScene(scene.id),
  })),
  ...skyTeachingScenes.map(scene => ({
    id: scene.id, title: scene.title, topic: 'light-pollution' as const,
    description: '同一杭州夜空、同一视野，太阳与月球在几何地平下；三个预设仅人工天空亮度为0、0.5、1，用于定性比较暗夜、郊外与城市。',
    source: 'm3-input' as const,
    sourceNote: '复用M3新增G场景固定输入；滑条是视觉示意，不能当作SQM、Bortle等级或当地实测天气。',
    variants: pollutionVariants, create: () => loadSkyTeachingScene(scene.id),
  })),
  {
    id: 'T01', title: '日周运动：固定地平参考', topic: 'diurnal',
    description: '杭州地平锁定天球，显示天极、天赤道与子午圈。播放或步进观察恒星绕天极的日周变化，比较地平锁定与惯性锁定，再比较太阳日与恒星日。',
    source: 'm4b-derived', sourceNote: '从V04完整状态派生的教学示例；时间、地点与参考系均可修改。',
    variants: ['T01', 'V01'], create: () => derive('V04', state => { state.layers.celestialEquator = true; }),
  },
  {
    id: 'T02', title: '南北纬对比：北纬30°', topic: 'latitude',
    description: '同一UTC、同一经度与显示时区的北纬30°示例，北天极约高30°，南天极在地平下；与南纬30°对照。',
    source: 'm4b-derived', sourceNote: '从V04派生的假想地理对比点，经度0°、显示时区固定UTC；不是政治时区推断。',
    variants: ['T02', 'T03'], create: () => latitudePreset(30),
  },
  {
    id: 'T03', title: '南北纬对比：南纬30°', topic: 'latitude',
    description: '保持UTC、经度与时区，改为南纬30°，观察南天极约高30°、北天极在地平下，与北纬30°的可见天空对照。',
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
    description: '杭州当地22:00、同一朝南视野，比较四季可见恒星与太阳周年方向。日期在分至附近，不宣称是精确分至时刻；月光随真实日期自然变化。',
    source: 'm4b-derived' as const, sourceNote: '从V01完整状态派生的固定夜空示例；同地点、固定UTC+8、同相机，不轮播不同星图。',
    variants: seasonVariants, create: () => seasonPreset(utc),
  })),
  {
    id: 'T08', title: '黄道：太阳与天赤道', topic: 'ecliptic',
    description: '十二月冬至附近的太阳位于黄道方向，黄道与天赤道不同面。更改日期后太阳位置由星历更新；太阳位置与显示尺寸分别说明。',
    source: 'm4b-derived', sourceNote: '从V03完整状态派生的方向教学示例；球壳不是太阳或恒星真实距离。',
    variants: ['T08', 'V03'], create: () => derive('V03', state => {
      atUtc(state, '2026-12-21T14:00:00Z');
      state.layers.ecliptic = true; state.layers.celestialEquator = true; state.layers.celestialPoles = true;
      state.selected = 'body:Sun';
    }),
  },
  {
    id: 'B01', title: '生日天空：明确时刻示例', topic: 'birthday',
    description: '示例：2026-09-14，杭州22:00，固定UTC+8。请按需要设置日期、时刻、地点和时区；未提供时刻时，本示例采用22:00。',
    source: 'm4b-derived', sourceNote: '从V01完整状态派生的生日天空输入示例；22:00是明确选择的演示时刻，不是个人出生资料。',
    variants: ['B01'], create: () => derive('V01', () => {}),
  },
];

function describeTimePlace(state: SimulationState): string {
  const observer = state.observer, zone = observer.displayZone;
  const zoneNote = zone.kind === 'fixed'
    ? `固定UTC${zone.offsetMinutes >= 0 ? '+' : ''}${zone.offsetMinutes / 60}`
    : `${zone.name}（${zone.versionNote}）`;
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
