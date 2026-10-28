import type { SimulationState } from '../contracts';
import type { SkyAppearance } from '../core/sky-appearance';
import { infoTip } from './info-tip';

export interface AppearanceControls {
  sync(): void;
  update(appearance: SkyAppearance): void;
  invalidate(): void;
  setObserverOverview(enabled: boolean): void;
  dispose(): void;
}

/** Display the shared model result; no visibility or astronomy calculations live here. */
export function mountAppearanceControls(parent: HTMLElement, state: SimulationState,
  onChange: (reason?: string) => void): AppearanceControls {
  const section = document.createElement('details');
  section.className = 'control-section appearance-controls';
  section.innerHTML = `<summary><span>星空显示 · 光污染</span><small id="sky-appearance-state"></small></summary>
    <div class="appearance-actions" role="group" aria-label="星空显示方式"><button id="sky-observe-appearance" type="button">模拟肉眼星空</button><button id="sky-full-star-map" type="button">完整星图</button></div>
    <p id="sky-appearance-scope" class="tiny-note" role="status" aria-live="polite"></p>
    <div class="appearance-heading"><label for="sky-star-map-depth">完整星图深度</label><output id="sky-star-map-depth-value" for="sky-star-map-depth"></output>${infoTip('sky-star-map-depth-help', '星图深度说明', '调整深度会切换为完整星图。HYG星表补充至10等，供寻星与构图，不是完备的深空测光星表。')}</div>
    <input id="sky-star-map-depth" type="range" min="6.5" max="10" step="0.5" aria-describedby="sky-star-map-depth-help">
    <button id="sky-star-map-deep" type="button">显示至10等</button>
    <div class="appearance-heading"><label for="sky-artificial-light">光污染强度</label><output id="sky-artificial-light-value" for="sky-artificial-light"></output>${infoTip('sky-appearance-qualitative', '光污染与月光说明', '日光、月光和人工灯光越强，暗星与银河越难看清。0–1为相对强度，不是实测天空亮度；完整星图保留这些设置，但不应用肉眼可见性衰减。')}</div>
    <input id="sky-artificial-light" type="range" min="0" max="1" step="0.01" aria-label="光污染强度，0至1" aria-describedby="sky-appearance-scope sky-appearance-qualitative">
    <div class="appearance-presets" role="group" aria-label="光污染预设"><button type="button" data-sky-light="0" aria-label="暗夜，0">暗夜</button><button type="button" data-sky-light="0.5" aria-label="郊外，0.5">郊外</button><button type="button" data-sky-light="1" aria-label="城市，1">城市</button></div>
    <label class="layer-toggle" title="计入月光对天空亮度的影响。"><input id="sky-moonlight" type="checkbox"><span>月光影响</span></label>
    <p id="sky-appearance-values" class="tiny-note"></p>`;
  parent.append(section);
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const slider = query<HTMLInputElement>('#sky-artificial-light');
  const moonlight = query<HTMLInputElement>('#sky-moonlight');
  const scope = query<HTMLElement>('#sky-appearance-scope');
  const values = query<HTMLElement>('#sky-appearance-values');
  const observe = query<HTMLButtonElement>('#sky-observe-appearance');
  const fullMap = query<HTMLButtonElement>('#sky-full-star-map');
  const mapDepth = query<HTMLInputElement>('#sky-star-map-depth');
  const deepMap = query<HTMLButtonElement>('#sky-star-map-deep');
  let appearance: SkyAppearance | undefined;
  let observerOverview = false;
  let disposed = false;
  const listeners: Array<() => void> = [];
  function listen(target: EventTarget, event: string, handler: EventListener) {
    target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler));
  }
  function sync() {
    if (disposed) return;
    const brightnessValue = String(state.environment.artificialSkyBrightness);
    if (slider.value !== brightnessValue) slider.value = brightnessValue;
    query<HTMLOutputElement>('#sky-artificial-light-value').textContent = state.environment.artificialSkyBrightness.toFixed(2);
    slider.setAttribute('aria-valuetext', `${state.environment.artificialSkyBrightness.toFixed(2)}，光污染强度`);
    const depth = state.environment.darkSkyLimitingMagnitude;
    if (mapDepth.valueAsNumber !== depth) mapDepth.value = String(depth);
    query<HTMLOutputElement>('#sky-star-map-depth-value').textContent = `${depth.toFixed(1)} 等`;
    mapDepth.setAttribute('aria-valuetext', `显示至${depth.toFixed(1)}等`);
    deepMap.setAttribute('aria-pressed', String(state.presentation === 'explanation' && depth === 10));
    moonlight.checked = state.environment.moonlightEnabled;
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-sky-light]')) button.setAttribute('aria-pressed', String(state.environment.artificialSkyBrightness === Number(button.dataset.skyLight)));
    const localOverview = observerOverview || state.viewMode === 'ground';
    const enabled = localOverview && state.presentation === 'observation' && state.layers.atmosphere;
    observe.setAttribute('aria-pressed', String(enabled));
    fullMap.setAttribute('aria-pressed', String(state.presentation === 'explanation'));
    query<HTMLElement>('#sky-appearance-state').textContent = state.presentation === 'explanation' ? '完整星图' : enabled ? '肉眼星空' : '未开启';
    // These are state semantics, not a parallel numerical appearance model.
    scope.textContent = state.presentation === 'explanation' ? '光污染与月光不影响完整星图。'
      : !localOverview ? '开启肉眼星空将切换到地表视角。'
      : !state.layers.atmosphere ? '开启肉眼星空将同时开启大气。'
      : '';
    values.textContent = enabled ? appearance ? `可见极限 ${appearance.limitingMagnitude.toFixed(1)} 等` : '正在更新星空…' : '';
  }
  function change() { appearance = undefined; sync(); onChange('environment-appearance'); }
  function setMapDepth(depth: number) {
    if (disposed || !Number.isFinite(depth) || depth < 6.5 || depth > 10) return;
    state.environment.darkSkyLimitingMagnitude = depth;
    state.presentation = 'explanation';
    appearance = undefined; sync(); onChange('presentation');
  }
  listen(mapDepth, 'input', () => setMapDepth(mapDepth.valueAsNumber));
  listen(deepMap, 'click', () => setMapDepth(10));
  listen(slider, 'input', () => {
    const brightness = slider.valueAsNumber;
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 1) return;
    state.environment.artificialSkyBrightness = brightness; change();
  });
  listen(moonlight, 'change', () => { state.environment.moonlightEnabled = moonlight.checked; change(); });
  listen(section, 'click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-sky-light]');
    if (!button) return;
    state.environment.artificialSkyBrightness = Number(button.dataset.skyLight);
    // A preset must update even while the range input retained focus.
    slider.value = String(state.environment.artificialSkyBrightness); change();
  });
  listen(observe, 'click', () => {
    if (disposed) return;
    const changedView = !observerOverview && state.viewMode !== 'ground';
    if (!observerOverview) state.viewMode = 'ground';
    state.presentation = 'observation'; state.layers.atmosphere = true;
    state.environment.darkSkyLimitingMagnitude = 6.5;
    appearance = undefined; sync(); onChange(changedView ? 'view' : 'presentation');
  });
  listen(fullMap, 'click', () => {
    if (disposed) return;
    state.presentation = 'explanation';
    appearance = undefined; sync(); onChange('presentation');
  });
  sync();
  return {
    sync,
    update(next) { if (disposed) return; appearance = next; sync(); },
    invalidate() { appearance = undefined; sync(); },
    setObserverOverview(enabled) { observerOverview = enabled; sync(); },
    dispose() { disposed = true; listeners.forEach(remove => remove()); section.remove(); },
  };
}
