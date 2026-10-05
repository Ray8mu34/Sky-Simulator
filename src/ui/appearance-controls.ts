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
  section.className = 'appearance-controls';
  section.innerHTML = `<summary>光污染 · 定性模拟</summary>
    <div class="appearance-heading"><label for="sky-artificial-light">人工天空亮度</label><output id="sky-artificial-light-value" for="sky-artificial-light"></output></div>
    <input id="sky-artificial-light" type="range" min="0" max="1" step="0.01" aria-label="定性人工天空亮度，0至1">
    <div class="appearance-presets" role="group" aria-label="定性光污染预设"><button type="button" data-sky-light="0" aria-label="暗夜示例，0">暗夜</button><button type="button" data-sky-light="0.5" aria-label="郊外示例，0.5">郊外</button><button type="button" data-sky-light="1" aria-label="城市示例，1">城市</button></div>
    <p class="tiny-note">0–1教学示例，非实测亮度或天气。</p>
    <label class="layer-toggle" title="地平上月球照亮天空；隐藏日月图层不会关闭月光。"><input id="sky-moonlight" type="checkbox"><span>月光参与可见性</span></label>
    <p id="sky-appearance-scope" class="tiny-note"></p><p id="sky-appearance-values" class="tiny-note"></p>
    <button id="sky-observe-appearance" type="button">地表观察＋大气</button>
    <details class="appearance-model-details"><summary>模型口径</summary><p class="tiny-note">0–1为教学定性参数；暗夜、郊外、城市仅为示例，不对应实测SQM、Bortle等级或天气。日光、地平上月光与人工灯光共同影响暗星、银河对比度和天空底亮。关闭大气不模拟散射；原理模式及外部视图忽略可见性。</p><p id="sky-appearance-notes" class="tiny-note"></p></details>`;
  parent.append(section);
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const slider = query<HTMLInputElement>('#sky-artificial-light');
  const moonlight = query<HTMLInputElement>('#sky-moonlight');
  const scope = query<HTMLElement>('#sky-appearance-scope');
  const values = query<HTMLElement>('#sky-appearance-values');
  const observe = query<HTMLButtonElement>('#sky-observe-appearance');
  let appearance: SkyAppearance | undefined;
  let observerOverview = false;
  let disposed = false;
  const listeners: Array<() => void> = [];
  function listen(target: EventTarget, event: string, handler: EventListener) {
    target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler));
  }
  function sync() {
    if (disposed) return;
    if (document.activeElement !== slider) slider.value = String(state.environment.artificialSkyBrightness);
    query<HTMLOutputElement>('#sky-artificial-light-value').textContent = state.environment.artificialSkyBrightness.toFixed(2);
    moonlight.checked = state.environment.moonlightEnabled;
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-sky-light]')) button.setAttribute('aria-pressed', String(state.environment.artificialSkyBrightness === Number(button.dataset.skyLight)));
    const localOverview = observerOverview || state.viewMode === 'ground';
    observe.hidden = localOverview && state.presentation === 'observation' && state.layers.atmosphere;
    observe.textContent = observerOverview ? '观察模式＋大气' : '地表观察＋大气';
    // These are state semantics, not a parallel numerical appearance model.
    scope.textContent = !localOverview ? '方向示意：不模拟当地污染；可切到地表观察。'
      : state.presentation === 'explanation' ? '原理示意：忽略可见性；污染与月光衰减不应用。'
      : !state.layers.atmosphere ? '大气关闭：不模拟散射与可见性衰减。'
      : '定性观察：暗星、银河与天空底亮联动。';
    values.textContent = appearance ? `模型星限 ${appearance.limitingMagnitude.toFixed(1)}等${observerOverview ? '' : ` · 银河对比 ${appearance.milkyWayContrast.toFixed(2)}`}\n相对天空底亮 ${appearance.skyBrightness.toFixed(2)}` : '等待共享可见性模型。';
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
    if (!observerOverview) state.viewMode = 'ground';
    state.presentation = 'observation'; state.layers.atmosphere = true;
    appearance = undefined; sync(); onChange(observerOverview ? 'presentation' : 'view');
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
