import type { LayerState, ObjectId, RuntimeMetrics, ScienceSnapshot, SimulationState, ViewMode } from '../contracts';
import { dateToUt, localCivilParts } from '../core/time';
import { applyState, parseState, serializeState } from '../state';
import { catalog } from '../data/catalog';
import { searchObjects } from '../data/search';
import type { ObjectSearchResult } from '../data/search';
import { resolveObjectDetails } from '../core/object-details';
import type { TeachingData } from '../core/teaching';
import { mountTeachingControls } from './teaching-controls';
import type { MoonLoupeInfo } from './teaching-controls';
import { mountAppearanceControls } from './appearance-controls';
import type { SkyAppearance } from '../core/sky-appearance';
import type { GraphicsStatus } from '../platform/renderer-port';
import type { OfflineStatus } from '../platform/offline-status';
import { mountTimeControls } from './time-controls';
import { mountSceneControls } from './scene-controls';
import { trackFormDraft } from './form-draft';
import { mountObjectDayControls } from './object-day-controls';
import { hasMatchingRefraction, mountRefractionControls } from './refraction-controls';
import type { ShareResult } from './scene-controls';
export type { ShareResult } from './scene-controls';
import '../style.css';

const MOBILE_CONTROLS_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 600px)';
const cities = [
  { name: '杭州', latitudeDeg: 30.25, longitudeDegEast: 120.17, heightMeters: 20 },
  { name: '北京', latitudeDeg: 39.90, longitudeDegEast: 116.40, heightMeters: 44 },
  { name: '赤道 · 0°经线', latitudeDeg: 0, longitudeDegEast: 0, heightMeters: 0 },
  { name: '悉尼', latitudeDeg: -33.87, longitudeDegEast: 151.21, heightMeters: 58 },
  { name: '北极', latitudeDeg: 90, longitudeDegEast: 0, heightMeters: 0 },
  { name: '南极', latitudeDeg: -90, longitudeDegEast: 0, heightMeters: 0 },
];
const viewNames: Record<ViewMode, string> = { ground: '地表', space: '太空', globe: '天球', horizon: '地平天球' };
// Updated only when the corresponding renderer has actually shipped.
let availableViews: readonly ViewMode[] = ['ground', 'space'];
export function setAvailableViews(views: readonly ViewMode[]): void { availableViews = [...views]; }

type LayerDefinition = { key: keyof LayerState; label: string; tip: string; views?: readonly ViewMode[]; advanced?: boolean };
const layerDefinitions: readonly LayerDefinition[] = [
  { key: 'constellationLines', label: '星座连线', tip: '来自固定星文化版本的方向连线，不表示恒星间的物理连接。' },
  { key: 'constellationLabels', label: '星座名称', tip: '星座名称与连线锚点；背面与被遮挡标签由渲染器筛选。' },
  { key: 'brightStarNamesZh', label: '恒星中文名', tip: '经稳定星表编号对应的常用亮星中文名。' },
  { key: 'sunMoon', label: '太阳 / 月球', tip: '地表为站心，外部视图为地心；日月角径来自同一快照。' },
  { key: 'milkyWay', label: '银河', tip: '静态J2000银河背景，与恒星共用方向变换；扩展年代不模拟银河自身演化。' },
  { key: 'atmosphere', label: '大气', tip: '太阳高度驱动的天空明暗与地球薄大气近似，不是天气预报。' },
  { key: 'terrain', label: '地景', tip: '当地水平系的示意地面，不是真实地形。', views: ['ground'] },
  { key: 'earthClouds', label: '云层', tip: '静态云层纹理，不是实时云图。', views: ['space', 'globe', 'horizon'] },
  { key: 'earthDay', label: '地球日景', tip: '静态日景贴图；关闭保留受光球体，云层、夜灯与大气独立。', views: ['space', 'globe', 'horizon'] },
  { key: 'earthNightLights', label: '夜景灯光', tip: '静态地球夜灯，只在背光区域显示。', views: ['space', 'globe', 'horizon'] },
  { key: 'secondaryNames', label: '外文名称', tip: '外文名称增加标签密度；教学演示建议按需打开。', advanced: true },
  { key: 'ecliptic', label: '黄道', tip: '太阳周年视运动的参考大圆，不是地球赤道。', advanced: true },
  { key: 'celestialEquator', label: '天赤道', tip: '地球赤道在天球上的投影。', advanced: true },
  { key: 'celestialPoles', label: '天极 / 地轴', tip: '地球自转轴方向。当地天顶只有在极点才与天极重合。', advanced: true },
  { key: 'horizon', label: '地平参考', tip: '垂直当地天顶的平面；方位北0°、东90°。', advanced: true },
  { key: 'meridian', label: '子午圈', tip: '通过南北方向、天顶与天极的参考大圆。', advanced: true },
  { key: 'backHemisphere', label: '背面半球', tip: '显示远侧半球星点与细线；远侧文字仍需要遮挡控制。', views: ['globe', 'horizon'], advanced: true },
];

function layerHtml(layer: LayerDefinition): string {
  return `<label class="layer-toggle" data-layer-row="${layer.key}" title="${layer.tip}"><input type="checkbox" data-layer="${layer.key}"><span>${layer.label}</span></label>`;
}
function pad(n: number): string { return String(n).padStart(2, '0'); }
function yearText(n: number): string { return n < 0 ? `-${String(-n).padStart(4, '0')}` : String(n).padStart(4, '0'); }
function degrees(n: number | undefined): string { return n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}°`; }
function bytes(n: number | null | undefined): string { return n == null ? '未测' : `${(n / 1048576).toFixed(1)} MiB`; }

export interface Controls {
  update(snapshot: ScienceSnapshot, metrics?: Partial<RuntimeMetrics>, teaching?: TeachingData): void;
  syncPlayback(): void;
  updateSkyAppearance(appearance: SkyAppearance): void;
  invalidateSkyAppearance(): void;
  setGraphicsStatus(status: GraphicsStatus): void;
  setOfflineStatus(status: OfflineStatus): void;
  showShareResult(result: ShareResult): void;
  rememberCurrentScene(name?: string): void;
  isObjectDayVisible(): boolean;
  isTeachingVisible(): boolean;
  getMoonLoupeViewport(): DOMRect | null;
  setMoonLoupeAvailability(status: 'pending' | 'ready' | 'error', message?: string, info?: MoonLoupeInfo): void;
  dispose(): void;
}

/** UI changes state; the owner computes science and controls the sole simulation clock. */
export function mountControls(container: HTMLElement, state: SimulationState, onChange: (reason?: string) => void): Controls {
  container.innerHTML = `
    <div class="controls-compact" aria-label="夜空快捷控制">
      <button class="controls-drawer-toggle compact-time" type="button" data-action="open-time" aria-expanded="false" aria-controls="sky-control-panel" aria-label="打开时间与完整设置"><span class="compact-clock"></span><small class="compact-zone"></small></button>
      <button class="compact-play" type="button" data-action="compact-play" aria-label="快捷播放或暂停">播放</button>
      <button class="compact-reset" type="button" data-action="reset" aria-label="恢复当前场景起点并暂停">复位</button>
      <select id="sky-compact-view" aria-label="快捷视角">${availableViews.map((mode) => `<option value="${mode}">${viewNames[mode]}</option>`).join('')}</select>
      <button id="sky-compact-graphics" type="button" data-action="open-graphics" aria-label="2D方位图模式与三维重试" hidden>2D方位</button>
      <button class="compact-search" type="button" data-action="open-search" aria-label="打开天体搜索">搜索</button>
      <span class="compact-mode-note"></span>
    </div>
    <aside id="sky-control-panel" class="sky-control-panel" aria-label="夜空教学控制">
      <header class="panel-header"><span>三维全景夜空 <small id="sky-graphics-mode">3D</small></span><button type="button" data-action="close" aria-label="收起控制面板" title="收起控制面板">‹</button></header>
      <div class="panel-scroll">
        <section class="control-section">
          <div id="sky-graphics-notice" role="status" aria-live="polite" hidden><p class="graphics-message tiny-note"></p><p class="graphics-boundary tiny-note"></p><button id="sky-retry-3d" type="button" data-action="retry-3d">重试三维</button></div>
          <div class="view-switch" role="group" aria-label="视角">${availableViews.map((mode) => `<button type="button" data-view="${mode}">${viewNames[mode]}</button>`).join('')}</div>
          <div class="presentation-row"><label for="sky-presentation">显示</label><select id="sky-presentation"><option value="observation">观察模式</option><option value="explanation">原理模式</option></select><select id="sky-density" aria-label="界面密度"><option value="teaching">教学</option><option value="reference">参考</option></select></div>
          <div class="reference-lock-row" hidden><label for="sky-reference-lock">参考系</label><select id="sky-reference-lock" aria-label="外部视角参考系"></select></div>
          <p class="mode-note" aria-live="polite"></p>
        </section>
        <section class="control-section object-section" aria-label="搜索与选中对象">
          <form id="sky-search-form" role="search"><input id="sky-search" type="search" autocomplete="off" placeholder="搜索 · 名称 / HIP" aria-label="搜索恒星、星座、太阳或月球" aria-controls="sky-search-results" aria-expanded="false"></form>
          <div id="sky-search-results" class="search-results" role="listbox" aria-label="搜索结果" hidden></div><p class="search-empty tiny-note" hidden>未找到匹配对象。</p>
          <div class="selected-object" hidden>
            <div class="object-heading"><strong class="object-label"></strong><button type="button" data-action="clear-selection" aria-label="取消选择">×</button></div>
            <p class="object-epoch tiny-note"></p>
            <dl class="object-coordinates"><dt>RA</dt><dd class="object-ra"></dd><dt>Dec</dt><dd class="object-dec"></dd><dt title="地点站心几何高度">几何高</dt><dd class="object-alt"></dd><dt title="地点站心视高度，所选折射近似">视高度</dt><dd class="object-apparent-alt"></dd><dt>方位</dt><dd class="object-az"></dd></dl><p class="object-observer-scope tiny-note" hidden></p>
            <p class="object-magnitude tiny-note"></p><p class="object-visibility tiny-note"></p>
            <div class="object-actions"><button type="button" data-action="focus-selection" title="定位到可见区域；地表地景仍可能遮挡低于地平的对象" aria-label="定位到可见区域">定位</button><details class="object-notes-details"><summary>说明</summary><p class="object-notes tiny-note"></p></details></div>
          </div>
        </section>
        <section class="control-section time-section"></section>
        <section class="control-section observer-section">
          <div class="section-heading"><h2>观测地点</h2><span>东经为正</span></div>
          <select id="sky-city" aria-label="地点预设">${cities.map((city, i) => `<option value="${i}">${city.name}</option>`).join('')}<option value="custom">自定义</option></select>
          <p class="tiny-note city-zone-policy">城市只换地点；显示时区由时间栏设置。</p>
          <details class="custom-observer"><summary>经纬度 / 海拔</summary><form id="sky-observer-form" class="observer-form"><label for="sky-latitude">纬度 °</label><input id="sky-latitude" type="number" min="-90" max="90" step="any" required><label for="sky-longitude">东经 °</label><input id="sky-longitude" type="number" min="-180" max="180" step="any" required><label for="sky-height">海拔 m</label><input id="sky-height" type="number" min="-500" max="100000" step="any" required><button type="submit">应用地点</button></form><p class="tiny-note">地点与时区分别设置。</p></details>
          <div class="body-readouts"><span class="sun-readout">太阳 几何 — · 视高度 —</span><span class="moon-readout">月球 几何 — · 视高度 —</span><span class="phase-readout">月面照亮 —</span></div>
        </section>
        <details class="control-section layer-section" open><summary>显示图层</summary><p id="sky-layer-capabilities" class="tiny-note" hidden>2D中灰色图层不可用；方位与地平边界固定显示。</p><div class="layer-grid">${layerDefinitions.filter((layer) => !layer.advanced).map(layerHtml).join('')}</div><details class="advanced-layers"><summary>参考线 / 名称</summary><div class="layer-grid">${layerDefinitions.filter((layer) => layer.advanced).map(layerHtml).join('')}</div><p class="tiny-note">连线是方向图样；云层与灯光为静态素材。</p></details></details>
        <details class="control-section scene-section"></details>
        <details class="control-section performance-section"><summary>运行数据</summary><dl class="metrics"><dt>帧间隔 p50 / p95 / p99</dt><dd class="metric-frame">未测</dd><dt>绘制 / 标签 / 待处理</dt><dd class="metric-calls">未测</dd><dt>纹理 / 几何</dt><dd class="metric-resources">未测</dd><dt>应用 GPU 估算</dt><dd class="metric-gpu">未测</dd><dt>主线程 / Worker 堆</dt><dd class="metric-heap">未测</dd></dl><p class="metric-notes tiny-note">浏览器与驱动内存另计。</p></details>
        <details class="control-section help-section"><summary>操作与科学口径</summary><p class="gesture-help">拖动调整视线，滚轮缩放。</p><p>时间、地点和图层在视角间共用；切换视角保留各自相机。控件区可上下滚动，触摸不会转动天空。</p><p>方位从北向东增加。几何高度不含折射，视高度使用所选近似；两者都是观测地点读数。外部三视图保持几何方向，近地平现场大气可能与近似显著不同。</p><p>天文纪年 0 是公元前1年，−1 是公元前2年。使用前推格里高利历；范围 −2000 至 +4000，扩展年代仅作近似探索。</p><p>天球半径是方向模型，太阳标记表示方向；显示比例不用于科学距离。</p></details>
        <p class="science-notice tiny-note" aria-live="polite"></p><p class="ui-message" role="status" aria-live="polite" hidden></p>
      </div>
      <footer class="panel-footer"><span class="playback-status">已暂停</span><button type="button" data-action="reset" title="恢复当前场景起点并暂停">复位</button><button type="button" data-action="pause">暂停</button></footer>
    </aside><p id="sky-offline-notice" class="offline-notice" data-sky-occlusion role="status" hidden></p>`;

  const panel = container.querySelector<HTMLElement>('.sky-control-panel')!;
  const drawer = container.querySelector<HTMLButtonElement>('.controls-drawer-toggle')!;
  const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
  const select = (id: string) => container.querySelector<HTMLSelectElement>(`#${id}`)!;
  const text = (selector: string, value: string) => { const el = container.querySelector<HTMLElement>(selector)!; if (el.textContent !== value) el.textContent = value; };
  const listeners: Array<() => void> = [];
  const listen = (element: EventTarget, event: string, handler: EventListener) => { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); };
  let disposed = false;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshot: ScienceSnapshot | undefined;
  let searchResults: ObjectSearchResult[] = [];
  let activeSearchIndex = -1;
  let referenceSignature = '';
  let graphicsStatus: GraphicsStatus | undefined;
  let offlineSignature = '';
  const observerDraft = trackFormDraft(container.querySelector<HTMLFormElement>('#sky-observer-form')!);
  const teachingControls = mountTeachingControls(container.querySelector<HTMLElement>('.observer-section')!, state, reason => { if (reason === 'time-event') timeControls.cancelSession(true); change(reason ?? 'teaching'); }, () => { if (window.matchMedia(MOBILE_CONTROLS_QUERY).matches) setDrawer(false); });
  const appearanceControls = mountAppearanceControls(container.querySelector<HTMLElement>('.layer-section')!, state, (reason) => change(reason ?? 'environment-appearance'));
  const refractionControls = mountRefractionControls(container.querySelector<HTMLElement>('.layer-section')!, state, change);
  const timeControls = mountTimeControls(container.querySelector<HTMLElement>('.time-section')!, state, change, (value) => message(value, true));
  const objectDayControls = mountObjectDayControls(container.querySelector<HTMLElement>('.selected-object')!, state, ut => {
    applyState(state, { ...state, time: { ...state.time, utDaysJ2000: ut, running: false, mode: 'simulation' } });
    timeControls.cancelSession(true); change('time-event');
  });
  const sceneControls = mountSceneControls(container.querySelector<HTMLElement>('.scene-section')!, state, (reason, seed) => { observerDraft.clear(); refractionControls.clearDraft(); teachingControls.setMoonPhaseSeed(seed); timeControls.cancelSession(true); closeSearch(); change(reason); });

  function message(value: string, error = false) {
    if (disposed) return;
    const el = container.querySelector<HTMLElement>('.ui-message')!;
    el.textContent = value; el.hidden = !value; el.classList.toggle('is-error', error);
    if (messageTimer) clearTimeout(messageTimer);
    if (!error && value) messageTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }
  function change(reason: string) {
    message('');
    const explicitScienceChange = reason.startsWith('time') || reason === 'observer' || reason === 'import';
    const clockChangedUt = reason === 'clock' && lastSnapshot?.utDaysJ2000 !== state.time.utDaysJ2000;
    if (reason === 'environment-refraction') refractionControls.invalidate();
    if (reason === 'selection' || explicitScienceChange || reason === 'display-zone' || clockChangedUt) objectDayControls.invalidate();
    if (explicitScienceChange) { teachingControls.invalidate(); appearanceControls.invalidate(); }
    else if (reason === 'display-zone') teachingControls.invalidate();
    if (explicitScienceChange || reason === 'environment-refraction' || clockChangedUt) lastSnapshot = undefined;
    sync(reason !== 'selection');
    if (reason === 'selection') objectDayControls.notifyVisibility(true);
    onChange(reason);
  }
  function tryAction(action: () => void) { try { action(); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } }
  function setDrawer(open: boolean) { container.classList.toggle('drawer-open', open); container.classList.toggle('controls-collapsed', !open); drawer.setAttribute('aria-expanded', String(open)); drawer.setAttribute('aria-label', open ? '收起完整设置' : '打开时间与完整设置'); window.dispatchEvent(new CustomEvent('sky:teaching-visibility', { detail: { visible: teachingControls.isVisible() } })); objectDayControls.notifyVisibility(true); window.dispatchEvent(new CustomEvent('sky:layout-change')); }
  function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) { if (document.activeElement !== el && el.value !== value) el.value = value; }
  function closeSearch() {
    container.querySelector<HTMLElement>('#sky-search-results')!.hidden = true;
    container.querySelector<HTMLElement>('.search-empty')!.hidden = true;
    input('sky-search').setAttribute('aria-expanded', 'false');
    input('sky-search').removeAttribute('aria-activedescendant');
    activeSearchIndex = -1;
  }
  function selectObject(id: ObjectId) { state.selected = id; closeSearch(); change('selection'); }
  function renderSearch() {
    const query = input('sky-search').value.trim();
    const results = container.querySelector<HTMLElement>('#sky-search-results')!;
    searchResults = query ? searchObjects(catalog, query, 12).slice(0, 12) : [];
    activeSearchIndex = -1; input('sky-search').removeAttribute('aria-activedescendant');
    results.replaceChildren();
    for (const [index, result] of searchResults.entries()) {
      const button = document.createElement('button');
      button.type = 'button'; button.id = `sky-result-${index}`;
      button.dataset.objectId = result.id; button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      const label = document.createElement('span'); label.textContent = result.label;
      const secondary = document.createElement('small'); secondary.textContent = result.secondary;
      button.append(label, secondary); results.append(button);
    }
    results.hidden = searchResults.length === 0;
    container.querySelector<HTMLElement>('.search-empty')!.hidden = !query || searchResults.length !== 0;
    input('sky-search').setAttribute('aria-expanded', String(searchResults.length > 0));
  }
  function updateSelection() {
    const object = container.querySelector<HTMLElement>('.selected-object')!;
    object.hidden = state.selected === null;
    if (state.selected === null) return;
    const pairedSnapshot = hasMatchingRefraction(lastSnapshot, state.environment) ? lastSnapshot : undefined;
    const details = pairedSnapshot ? resolveObjectDetails(catalog, state.selected, pairedSnapshot) : null;
    text('.object-label', details?.label ?? state.selected);
    const focus = container.querySelector<HTMLButtonElement>('[data-action="focus-selection"]')!;
    focus.textContent = graphicsStatus?.capabilities.observerOverview ? '标示' : '定位';
    focus.title = graphicsStatus?.capabilities.observerOverview ? '在固定方位图中标示；当前显示地平以下不标示。' : '定位到可见区域；地表地景仍可能遮挡视高度低于地平的对象';
    focus.setAttribute('aria-label', graphicsStatus?.capabilities.observerOverview ? '在方位图中标示选中对象' : '定位到可见区域');
    focus.disabled = details === null || graphicsStatus?.available === false;
    text('.object-epoch', details?.coordinateEpochLabel ?? (pairedSnapshot ? '当前数据中没有该对象的坐标。' : '正在更新天体读数…'));
    text('.object-ra', details?.raHours != null && Number.isFinite(details.raHours) ? `${details.raHours.toFixed(3)}h` : details ? '—（无定义）' : '—');
    text('.object-dec', details ? degrees(details.decDeg) : '—');
    text('.object-alt', details ? degrees(details.geometricAltitudeDeg) : '—');
    text('.object-apparent-alt', details ? degrees(details.apparentAltitudeDeg) : '—');
    text('.object-az', details?.azimuthDeg == null ? details ? '—（无定义）' : '—' : degrees(details.azimuthDeg));
    const kind = details?.kind === 'star' ? '恒星' : details?.kind === 'constellation' ? '星座方向锚点' : details?.kind === 'body' ? '太阳系天体' : pairedSnapshot ? '未识别对象' : '读数待更新';
    text('.object-magnitude', `${kind} · ${details?.magnitude == null ? '星等不适用 / 缺失' : `星等 ${details.magnitude.toFixed(2)}`}`);
    text('.object-visibility', details ? `${details.visibilityText}；非升落预报` : pairedSnapshot ? '不推测未知对象的位置。' : '天体读数正在更新。');
    const observerScope = container.querySelector<HTMLElement>('.object-observer-scope')!;
    observerScope.hidden = state.viewMode === 'ground' || !!graphicsStatus?.capabilities.observerOverview;
    observerScope.textContent = details?.kind === 'body' ? '高度是地点站心读数；外部日月图形为地心几何方向。' : '高度是观测地点读数；外部图形保持几何方向。';
    const notes = [...(details?.notes ?? [])];
    if (details?.kind === 'body' && state.viewMode !== 'ground' && !graphicsStatus?.capabilities.observerOverview) notes.push('外部日月为地心方向；Alt/Az为观测地点站心。');
    if (details?.kind === 'body' && graphicsStatus?.capabilities.observerOverview) notes.push('2D日月仅为站心方向标记，不表示真实角径或月面。');
    text('.object-notes', notes.join('；'));
    container.querySelector<HTMLElement>('.object-notes-details')!.hidden = notes.length === 0;
  }
  function updateReferenceLock() {
    const row = container.querySelector<HTMLElement>('.reference-lock-row')!;
    row.hidden = state.viewMode === 'ground' || graphicsStatus?.capabilities.referenceLock === false || graphicsStatus?.available === false;
    if (state.viewMode === 'ground' || graphicsStatus?.capabilities.referenceLock === false || graphicsStatus?.available === false) return;
    const current = state.cameras[state.viewMode].referenceLock;
    const signature = `${state.viewMode}:${current}`;
    const control = select('sky-reference-lock');
    if (signature !== referenceSignature) {
      referenceSignature = signature;
      const labels = { inertial: '惯性锁定', 'earth-fixed': '随地球', 'local-horizon': '地平锁定' };
      const supported = state.viewMode === 'horizon' ? ['inertial', 'local-horizon'] as const : ['inertial', 'earth-fixed'] as const;
      control.replaceChildren();
      for (const lock of supported) control.add(new Option(labels[lock], lock));
      if (![...control.options].some((option) => option.value === current)) control.add(new Option(`${labels[current]}（载入值）`, current));
    }
    setValue(control, current);
  }
  function sync(notifyObjectVisibility = true) {
    panel.dataset.density = state.density;
    document.documentElement.dataset.density = state.density;
    timeControls.sync();
    setValue(select('sky-compact-view'), state.viewMode);
    const absRate = Math.abs(state.time.rateSimSecondsPerRealSecond);
    const rate = select('sky-rate');
    if (![...rate.options].some((option) => Number(option.value) === absRate)) rate.add(new Option(`${absRate}×`, String(absRate)));
    setValue(rate, String(absRate)); setValue(select('sky-presentation'), state.presentation); setValue(select('sky-density'), state.density);
    const cityIndex = cities.findIndex((city) => Math.abs(city.latitudeDeg - state.observer.latitudeDeg) < 0.000001 && Math.abs(city.longitudeDegEast - state.observer.longitudeDegEast) < 0.000001 && city.heightMeters === state.observer.heightMeters);
    setValue(select('sky-city'), cityIndex === -1 ? 'custom' : String(cityIndex));
    if (!observerDraft.isDirty()) { input('sky-latitude').value = String(state.observer.latitudeDeg); input('sky-longitude').value = String(state.observer.longitudeDegEast); input('sky-height').value = String(state.observer.heightMeters); }
    for (const el of container.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      el.setAttribute('aria-pressed', String(el.dataset.view === state.viewMode));
      el.disabled = graphicsStatus?.available === false || !!graphicsStatus && !graphicsStatus.capabilities.supportedViews.includes(el.dataset.view as ViewMode);
    }
    const overview = graphicsStatus?.capabilities.observerOverview ?? false;
    const unavailable = graphicsStatus?.available === false;
    container.querySelector<HTMLElement>('.view-switch')!.hidden = overview || unavailable;
    select('sky-compact-view').hidden = overview || unavailable;
    select('sky-compact-view').disabled = overview || unavailable;
    container.querySelector<HTMLElement>('#sky-compact-graphics')!.hidden = !overview && !unavailable;
    text('#sky-compact-graphics', unavailable ? '绘图' : '2D方位');
    container.querySelector<HTMLElement>('#sky-layer-capabilities')!.hidden = !overview;
    text('#sky-graphics-mode', unavailable ? '不可用' : graphicsStatus?.kind === 'canvas2d' ? '2D' : '3D');
    const graphicsNotice = container.querySelector<HTMLElement>('#sky-graphics-notice')!;
    graphicsNotice.hidden = !overview && !unavailable;
    text('.graphics-message', overview || unavailable ? graphicsStatus?.message || '三维模式不可用，已切换2D方位总览。' : '');
    text('.graphics-boundary', overview ? '全天方位图 · 北上东左；日月仅方向标记，无银河、月面或地球图层。' : '');
    container.querySelector<HTMLButtonElement>('#sky-retry-3d')!.disabled = !graphicsStatus?.retry3dAvailable;
    text('#sky-retry-3d', graphicsStatus?.contextLost ? '等待三维恢复' : '重试三维');
    text('.gesture-help', overview ? '全天方位图固定朝向：北上东左。点击可选择；不拖动或缩放相机。' : '单指转向／轨道旋转，双指缩放；鼠标拖动与滚轮亦可。');
    updateReferenceLock();
    for (const layer of layerDefinitions) {
      const control = inputByLayer(layer.key);
      const unsupported = graphicsStatus?.capabilities.unsupportedLayers.includes(layer.key) ?? false;
      control.checked = state.layers[layer.key]; control.disabled = unsupported;
      const row = container.querySelector<HTMLElement>(`[data-layer-row="${layer.key}"]`)!;
      row.hidden = !overview && !!layer.views && !layer.views.includes(state.viewMode);
      row.classList.toggle('is-unavailable', unsupported);
      row.title = unsupported ? '2D方位图不支持此图层；三维模式恢复后可用。' : overview && layer.key === 'sunMoon' ? '日月仅为站心方向符号，固定图示大小，非真实角径或月面。' : layer.tip;
    }
    appearanceControls.sync();
    refractionControls.sync();
    syncPlayback();
    const note = !overview && state.viewMode !== 'ground' ? '几何方向示意：忽略当地可见性' : state.presentation === 'explanation' ? '示意：忽略肉眼可见性' : !state.layers.atmosphere ? '大气关闭：不模拟可见性衰减' : '观察：日光、月光与光污染影响可见性';
    const modeNote = `${overview ? '2D · ' : '3D · '}${note}` + (!overview && state.illustration.bodySizeScale !== 1 ? ` · 日月放大 ${state.illustration.bodySizeScale}×` : '') + (!overview && state.illustration.distanceCompressed ? ' · 距离已压缩' : '');
    text('.mode-note', modeNote);
    text('.compact-mode-note', modeNote);
    if (lastSnapshot) updateScience(lastSnapshot);
    else {
      text('.sun-readout', '太阳 几何 — · 视高度 —'); text('.moon-readout', '月球 几何 — · 视高度 —');
      text('.phase-readout', '月面照亮 —'); text('.lst-readout', '当地恒星时 —'); text('.science-notice', '');
    }
    updateSelection();
    if (notifyObjectVisibility) objectDayControls.notifyVisibility();
  }
  function inputByLayer(key: keyof LayerState): HTMLInputElement { return container.querySelector<HTMLInputElement>(`[data-layer="${key}"]`)!; }
  function syncPlayback() {
    if (disposed) return;
    const absRate = Math.abs(state.time.rateSimSecondsPerRealSecond);
    text('[data-action="play"]', state.time.running ? '暂停' : '播放');
    text('[data-action="compact-play"]', state.time.running ? '暂停' : '播放');
    text('[data-action="reverse"]', state.time.rateSimSecondsPerRealSecond < 0 ? '反向' : '正向');
    container.querySelector('[data-action="realtime"]')!.setAttribute('aria-pressed', String(state.time.mode === 'realtime' && state.time.running));
    const playback = !state.time.running ? '已暂停' : state.time.mode === 'realtime' ? '实时 · 1秒/秒' : `${state.time.rateSimSecondsPerRealSecond < 0 ? '反向' : '正向'} · ${absRate === 86400 ? '1天/秒' : `${absRate}秒/秒`}`;
    text('.playback-status', playback);
  }
  function updateScience(snapshot: ScienceSnapshot) {
    const sun = snapshot.bodies.find((body) => body.id === 'Sun');
    const moon = snapshot.bodies.find((body) => body.id === 'Moon');
    const h = Math.floor(snapshot.lstHours); const m = Math.floor((snapshot.lstHours - h) * 60);
    text('.lst-readout', `当地恒星时 ${pad(h)}时${pad(m)}分`);
    const refractionReady = hasMatchingRefraction(snapshot, state.environment);
    text('.sun-readout', `太阳 几何 ${degrees(refractionReady ? sun?.geometricAltitudeDeg : undefined)} · 视高度 ${degrees(refractionReady ? sun?.apparentAltitudeDeg : undefined)}`);
    text('.moon-readout', `月球 几何 ${degrees(refractionReady ? moon?.geometricAltitudeDeg : undefined)} · 视高度 ${degrees(refractionReady ? moon?.apparentAltitudeDeg : undefined)}`);
    text('.phase-readout', `月面照亮 ${moon?.illuminatedFraction == null ? '—' : `${(moon.illuminatedFraction * 100).toFixed(1)}%`}`);
    const accuracy = snapshot.accuracyTier === 'extended-exploration' ? '扩展年代：长期近似探索' : snapshot.accuracyTier === 'unvalidated' ? '科学计算：未完成独立验证' : '';
    text('.science-notice', [accuracy, ...snapshot.warnings].filter(Boolean).join('；'));
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) listen(container, type, (event) => {
    event.stopPropagation();
  });
  listen(container, 'click', (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    tryAction(() => {
      if (target.dataset.view && graphicsStatus?.capabilities.observerOverview !== true) { state.viewMode = target.dataset.view as ViewMode; change('view'); }
      if (target.dataset.objectId) selectObject(target.dataset.objectId as ObjectId);
      switch (target.dataset.action) {
        case 'close': setDrawer(false); break;
        case 'open-time': { const open = !container.classList.contains('drawer-open'); setDrawer(open); if (open) input('sky-time').focus(); break; }
        case 'open-search': setDrawer(true); input('sky-search').focus(); break;
        case 'open-graphics': setDrawer(true); container.querySelector<HTMLElement>('#sky-graphics-notice')!.scrollIntoView({ block: 'nearest' }); break;
        case 'retry-3d': if (graphicsStatus?.retry3dAvailable) window.dispatchEvent(new CustomEvent('sky:retry-3d')); break;
        case 'clear-selection': state.selected = null; change('selection'); break;
        case 'focus-selection': if (!target.disabled && state.selected) window.dispatchEvent(new CustomEvent('sky:focus-selection')); break;
        case 'pause': state.time.running = false; change('clock'); break;
        case 'compact-play':
        case 'play': state.time.running = !state.time.running; if (state.time.mode === 'realtime' && state.time.running) { state.time.utDaysJ2000 = dateToUt(new Date()); timeControls.cancelSession(true); } change('clock'); break;
        case 'realtime': state.time.utDaysJ2000 = dateToUt(new Date()); state.time.running = true; state.time.mode = 'realtime'; state.time.rateSimSecondsPerRealSecond = 1; timeControls.cancelSession(true); change('clock'); break;
        case 'reverse': state.time.mode = 'simulation'; state.time.rateSimSecondsPerRealSecond = -(state.time.rateSimSecondsPerRealSecond || 1); change('clock'); break;
        case 'reset': sceneControls.reset(); break;
        case 'capture': window.dispatchEvent(new CustomEvent('sky:capture')); break;
        case 'import': input('sky-import-file').click(); break;
        case 'export': {
          const url = URL.createObjectURL(new Blob([serializeState(state)], { type: 'application/json' }));
          const civil = localCivilParts(state.time.utDaysJ2000, state.observer.displayZone);
          const link = document.createElement('a'); link.href = url; link.download = `sky-scene-${yearText(civil.year)}-${pad(civil.month)}-${pad(civil.day)}.json`; link.click(); URL.revokeObjectURL(url); message('已导出完整场景。'); break;
        }
      }
    });
  });
  listen(container.querySelector('#sky-observer-form')!, 'submit', (event) => {
    event.preventDefault(); tryAction(() => {
      const incoming = { ...state, observer: { ...state.observer, name: '自定义地点', latitudeDeg: input('sky-latitude').valueAsNumber, longitudeDegEast: input('sky-longitude').valueAsNumber, heightMeters: input('sky-height').valueAsNumber } };
      applyState(state, incoming); observerDraft.clear(); change('observer');
    });
  });
  listen(container, 'change', (event) => {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    tryAction(() => {
      if (el.dataset.layer && !(el as HTMLInputElement).disabled) { state.layers[el.dataset.layer as keyof LayerState] = (el as HTMLInputElement).checked; change('layers'); }
      if (el.id === 'sky-city') {
        if (el.value === 'custom') { container.querySelector<HTMLDetailsElement>('.custom-observer')!.open = true; input('sky-latitude').focus(); }
        else { state.observer = { ...cities[Number(el.value)]!, displayZone: state.observer.displayZone }; observerDraft.clear(); change('observer'); }
      }
      if (el.id === 'sky-rate') { state.time.rateSimSecondsPerRealSecond = Number(el.value) * (state.time.rateSimSecondsPerRealSecond < 0 ? -1 : 1); state.time.mode = 'simulation'; change('clock'); }
      if (el.id === 'sky-presentation') { state.presentation = el.value as SimulationState['presentation']; change('presentation'); }
      if (el.id === 'sky-density') { state.density = el.value as SimulationState['density']; change('density'); }
      if (el.id === 'sky-compact-view' && graphicsStatus?.capabilities.observerOverview !== true) { state.viewMode = el.value as ViewMode; change('view'); }
      if (el.id === 'sky-reference-lock' && state.viewMode !== 'ground' && graphicsStatus?.capabilities.referenceLock !== false) { state.cameras[state.viewMode].referenceLock = el.value as 'inertial' | 'earth-fixed' | 'local-horizon'; change('reference-lock'); }
    });
  });
  listen(input('sky-search'), 'input', renderSearch);
  listen(container.querySelector('#sky-search-form')!, 'submit', (event) => {
    event.preventDefault();
    if (container.querySelector<HTMLElement>('#sky-search-results')!.hidden) renderSearch();
    const result = searchResults[Math.max(0, activeSearchIndex)];
    if (result) selectObject(result.id);
  });
  listen(input('sky-search'), 'keydown', (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape') { event.preventDefault(); closeSearch(); return; }
    if (keyboard.key !== 'ArrowDown' && keyboard.key !== 'ArrowUp') return;
    event.preventDefault();
    if (container.querySelector<HTMLElement>('#sky-search-results')!.hidden) renderSearch();
    if (!searchResults.length) return;
    activeSearchIndex = activeSearchIndex < 0 ? keyboard.key === 'ArrowDown' ? 0 : searchResults.length - 1 : (activeSearchIndex + (keyboard.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
    for (const [index, button] of [...container.querySelectorAll<HTMLElement>('[data-object-id]')].entries()) button.setAttribute('aria-selected', String(index === activeSearchIndex));
    const active = container.querySelector<HTMLElement>(`#sky-result-${activeSearchIndex}`)!;
    input('sky-search').setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' });
  });
  listen(input('sky-import-file'), 'change', async () => {
    const file = input('sky-import-file').files?.[0];
    if (!file) return;
    try { if (file.size > 100000) throw new Error('场景文件过大；最大 100 KB。'); const next = parseState(await file.text()); if (disposed) return; if (!availableViews.includes(next.viewMode)) throw new Error('此场景视角尚未在本轮实现。'); applyState(state, next); observerDraft.clear(); refractionControls.clearDraft(); sceneControls.rememberCurrent(file.name); teachingControls.setMoonPhaseSeed(null); timeControls.cancelSession(true); change('import'); message('已导入完整场景。'); }
    catch (error) { message(error instanceof Error ? error.message : String(error), true); }
    finally { if (!disposed) input('sky-import-file').value = ''; }
  });
  const mobileMedia = window.matchMedia(MOBILE_CONTROLS_QUERY);
  function syncDock() { const dock = mobileMedia.matches ? 'bottom' : 'left'; panel.dataset.skyDock = dock; container.querySelector<HTMLElement>('.controls-compact')!.dataset.skyDock = dock; container.classList.toggle('mobile-controls', mobileMedia.matches); setDrawer(!mobileMedia.matches); }
  listen(mobileMedia, 'change', syncDock);
  function syncViewport() {
    const viewport = window.visualViewport;
    container.style.setProperty('--sky-visible-height', `${viewport?.height ?? window.innerHeight}px`);
    container.style.setProperty('--sky-keyboard-inset', `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`);
    window.dispatchEvent(new CustomEvent('sky:layout-change'));
  }
  listen(window, 'resize', syncViewport);
  if (window.visualViewport) { listen(window.visualViewport, 'resize', syncViewport); listen(window.visualViewport, 'scroll', syncViewport); }
  syncViewport();
  syncDock();
  sync();
  return {
    update(snapshot, metrics, teaching) {
      if (disposed) return;
      lastSnapshot = snapshot; refractionControls.update(snapshot); teachingControls.update(teaching, snapshot); objectDayControls.update(teaching); sync();
      if (metrics) {
        text('.metric-frame', metrics.frameMs && metrics.samplingWindowSeconds !== 0 ? `${metrics.frameMs.p50.toFixed(1)} / ${metrics.frameMs.p95.toFixed(1)} / ${metrics.frameMs.p99.toFixed(1)} ms` : '未测（暂停空闲）');
        text('.metric-calls', `${metrics.drawCallsPerFrame ?? '未测'} / ${metrics.visibleLabelCount ?? '未测'} / ${metrics.pendingLatestRequestCount ?? '未测'}`);
        text('.metric-resources', `${metrics.textureCount ?? '未测'} / ${metrics.geometryCount ?? '未测'}`);
        text('.metric-gpu', bytes(metrics.appOwnedGpuBytesEstimate));
        text('.metric-heap', `${bytes(metrics.mainThreadJsHeapBytes)} / ${bytes(metrics.workerHeapBytes)}`);
        text('.metric-notes', (metrics.measurementNotes ?? ['浏览器与驱动内存另计。']).join(' '));
      }
    },
    updateSkyAppearance(appearance) { appearanceControls.update(appearance); },
    syncPlayback,
    invalidateSkyAppearance() { appearanceControls.invalidate(); },
    setGraphicsStatus(status) { if (disposed) return; if (graphicsStatus?.kind !== status.kind) appearanceControls.invalidate(); graphicsStatus = status; appearanceControls.setObserverOverview(status.capabilities.observerOverview); refractionControls.setObserverOverview(status.capabilities.observerOverview); teachingControls.setMoonLoupeCapability(status.available && status.capabilities.moonLoupe); sync(); },
    setOfflineStatus(status) { if (disposed) return; const signature = `${status.phase}:${status.message}`; if (signature === offlineSignature) return; offlineSignature = signature; const notice = container.querySelector<HTMLElement>('#sky-offline-notice')!; notice.textContent = status.message; notice.dataset.phase = status.phase; notice.hidden = !['update-ready', 'update-failed', 'error'].includes(status.phase); window.dispatchEvent(new CustomEvent('sky:layout-change')); },
    showShareResult(result) { if (disposed) return; setDrawer(true); container.querySelector<HTMLDetailsElement>('.scene-section')!.open = true; sceneControls.showShareResult(result); },
    rememberCurrentScene(name = '载入场景') { if (disposed) return; lastSnapshot = undefined; objectDayControls.invalidate(); observerDraft.clear(); refractionControls.clearDraft(); sceneControls.rememberCurrent(name); timeControls.cancelSession(true); },
    isObjectDayVisible() { return objectDayControls.isVisible(); },
    isTeachingVisible() { return teachingControls.isVisible(); },
    getMoonLoupeViewport() { return teachingControls.getMoonLoupeViewport(); },
    setMoonLoupeAvailability(status, message, info) { teachingControls.setMoonLoupeAvailability(status, message, info); },
    dispose() { disposed = true; objectDayControls.dispose(); observerDraft.dispose(); sceneControls.dispose(); timeControls.dispose(); appearanceControls.dispose(); refractionControls.dispose(); teachingControls.dispose(); listeners.forEach((remove) => remove()); if (messageTimer) clearTimeout(messageTimer); container.innerHTML = ''; },
  };
}
