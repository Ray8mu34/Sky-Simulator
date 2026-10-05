import type { SimulationState } from '../contracts';
import type { TeachingData } from '../core/teaching';
import { formatCivil, localCivilParts } from '../core/time';
import { displayZoneLabel } from './time-controls';

export interface ObjectDayControls {
  update(data?: TeachingData): void;
  invalidate(): void;
  isVisible(): boolean;
  notifyVisibility(force?: boolean): void;
  dispose(): void;
}

/** A view of the shared day-event result, with no event solver or science cache. */
export function mountObjectDayControls(parent: HTMLElement, state: SimulationState,
  onJump: (utDaysJ2000: number) => void): ObjectDayControls {
  const section = document.createElement('details');
  section.id = 'sky-object-day'; section.className = 'object-day-section'; section.open = true;
  section.innerHTML = `<summary>本日升落</summary><p class="object-day-heading tiny-note"></p><p class="object-day-status tiny-note" role="status" aria-live="polite"></p><div class="object-day-events event-grid"></div><p class="object-day-reason tiny-note"></p><details class="object-day-definition-details" hidden><summary>事件口径</summary><p class="object-day-definition tiny-note"></p><p class="object-day-range tiny-note"></p><p class="object-day-notes tiny-note"></p></details>`;
  parent.append(section);
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const put = (selector: string, value: string) => { const element = query<HTMLElement>(selector); if (element.textContent !== value) element.textContent = value; };
  const listeners: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: EventListener) => { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)); };
  let disposed = false, previousVisible: boolean | undefined;
  let renderedDay: TeachingData['objectDay'];
  let renderedStatus = '', renderedMessage = '', renderedKey: string | undefined;
  function isVisible() {
    return !disposed && state.selected !== null && section.open && section.getClientRects().length > 0 && getComputedStyle(section).visibility !== 'hidden';
  }
  function notifyVisibility(force = false) {
    const visible = isVisible();
    if (!force && visible === previousVisible) return;
    previousVisible = visible;
    window.dispatchEvent(new CustomEvent('sky:object-day-visibility', { detail: { visible } }));
  }
  function clear(status: string, message: string) {
    renderedDay = undefined; renderedStatus = status; renderedMessage = message; renderedKey = undefined;
    section.dataset.objectDayStatus = status; delete section.dataset.objectDayKey; delete section.dataset.objectDayState;
    query('.object-day-events').replaceChildren();
    query<HTMLElement>('.object-day-definition-details').hidden = true;
    put('.object-day-heading', `本日 · ${displayZoneLabel(state.observer.displayZone)}`);
    put('.object-day-status', message); put('.object-day-reason', '');
    put('.object-day-definition', ''); put('.object-day-range', ''); put('.object-day-notes', '');
  }
  function update(data?: TeachingData) {
    if (disposed) return;
    const status = data?.objectDayStatus;
    const day = data && status === 'ready' && data.objectDay?.key === data.objectDayKey ? data.objectDay : undefined;
    const message = status === 'error' ? data?.objectDayError || '本日升落计算失败。'
      : status === 'unsupported' ? data?.objectDayUnsupportedReason || '此对象不提供整体升落事件。'
      : status === 'pending' || status === 'ready' ? '正在计算当前对象、地点与当地日；旧结果已清除。'
      : '展开后计算所选对象的本日升落。';
    if (!day) {
      const emptyStatus = status === 'ready' ? 'pending' : status ?? '';
      if (renderedDay || renderedStatus !== emptyStatus || renderedMessage !== message) clear(emptyStatus, message);
      return;
    }
    if (day === renderedDay && renderedKey === data?.objectDayKey && renderedStatus === status) return;
    renderedDay = day; renderedKey = data?.objectDayKey; renderedStatus = 'ready'; renderedMessage = '';
    section.dataset.objectDayStatus = 'ready'; section.dataset.objectDayKey = day.key; section.dataset.objectDayState = day.state;
    put('.object-day-heading', `${day.dateLocal} · ${displayZoneLabel(day.bounds.displayZone)}`);
    const rises = day.crossings.filter(event => event.kind === 'rise').length;
    const sets = day.crossings.length - rises;
    const stateText = day.state === 'events' ? rises && sets ? `本日升落 · ${day.crossings.length}次` : rises ? '本日仅有升起事件' : sets ? '本日仅有落下事件' : '本日未列出升落事件'
      : day.state === 'always-above' ? day.kind === 'star' ? '本日周极：始终在事件地平以上' : '本日始终在事件地平以上'
      : day.state === 'always-below' ? '本日终日不升'
      : day.state === 'grazing' ? '本日接近相切；大气微扰可能改变事件'
      : '事件搜索未完成；不能据此判断本日不升或不落';
    put('.object-day-status', stateText);
    put('.object-day-reason', day.noEventReason ?? '');
    const events = query('.object-day-events'); events.replaceChildren();
    for (const event of day.crossings) {
      const item = document.createElement('div'); item.className = 'object-day-event';
      const button = document.createElement('button'); button.type = 'button';
      const civil = localCivilParts(event.utDaysJ2000, day.bounds.displayZone);
      const label = day.id === 'body:Sun' ? event.kind === 'rise' ? '日出' : '日落' : day.id === 'body:Moon' ? event.kind === 'rise' ? '月升' : '月落' : event.kind === 'rise' ? '升起' : '落下';
      button.textContent = `${label} ${String(civil.hour).padStart(2, '0')}:${String(civil.minute).padStart(2, '0')}`;
      button.dataset.objectEventUt = String(event.utDaysJ2000); button.dataset.crossingKind = event.kind;
      button.disabled = !event.jumpAllowed;
      button.title = `${formatCivil(event.utDaysJ2000, day.bounds.displayZone)} · ${displayZoneLabel(day.bounds.displayZone)}；${event.jumpAllowed ? '跳转并暂停' : event.jumpBlockReason || '超出可跳转范围'}`;
      item.append(button);
      if (!event.jumpAllowed) { const reason = document.createElement('small'); reason.className = 'object-day-jump-reason tiny-note'; reason.textContent = event.jumpBlockReason || '超出可跳转范围'; item.append(reason); }
      events.append(item);
    }
    query<HTMLElement>('.object-day-definition-details').hidden = false;
    put('.object-day-definition', day.definition);
    put('.object-day-range', `全天中心几何高度 ${day.geometricAltitudeRangeDeg.minimum.toFixed(1)}° 至 ${day.geometricAltitudeRangeDeg.maximum.toFixed(1)}°`);
    put('.object-day-notes', [...day.notes, '事件采用标准大气地平口径；画面折射、地景与光污染不改变升落时刻。'].join('；'));
  }
  listen(section, 'toggle', () => notifyVisibility(true));
  listen(section, 'click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-object-event-ut]');
    if (!button || button.disabled || !renderedDay || renderedStatus !== 'ready') return;
    // Only the actual allowed crossing from the current authoritative result can jump.
    const crossing = renderedDay.crossings.find(crossing => crossing.jumpAllowed && String(crossing.utDaysJ2000) === button.dataset.objectEventUt);
    if (!crossing) return;
    try { onJump(crossing.utDaysJ2000); }
    catch (error) { put('.object-day-status', error instanceof Error ? error.message : String(error)); }
  });
  clear('', '展开后计算所选对象的本日升落。');
  return {
    update, isVisible, notifyVisibility,
    invalidate() { if (!disposed) clear('pending', '正在更新当前对象、地点与当地日；旧结果已清除。'); },
    dispose() { disposed = true; listeners.forEach(remove => remove()); section.remove(); },
  };
}
