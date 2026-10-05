import type { SimulationState } from '../contracts';
import { applyState, createDefaultState, parseState, serializeState } from '../state';
import { getPreset, loadPreset, teachingPresets, teachingPresetTopics } from '../teaching-presets';
import { sceneLibrary } from '../platform/scene-library';
import type { SceneSummary } from '../platform/scene-library';

export type ShareResult = { mode: 'web'; url: string; copied: boolean; message: string }
  | { mode: 'portable'; json: string; copied: boolean; message: string };
export interface SceneControls {
  reset(): void;
  rememberCurrent(name: string): void;
  showShareResult(result: ShareResult): void;
  resetTitle(): string;
  dispose(): void;
}

/** One validated state and the platform's one scene library; all user strings use DOM values. */
export function mountSceneControls(section: HTMLElement, state: SimulationState,
  onLoad: (reason: string, phaseSeed: number | null) => void): SceneControls {
  section.innerHTML = `<summary>场景 / 输出</summary><label class="scene-preset-label" for="sky-preset">教学场景</label><select id="sky-preset" aria-label="选择教学场景"></select><button id="sky-load-preset" type="button">载入教学场景</button><p class="preset-description tiny-note"></p><p class="preset-time-place tiny-note"></p><p class="current-scene-label tiny-note"></p>
    <details class="scene-library-section"><summary>我的场景 · 本地保存</summary><label for="sky-scene-name">名称</label><input id="sky-scene-name" type="text" autocomplete="off" aria-label="本地场景名称，最多80字"><button id="sky-save-scene" type="button">另存新场景</button><select id="sky-saved-scenes" aria-label="我的本地场景"></select><div class="scene-library-actions"><button id="sky-load-saved-scene" type="button">载入</button><button id="sky-update-saved-scene" type="button">覆盖选中</button><button id="sky-remove-saved-scene" type="button">删除选中</button></div><p class="scene-library-status tiny-note" role="status" aria-live="polite"></p></details>
    <div class="utility-grid"><button type="button" data-action="export">导出场景</button><button type="button" data-action="import">导入场景</button><button type="button" data-action="capture">截图</button><button type="button" id="sky-share-scene">分享</button><button type="button" id="sky-reset-default">全局默认</button></div><input id="sky-import-file" type="file" accept="application/json,.json" hidden><div class="share-result" hidden><p class="share-message tiny-note" role="status"></p><textarea id="sky-share-value" readonly aria-label="可手动复制的场景分享内容"></textarea><button id="sky-select-share" type="button">全选内容</button></div><p class="tiny-note">场景保存时间、地点、图层、选择和全部相机。复位恢复已载入场景的起点并暂停。</p>`;
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const presetSelect = query<HTMLSelectElement>('#sky-preset');
  const savedSelect = query<HTMLSelectElement>('#sky-saved-scenes');
  const listeners: Array<() => void> = [];
  let initial = parseState(state), initialName = '初始场景', phaseSeed: number | null = null;
  let summaries: SceneSummary[] = [], disposed = false;
  const put = (selector: string, value: string) => { query<HTMLElement>(selector).textContent = value; };
  const listen = (target: EventTarget, event: string, handler: EventListener) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  function status(message: string, error = false) { put('.scene-library-status', message); query<HTMLElement>('.scene-library-status').classList.toggle('is-error', error); }
  function tryAction(action: () => void) { try { action(); } catch (error) { status(error instanceof Error ? error.message : String(error), true); } }
  function refreshLibrary(selected = savedSelect.value) {
    summaries = sceneLibrary.list();
    savedSelect.replaceChildren(new Option('选择我的场景', ''));
    for (const summary of summaries) savedSelect.add(new Option(summary.name, summary.id));
    savedSelect.value = summaries.some(summary => summary.id === selected) ? selected : '';
    for (const button of section.querySelectorAll<HTMLButtonElement>('.scene-library-actions button')) button.disabled = !savedSelect.value;
  }
  function remember(name: string, seed: number | null = null) {
    initial = parseState(state); initialName = name; phaseSeed = seed;
    put('.current-scene-label', `当前起点：${name}`);
    for (const button of document.querySelectorAll<HTMLElement>('#controls [data-action="reset"]')) button.title = `恢复“${name}”起点并暂停`;
  }
  function load(candidate: SimulationState, name: string, seed: number | null, reason: string, rememberStart = true) {
    applyState(state, candidate);
    if (rememberStart) remember(name, seed);
    onLoad(reason, seed);
  }
  for (const topic of teachingPresetTopics) {
    const group = document.createElement('optgroup'); group.label = topic.title;
    for (const preset of teachingPresets.filter(preset => preset.topic === topic.id)) group.append(new Option(preset.title, preset.id));
    presetSelect.append(group);
  }
  function showPreset() {
    const preset = getPreset(presetSelect.value);
    put('.preset-description', preset?.description ?? ''); put('.preset-time-place', preset?.timePlaceNote ?? '');
  }
  listen(presetSelect, 'change', showPreset);
  listen(query('#sky-load-preset'), 'click', () => tryAction(() => {
    const preset = getPreset(presetSelect.value); if (!preset) throw new Error('请选择有效教学场景。');
    load(loadPreset(preset.id), preset.title, preset.moonPhaseSeedUtDaysJ2000, 'time-scene');
    status(`已载入“${preset.title}”；复位可恢复这一场景起点。`);
  }));
  listen(query('#sky-save-scene'), 'click', () => tryAction(() => {
    const record = sceneLibrary.save(query<HTMLInputElement>('#sky-scene-name').value, state);
    refreshLibrary(record.id); status(`已另存“${record.name}”。`);
  }));
  listen(savedSelect, 'change', () => {
    const record = summaries.find(summary => summary.id === savedSelect.value);
    if (record) query<HTMLInputElement>('#sky-scene-name').value = record.name;
    for (const button of section.querySelectorAll<HTMLButtonElement>('.scene-library-actions button')) button.disabled = !record;
  });
  listen(query('#sky-load-saved-scene'), 'click', () => tryAction(() => {
    const record = summaries.find(summary => summary.id === savedSelect.value); if (!record) return;
    load(sceneLibrary.load(record.id), record.name, null, 'import'); status(`已载入“${record.name}”，保留保存的播放设置。`);
  }));
  listen(query('#sky-update-saved-scene'), 'click', () => tryAction(() => {
    if (!savedSelect.value) return;
    const record = sceneLibrary.save(query<HTMLInputElement>('#sky-scene-name').value, state, savedSelect.value);
    refreshLibrary(record.id); status(`已明确覆盖“${record.name}”。`);
  }));
  listen(query('#sky-remove-saved-scene'), 'click', () => tryAction(() => {
    const record = summaries.find(summary => summary.id === savedSelect.value); if (!record) return;
    sceneLibrary.remove(record.id); refreshLibrary(''); status(`已删除“${record.name}”。`);
  }));
  listen(query('#sky-reset-default'), 'click', () => { load(createDefaultState(), '全局默认', null, 'time-reset'); status('已恢复全局默认并暂停。'); });
  listen(query('#sky-share-scene'), 'click', () => { window.dispatchEvent(new CustomEvent('sky:share')); });
  listen(query('#sky-select-share'), 'click', () => { const value = query<HTMLTextAreaElement>('#sky-share-value'); value.focus(); value.select(); });
  listen(section, 'toggle', () => { if ((section as HTMLDetailsElement).open) tryAction(() => refreshLibrary()); });
  tryAction(() => refreshLibrary()); showPreset(); remember(initialName);
  return {
    reset() { if (disposed) return; const candidate = parseState(initial); candidate.time.running = false; load(candidate, initialName, phaseSeed, 'time-reset', false); status(`已恢复“${initialName}”起点并暂停。`); },
    rememberCurrent(name) { if (!disposed) remember(name); },
    resetTitle() { return `恢复“${initialName}”起点并暂停`; },
    showShareResult(result) {
      if (disposed) return;
      query<HTMLElement>('.share-result').hidden = false;
      put('.share-message', result.message);
      query<HTMLTextAreaElement>('#sky-share-value').value = result.mode === 'web' ? result.url : result.json;
      query<HTMLButtonElement>('#sky-select-share').textContent = result.mode === 'web' ? '全选链接' : '全选场景JSON';
      if (result.mode === 'portable' && !result.json) query<HTMLTextAreaElement>('#sky-share-value').value = serializeState(state);
      query<HTMLElement>('.share-result').scrollIntoView({ block: 'nearest' });
    },
    dispose() { disposed = true; listeners.forEach(remove => remove()); },
  };
}
