import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Form/metadata fixtures only; no independent refraction or astronomical accuracy claim.
const origin = new URL(process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/').origin;
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m5c-ui/component';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] });
const checks = []; let result;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route(`${origin}/__ui_m5c_component`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><div id="fixture-host" style="width:350px"></div></body></html>' }));
  await page.goto(`${origin}/__ui_m5c_component`);
  result = await page.evaluate(async () => {
    const { mountRefractionControls, hasMatchingRefraction } = await import('/src/ui/refraction-controls.ts');
    const { createDefaultState, serializeState } = await import('/src/state.ts');
    const state = createDefaultState(), reasons = [];
    const parent = document.querySelector('#fixture-host');
    const ui = mountRefractionControls(parent, state, reason => reasons.push(reason));
    const descriptor = () => ({ observerRefraction: { definitionVersion: 'display-fixture', profileVersion: 'display-fixture', mode: state.environment.refraction, pressureHpa: state.environment.pressureHpa, temperatureC: state.environment.temperatureC } });
    const initial = descriptor(); ui.update(initial);
    const form = parent.querySelector('#sky-refraction-form'), p = parent.querySelector('#sky-pressure'), t = parent.querySelector('#sky-temperature');
    const status = () => parent.querySelector('#sky-refraction-status').textContent;
    const put = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const originalClosed = !parent.querySelector('details').open;
    parent.querySelector('details').open = true;
    put(p, '950.25'); ui.update(initial); state.selected = 'hip:32349'; state.viewMode = 'space'; ui.sync();
    put(t, '-25'); ui.update(initial); ui.sync();
    const draftPreserved = p.value === '950.25' && t.value === '-25';
    const stable = serializeState(state); put(t, '81'); form.requestSubmit();
    const rejected = status(), rejectedAtomic = serializeState(state) === stable && reasons.length === 0;
    ui.update(initial); const invalidDraftPreserved = p.value === '950.25' && t.value === '81' && status() === rejected;
    put(t, '-25'); form.requestSubmit();
    const submitted = { p: state.environment.pressureHpa, t: state.environment.temperatureC, reasons: [...reasons], pending: parent.querySelector('details').dataset.refractionStatus, status: status() };
    const oldRejected = !hasMatchingRefraction(initial, state.environment); ui.update(initial);
    const oldStillPending = parent.querySelector('details').dataset.refractionStatus === 'pending';
    ui.update(descriptor()); const pairedReady = parent.querySelector('details').dataset.refractionStatus === 'ready' && !status();
    const externalScope = parent.querySelector('#sky-refraction-scope').textContent;
    ui.setObserverOverview(true); const canvasScope = parent.querySelector('#sky-refraction-scope').textContent;
    const preservedView = state.viewMode;
    put(p, '999'); put(t, '33'); p.focus();
    state.environment.pressureHpa = 1012; state.environment.temperatureC = 17;
    ui.clearDraft(); const explicitReplacement = p.value === '1012' && t.value === '17';
    const targetHeights = [p, t, parent.querySelector('#sky-refraction-mode'), parent.querySelector('#sky-apply-refraction')].map(el => el.getBoundingClientRect().height);
    ui.dispose();
    return { originalClosed, draftPreserved, rejected, rejectedAtomic, invalidDraftPreserved, submitted, oldRejected, oldStillPending, pairedReady, externalScope, canvasScope, preservedView, explicitReplacement, targetHeights, disposed: parent.children.length === 0 };
  });
  assert.ok(result.originalClosed && result.draftPreserved && result.invalidDraftPreserved);
  checks.push('The compact section begins folded; both P/T drafts survive background metadata, selection and external-view updates as one form.');
  assert.ok(result.rejectedAtomic); assert.match(result.rejected, /温度/);
  assert.deepEqual([result.submitted.p, result.submitted.t, result.submitted.reasons], [950.25, -25, ['environment-refraction']]);
  checks.push('An out-of-range temperature rejects the whole transaction, keeps the draft/error and emits no change; successful retry applies both values once.');
  assert.equal(result.submitted.pending, 'pending'); assert.ok(result.oldRejected && result.oldStillPending && result.pairedReady);
  assert.match(result.externalScope, /外部图形保持几何方向/); assert.match(result.canvasScope, /2D方位图采用所选口径/); assert.equal(result.preservedView, 'space');
  checks.push('Old snapshot input metadata remains pending, matching metadata becomes ready, and actual Canvas observer-overview semantics preserve the saved external view.');
  assert.ok(result.explicitReplacement && result.disposed); assert.ok(result.targetHeights.every(height => height >= 44));
  checks.push('An explicit scene replacement clears the entire draft even while focused; mobile inputs/select/apply are 44px and disposal removes the component.');
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ url: origin, stage: 'isolated UI metadata/form fixture', checks, result, browserClosed: true, limits: ['No app clock, worker, GPU, astronomical accuracy or physical-phone claim.'] }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
