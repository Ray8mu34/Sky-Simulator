import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = new URL(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/').origin;
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5c-ui/playback-error-component';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] });
const checks = []; let result;
try {
  const page = await browser.newPage();
  await page.route(`${origin}/__ui_playback_error`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="sky-stage"></div><div id="controls"></div></body></html>' }));
  await page.goto(`${origin}/__ui_playback_error`);
  result = await page.evaluate(async () => {
    const { mountControls } = await import('/src/ui/controls.ts');
    const { createDefaultState } = await import('/src/state.ts');
    const { computeSnapshot } = await import('/src/core/astronomy.ts');
    const state = createDefaultState(); state.selected = 'body:Sun'; state.time.running = true; state.time.rateSimSecondsPerRealSecond = -60;
    const changes = [], parent = document.querySelector('#controls');
    const controls = mountControls(parent, state, reason => changes.push(reason));
    controls.update(computeSnapshot(state, 1));
    const put = (id, value) => { const input = parent.querySelector(`#${id}`); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    put('sky-date', '2026-10-01'); put('sky-time', '20:30:00');
    put('sky-latitude', '25.5'); put('sky-longitude', '135.5'); put('sky-height', '123');
    put('sky-pressure', '950.25'); put('sky-temperature', '-25');
    const fields = ['sky-date', 'sky-time', 'sky-latitude', 'sky-longitude', 'sky-height', 'sky-pressure', 'sky-temperature'];
    const drafts = () => fields.map(id => parent.querySelector(`#${id}`).value);
    const science = () => ['.sun-readout', '.moon-readout', '.object-epoch', '.object-alt', '.object-apparent-alt', '.object-notes', '.object-day-status', '.moon-phase-name'].map(selector => parent.querySelector(selector).textContent);
    const beforeDrafts = drafts(), beforeScience = science();
    // A valid new input is not paired with the previously displayed snapshot when its request fails.
    state.observer.latitudeDeg = -33.87; state.environment.refraction = 'standard'; state.environment.pressureHpa = 800; state.time.utDaysJ2000 += 10;
    state.time.running = false;
    const beforeSyncState = JSON.stringify(state); controls.syncPlayback();
    const text = selector => parent.querySelector(selector).textContent;
    const halted = { play: text('[data-action="play"]'), compact: text('[data-action="compact-play"]'), reverse: text('[data-action="reverse"]'), realtime: parent.querySelector('[data-action="realtime"]').getAttribute('aria-pressed'), footer: text('.playback-status') };
    const afterDrafts = drafts(), afterScience = science(), stateUnchanged = JSON.stringify(state) === beforeSyncState;
    state.time.mode = 'realtime'; state.time.running = true; state.time.rateSimSecondsPerRealSecond = 1; controls.syncPlayback();
    const live = { play: text('[data-action="play"]'), compact: text('[data-action="compact-play"]'), realtime: parent.querySelector('[data-action="realtime"]').getAttribute('aria-pressed'), footer: text('.playback-status') };
    state.time.running = false; controls.syncPlayback();
    const liveHalted = { realtime: parent.querySelector('[data-action="realtime"]').getAttribute('aria-pressed'), footer: text('.playback-status') };
    controls.dispose(); controls.syncPlayback();
    return { beforeDrafts, afterDrafts, beforeScience, afterScience, stateUnchanged, changes, halted, live, liveHalted, disposed: parent.children.length === 0 };
  });
  assert.deepEqual(result.halted, { play: '播放', compact: '播放', reverse: '反向', realtime: 'false', footer: '已暂停' });
  assert.deepEqual(result.beforeDrafts, result.afterDrafts);
  checks.push('An error-style pause updates the five existing playback flags and retains date/time, observer and P/T form drafts.');
  assert.deepEqual(result.beforeScience, result.afterScience); assert.equal(result.stateUnchanged, true); assert.deepEqual(result.changes, []);
  checks.push('The pure control refresh publishes no old scientific geometry/notes/teaching under new unpaired inputs, changes no state and emits no onChange.');
  assert.deepEqual(result.live, { play: '暂停', compact: '暂停', realtime: 'true', footer: '实时 · 1秒/秒' });
  assert.deepEqual(result.liveHalted, { realtime: 'false', footer: '已暂停' }); assert.equal(result.disposed, true);
  checks.push('The same function handles realtime and its pause consistently and becomes a safe no-op after disposal.');
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ stage: 'isolated UI error-control fixture', url: origin, checks, result, browserClosed: true, limits: ['No app clock/worker/WebGL or actual science failure injection; the main callback is validated separately.', 'No old snapshot is recomputed by this fixture refresh.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
