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
    <div class="moon-teaching"><div class="moon-teaching-row"><span class="moon-phase-name">正在加载月相…</span><button type="button" id="sky-moon-loupe-toggle" aria-pressed="false" aria-controls="sky-moon-loupe">月相放大镜</button></div><p class="moon-interpretation tiny-note"></p><p class="moon-loupe-status tiny-note" role="status"></p><details class="moon-model-details"><summary>月相说明</summary><p class="moon-phase-definition tiny-note"></p></details>
    <button type="button" id="sky-quarter-search">查看相邻月相</button><p class="moon-quarter-seed tiny-note"></p><div class="moon-quarter-events event-grid"></div><p class="moon-quarter-status tiny-note" role="status"></p><button type="button" id="sky-quarter-export" hidden>导出月相时刻</button></div>
    <div class="solar-day-section"><p class="solar-day-heading"></p><p class="solar-day-status tiny-note" role="status">展开查看日出日落。</p><div class="solar-day-events event-grid"></div><p class="solar-day-range tiny-note"></p><p class="solar-no-event tiny-note"></p><div class="twilight-events"></div><details class="solar-definition-details"><summary>日出日落说明</summary><p class="solar-day-definition tiny-note"></p><p class="solar-day-notes tiny-note"></p></details></div>
    <p class="lunar-calendar-definition tiny-note">农历按北京时间（UTC+8）显示。</p>`;
  after.insertAdjacentElement('afterend', section);
  const calendarLine = document.createElement('span'); calendarLine.className = 'lunar-calendar-readout';
  calendarLine.textContent = '农历 —';
  after.querySelector('.body-readouts')!.append(calendarLine);
  const stage = document.querySelector<HTMLElement>('#sky-stage')!;
  const loupe = document.createElement('aside'); loupe.id = 'sky-moon-loupe'; loupe.hidden = true;
  loupe.setAttribute('aria-label', '月相放大镜'); loupe.setAttribute('data-sky-occlusion', '');
  loupe.innerHTML = `<header><span>月相放大镜</span><button type="button" id="sky-moon-loupe-close" aria-label="关闭月相放大镜">×</button></header><div id="sky-moon-loupe-viewport" aria-label="月面"></div><p class="moon-loupe-scale"></p><p class="moon-loupe-view"></p><p class="moon-loupe-horizon"></p>`;
  stage.append(loupe);
  const listeners: Array<() => void> = [];
  const listen = (element: EventTarget, event: string, handler: EventListener) => { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); };
  const text = (selector: string, value: string) => { const el = section.querySelector<HTMLElement>(selector)!; if (el.textContent !== value) el.textContent = value; };
  let data: TeachingData | undefined;
  let snapshot: ScienceSnapshot | undefined;
  let loupeOpen = false;
  let loupeAvailable = true;
  let loupeStatus: 'pending' | 'ready' | 'error' = 'pending';
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
    text('.moon-loupe-status', !loupeAvailable ? '月相放大镜可在三维模式中使用。' : loupeOpen && loupeStatus !== 'ready' ? (loupeStatus === 'error' ? '月面加载失败，请关闭后重试。' : '正在加载月面…') : '');
    loupe.querySelector('.moon-loupe-scale')!.textContent = Number.isFinite(magnification) && magnification !== null ? `放大 ×${magnification.toFixed(1)}` : '月面放大';
    loupe.querySelector('.moon-loupe-view')!.textContent = '随当前视野朝向';
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
    text('.solar-no-event', day.state === 'search-incomplete' ? '暂未算出完整时刻，请重新选择日期。' : '');
    text('.solar-day-definition', '日出、日落按太阳上缘到达地平线的时刻计算，计入标准大气折射。');
    text('.solar-day-notes', '点击时刻可跳转查看。');
    for (const [key, label] of [['civil', '民用 −6°'], ['nautical', '航海 −12°'], ['astronomical', '天文 −18°']] as const) {
      const result = day.twilight[key];
      const row = document.createElement('div'); row.className = 'twilight-row';
      const heading = document.createElement('span'); heading.className = 'twilight-label'; heading.textContent = label;
      const buttons = document.createElement('div'); buttons.className = 'event-grid';
      buttons.append(eventButton('晨', result.dawnUtDaysJ2000, zone), eventButton('昏', result.duskUtDaysJ2000, zone));
      row.append(heading, buttons);
      const reason = result.state === 'always-above' ? `太阳全天高于${result.thresholdGeometricAltitudeDeg}°`
        : result.state === 'always-below' ? `太阳全天低于${result.thresholdGeometricAltitudeDeg}°`
        : result.state === 'grazing' ? '太阳接近此高度'
        : result.state === 'search-incomplete' ? '暂未算出完整晨昏时刻' : '';
      if (reason) { const note = document.createElement('p'); note.className = 'tiny-note'; note.textContent = reason; row.append(note); }
      twilight.append(row);
    }
  }
  function update(next?: TeachingData) {
    data = next;
    const calendar = data?.lunarCalendar;
    calendarLine.textContent = calendar ? `农历（UTC+8）${calendar.label}${calendar.uncertain ? '（预报不确定）' : ''}` : '农历（UTC+8）—';
    calendarLine.title = calendar ? `${calendar.civilDate ?? ''} · 北京时间（UTC+8）` : '固定UTC+8民用日界。';
    calendarLine.classList.toggle('calendar-uncertain', calendar?.uncertain ?? false);
    const moon = data?.moon;
    text('.moon-phase-name', moon ? moon.phaseNameZh : '正在加载月相…');
    text('.moon-interpretation', moon ? `月面照亮 ${(moon.illuminatedFraction * 100).toFixed(1)}%` : '');
    text('.moon-phase-definition', '新月、上弦、满月、下弦表示月球相对太阳的位置；照亮比例表示当前可见月面的明亮部分。');
    const status = data?.solarDayStatus;
    const dayLabels = { normal: '', 'continuous-daylight': '极昼 · 全天连续日照', 'no-sunrise': '全天无日出', grazing: '太阳掠过地平线', 'search-incomplete': '暂未算出完整日出日落时刻' };
    text('.solar-day-status', status === 'error' ? '日出日落计算失败，请重新选择日期或地点。' : status === 'pending' ? '正在计算日出日落…' : status === 'ready' ? data?.solarDay ? dayLabels[data.solarDay.state] : '暂无日出日落数据。' : '展开查看日出日落。');
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
    text('.moon-quarter-seed', phases || data?.moonPhaseStatus ? `查询起点：${formatCivil(seed ?? phases?.seedUtDaysJ2000 ?? state.time.utDaysJ2000, state.observer.displayZone)}` : '');
    text('.moon-quarter-status', data?.moonPhaseStatus === 'error' ? '月相查询失败，请调整日期后重试。' : data?.moonPhaseStatus === 'pending' ? '正在查询相邻月相…' : phases ? `${phases.complete ? '' : `当前日期范围内找到${phases.events.length}个月相。`}${zoneLabel(state.observer.displayZone)} · 点击时刻跳转` : '');
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
    setMoonLoupeAvailability(status, _message, info) { if (disposed) return; const changed = status !== loupeStatus; loupeStatus = status; if (info?.magnificationRelativeToMain !== undefined) magnification = info.magnificationRelativeToMain; syncLoupe(); if (changed && loupeOpen) window.dispatchEvent(new CustomEvent('sky:moon-loupe', { detail: { open: true } })); },
    setMoonPhaseSeed(ut) { seed = ut; if (data) data = { ...data, moonPhases: undefined, moonPhaseStatus: undefined, moonPhaseError: undefined }; quarterSignature = 'invalidated'; update(data); },
    invalidate() { solarSignature = ''; renderSolar(undefined); text('.solar-day-status', section.open ? '正在更新日出日落…' : '展开查看日出日落。'); },
    dispose() { disposed = true; listeners.forEach(remove => remove()); section.remove(); loupe.remove(); calendarLine.remove(); },
  };
}
