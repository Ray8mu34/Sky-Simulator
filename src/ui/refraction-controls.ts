import type { EnvironmentState, ScienceSnapshot, SimulationState } from '../contracts';
import { applyState } from '../state';
import { trackFormDraft } from './form-draft';

export interface RefractionControls {
  sync(): void;
  update(snapshot: ScienceSnapshot): void;
  clearDraft(): void;
  invalidate(): void;
  setObserverOverview(enabled: boolean): void;
  dispose(): void;
}

/** Compare published input metadata only; the core owns all directional correction. */
export function hasMatchingRefraction(snapshot: ScienceSnapshot | undefined, environment: EnvironmentState): boolean {
  const descriptor = snapshot?.observerRefraction;
  return !!descriptor && descriptor.mode === environment.refraction &&
    descriptor.pressureHpa === environment.pressureHpa && descriptor.temperatureC === environment.temperatureC;
}

/** One explicit form transaction keeps P/T drafts intact during background updates. */
export function mountRefractionControls(parent: HTMLElement, state: SimulationState,
  onChange: (reason: string) => void): RefractionControls {
  const section = document.createElement('details');
  section.className = 'refraction-controls'; section.id = 'sky-refraction';
  section.innerHTML = `<summary><span class="refraction-heading">画面折射</span></summary>
    <form id="sky-refraction-form" class="refraction-form" novalidate>
      <label for="sky-refraction-mode">口径</label><select id="sky-refraction-mode"><option value="none">几何 · 无折射</option><option value="standard">标准折射近似</option></select>
      <label for="sky-pressure">气压 hPa</label><input id="sky-pressure" type="number" min="0" max="1200" step="any" required>
      <label for="sky-temperature">温度 °C</label><input id="sky-temperature" type="number" min="-100" max="80" step="any" required>
      <button id="sky-apply-refraction" type="submit">应用折射设置</button>
    </form>
    <p id="sky-refraction-scope" class="tiny-note"></p><p id="sky-refraction-status" class="tiny-note" role="status" aria-live="polite"></p>
    <p class="tiny-note">经验大气近似，非现场天气；气压为0时无改正。折射与背景大气图层独立，低于−1°仅作连续数值延拓。升落预报仍用独立34′标准事件口径，不随此设置改变。</p>`;
  parent.append(section);
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const form = query<HTMLFormElement>('#sky-refraction-form');
  const mode = query<HTMLSelectElement>('#sky-refraction-mode');
  const pressure = query<HTMLInputElement>('#sky-pressure');
  const temperature = query<HTMLInputElement>('#sky-temperature');
  const heading = query<HTMLElement>('.refraction-heading');
  const scope = query<HTMLElement>('#sky-refraction-scope');
  const status = query<HTMLElement>('#sky-refraction-status');
  const draft = trackFormDraft(form);
  let snapshot: ScienceSnapshot | undefined;
  let observerOverview = false;
  let error = '';
  let disposed = false;
  function sync() {
    if (disposed) return;
    const local = observerOverview || state.viewMode === 'ground';
    heading.textContent = `画面折射 · ${state.environment.refraction === 'none' ? '几何' : local ? '标准近似' : '外部保持几何'}`;
    if (!draft.isDirty()) {
      mode.value = state.environment.refraction;
      pressure.value = String(state.environment.pressureHpa);
      temperature.value = String(state.environment.temperatureC);
    }
    scope.textContent = local ? `${observerOverview ? '2D方位图' : '地表'}采用所选口径；几何与视高度均保留。`
      : '外部图形保持几何方向；折射设置保留，供地表或2D当地观察。详情高度是观测地点站心读数。';
    status.textContent = error || (hasMatchingRefraction(snapshot, state.environment) ? '' : '正在更新视高度…');
    status.classList.toggle('is-error', !!error);
    section.dataset.refractionStatus = error ? 'error' : hasMatchingRefraction(snapshot, state.environment) ? 'ready' : 'pending';
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    try {
      applyState(state, { ...state, environment: { ...state.environment,
        refraction: mode.value, pressureHpa: pressure.valueAsNumber, temperatureC: temperature.valueAsNumber } });
      draft.clear(); error = ''; snapshot = undefined; sync(); onChange('environment-refraction');
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); sync(); }
  }
  form.addEventListener('submit', submit);
  sync();
  return {
    sync,
    update(next) { snapshot = next; sync(); },
    clearDraft() { draft.clear(); error = ''; sync(); },
    invalidate() { snapshot = undefined; sync(); },
    setObserverOverview(enabled) { observerOverview = enabled; sync(); },
    dispose() { disposed = true; form.removeEventListener('submit', submit); draft.dispose(); section.remove(); },
  };
}
