import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.SKY_UI_QA_OUT_DIR ?? 'qa/m6-ui/development';
const stage = process.env.SKY_UI_QA_STAGE ?? 'development source / real main and native WAAPI';
await mkdir(out, { recursive: true });
const sourcePaths = ['src/main.ts', 'src/ui/view-transition.ts', 'src/platform/graphics-host.ts',
  'src/platform/runtime-quality-contract.ts', 'src/render/SkyRenderer.ts', 'src/render/CanvasSkyRenderer.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const beforeHashes = await hashes(), checks = [], records = [], actualBuilds = [], errors = [], contexts = [];
const canvasSelector = '.sky-graphics-webgl2 canvas.sky-webgl-canvas';
let browser, page, failure = null, recording = null;
const current = page => page.evaluate(() => window.skyApp.state);
const paired = page => page.waitForFunction(() => window.skyApp.ready && !window.skyApp.diagnostics.scienceDirty
  && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000);
const settled = page => page.waitForFunction(() => window.skyApp.diagnostics.viewTransition.phase === 'idle'
  && window.skyApp.diagnostics.viewTransition.handleCount === 0 && window.skyApp.rendererDiagnostics.stageInputEnabled
  && !window.skyApp.diagnostics.scienceDirty && window.skyApp.diagnostics.lastRenderedMode === window.skyApp.state.viewMode);
const preserved = (before, after, playing = false) => {
  assert.deepEqual(after.cameras, before.cameras); assert.deepEqual(after.observer, before.observer);
  assert.deepEqual(after.layers, before.layers); assert.deepEqual(after.environment, before.environment);
  assert.equal(after.selected, before.selected); assert.equal(after.presentation, before.presentation); assert.equal(after.density, before.density);
  const beforeTime = { ...before.time }, afterTime = { ...after.time };
  if (playing) { assert.ok(afterTime.utDaysJ2000 >= beforeTime.utDaysJ2000); delete beforeTime.utDaysJ2000; delete afterTime.utDaysJ2000; }
  assert.deepEqual(afterTime, beforeTime);
};
async function verifyBuild(page) {
  const value = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(el => el.getAttribute('src')) }));
  if (process.env.SKY_QA_BUILD_ID) assert.equal(value.id, process.env.SKY_QA_BUILD_ID);
  if (process.env.SKY_QA_ENTRY) assert.ok(value.entries.some(entry => entry.endsWith(`/assets/${process.env.SKY_QA_ENTRY}`)));
  actualBuilds.push({ url: page.url(), ...value });
}
async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, reducedMotion: 'no-preference', ...options });
  contexts.push(context);
  const created = await context.newPage(); created.on('pageerror', error => errors.push(error.message));
  return { context, page: created };
}
async function open(page) {
  await page.goto(url); await verifyBuild(page); await paired(page);
  assert.equal(await page.evaluate(() => window.skyApp.graphicsStatus.kind), 'webgl2');
  await page.waitForFunction(() => window.skyApp.diagnostics.assetStatus.pending.length === 0);
}
async function choose(page, mode) { await page.locator(`[data-view="${mode}"]`).click(); }
async function search(page, query, id) {
  await page.locator('#sky-search').fill(query); await page.locator('#sky-search').press('Enter');
  assert.equal((await current(page)).selected, id);
}
async function assertRestored(page) {
  await settled(page);
  const actual = await page.evaluate(() => ({ transition: window.skyApp.diagnostics.viewTransition,
    enabled: window.skyApp.rendererDiagnostics.stageInputEnabled,
    canvases: [...document.querySelectorAll('#sky-stage canvas')].map(el => ({ opacity: el.style.opacity, animations: el.getAnimations().length })) }));
  assert.equal(actual.enabled, true); assert.equal(actual.transition.handleCount, 0);
  for (const canvas of actual.canvases) { assert.ok(canvas.opacity === '' || canvas.opacity === '1'); assert.equal(canvas.animations, 0); }
  return actual;
}
async function heldFade(page, preferred) {
  const state = await current(page), mode = preferred && state.viewMode !== preferred ? preferred : state.viewMode === 'space' ? 'globe' : 'space';
  await choose(page, mode);
  await page.waitForFunction(() => window.skyApp.diagnostics.viewTransition.phase === 'animating');
  const value = await page.evaluate(selector => {
    const canvas = document.querySelector(selector), animations = canvas.getAnimations();
    if (animations.length !== 1) throw new Error(`Expected sole native fade, found ${animations.length}`);
    animations[0].pause();
    return { phase: window.skyApp.diagnostics.viewTransition, duration: animations[0].effect.getTiming().duration,
      currentTime: animations[0].currentTime, state: window.skyApp.state,
      stageInputEnabled: window.skyApp.rendererDiagnostics.stageInputEnabled };
  }, canvasSelector);
  assert.equal(value.duration, 300); assert.equal(value.stageInputEnabled, false);
  return value;
}
async function nativeTrace(page) {
  return page.evaluate(async selector => {
    const canvas = document.querySelector(selector), trace = [], started = performance.now();
    for (let sample = 0; sample < 9; sample++) {
      const animation = canvas.getAnimations()[0], app = window.skyApp;
      trace.push({ elapsedMs: performance.now() - started, opacity: Number(getComputedStyle(canvas).opacity),
        inlineOpacity: canvas.style.opacity, animationCount: canvas.getAnimations().length,
        animationTime: animation?.currentTime ?? null, animationDuration: animation?.effect.getTiming().duration ?? null,
        phase: app.diagnostics.viewTransition.phase, stageInputEnabled: app.rendererDiagnostics.stageInputEnabled,
        state: { viewMode: app.state.viewMode, time: app.state.time, selected: app.state.selected, cameras: app.state.cameras },
        lastRenderedMode: app.diagnostics.lastRenderedMode });
      if (sample !== 8) await new Promise(resolve => setTimeout(resolve, 45));
    }
    return trace;
  }, canvasSelector);
}
async function cancelCase(name, action, { preferred = 'space', keepState = true } = {}) {
  const fade = await heldFade(page, preferred), before = await current(page);
  await action();
  const restored = await assertRestored(page), after = await current(page);
  if (keepState) preserved(before, after);
  records.push({ name, beforeTransition: fade.phase, afterTransition: restored.transition, before, after });
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.SKY_QA_HEADED !== '1' });
  // A short raw native video contains only the four paused view switches.
  const first = await newPage({ recordVideo: { dir: `${out}/recording`, size: { width: 1152, height: 720 } } });
  page = first.page; await open(page); await search(page, '月球', 'body:Moon');
  await page.waitForFunction(() => window.skyApp.teachingData.objectDayStatus === 'ready');
  const baseline = await current(page), beforeCounters = await page.evaluate(() => window.skyApp.diagnostics);
  const traces = [];
  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    await choose(page, mode);
    const tracePromise = nativeTrace(page);
    if (mode === 'space' || mode === 'horizon') await page.screenshot({ path: `${out}/${mode}-fade.png` });
    const trace = await tracePromise; await assertRestored(page);
    assert.ok(trace.some(row => row.animationDuration === 300 && row.phase === 'animating'));
    assert.ok(trace.some(row => row.opacity > 0 && row.opacity < 1));
    for (const row of trace) { assert.deepEqual(row.state.time, baseline.time); assert.deepEqual(row.state.cameras, baseline.cameras); assert.equal(row.state.selected, baseline.selected); }
    preserved(baseline, await current(page)); traces.push({ mode, trace });
  }
  await page.screenshot({ path: `${out}/paused-ground-settled.png` });
  const afterCounters = await page.evaluate(() => window.skyApp.diagnostics);
  assert.equal(afterCounters.scienceRequestCount, beforeCounters.scienceRequestCount);
  assert.equal(afterCounters.clockRebaseCount, beforeCounters.clockRebaseCount);
  assert.equal(afterCounters.graphics.webglCreationCount, beforeCounters.graphics.webglCreationCount);
  await page.waitForTimeout(250);
  const idleBefore = await page.evaluate(() => ({ frames: window.skyApp.diagnostics.frameCount, draws: window.skyApp.diagnostics.renderCount }));
  await page.waitForTimeout(420);
  assert.deepEqual(await page.evaluate(() => ({ frames: window.skyApp.diagnostics.frameCount, draws: window.skyApp.diagnostics.renderCount })), idleBefore);
  records.push({ name: 'normal-native-four-views', traces, baseline, beforeCounters: { science: beforeCounters.scienceRequestCount, rebases: beforeCounters.clockRebaseCount },
    afterCounters: { science: afterCounters.scienceRequestCount, rebases: afterCounters.clockRebaseCount }, idleBefore });
  checks.push('Four paused native view switches use a sole 300ms WAAPI canvas fade; sampled opacity and raw video show the actual target, canonical state/counters stay unchanged and settled paused main returns to idle.');
  const video = page.video(); await first.context.close(); contexts.splice(contexts.indexOf(first.context), 1);
  await video.saveAs(`${out}/four-views.webm`); recording = `${out}/four-views.webm`;

  const second = await newPage(); page = second.page; await open(page); await search(page, '月球', 'body:Moon');
  const rapidBefore = await current(page), rapidCounters = await page.evaluate(() => window.skyApp.diagnostics);
  const rapid = await page.evaluate(() => {
    for (const mode of ['space', 'globe', 'ground', 'horizon']) document.querySelector(`[data-view="${mode}"]`).click();
    return { transition: window.skyApp.diagnostics.viewTransition, state: window.skyApp.state,
      opacity: getComputedStyle(document.querySelector('canvas.sky-webgl-canvas')).opacity };
  });
  assert.equal(rapid.state.viewMode, 'horizon'); assert.equal(rapid.transition.ticket.target, 'horizon');
  assert.equal(rapid.opacity, '1'); await assertRestored(page); preserved(rapidBefore, await current(page));
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.scienceRequestCount), rapidCounters.scienceRequestCount);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount), rapidCounters.clockRebaseCount);
  await page.locator('#sky-rate').selectOption('60'); await page.locator('[data-action="play"]').click(); await paired(page);
  const playingBefore = await current(page), playingRebase = await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount);
  for (const mode of ['ground', 'space', 'globe', 'horizon']) { await choose(page, mode); await assertRestored(page); }
  const playingAfter = await current(page); preserved(playingBefore, playingAfter, true);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.clockRebaseCount), playingRebase);
  assert.ok((await page.evaluate(() => window.skyApp.diagnostics)).activeRequestCount <= 1);
  await page.locator('[data-action="pause"]').click(); await paired(page);
  records.push({ name: 'rapid-latest-playing', rapid, playingBefore, playingAfter });
  checks.push('Synchronous rapid native view requests retain only the latest target and do not add a science request or clock rebase.');
  checks.push('Playing four-view fades keep cameras/location/selection and the existing advancing clock without a transition rebase or second science queue.');

  await page.locator('#sky-teaching').evaluate(el => { el.open = true; });
  await page.locator('#sky-moon-loupe-toggle').click(); await page.locator('#sky-moon-loupe').waitFor({ state: 'visible' });
  const guarded = await heldFade(page, 'space'), guardedState = await current(page);
  await page.mouse.move(950, 340); await page.mouse.down(); await page.mouse.move(1020, 385); await page.mouse.up();
  await page.mouse.wheel(0, 200);
  await page.locator(canvasSelector).focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('+'); await page.keyboard.press('Escape');
  preserved(guardedState, await current(page));
  assert.deepEqual(await page.evaluate(() => window.skyApp.rendererDiagnostics.gesture.activePointerIds), []);
  await search(page, 'HIP 11767', 'hip:11767');
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.viewTransition.phase), 'animating');
  await page.locator('#sky-moon-loupe-close').click(); await page.locator('#sky-moon-loupe').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.viewTransition.phase), 'animating');
  await page.screenshot({ path: `${out}/toolbar-usable-during-held-native-fade.png` });
  await page.locator('[data-action="focus-selection"]').click(); await assertRestored(page);
  const releasedCamera = (await current(page)).cameras;
  await page.locator(canvasSelector).focus(); await page.keyboard.press('ArrowRight');
  assert.notDeepEqual((await current(page)).cameras, releasedCamera);
  records.push({ name: 'stage-only-native-guard', guarded, guardedState });
  checks.push('With the native fade deliberately paused, real pointer/wheel/stage keys cannot pan/zoom/pick; toolbar search and loupe close remain usable, focus settles it and native stage keys work again.');

  await heldFade(page);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await assertRestored(page);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.viewTransition.reducedMotion), true);
  const reducedBefore = await current(page);
  for (const mode of ['ground', 'space', 'globe', 'horizon']) {
    await choose(page, mode); await paired(page); await assertRestored(page);
    assert.equal(await page.locator(canvasSelector).evaluate(el => el.getAnimations().length), 0);
  }
  preserved(reducedBefore, await current(page));
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await heldFade(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await assertRestored(page);
  records.push({ name: 'dynamic-reduced-motion', diagnostics: await page.evaluate(() => window.skyApp.diagnostics.viewTransition) });
  checks.push('Dynamic reduced motion cancels native fades and subsequent view switches are direct; turning it off permits a new fade and turning it back on leaves no opacity/input residue.');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await cancelCase('focus', () => page.locator('[data-action="focus-selection"]').click(), { keepState: false });
  await cancelCase('reference-lock', async () => {
    const other = await page.locator('#sky-reference-lock').evaluate(el => [...el.options].find(option => option.value !== el.value).value);
    await page.locator('#sky-reference-lock').selectOption(other); await paired(page);
  }, { keepState: false });
  await cancelCase('capture', async () => { const length = await page.evaluate(() => window.skyApp.capture().length); assert.ok(length > 1000); });
  await cancelCase('actual-file-import', async () => {
    const incoming = await current(page); incoming.selected = 'body:Moon';
    await page.locator('#sky-import-file').setInputFiles({ name: 'm6-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
    await page.waitForFunction(() => window.skyApp.state.selected === 'body:Moon'); await paired(page);
  }, { keepState: false });
  await cancelCase('native-scene-reset', async () => { await page.locator('.panel-footer [data-action="reset"]').click(); await paired(page); }, { keepState: false });
  await cancelCase('viewport-resize', () => page.setViewportSize({ width: 1100, height: 700 }));
  await page.setViewportSize({ width: 1152, height: 720 }); await paired(page);
  checks.push('Focus, reference lock, real PNG capture, actual JSON file import, native scene reset and viewport resize settle the native handle and restore the active stage; intentional camera/scene operations retain their existing semantics.');

  await heldFade(page);
  const contextBefore = await current(page), identityBefore = await page.evaluate(() => {
    window.__qaLostCanvas = document.querySelector('canvas.sky-webgl-canvas');
    window.__qaLoseExtension = window.__qaLostCanvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    if (!window.__qaLoseExtension) throw new Error('Native WEBGL_lose_context unavailable');
    const diagnostics = window.skyApp.diagnostics.graphics; window.__qaLoseExtension.loseContext(); return diagnostics;
  });
  await page.waitForFunction(() => window.skyApp.graphicsStatus.kind === 'canvas2d' && window.skyApp.graphicsStatus.available);
  await paired(page); await assertRestored(page); preserved(contextBefore, await current(page));
  const fallback = await page.evaluate(() => ({ graphics: window.skyApp.diagnostics.graphics, transition: window.skyApp.diagnostics.viewTransition }));
  const incoming2d = await current(page); incoming2d.viewMode = incoming2d.viewMode === 'globe' ? 'horizon' : 'globe';
  await page.locator('#sky-import-file').setInputFiles({ name: 'm6-canvas-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming2d)) });
  await page.waitForFunction(target => window.skyApp.state.viewMode === target, incoming2d.viewMode); await paired(page); await assertRestored(page);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.lastRenderedEffectiveView), 'ground');
  assert.equal(await page.locator('.sky-canvas2d-canvas').evaluate(el => el.getAnimations().length), 0);
  await page.screenshot({ path: `${out}/real-context-loss-canvas.png` });
  await page.evaluate(() => window.__qaLoseExtension.restoreContext());
  await page.waitForFunction(() => window.skyApp.graphicsStatus.kind === 'webgl2' && window.skyApp.graphicsStatus.available);
  await paired(page); await assertRestored(page);
  assert.equal(await page.evaluate(() => document.querySelector('canvas.sky-webgl-canvas') === window.__qaLostCanvas), true);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.graphics.webglCreationCount), identityBefore.webglCreationCount);
  records.push({ name: 'native-context-backend-cancel', identityBefore, fallback, restored: await page.evaluate(() => window.skyApp.diagnostics.graphics) });
  checks.push('Real WebGL loss cancels the fade and activates Canvas without changing saved cameras/state; imported saved view changes do not fake a 3D animation in Canvas, and restoration reuses the same WebGL canvas/instance.');

  await heldFade(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const pagehide = await assertRestored(page);
  assert.equal(await page.evaluate(() => window.skyApp.diagnostics.lifecycle.disposed), false);
  assert.equal(pagehide.transition.lastCancelReason, 'pagehide');
  records.push({ name: 'synthetic-persisted-pagehide-branch', pagehide });
  checks.push('A synthetic persisted pagehide invokes its cancellation branch without disposing the application; this is branch coverage, not a real BFCache claim.');
  await second.context.close(); contexts.splice(contexts.indexOf(second.context), 1);

  const pendingContext = await newPage(); page = pendingContext.page;
  await pendingContext.context.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage'), listeners = new WeakMap();
    window.__qaSnapshotBridge = { supported: Boolean(descriptor?.set), hold: false, pending: [], flush() {
      this.hold = false; for (const deliver of this.pending.splice(0)) deliver();
    } };
    if (!descriptor?.set) return;
    Object.defineProperty(Worker.prototype, 'onmessage', { configurable: true, enumerable: descriptor.enumerable,
      get() { return listeners.get(this) ?? null; }, set(listener) {
        listeners.set(this, listener);
        descriptor.set.call(this, typeof listener !== 'function' ? listener : event => {
          const deliver = () => listener.call(this, event);
          if (window.__qaSnapshotBridge.hold && event.data?.snapshot) window.__qaSnapshotBridge.pending.push(deliver);
          else deliver();
        });
      } });
  });
  await open(page);
  assert.equal(await page.evaluate(() => window.__qaSnapshotBridge.supported && window.skyApp.diagnostics.workerMode === 'worker'), true);
  const clip = { x: 560, y: 50, width: 520, height: 560 };
  const oldPicture = await page.screenshot({ clip });
  const pending = await page.evaluate(() => {
    const old = window.skyApp.diagnostics.lastRenderedMode;
    window.__qaSnapshotBridge.hold = true;
    const state = window.skyApp.state; state.observer.latitudeDeg += 0.01; window.skyApp.setState(state);
    document.querySelector('[data-view="space"]').click();
    return { oldMode: old, state, transition: window.skyApp.diagnostics.viewTransition };
  });
  await page.waitForFunction(() => window.__qaSnapshotBridge.pending.length === 1);
  const waiting = await page.evaluate(() => ({ transition: window.skyApp.diagnostics.viewTransition,
    lastRenderedMode: window.skyApp.diagnostics.lastRenderedMode, dirty: window.skyApp.diagnostics.scienceDirty,
    opacity: getComputedStyle(document.querySelector('canvas.sky-webgl-canvas')).opacity,
    nativeAnimations: document.querySelector('canvas.sky-webgl-canvas').getAnimations().length,
    guarded: !window.skyApp.rendererDiagnostics.stageInputEnabled, heldMessages: window.__qaSnapshotBridge.pending.length }));
  assert.equal(waiting.transition.phase, 'waiting-render'); assert.equal(waiting.lastRenderedMode, pending.oldMode);
  assert.equal(waiting.opacity, '1'); assert.equal(waiting.nativeAnimations, 0); assert.equal(waiting.guarded, true); assert.equal(waiting.dirty, true);
  const heldPicture = await page.screenshot({ path: `${out}/pending-keeps-old-picture.png`, clip });
  assert.ok(oldPicture.equals(heldPicture), 'The unoccluded old canvas region stays identical until the real paired snapshot is delivered');
  await page.evaluate(() => window.__qaSnapshotBridge.flush()); await paired(page); await assertRestored(page);
  assert.equal((await current(page)).viewMode, 'space');
  records.push({ name: 'delayed-real-worker-paired-render', pending, waiting,
    oldPictureSha256: createHash('sha256').update(oldPicture).digest('hex'), heldPictureSha256: createHash('sha256').update(heldPicture).digest('hex') });
  checks.push('Holding only delivery of one real snapshot-worker message leaves the last paired canvas region pixel-identical and visible, with no native fade; the real target fades only after that message is released.');
  await pendingContext.context.close(); contexts.splice(contexts.indexOf(pendingContext.context), 1);

  const failureContext = await newPage({ reducedMotion: 'reduce' }); page = failureContext.page; await open(page);
  await choose(page, 'space'); await paired(page); await assertRestored(page);
  assert.equal(await page.locator(canvasSelector).evaluate(el => el.getAnimations().length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator(canvasSelector).evaluate(el => { el.animate = () => { throw new Error('QA injected native WAAPI failure'); }; });
  await choose(page, 'globe'); await paired(page); await assertRestored(page);
  const waapi = await page.evaluate(() => ({ transition: window.skyApp.diagnostics.viewTransition, mode: window.skyApp.diagnostics.lastRenderedMode }));
  assert.match(waapi.transition.failure, /QA injected native WAAPI failure/); assert.equal(waapi.mode, 'globe');
  await page.screenshot({ path: `${out}/waapi-failure-direct-target.png` });
  records.push({ name: 'initial-reduced-motion-waapi-failure', waapi });
  checks.push('Initial reduced motion draws a direct target; an injected native WAAPI exception safely falls back to that actual target, restores opacity/input and leaves no handle.');
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser?.close();
  const afterHashes = await hashes(), sourceChanged = JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes);
  const sourceViolation = !failure && sourceChanged;
  if (sourceViolation) failure = { message: 'Source changed during the run; retain this dev report and rerun in a new directory after HMR settles.' };
  await writeFile(`${out}/report.json`, JSON.stringify({ stage, url, actualBuilds, checks, records, recording,
    beforeHashes, afterHashes, sourceChanged, errors, failure, browserClosed: true,
    limits: ['Development source unless an actual expected bundle id/entry was supplied; never a final-package claim by default.',
      'Native fade pause, WAAPI exception and one worker-delivery hold are deliberate QA fault injection; no production hook was added.',
      'Synthetic persisted pagehide only verifies that branch. Real BFCache, hidden-page lifecycle and error/range branches use separate owner evidence.',
      'QA trace timers sample compositor opacity; they do not measure GPU/FPS or claim zero test-side timers. No performance or 30-minute run.',
      'Desktop native browser input, not physical phone/touch validation.'] }, null, 2));
  if (sourceViolation) throw new Error(failure.message);
}
console.log(JSON.stringify({ passed: checks.length, out, browserClosed: true }));
