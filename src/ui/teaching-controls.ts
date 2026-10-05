import type { DisplayZone, ScienceSnapshot, SimulationState, SolarDayEvents } from '../contracts';
import type { TeachingData } from '../core/teaching';
import { formatCivil, localCivilParts, utToDate } from '../core/time';
import { applyState } from '../state';

export interface MoonLoupeInfo {
  magnificationRelativeToMain?: number | null;
}
export interface TeachingControls {
  update(data?: TeachingData, snapshot?: ScienceSnapshot): void;
  isVisible(): boolean;
  getMoonLoupeViewport(): DOMRect | null;
  setMoonLoupeAvailability(status: 'pending' | 'ready' | 'error', message?: string, info?: MoonLoupeInfo): void;
  setMoonLoupeCapability(available: boolean): void;
  setMoonPhaseSeed(utDaysJ2000: number | null): void;
  invalidate(): void;
  dispose(): void;
}

const two = (n: number) => String(n).padStart(2, '0');
function zoneLabel(zone: DisplayZone): string {
  if (zone.kind === 'iana') return zone.name;
  const offset = Math.abs(zone.offsetMinutes);
  return `UTC${zone.offsetMinutes < 0 ? '−' : '+'}${two(Math.floor(offset / 60))}:${two(offset % 60)}`;
}
function eventClock(ut: number, zone: DisplayZone): string {
  const p = localCivilParts(ut, zone);
  return `${two(p.hour)}:${two(p.minute)}`;
}
function altitude(value: number): string { return Number.isFinite(value) ? `${value.toFixed(1)}°` : '—'; }

/** Reads core results only; does not search events or derive lunar dates in the UI. */
export function mountTeachingControls(after: HTMLElement, state: SimulationState, onChange: (reason?: string) => void, onOpenLoupe?: () => void): TeachingControls {
  const section = document.createElement('details');
  section.className = 'control-section teaching-section'; section.id = 'sky-teaching';
  section.innerHTML = `<summary>日月与历法</summary>
    <div class="moon-teaching"><div class="moon-teaching-row"><span class="moon-phase-name">月相读数尚未就绪</span><button type="button" id="sky-moon-loupe-toggle" aria-pressed="false" aria-controls="sky-moon-loupe">月相放大镜</button></div><p class="moon-interpretation tiny-note"></p><p class="moon-loupe-status tiny-note" role="status"></p><details class="moon-model-details"><summary>月相口径</summary><p class="moon-phase-definition tiny-note"></p></details>
    <button type="button" id="sky-quarter-search">搜索相邻四月相</button><p class="moon-quarter-seed tiny-note"></p><div class="moon-quarter-events event-grid"></div><p class="moon-quarter-status tiny-note" role="status"></p><button type="button" id="sky-quarter-export" hidden>导出月相时刻</button></div>
    <div class="solar-day-section"><p class="solar-day-heading"></p><p class="solar-day-status tiny-note" role="status">展开后计算当地日事件。</p><div class="solar-day-events event-grid"></div><p class="solar-day-range tiny-note"></p><p class="solar-no-event tiny-note"></p><div class="twilight-events"></div><details class="solar-definition-details"><summary>事件口径</summary><p class="solar-day-definition tiny-note"></p><p class="solar-day-notes tiny-note"></p></details></div>
    <p class="lunar-calendar-definition tiny-note">农历以UTC+8民用日期为日界，与月相照亮比例独立。</p><details class="lunar-calendar-details"><summary>数据来源与边界</summary><p class="lunar-calendar-source tiny-note"></p></details>`;
  after.insertAdjacentElement('afterend', section);
  const calendarLine = document.createElement('span'); calendarLine.className = 'lunar-calendar-readout';
  calendarLine.textContent = '农历：数据尚未就绪';
  after.querySelector('.body-readouts')!.append(calendarLine);
  const stage = document.querySelector<HTMLElement>('#sky-stage')!;
  const loupe = document.createElement('aside'); loupe.id = 'sky-moon-loupe'; loupe.hidden = true;
  loupe.setAttribute('aria-label', '月相教学放大镜'); loupe.setAttribute('data-sky-occlusion', '');
  loupe.innerHTML = `<header><span>月相教学放大</span><button type="button" id="sky-moon-loupe-close" aria-label="关闭月相放大镜">×</button></header><div id="sky-moon-loupe-viewport" aria-label="同一科学快照的月相绘制区域"></div><p class="moon-loupe-scale"></p><p class="moon-loupe-view"></p><p class="moon-loupe-definition">科学月盘 · 不含画面折射</p><p class="moon-loupe-horizon"></p>`;
  stage.append(loupe);
  const listeners: Array<() => void> = [];
  const listen = (element: EventTarget, event: string, handler: EventListener) => { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); };
  const text = (selector: string, value: string) => { const el = section.querySelector<HTMLElement>(selector)!; if (el.textContent !== value) el.textContent = value; };
  let data: TeachingData | undefined;
  let snapshot: ScienceSnapshot | undefined;
  let loupeOpen = false;
  let loupeAvailable = true;
  let loupeStatus: 'pending' | 'ready' | 'error' = 'pending';
  let loupeMessage = '';
  let magnification: number | null = null;
  let seed: number | null = null;
  let solarSignature = '';
  let quarterSignature = '';
  let disposed = false;
  function syncLoupe() {
    const button = section.querySelector<HTMLButtonElement>('#sky-moon-loupe-toggle')!;
    button.disabled = !loupeAvailable;
    button.setAttribute('aria-pressed', String(loupeOpen)); button.textContent = loupeOpen ? '关闭放大镜' : '月相放大镜';
    loupe.hidden = !loupeAvailable || !loupeOpen || loupeStatus !== 'ready';
    text('.moon-loupe-status', !loupeAvailable ? '2D仅显示月球方向；月面放大镜不可用，月相读数保留。' : loupeOpen && loupeStatus !== 'ready' ? loupeMessage || (loupeStatus === 'error' ? '月相绘制不可用。' : '月相纹理与姿态正在准备。') : '');
    loupe.querySelector('.moon-loupe-scale')!.textContent = Number.isFinite(magnification) && magnification !== null ? `视场中心角比例 ×${magnification.toFixed(1)}` : '非真实角径';
    loupe.querySelector('.moon-loupe-view')!.textContent = `随当前视野朝向 · ${state.viewMode === 'ground' ? '站心' : '地心'}`;
    const moonAltitude = snapshot?.bodies.find(body => body.id === 'Moon')?.geometricAltitudeDeg;
    loupe.querySelector('.moon-loupe-horizon')!.textContent = moonAltitude === undefined ? '月球高度尚未就绪' : moonAltitude < 0 ? '当前月球在几何地平下' : '当前月球在几何地平上';
  }
  function showLoupe(open: boolean) {
    if (open && !loupeAvailable) return;
    loupeOpen = open; syncLoupe();
    window.dispatchEvent(new CustomEvent('sky:moon-loupe', { detail: { open } }));
    if (open) onOpenLoupe?.();
  }
  function eventButton(label: string, ut: number | null, zone: DisplayZone, showDate = false): HTMLButtonElement | HTMLElement {
    if (ut === null) { const span = document.createElement('span'); span.className = 'event-unavailable'; span.textContent = `${label} 无事件`; return span; }
    const button = document.createElement('button'); button.type = 'button'; button.dataset.eventUt = String(ut);
    const parts = localCivilParts(ut, zone);
    const date = showDate ? `${parts.year}-${two(parts.month)}-${two(parts.day)} ` : '';
    button.textContent = `${label} ${date}${eventClock(ut, zone)}`; button.title = `${formatCivil(ut, zone)} · ${zoneLabel(zone)}；跳转并暂停`;
    return button;
  }
  function renderSolar(day: SolarDayEvents | undefined) {
    const events = section.querySelector<HTMLElement>('.solar-day-events')!;
    const twilight = section.querySelector<HTMLElement>('.twilight-events')!;
    events.replaceChildren(); twilight.replaceChildren();
    section.querySelector<HTMLElement>('.solar-definition-details')!.hidden = !day;
    if (!day) {
      text('.solar-day-heading', '太阳日事件'); text('.solar-day-range', ''); text('.solar-no-event', ''); text('.solar-day-definition', ''); text('.solar-day-notes', ''); return;
    }
    const zone = day.bounds.displayZone;
    text('.solar-day-heading', `${day.dateLocal} · ${zoneLabel(zone)}`);
    events.append(eventButton('日出', day.riseUtDaysJ2000, zone), eventButton('日落', day.setUtDaysJ2000, zone));
    text('.solar-day-range', `全天太阳几何高度 ${altitude(day.minimumGeometricAltitudeDeg)} 至 ${altitude(day.maximumGeometricAltitudeDeg)}`);
    text('.solar-no-event', [day.noEventReason, day.twilightSummary].filter(Boolean).join('；'));
    text('.solar-day-definition', day.definition);
    text('.solar-day-notes', [...day.notes, '点击事件时刻跳转并暂停；主时间栏使用当前显示时区。'].join('；'));
    for (const [key, label] of [['civil', '民用 −6°'], ['nautical', '航海 −12°'], ['astronomical', '天文 −18°']] as const) {
      const result = day.twilight[key];
      const row = document.createElement('div'); row.className = 'twilight-row';
      const heading = document.createElement('span'); heading.className = 'twilight-label'; heading.textContent = label;
      const buttons = document.createElement('div'); buttons.className = 'event-grid';
      buttons.append(eventButton('晨', result.dawnUtDaysJ2000, zone), eventButton('昏', result.duskUtDaysJ2000, zone));
      row.append(heading, buttons);
      if (result.noEventReason) { const note = document.createElement('p'); note.className = 'tiny-note'; note.textContent = result.noEventReason; row.append(note); }
      twilight.append(row);
    }
  }
  function update(next?: TeachingData) {
    data = next;
    const calendar = data?.lunarCalendar;
    calendarLine.textContent = calendar ? `农历（UTC+8）${calendar.label}${calendar.uncertain ? '（预报不确定）' : ''}` : '农历（UTC+8）：数据尚未就绪';
    calendarLine.title = calendar ? `${calendar.civilDate ?? ''} · ${calendar.calendarZone}；${calendar.sourceNote}` : '固定UTC+8民用日界。';
    calendarLine.classList.toggle('calendar-uncertain', calendar?.uncertain ?? false);
    text('.lunar-calendar-source', calendar ? `${calendar.civilDate ?? ''} · ${calendar.calendarZone}；${calendar.sourceNote}` : '');
    const moon = data?.moon;
    text('.moon-phase-name', moon ? moon.phaseNameZh : '月相读数尚未就绪');
    text('.moon-interpretation', moon ? `${moon.perspective === 'topocentric' ? '站心' : '地心'}观测 · 照亮 ${(moon.illuminatedFraction * 100).toFixed(1)}%` : '');
    text('.moon-phase-definition', moon?.phaseNameDefinition ?? '');
    const status = data?.solarDayStatus;
    const dayLabels = { normal: '当地日升落事件', 'continuous-daylight': '全天连续日照', 'no-sunrise': '全天无日出', grazing: '地平擦边', 'search-incomplete': '事件搜索未完成' };
    text('.solar-day-status', status === 'error' ? data?.solarDayError || '当天事件计算失败。' : status === 'pending' ? '正在计算当前地点与当地日；旧结果已清除。' : status === 'ready' ? data?.solarDay ? dayLabels[data.solarDay.state] : '当天结果未提供。' : '展开后计算当地日事件。');
    const signature = `${data?.solarDayKey ?? ''}:${status ?? ''}`;
    if (signature !== solarSignature) { solarSignature = signature; renderSolar(status === 'ready' ? data?.solarDay : undefined); }
    const phases = data?.moonPhases;
    const phaseSignature = phases ? JSON.stringify([phases.events, state.observer.displayZone]) : '';
    if (phaseSignature !== quarterSignature) {
      quarterSignature = phaseSignature;
      const root = section.querySelector<HTMLElement>('.moon-quarter-events')!; root.replaceChildren();
      for (const event of phases?.events.slice(0, 4) ?? []) root.append(eventButton(event.labelZh, event.utDaysJ2000, state.observer.displayZone, true));
      section.querySelector<HTMLElement>('#sky-quarter-export')!.hidden = !phases;
    }
    text('.moon-quarter-seed', `月相种子：${formatCivil(seed ?? phases?.seedUtDaysJ2000 ?? state.time.utDaysJ2000, { kind: 'fixed', offsetMinutes: 0 })} UTC`);
    text('.moon-quarter-status', data?.moonPhaseStatus === 'error' ? data.moonPhaseError || '月相搜索失败。' : data?.moonPhaseStatus === 'pending' ? '正在搜索相邻月相事件。' : phases ? `${phases.complete ? '' : `支持范围内仅${phases.events.length}个事件；${phases.notes.join('；')}；`}按钮时刻为${zoneLabel(state.observer.displayZone)}；跳转并暂停，保留地点与相机。` : '按需搜索地心黄经差事件；不由照亮比例推算日期。');
    syncLoupe();
  }
  const isVisible = () => section.open && section.getClientRects().length > 0;
  listen(section, 'toggle', () => { window.dispatchEvent(new CustomEvent('sky:teaching-visibility', { detail: { visible: isVisible() } })); });
  listen(section.querySelector('#sky-moon-loupe-toggle')!, 'click', () => showLoupe(!loupeOpen));
  listen(loupe.querySelector('#sky-moon-loupe-close')!, 'click', () => showLoupe(false));
  listen(section.querySelector('#sky-quarter-search')!, 'click', () => { seed ??= state.time.utDaysJ2000; window.dispatchEvent(new CustomEvent('sky:moon-quarter-search', { detail: { seedUtDaysJ2000: seed } })); });
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) listen(loupe, event, event => event.stopPropagation());
  listen(section, 'click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-event-ut]');
    if (!button) return;
    try { applyState(state, { ...state, time: { ...state.time, utDaysJ2000: Number(button.dataset.eventUt), running: false, mode: 'simulation' } }); onChange('time-event'); }
    catch (error) { text('.solar-day-status', error instanceof Error ? error.message : String(error)); }
  });
  listen(section.querySelector('#sky-quarter-export')!, 'click', () => {
    if (!data?.moonPhases) return;
    const saved = { ...data.moonPhases, seedUtc: utToDate(data.moonPhases.seedUtDaysJ2000).toISOString(), events: data.moonPhases.events.map(event => ({ ...event, utc: utToDate(event.utDaysJ2000).toISOString() })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sky-derived-moon-phases.json'; link.click(); URL.revokeObjectURL(url);
  });
  update();
  return {
    update(next, nextSnapshot) { if (!disposed) { snapshot = nextSnapshot ?? snapshot; update(next); } },
    isVisible,
    getMoonLoupeViewport() { return !disposed && loupeAvailable && loupeOpen && loupeStatus === 'ready' && !loupe.hidden ? loupe.querySelector<HTMLElement>('#sky-moon-loupe-viewport')!.getBoundingClientRect() : null; },
    setMoonLoupeCapability(available) { if (disposed) return; loupeAvailable = available; if (!available && loupeOpen) showLoupe(false); else syncLoupe(); },
    setMoonLoupeAvailability(status, message, info) { if (disposed) return; const changed = status !== loupeStatus; loupeStatus = status; loupeMessage = message ?? ''; if (info?.magnificationRelativeToMain !== undefined) magnification = info.magnificationRelativeToMain; syncLoupe(); if (changed && loupeOpen) window.dispatchEvent(new CustomEvent('sky:moon-loupe', { detail: { open: true } })); },
    setMoonPhaseSeed(ut) { seed = ut; if (data) data = { ...data, moonPhases: undefined, moonPhaseStatus: undefined, moonPhaseError: undefined }; quarterSignature = 'invalidated'; update(data); },
    invalidate() { solarSignature = ''; renderSolar(undefined); text('.solar-day-status', section.open ? '正在更新当前地点与当地日。' : '展开后计算当地日事件。'); },
    dispose() { disposed = true; listeners.forEach(remove => remove()); section.remove(); loupe.remove(); calendarLine.remove(); },
  };
}
