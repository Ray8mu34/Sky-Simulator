import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const url = process.env.SKY_QA_URL ?? 'http://127.0.0.1:4173/';
const expectedBuild = process.env.SKY_QA_BUILD_ID, expectedEntry = process.env.SKY_QA_ENTRY;
const samplesPerView = Number(process.env.SKY_QA_DRAG_SAMPLES ?? 10);
assert.equal(process.env.SKY_QA_GPU_TOKEN, 'drag-feedback', 'This exclusive GPU check requires the root-issued drag-feedback token.');
assert.ok(expectedBuild && expectedEntry, 'Set the actual frozen build id and entry before launching Chrome.');
assert.ok(Number.isInteger(samplesPerView) && samplesPerView >= 8 && samplesPerView <= 12, 'Use 8–12 starts per view, once; do not select a passing subset.');
const target = new URL(url); assert.ok(['http:', 'https:'].includes(target.protocol));
assert.equal(target.hash, ''); assert.equal(target.search, '', 'Use the unmodified default frozen Web entry.');
const out = resolve(process.env.SKY_UI_QA_OUT_DIR ?? 'qa/final-native-drag-feedback');
await mkdir(out, { recursive: true });
const defaultEffects = { hideOrdinaryBackLabels: false, hideOrdinarySecondaryLabels: false, ordinaryLabelBudgetScale: 1,
  reduceVerifiedDecoration: false, pixelScale: 1, omitOptionalInvisibleStars: false };
const report = { status: 'prepared', url, startedAt: new Date().toISOString(), headed: true, channel: 'chrome',
  samplesPerView, capacityPerContext: 96, matrix: [], builds: [], errors: [], consoleErrors: [], failure: null,
  scope: 'First drag motion accepted by the existing >4 CSS px gesture policy → actual main render submission end; subsequent native RAF is a later display opportunity bound.',
  limits: ['DOM capture, callback end and the follow-up RAF share browser performance.now/timeOrigin; Node/CDP round-trip time is never a latency endpoint.',
    'RenderCount increment and changed camera identify a submitted response, not GPU completion, compositor presentation or physical scan-out.',
    'Pointerdown→first meaningful move is also retained, but includes driver/inter-command time and is not substituted for application motion-response latency.',
    'Mobile is 390×844 Chrome/CDP touch engine emulation on the same desktop GPU, not a physical mobile device result.',
    'The observer wraps native RAF callbacks once without modifying timestamps, return values, renderer calls or production setters. Probe overhead is measured separately and not subtracted.',
    'All samples and both threshold flags are retained; this is neither a 30-minute test nor a repetition of the separate 5-warmup/100-switch driver.' ] };
let browser, context, page;

async function installObserver(context) {
  await context.addInitScript(() => {
    const nativeRaf = window.requestAnimationFrame.bind(window), now = performance.now.bind(performance);
    const capacity = 96, records = [];
    let mainCallback = null, active = null, sequence = 0, identificationReads = 0;
    let wrappedCallbacks = 0, nonMainCallbacks = 0;
    function readState() {
      const state = window.skyApp.state, diagnostics = window.skyApp.diagnostics;
      return { state, counters: { frameCount: diagnostics.frameCount, renderCount: diagnostics.renderCount,
        scienceRequestCount: diagnostics.scienceRequestCount, clockRebaseCount: diagnostics.clockRebaseCount,
        lastRenderedMode: diagnostics.lastRenderedMode, lastRenderedUt: diagnostics.lastRenderedUt,
        scienceDirty: diagnostics.scienceDirty, currentInputSignature: diagnostics.currentInputSignature,
        snapshotInputSignature: diagnostics.snapshotInputSignature }, quality: diagnostics.runtimeQuality,
        transition: diagnostics.viewTransition };
    }
    function finishAfterNextRaf(sample) {
      nativeRaf(timestamp => {
        const observedAtMs = now();
        sample.record.nextRaf = { nativeTimestampMs: timestamp, observedAtMs,
          latencyMs: observedAtMs - sample.record.motion.observedAtMs,
          overBudget: observedAtMs - sample.record.motion.observedAtMs > sample.record.thresholdMs };
        sample.complete = true;
        records.push(sample.record);
        sample.resolve(sample.record);
      });
    }
    window.requestAnimationFrame = function(callback) {
      return nativeRaf(function(timestamp) {
        const wrapperEnteredMs = now(); wrappedCallbacks++;
        if (mainCallback && callback !== mainCallback) {
          nonMainCallbacks++; return Reflect.apply(callback, this, [timestamp]);
        }
        const learn = !mainCallback && Boolean(window.skyApp);
        const beforeFrame = learn ? (++identificationReads, window.skyApp.diagnostics.frameCount) : null;
        const sample = callback === mainCallback && active?.record.motion && !active.record.submission ? active : null;
        const callbackStartMs = now();
        try { return Reflect.apply(callback, this, [timestamp]); }
        finally {
          const callbackEndMs = now();
          if (learn) {
            const afterFrame = (++identificationReads, window.skyApp.diagnostics.frameCount);
            if (afterFrame === beforeFrame + 1) mainCallback = callback;
          }
          if (sample && active === sample) {
            const observationStartMs = now(), after = readState();
            sample.record.observation.callbacksChecked++;
            const changed = JSON.stringify(after.state.cameras[sample.record.view]) !== sample.cameraBeforeJson;
            if (after.counters.renderCount > sample.record.before.counters.renderCount && changed
              && after.counters.lastRenderedMode === sample.record.view && !after.counters.scienceDirty) {
              const latencyMs = callbackEndMs - sample.record.motion.observedAtMs;
              sample.record.submission = { rafTimestampMs: timestamp, callbackStartMs, callbackEndMs,
                callbackCpuMs: callbackEndMs - callbackStartMs, latencyMs, overBudget: latencyMs > sample.record.thresholdMs,
                renderCountDelta: after.counters.renderCount - sample.record.before.counters.renderCount };
              sample.record.after = after;
              finishAfterNextRaf(sample);
            }
            sample.record.observation.beforeCallbackWorkMs += callbackStartMs - wrapperEnteredMs;
            sample.record.observation.afterCallbackWorkMs += now() - observationStartMs;
          }
        }
      });
    };
    function observePointer(event) {
      const startedMs = now(), sample = active;
      if (!sample || (sample.complete && !['pointerup', 'pointercancel', 'lostpointercapture'].includes(event.type)) || !(event.target instanceof HTMLCanvasElement)
        || !event.target.matches('.sky-webgl-canvas')) return;
      const record = sample.record;
      const observed = { type: event.type, observedAtMs: startedMs, nativeEventTimestampMs: event.timeStamp,
        isTrusted: event.isTrusted, pointerType: event.pointerType, pointerId: event.pointerId,
        x: event.clientX, y: event.clientY, buttons: event.buttons, hidden: document.hidden };
      if (event.type === 'pointerdown' && !record.down) record.down = observed;
      else if (event.type === 'pointermove' && record.down && record.down.pointerId === event.pointerId && !record.motion
        && Math.hypot(event.clientX - record.down.x, event.clientY - record.down.y) > 4) {
        record.motion = observed;
        record.downToMotionMs = observed.observedAtMs - record.down.observedAtMs;
      } else if (event.type === 'pointerup' && record.down?.pointerId === event.pointerId) record.up = observed;
      else if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
        if (record.cancellations.length < 4) record.cancellations.push(observed);
      }
      record.observation.pointerWorkMs += now() - startedMs;
    }
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.addEventListener(type, observePointer, { capture: true, passive: true });
    }
    window.__qaDragFeedback = {
      get identified() { return Boolean(mainCallback); },
      arm({ view, inputKind, thresholdMs, start, end }) {
        if (!mainCallback) throw new Error('The actual main callback must be identified before input sampling.');
        if (active && !active.complete) throw new Error('Only one drag observation can be pending.');
        if (records.length >= capacity) throw new Error('The bounded drag observation capacity is exhausted.');
        const armStartMs = now(), before = readState();
        if (before.state.viewMode !== view || before.state.time.running || before.transition.phase !== 'idle') throw new Error('Each drag requires its paused, fully settled target.');
        let resolve;
        const promise = new Promise(yes => { resolve = yes; });
        const record = { id: ++sequence, view, inputKind, thresholdMs, timeOriginMs: performance.timeOrigin,
          start, end, armStartMs, armWorkMs: 0, before, down: null, motion: null, up: null, cancellations: [],
          submission: null, nextRaf: null, after: null,
          observation: { callbacksChecked: 0, beforeCallbackWorkMs: 0, afterCallbackWorkMs: 0, pointerWorkMs: 0 } };
        active = { record, promise, resolve, complete: false, cameraBeforeJson: JSON.stringify(before.state.cameras[view]) };
        record.armWorkMs = now() - armStartMs;
        return { id: record.id, before };
      },
      wait(id) {
        if (active?.record.id === id) return active.promise;
        const record = records.find(sample => sample.id === id);
        if (!record) throw new Error('Unknown observation id.');
        return Promise.resolve(record);
      },
      read() { return { capacity, sequence, records: [...records], identificationReads, wrappedCallbacks, nonMainCallbacks,
        identified: Boolean(mainCallback), callbackName: mainCallback?.name ?? null,
        pending: active && !active.complete ? active.record : null }; },
    };
  });
}
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
function assertQuality(value) {
  assert.equal(value.state.stage, 0, 'The default-quality first-input budget cannot be passed by reducing quality.');
  assert.deepEqual(value.effects, defaultEffects); assert.deepEqual(value.state.history, []);
}
function assertUnchangedScene(before, after, view) {
  for (const field of ['time', 'observer', 'layers', 'environment', 'selected', 'presentation', 'density']) assert.deepEqual(after.state[field], before.state[field]);
  for (const mode of ['ground', 'space', 'globe', 'horizon']) if (mode !== view) assert.deepEqual(after.state.cameras[mode], before.state.cameras[mode]);
  assert.notDeepEqual(after.state.cameras[view], before.state.cameras[view]);
  assert.equal(after.counters.scienceRequestCount, before.counters.scienceRequestCount);
  assert.equal(after.counters.clockRebaseCount, before.counters.clockRebaseCount);
}
async function verifyBuild(page) {
  const value = await page.evaluate(() => ({ id: document.querySelector('meta[name="sky-build-id"]')?.content ?? null,
    entries: [...document.querySelectorAll('script[type="module"][src]')].map(el => el.getAttribute('src')) }));
  assert.equal(value.id, expectedBuild);
  const entry = value.entries.find(value => value.endsWith(`/assets/${expectedEntry}`)); assert.ok(entry);
  assert.ok(!value.entries.some(value => value.includes('/@vite') || value.includes('/src/')));
  const moduleUrl = new URL(entry, page.url()).href, response = await page.request.get(moduleUrl);
  assert.ok(response.ok()); const moduleSha256 = createHash('sha256').update(await response.body()).digest('hex');
  const actual = { url: page.url(), ...value, moduleUrl, moduleSha256 };
  if (report.builds.length) assert.equal(moduleSha256, report.builds[0].moduleSha256, 'The frozen entry bytes changed between contexts.');
  report.builds.push(actual); return actual;
}
async function settled(page, view) {
  await page.waitForFunction(view => {
    const app = window.skyApp, diagnostics = app?.diagnostics;
    return app?.ready && !app.state.time.running && !diagnostics.scienceDirty && diagnostics.lastRenderedMode === view
      && diagnostics.lastRenderedUt === app.state.time.utDaysJ2000 && diagnostics.viewTransition.phase === 'idle'
      && diagnostics.viewTransition.handleCount === 0 && app.rendererDiagnostics.stageInputEnabled;
  }, view);
}
async function stagePoint(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.sky-webgl-canvas'), rect = canvas.getBoundingClientRect();
    const panel = document.querySelector('#sky-control-panel'), compact = document.querySelector('.controls-compact');
    for (const [fx, fy] of [[.72, .43], [.6, .4], [.52, .48], [.82, .32]]) {
      const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
      if (document.elementFromPoint(x, y) === canvas && document.elementFromPoint(x + 24, y + 10) === canvas
        && document.elementFromPoint(x - 24, y - 10) === canvas) {
        return { x, y, viewport: [innerWidth, innerHeight], canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          drawerCollapsed: document.querySelector('#controls').classList.contains('controls-collapsed'),
          panelVisible: panel.getClientRects().length > 0 && getComputedStyle(panel).display !== 'none',
          panelRect: panel.getBoundingClientRect().toJSON(), compactRect: compact.getBoundingClientRect().toJSON(), hidden: document.hidden };
      }
    }
    throw new Error('No verified native canvas input region clear of the controls and labels.');
  });
}
async function waitSample(page, id) {
  let timer;
  try {
    return await Promise.race([page.evaluate(id => window.__qaDragFeedback.wait(id), id),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`No actual changed-camera render completed for drag ${id}`)), 3000); })]);
  } finally { clearTimeout(timer); }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
  const system = await browser.newBrowserCDPSession();
  try { report.systemGpu = (await system.send('SystemInfo.getInfo')).gpu; }
  finally { await system.detach(); }
  for (const profile of [
    { name: 'desktop-1152x720', viewport: { width: 1152, height: 720 }, thresholdMs: 50, isMobile: false, hasTouch: false },
    { name: 'mobile-emulated-390x844', viewport: { width: 390, height: 844 }, thresholdMs: 80, isMobile: true, hasTouch: true },
  ]) {
    context = await browser.newContext({ viewport: profile.viewport, screen: profile.viewport, deviceScaleFactor: 1,
      isMobile: profile.isMobile, hasTouch: profile.hasTouch, reducedMotion: 'no-preference' });
    await installObserver(context); page = await context.newPage();
    page.on('pageerror', error => { if (report.errors.length < 128) report.errors.push(error.message); });
    page.on('console', message => { if (message.type() === 'error' && report.consoleErrors.length < 128) report.consoleErrors.push(message.text()); });
    await page.goto(url); await page.bringToFront(); await verifyBuild(page); await settled(page, 'ground');
    await page.waitForFunction(() => window.skyApp.diagnostics.assetStatus.pending.length === 0 && window.skyApp.diagnostics.assetStatus.errors.length === 0);
    await page.waitForFunction(() => window.__qaDragFeedback.identified);
    const baseline = await page.evaluate(() => ({ state: window.skyApp.state, diagnostics: window.skyApp.diagnostics }));
    assert.equal(baseline.state.density, 'teaching'); assert.equal(baseline.state.selected, null);
    assert.equal(baseline.state.environment.refraction, 'none'); assertQuality(baseline.diagnostics.runtimeQuality);
    const environment = await page.evaluate(() => {
      const canvas = document.querySelector('.sky-webgl-canvas'), gl = canvas.getContext('webgl2'), debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
      return { userAgent: navigator.userAgent, platform: navigator.platform, viewport: [innerWidth, innerHeight],
        screen: [screen.width, screen.height], devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints, hidden: document.hidden,
        renderer, vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
        classification: /swiftshader|llvmpipe|software|microsoft basic|\bwarp\b/i.test(renderer) ? 'software'
          : renderer === 'unavailable' ? 'unknown' : /or similar/i.test(renderer) ? 'hardware-string-reported-device-privacy-masked' : 'hardware-string-reported',
        budgetClass: window.skyApp.rendererDiagnostics.runtimeQualityConsumption.budgetClass,
        backingSize: [canvas.width, canvas.height], sceneDefaultScope: 'Fresh private context, unmodified no-query/no-hash entry, no scene import or state setter.' };
    });
    assert.equal(environment.hidden, false); assert.doesNotMatch(environment.userAgent, /HeadlessChrome/);
    assert.ok(environment.classification.startsWith('hardware-string-reported'), 'Software or unknown WebGL cannot certify this hardware budget.');
    assert.equal(environment.budgetClass, profile.isMobile ? 'mobile' : 'desktop');
    const matrix = { ...profile, environment, baseline: baseline.state, modes: [], probe: null }; report.matrix.push(matrix);
    const cdp = profile.hasTouch ? await context.newCDPSession(page) : null;
    try {
      for (const view of ['ground', 'space', 'globe', 'horizon']) {
        if (view !== 'ground') {
          if (profile.isMobile) await page.locator('#sky-compact-view').selectOption(view);
          else await page.locator(`[data-view="${view}"]`).click();
        }
        await settled(page, view);
        const location = await stagePoint(page); assert.equal(location.hidden, false);
        if (profile.isMobile) {
          assert.equal(location.drawerCollapsed, true, 'The mobile drawer must be closed before touch timing.');
          assert.equal(location.panelVisible, false);
        }
        const mode = { view, location, samples: [], summary: null }; matrix.modes.push(mode);
        for (let index = 0; index < samplesPerView; index++) {
          const sign = index % 2 === 0 ? 1 : -1, start = { x: location.x, y: location.y }, end = { x: start.x + sign * 24, y: start.y + sign * 10 };
          const armed = await page.evaluate(input => window.__qaDragFeedback.arm(input), { view,
            inputKind: profile.hasTouch ? 'native-CDP-touch-engine-emulation' : 'native-Playwright-mouse-CDP', thresholdMs: profile.thresholdMs, start, end });
          assertQuality(armed.before.quality);
          try {
            if (profile.hasTouch) {
              const point = value => ({ id: 1, ...value, radiusX: 2, radiusY: 2, force: 1 });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start)] });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(end)] });
            } else {
              await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y);
            }
          } finally {
            if (profile.hasTouch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            else await page.mouse.up();
          }
          const sample = await waitSample(page, armed.id); mode.samples.push(sample);
          assert.ok(sample.down?.isTrusted && sample.motion?.isTrusted && sample.up?.isTrusted, 'Each sample must have actual trusted browser down/move/up.');
          assert.equal(sample.motion.hidden, false); assert.equal(sample.motion.pointerType, profile.hasTouch ? 'touch' : 'mouse');
          assert.ok(sample.submission.renderCountDelta >= 1); assert.ok(Number.isFinite(sample.submission.latencyMs));
          assert.ok(sample.nextRaf.observedAtMs >= sample.submission.callbackEndMs);
          assertQuality(sample.after.quality); assertUnchangedScene(sample.before, sample.after, view);
          await page.waitForFunction(() => window.skyApp.rendererDiagnostics.gesture.activePointerIds.length === 0);
        }
        const submission = mode.samples.map(sample => sample.submission.latencyMs), next = mode.samples.map(sample => sample.nextRaf.latencyMs);
        mode.summary = { count: mode.samples.length, thresholdMs: profile.thresholdMs,
          submissionMs: { p50: quantile(submission, .5), p95: quantile(submission, .95), max: Math.max(...submission), overBudgetIds: mode.samples.filter(sample => sample.submission.overBudget).map(sample => sample.id) },
          nextRafOpportunityMs: { p50: quantile(next, .5), p95: quantile(next, .95), max: Math.max(...next), overBudgetIds: mode.samples.filter(sample => sample.nextRaf.overBudget).map(sample => sample.id) },
          probe: { pointerWorkMaxMs: Math.max(...mode.samples.map(sample => sample.observation.pointerWorkMs)),
            postCallbackObservationMaxMs: Math.max(...mode.samples.map(sample => sample.observation.afterCallbackWorkMs)),
            armWorkMaxMs: Math.max(...mode.samples.map(sample => sample.armWorkMs)) } };
      }
    } finally { await cdp?.detach(); }
    matrix.probe = await page.evaluate(() => window.__qaDragFeedback.read());
    assert.equal(matrix.probe.records.length, samplesPerView * 4); assert.ok(matrix.probe.records.length <= matrix.probe.capacity);
    await page.screenshot({ path: resolve(out, `${profile.name}-after-sampling.png`) });
    await verifyBuild(page); await context.close(); context = null; page = null;
  }
  assert.deepEqual(report.errors, []);
  report.overBudget = report.matrix.flatMap(matrix => matrix.modes.flatMap(mode => mode.samples.filter(sample => sample.submission.overBudget || sample.nextRaf.overBudget)
    .map(sample => ({ profile: matrix.name, view: mode.view, id: sample.id, thresholdMs: sample.thresholdMs,
      submissionMs: sample.submission.latencyMs, nextRafMs: sample.nextRaf.latencyMs, submissionExceeded: sample.submission.overBudget, nextRafExceeded: sample.nextRaf.overBudget }))));
  report.status = report.overBudget.length ? 'threshold-exceeded' : 'passed-observed-submission-and-next-raf';
  assert.equal(report.overBudget.length, 0, 'Retained drag samples exceeded the original budget; do not rerun/select a passing subset.');
} catch (error) {
  report.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  if (report.status !== 'threshold-exceeded') report.status = 'failed';
  if (page && !page.isClosed()) {
    report.pendingProbe = await page.evaluate(() => window.__qaDragFeedback?.read()).catch(() => null);
    await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close().catch(() => {}); await browser?.close();
  report.browserClosed = true; report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, samples: samplesPerView * 8, out, browserClosed: true }));
