import type { DisplayZone, SimulationState } from '../contracts';
import { formatCivil, formatEraYear, localCivilParts, parseCivilInput, utToDate } from '../core/time';
import { createTimeNavigationWindow, sliderFractionToUt, stepTimeNavigation, shiftTimeNavigationWindow, utToSliderFraction } from '../core/time-navigation';
import type { TimeAmbiguityPolicy, TimeNavigationSpan, TimeNavigationWindow } from '../core/time-navigation';
import { applyState } from '../state';
import { trackFormDraft } from './form-draft';

const two = (value: number) => String(value).padStart(2, '0');
const year = (value: number) => value < 0 ? `-${String(-value).padStart(4, '0')}` : String(value).padStart(4, '0');
export function displayZoneLabel(zone: DisplayZone): string {
  if (zone.kind === 'iana') return zone.name;
  const magnitude = Math.abs(zone.offsetMinutes);
  return `UTC${zone.offsetMinutes < 0 ? '−' : '+'}${two(Math.floor(magnitude / 60))}:${two(magnitude % 60)}`;
}
export interface TimeControls { sync(): void; cancelSession(resetWindow?: boolean): void; dispose(): void }

/** Civil conversion and navigation come from the shared pure time module. */
export function mountTimeControls(section: HTMLElement, state: SimulationState,
  onChange: (reason: string) => void, onError: (message: string) => void): TimeControls {
  section.innerHTML = `<div class="section-heading"><h2>时间</h2><span class="input-zone-label"></span></div>
    <form id="sky-time-form" class="time-form"><label for="sky-date">日期</label><input id="sky-date" type="text" autocomplete="off" aria-label="当前时区日期，天文纪年" title="0为公元前1年；−1为公元前2年；前推格里高利历"><label for="sky-time">时刻</label><input id="sky-time" type="text" inputmode="numeric" autocomplete="off" aria-label="当前时区时分秒"><button type="submit" class="apply-time">应用</button></form>
    <p class="time-controls-status tiny-note" role="status" aria-live="polite"></p><details class="time-zone-settings"><summary>时区设置</summary><form id="sky-zone-form" class="zone-form"><label for="sky-zone-kind">规则</label><select id="sky-zone-kind"><option value="fixed">固定偏移</option><option value="iana">命名时区</option></select><label class="fixed-zone-field" for="sky-zone-offset">UTC偏移</label><input class="fixed-zone-field" id="sky-zone-offset" type="text" autocomplete="off" placeholder="+08:00" aria-label="固定UTC偏移，正负小时和分钟"><label class="iana-zone-field" for="sky-zone-name" hidden>IANA</label><input class="iana-zone-field" id="sky-zone-name" type="text" autocomplete="off" placeholder="America/New_York" aria-label="IANA时区名称" hidden><button type="submit">应用时区</button></form><p class="tiny-note">只改显示时区，保持UTC与天空。城市不自动推时区。</p><p class="iana-zone-note tiny-note" hidden>命名规则使用当前浏览器Intl，仅1900–2100；扩展年代请用固定偏移。</p></details>
    <label class="time-ambiguity-row" hidden for="sky-time-ambiguity">重复时刻<select id="sky-time-ambiguity"><option value="reject">拒绝</option><option value="earlier">早一次</option><option value="later">晚一次</option></select></label>
    <div class="time-navigation-heading"><label for="sky-time-span">跨度</label><select id="sky-time-span" aria-label="时间滑条跨度"><option value="hour">UTC一小时</option><option value="day">民用日 · 细调</option><option value="month">民用月</option></select></div>
    <input id="sky-day-slider" type="range" min="0" max="1" step="any" aria-label="当前固定时间窗口滑条"><p class="time-window-label tiny-note"></p>
    <div class="step-actions"><button type="button" data-time-window="-1" aria-label="跳到前一个时间窗口" title="跳到前一个时间窗口并暂停">‹前窗</button><button type="button" data-time-step="-1">−1天</button><button type="button" data-time-step="1">+1天</button><button type="button" data-time-window="1" aria-label="跳到后一个时间窗口" title="跳到后一个时间窗口并暂停">后窗›</button></div>
    <div class="time-actions"><button type="button" data-action="play" aria-label="播放或暂停">播放</button><button type="button" data-action="realtime">实时</button><button type="button" data-action="reverse" title="改变模拟播放方向" aria-label="反向播放">正向</button><select id="sky-rate" aria-label="模拟秒每真实秒"><option value="1">1×</option><option value="60">60×</option><option value="600">600×</option><option value="3600">3600×</option><option value="86400">1天/秒</option></select></div>
    <div class="time-readouts"><span class="utc-readout"></span><span class="era-readout"></span><span class="lst-readout">当地恒星时 —</span></div>`;
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const slider = query<HTMLInputElement>('#sky-day-slider');
  const kind = query<HTMLSelectElement>('#sky-zone-kind');
  const spanControl = query<HTMLSelectElement>('#sky-time-span');
  const ambiguity = query<HTMLSelectElement>('#sky-time-ambiguity');
  const draft = trackFormDraft(query<HTMLFormElement>('#sky-time-form'));
  const listeners: Array<() => void> = [];
  let span: TimeNavigationSpan = 'day', window: TimeNavigationWindow | null = null, session: TimeNavigationWindow | null = null;
  let zoneSignature = '', disposed = false;
  const policy = () => ambiguity.value as TimeAmbiguityPolicy;
  function listen(target: EventTarget, type: string, handler: EventListener) { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)); }
  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) { if (element.value !== value) element.value = value; }
  function put(selector: string, value: string) { const element = query<HTMLElement>(selector); if (element.textContent !== value) element.textContent = value; }
  function tryAction(action: () => void) { try { action(); put('.time-controls-status', ''); } catch (error) { const message = error instanceof Error ? error.message : String(error); put('.time-controls-status', message); onError(message); } }
  function zoneFields() {
    for (const element of section.querySelectorAll<HTMLElement>('.fixed-zone-field')) element.hidden = kind.value !== 'fixed';
    for (const element of section.querySelectorAll<HTMLElement>('.iana-zone-field, .iana-zone-note')) element.hidden = kind.value !== 'iana';
  }
  function sync() {
    if (disposed) return;
    setValue(spanControl, span);
    const zone = state.observer.displayZone, civil = localCivilParts(state.time.utDaysJ2000, zone);
    const nextZoneSignature = JSON.stringify(zone);
    if (nextZoneSignature !== zoneSignature) draft.clear();
    if (!draft.isDirty()) {
      setValue(query<HTMLInputElement>('#sky-date'), `${year(civil.year)}-${two(civil.month)}-${two(civil.day)}`);
      setValue(query<HTMLInputElement>('#sky-time'), `${two(civil.hour)}:${two(civil.minute)}:${two(civil.second)}`);
    }
    put('.input-zone-label', displayZoneLabel(zone));
    const root = section.closest('#controls')!;
    root.querySelector('.compact-clock')!.textContent = `${two(civil.hour)}:${two(civil.minute)}`;
    root.querySelector('.compact-zone')!.textContent = zone.kind === 'fixed' ? displayZoneLabel(zone).replace(':00', '') : zone.name.split('/').at(-1)!.replaceAll('_', ' ');
    root.querySelector('.compact-time')!.setAttribute('title', `${formatCivil(state.time.utDaysJ2000, zone)} · ${displayZoneLabel(zone)}`);
    put('.era-readout', `${formatEraYear(civil.year)} · 前推格里高利历`);
    const utc = utToDate(state.time.utDaysJ2000);
    put('.utc-readout', `UTC ${year(utc.getUTCFullYear())}-${two(utc.getUTCMonth() + 1)}-${two(utc.getUTCDate())} ${two(utc.getUTCHours())}:${two(utc.getUTCMinutes())}:${two(utc.getUTCSeconds())}`);
    if (nextZoneSignature !== zoneSignature) {
      zoneSignature = nextZoneSignature; session = null; window = null; kind.value = zone.kind;
      if (zone.kind === 'fixed') query<HTMLInputElement>('#sky-zone-offset').value = displayZoneLabel(zone).replace('UTC', '').replace('−', '-');
      else query<HTMLInputElement>('#sky-zone-name').value = zone.name;
      zoneFields();
    }
    query<HTMLElement>('.time-ambiguity-row').hidden = zone.kind !== 'iana';
    const unit = span === 'hour' ? '时' : span === 'day' ? '天' : '月';
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-time-step]')) button.textContent = `${Number(button.dataset.timeStep) < 0 ? '−' : '+'}1${unit}`;
    try {
      if (!session && (!window || window.span !== span || utToSliderFraction(window, state.time.utDaysJ2000) === null)) window = createTimeNavigationWindow(state.time.utDaysJ2000, span, zone, policy());
      const active = session ?? window!;
      const fraction = utToSliderFraction(active, state.time.utDaysJ2000);
      if (fraction !== null) slider.value = String(fraction);
      slider.disabled = false;
      slider.step = String((span === 'month' ? 60 : 1) / ((active.endUtDaysJ2000 - active.startUtDaysJ2000) * 86400));
      slider.setAttribute('aria-valuetext', `${formatCivil(state.time.utDaysJ2000, zone)} · ${displayZoneLabel(zone)}`);
      put('.time-window-label', `${formatCivil(active.startUtDaysJ2000, zone)} → ${formatCivil(active.endUtDaysJ2000, zone)}${active.rangeClippedStart || active.rangeClippedEnd ? '（支持范围边界）' : ''}`);
    } catch (error) { slider.disabled = true; put('.time-window-label', error instanceof Error ? error.message : String(error)); }
  }
  function cancelSession(resetWindow = false) { session = null; if (resetWindow) { window = null; draft.clear(); } sync(); }
  function setUt(ut: number, reason: string) { applyState(state, { ...state, time: { ...state.time, utDaysJ2000: ut, running: false, mode: 'simulation' } }); draft.clear(); onChange(reason); }
  listen(query('#sky-time-form'), 'submit', event => {
    event.preventDefault(); tryAction(() => {
      const date = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/.exec(query<HTMLInputElement>('#sky-date').value.trim());
      const time = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(query<HTMLInputElement>('#sky-time').value.trim());
      if (!date || !time) throw new Error('日期用年-月-日，时刻用时:分:秒；公元前1年填0。');
      const ut = parseCivilInput({ astronomicalYear: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: Number(time[1]), minute: Number(time[2]), second: Number(time[3] ?? 0), zone: state.observer.displayZone, ambiguousTime: policy() });
      session = null; window = null; setUt(ut, 'time-input');
    });
  });
  listen(kind, 'change', zoneFields);
  listen(query('#sky-zone-form'), 'submit', event => {
    event.preventDefault(); tryAction(() => {
      let zone: DisplayZone;
      if (kind.value === 'fixed') {
        const match = /^([+-])(\d{1,2}):([0-5]\d)$/.exec(query<HTMLInputElement>('#sky-zone-offset').value.trim());
        if (!match) throw new Error('固定偏移用+08:00或-05:30；允许±14:00内整数分钟。');
        zone = { kind: 'fixed', offsetMinutes: (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) };
      } else {
        const name = query<HTMLInputElement>('#sky-zone-name').value.trim();
        zone = { kind: 'iana', name, versionNote: state.observer.displayZone.kind === 'iana' && state.observer.displayZone.name === name ? state.observer.displayZone.versionNote : '运行环境Intl时区规则；民用输入/导航仅1900–2100；未声明固定tzdata版本。' };
      }
      applyState(state, { ...state, observer: { ...state.observer, displayZone: zone } });
      session = null; window = null; onChange('display-zone');
    });
  });
  listen(spanControl, 'change', () => { span = spanControl.value as TimeNavigationSpan; window = null; cancelSession(); });
  listen(ambiguity, 'change', () => { session = null; window = null; sync(); });
  // Freeze the displayed window, including its selectable next-day endpoint.
  listen(slider, 'pointerdown', () => tryAction(() => { if (!slider.disabled) { window ??= createTimeNavigationWindow(state.time.utDaysJ2000, span, state.observer.displayZone, policy()); session = window; } }));
  listen(slider, 'input', () => tryAction(() => { session ??= window; if (!session) return; setUt(sliderFractionToUt(session, slider.valueAsNumber), 'time-slider'); }));
  listen(slider, 'keyup', () => cancelSession());
  listen(slider, 'blur', () => cancelSession());
  for (const event of ['pointerup', 'pointercancel']) listen(slider, event, () => cancelSession());
  listen(globalThis.window, 'blur', () => cancelSession());
  listen(section, 'click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-time-step], [data-time-window]');
    if (!button) return;
    tryAction(() => {
      if (button.dataset.timeWindow) {
        const next = shiftTimeNavigationWindow(window ?? createTimeNavigationWindow(state.time.utDaysJ2000, span, state.observer.displayZone, policy()), Number(button.dataset.timeWindow) as -1 | 1, policy());
        session = null; window = next; setUt(next.anchorUtDaysJ2000, 'time-window');
      } else { session = null; window = null; setUt(stepTimeNavigation(state.time.utDaysJ2000, span, Number(button.dataset.timeStep), state.observer.displayZone, policy()), 'time-step'); }
    });
  });
  sync();
  return { sync, cancelSession, dispose() { disposed = true; draft.dispose(); listeners.forEach(remove => remove()); } };
}
