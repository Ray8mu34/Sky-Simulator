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
    <div class="appearance-heading"><label for="sky-artificial-light">光污染强度</label><output id="sky-artificial-light-value" for="sky-artificial-light"></output></div>
    <input id="sky-artificial-light" type="range" min="0" max="1" step="0.01" aria-label="光污染强度，0至1" aria-describedby="sky-appearance-scope sky-appearance-qualitative">
    <div class="appearance-presets" role="group" aria-label="光污染预设"><button type="button" data-sky-light="0" aria-label="暗夜，0">暗夜</button><button type="button" data-sky-light="0.5" aria-label="郊外，0.5">郊外</button><button type="button" data-sky-light="1" aria-label="城市，1">城市</button></div>
    <p id="sky-appearance-qualitative" class="tiny-note">从暗夜到城市，比较光污染对星空的影响。</p>
    <label class="layer-toggle" title="计入月光对天空亮度的影响。"><input id="sky-moonlight" type="checkbox"><span>月光影响</span></label>
    <p id="sky-appearance-values" class="tiny-note"></p>
    <details class="appearance-model-details"><summary>星空亮度说明</summary><p class="tiny-note">日光、月光和人工灯光越强，暗星与银河越难看清。光污染强度使用0–1的相对刻度。</p></details>`;
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
    slider.setAttribute('aria-valuetext', `${state.environment.artificialSkyBrightness.toFixed(2)}，光污染强度`);
    moonlight.checked = state.environment.moonlightEnabled;
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-sky-light]')) button.setAttribute('aria-pressed', String(state.environment.artificialSkyBrightness === Number(button.dataset.skyLight)));
    const localOverview = observerOverview || state.viewMode === 'ground';
    const enabled = localOverview && state.presentation === 'observation' && state.layers.atmosphere;
    observe.setAttribute('aria-pressed', String(enabled));
    fullMap.setAttribute('aria-pressed', String(state.presentation === 'explanation'));
    query<HTMLElement>('#sky-appearance-state').textContent = enabled ? '已开启' : '未开启';
    // These are state semantics, not a parallel numerical appearance model.
    scope.textContent = !localOverview ? '开启肉眼星空将切换到地表视角。'
      : state.presentation === 'explanation' ? '完整星图已开启。'
      : !state.layers.atmosphere ? '开启肉眼星空将同时开启大气。'
      : '';
    values.textContent = enabled ? appearance ? `可见极限 ${appearance.limitingMagnitude.toFixed(1)} 等` : '正在更新星空…' : '';
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
