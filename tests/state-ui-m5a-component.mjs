import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// These are display/interaction fixtures, not astronomical reference results.
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5a-ui/component';
const origin = new URL(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/').origin;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] });
const checks = []; let page;
try {
  page = await browser.newPage();
  await page.route(`${origin}/__ui_m5a_component`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="fixture-host"></div></body></html>' }));
  await page.goto(`${origin}/__ui_m5a_component`);
  const result = await page.evaluate(async () => {
    const { mountObjectDayControls } = await import('/src/ui/object-day-controls.ts');
    const { createDefaultState } = await import('/src/state.ts');
    const state = createDefaultState(); state.selected = 'body:Moon';
    const parent = document.querySelector('#fixture-host'), jumped = [], visibility = [];
    window.addEventListener('sky:object-day-visibility', event => visibility.push(event.detail.visible));
    const ui = mountObjectDayControls(parent, state, ut => jumped.push(ut));
    const base = {
      id: 'body:Moon', kind: 'body', key: 'display-fixture', dateLocal: '2026-09-14',
      bounds: { startUtDaysJ2000: state.time.utDaysJ2000 - .5, endUtDaysJ2000: state.time.utDaysJ2000 + .5, displayZone: state.observer.displayZone },
      definitionVersion: 'display-fixture-only', definition: '月球站心上边缘，标准事件地平；显示夹具。', astrometryModelVersion: null,
      crossings: [
        { kind: 'rise', utDaysJ2000: state.time.utDaysJ2000 - .4, jumpAllowed: true, jumpBlockReason: null },
        { kind: 'set', utDaysJ2000: state.time.utDaysJ2000 - .2, jumpAllowed: true, jumpBlockReason: null },
        { kind: 'rise', utDaysJ2000: state.time.utDaysJ2000 + .1, jumpAllowed: true, jumpBlockReason: null },
        { kind: 'set', utDaysJ2000: state.time.utDaysJ2000 + .4, jumpAllowed: false, jumpBlockReason: '测试夹具：超出可编辑UTC范围' },
      ], state: 'events', geometricAltitudeRangeDeg: { minimum: -20, maximum: 25 }, clearanceRangeDeg: { minimum: -19, maximum: 26 },
      extremaTimes: { minimumUtDaysJ2000: state.time.utDaysJ2000 - .3, maximumUtDaysJ2000: state.time.utDaysJ2000 + .2 }, noEventReason: null, notes: ['显示夹具不验证科学值。'],
    };
    const update = day => ui.update({ objectDay: day, objectDayKey: day.key, objectDayStatus: 'ready' });
    const status = () => parent.querySelector('.object-day-status').textContent;
    update(base);
    const count = parent.querySelectorAll('[data-object-event-ut]').length;
    const buttons = [...parent.querySelectorAll('[data-object-event-ut]')];
    buttons[3].click(); buttons[3].dispatchEvent(new MouseEvent('click', { bubbles: true })); buttons[2].click();
    const blocked = buttons[3].disabled && parent.querySelector('.object-day-jump-reason').textContent.includes('超出');
    update({ ...base, crossings: [base.crossings[0]], state: 'events' }); const riseOnly = status();
    update({ ...base, crossings: [base.crossings[1]], state: 'events' }); const setOnly = status();
    update({ ...base, id: 'hip:11767', kind: 'star', crossings: [], state: 'always-above' }); const starAbove = status();
    update({ ...base, crossings: [], state: 'always-above' }); const moonAbove = status();
    update({ ...base, crossings: [], state: 'always-below' }); const below = status();
    update({ ...base, crossings: [], state: 'grazing', noEventReason: '近相切夹具' }); const grazing = status();
    update({ ...base, crossings: [], state: 'search-incomplete', noEventReason: '预算夹具' }); const incomplete = status();
    update(base); ui.invalidate();
    const cleared = parent.querySelectorAll('[data-object-event-ut]').length === 0 && parent.querySelector('.object-day-definition-details').hidden;
    ui.update({ objectDay: base, objectDayKey: 'other-current-target-key', objectDayStatus: 'ready' });
    const keyRejected = parent.querySelectorAll('[data-object-event-ut]').length === 0 && /正在/.test(status()) && parent.querySelector('#sky-object-day').dataset.objectDayStatus === 'pending';
    ui.update({ objectDayStatus: 'unsupported', objectDayUnsupportedReason: '星座整体不适用 <img src=x>' });
    const unsupported = status(), safe = parent.querySelectorAll('img').length === 0;
    ui.update({ objectDayStatus: 'error', objectDayError: '受控计算失败' }); const error = status();
    ui.notifyVisibility(true); const visible = ui.isVisible();
    parent.hidden = true; ui.notifyVisibility(true); const hidden = !ui.isVisible();
    parent.hidden = false; parent.querySelector('#sky-object-day').open = false; ui.notifyVisibility(true); const folded = !ui.isVisible();
    ui.dispose();
    return { count, jumped, allowedUt: base.crossings[2].utDaysJ2000, blocked, riseOnly, setOnly, starAbove, moonAbove, below, grazing, incomplete, cleared, keyRejected, unsupported, safe, error, visible, hidden, folded, visibility, removed: parent.children.length === 0 };
  });
  assert.equal(result.count, 4); assert.deepEqual(result.jumped, [result.allowedUt]); assert.equal(result.blocked, true);
  checks.push('All four fixture crossings render without pair truncation; a disabled out-of-range crossing cannot jump even through a dispatched click and its reason is visible.');
  assert.match(result.riseOnly, /仅有升起/); assert.match(result.setOnly, /仅有落下/);
  assert.match(result.starAbove, /本日周极/); assert.doesNotMatch(result.moonAbove, /周极/); assert.match(result.below, /本日终日不升/);
  assert.match(result.grazing, /相切/); assert.match(result.incomplete, /未完成.*不能/);
  checks.push('Single-direction, current-day always-above/below, grazing and incomplete states are distinct; the Moon is not labeled a permanently circumpolar star.');
  assert.equal(result.cleared, true); assert.equal(result.keyRejected, true); assert.equal(result.safe, true); assert.match(result.unsupported, /星座整体不适用/); assert.match(result.error, /受控计算失败/);
  checks.push('Pending clears old values, mismatched authoritative keys are not displayed, and error/unsupported text remains safe literal content.');
  assert.ok(result.visible && result.hidden && result.folded && result.removed);
  assert.deepEqual(result.visibility, [true, false, false]);
  checks.push('Component demand follows selection, open details and actual visible ancestors; hide/fold/dispose does not change scientific state.');
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ stage: 'isolated UI fixture', url: origin, checks, browserClosed: true, limits: ['Fixtures test display and interaction only, not astronomical event accuracy.', 'No app clock, worker, GPU, performance or physical-phone result is claimed.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
