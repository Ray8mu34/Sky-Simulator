import type { SimulationState } from '../contracts';
import type { SkyAppearance } from '../core/sky-appearance';

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
  section.innerHTML = `<summary><span>肉眼星空 · 光污染</span><small id="sky-appearance-state"></small></summary>
    <div class="appearance-actions" role="group" aria-label="星空显示方式"><button id="sky-observe-appearance" type="button">模拟肉眼星空</button><button id="sky-full-star-map" type="button">完整星图</button></div>
    <p id="sky-appearance-scope" class="tiny-note" role="status" aria-live="polite"></p>
    <div class="appearance-heading"><label for="sky-artificial-light">人工天空亮度</label><output id="sky-artificial-light-value" for="sky-artificial-light"></output></div>
    <input id="sky-artificial-light" type="range" min="0" max="1" step="0.01" aria-label="定性人工天空亮度，0至1" aria-describedby="sky-appearance-scope sky-appearance-qualitative">
    <div class="appearance-presets" role="group" aria-label="定性光污染预设"><button type="button" data-sky-light="0" aria-label="暗夜示例，0">暗夜</button><button type="button" data-sky-light="0.5" aria-label="郊外示例，0.5">郊外</button><button type="button" data-sky-light="1" aria-label="城市示例，1">城市</button></div>
    <p id="sky-appearance-qualitative" class="tiny-note">0–1定性示例：亮星组合更突出，非实测亮度或天气。</p>
    <label class="layer-toggle" title="地平上月球照亮天空；隐藏日月图层不会关闭月光。"><input id="sky-moonlight" type="checkbox"><span>月光参与可见性</span></label>
    <p id="sky-appearance-values" class="tiny-note"></p>
    <details class="appearance-model-details"><summary>模型口径</summary><p class="tiny-note">0–1为教学定性参数；暗夜、郊外、城市仅为示例，不对应实测SQM、Bortle等级或天气。日光、地平上月光与人工灯光共同影响暗星、银河对比度和天空底亮。关闭大气不模拟散射；原理模式及外部视图忽略可见性。</p><p id="sky-appearance-notes" class="tiny-note"></p></details>`;
  parent.append(section);
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const slider = query<HTMLInputElement>('#sky-artificial-light');
  const moonlight = query<HTMLInputElement>('#sky-moonlight');
  const scope = query<HTMLElement>('#sky-appearance-scope');
  const values = query<HTMLElement>('#sky-appearance-values');
  const observe = query<HTMLButtonElement>('#sky-observe-appearance');
  const fullMap = query<HTMLButtonElement>('#sky-full-star-map');
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
    slider.setAttribute('aria-valuetext', `${state.environment.artificialSkyBrightness.toFixed(2)}，定性人工天空亮度`);
    moonlight.checked = state.environment.moonlightEnabled;
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-sky-light]')) button.setAttribute('aria-pressed', String(state.environment.artificialSkyBrightness === Number(button.dataset.skyLight)));
    const localOverview = observerOverview || state.viewMode === 'ground';
    const enabled = localOverview && state.presentation === 'observation' && state.layers.atmosphere;
    observe.setAttribute('aria-pressed', String(enabled));
    fullMap.setAttribute('aria-pressed', String(state.presentation === 'explanation'));
    query<HTMLElement>('#sky-appearance-state').textContent = enabled ? '已开启' : '未生效';
    // These are state semantics, not a parallel numerical appearance model.
    scope.textContent = !localOverview ? '当前未生效：外部视图仅示意方向。模拟肉眼星空会切到地表。'
      : state.presentation === 'explanation' ? '当前未生效：完整星图忽略肉眼可见性，保留污染设置。'
      : !state.layers.atmosphere ? '当前未生效：大气已关闭。开启肉眼模拟可恢复可见性衰减。'
      : `当前已生效：${observerOverview ? '2D当地观察' : '地表观察'}，日光、月光与污染共同淡化暗星。`;
    values.textContent = appearance ? `模型星限 ${appearance.limitingMagnitude.toFixed(1)}等${observerOverview ? '' : ` · 银河对比 ${appearance.milkyWayContrast.toFixed(2)}`}\n相对天空底亮 ${appearance.skyBrightness.toFixed(2)}` : '正在更新星空可见性…';
    query<HTMLElement>('#sky-appearance-notes').textContent = appearance?.notes.join('；') ?? '';
  }
  function change() { appearance = undefined; sync(); onChange('environment-appearance'); }
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
