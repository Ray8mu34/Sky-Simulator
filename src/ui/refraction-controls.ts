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
  section.innerHTML = `<summary><span class="refraction-heading">大气折射</span></summary>
    <form id="sky-refraction-form" class="refraction-form" novalidate>
      <label for="sky-refraction-mode">模式</label><select id="sky-refraction-mode"><option value="none">关闭</option><option value="standard">标准大气</option></select>
      <label for="sky-pressure">气压 hPa</label><input id="sky-pressure" type="number" min="0" max="1200" step="any" required>
      <label for="sky-temperature">温度 °C</label><input id="sky-temperature" type="number" min="-100" max="80" step="any" required>
      <button id="sky-apply-refraction" type="submit">应用折射设置</button>
    </form>
    <p id="sky-refraction-scope" class="tiny-note"></p><p id="sky-refraction-status" class="tiny-note" role="status" aria-live="polite"></p>
    <p class="tiny-note">调整气压与温度，观察大气折射对天体视高度的影响。</p>`;
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
    heading.textContent = `大气折射 · ${state.environment.refraction === 'none' ? '关闭' : local ? '已开启' : '地表视角适用'}`;
    if (!draft.isDirty()) {
      mode.value = state.environment.refraction;
      pressure.value = String(state.environment.pressureHpa);
      temperature.value = String(state.environment.temperatureC);
    }
    scope.textContent = local ? ''
      : '切换到地表视角可查看折射效果。';
    status.textContent = error || (hasMatchingRefraction(snapshot, state.environment) ? '' : '正在更新视高度…');
    status.classList.toggle('is-error', !!error);
    section.dataset.refractionStatus = error ? 'error' : hasMatchingRefraction(snapshot, state.environment) ? 'ready' : 'pending';
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    try {
      if (!Number.isFinite(pressure.valueAsNumber) || pressure.valueAsNumber < 0 || pressure.valueAsNumber > 1200) {
        pressure.focus(); throw new Error('气压请输入0至1200 hPa。');
      }
      if (!Number.isFinite(temperature.valueAsNumber) || temperature.valueAsNumber < -100 || temperature.valueAsNumber > 80) {
        temperature.focus(); throw new Error('温度请输入−100至80 °C。');
      }
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
