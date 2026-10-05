import { SkyRenderer, supportedModes } from './render/SkyRenderer';
import { CanvasSkyRenderer } from './render/CanvasSkyRenderer';
import { mountControls, setAvailableViews } from './ui/controls';
import { applyState, createDefaultState, parseState, serializeState } from './state';
import type { ExternalCamera, MoonPhaseSequence, ObjectId, RuntimeMetrics, ScienceSnapshot, SimulationState, SolarDayEvents, ViewMode } from './contracts';
import { SimulationClock } from './platform/clock';
import { requestEnvironmentSnapshot } from './platform/environment-refresh';
import { snapshotNeedsImmediateUi, uiCadenceDue } from './platform/ui-cadence';
import { SnapshotService } from './platform/snapshot-service';
import { registerOffline } from './platform/offline';
import { dateToUt, localCivilParts, utToDate } from './core/time';
import { scienceInputSignature } from './platform/snapshot-provenance';
import { catalog } from './data/catalog';
import { resolveObjectDetails } from './core/object-details';
import { DayEventService } from './platform/solar-day-service';
import { resolveObjectDayTarget } from './data/object-day-target';
import type { ObjectDayEvents, ObjectDayTargetResolution } from './core/object-day-events';
import { computeMoonAppearance, computeMoonQuarterSequence, type TeachingData } from './core/teaching';
import { lookupLunarCalendar, type LunarCalendarInfo } from './data/lunar';
import { deriveSkyAppearance, type SkyAppearance } from './core/sky-appearance';
import { GraphicsHost } from './platform/graphics-host';
import type { OfflineController, OfflineStatus } from './platform/offline-status';
import { advanceQuality, createQualityState } from './platform/runtime-quality';
import { DEFAULT_RUNTIME_RENDER_QUALITY, NO_RUNTIME_QUALITY_CAPABILITIES, QUALITY_CONFIGS, renderBudgetClass,
  type QualityResetReason, type RuntimeRenderQuality, type ViewTransitionCancelReason,
  type ViewTransitionController } from './platform/runtime-quality-contract';
import { RuntimeQualitySampler, type QualityExclusion } from './platform/runtime-quality-sampling';
import { createViewTransition } from './ui/view-transition';

type ExternalView = Exclude<ViewMode, 'ground'>;
type ReferenceLock = ExternalCamera['referenceLock'];
type PendingLock = { previousLock: ReferenceLock; nextLock: ReferenceLock };

const state = createDefaultState();
const stage = document.querySelector<HTMLElement>('#sky-stage')!;
const panel = document.querySelector<HTMLElement>('#controls')!;
const status = document.querySelector<HTMLElement>('#runtime-status')!;
let offlineStatus = '';
let offlineInfo: OfflineStatus | null = null;
let offlineController: OfflineController | null = null;
let shareRequest = 0;
let lastError = '';
let snapshot: ScienceSnapshot | null = null;
let pendingSnapshot: { snapshot: ScienceSnapshot; inputSignature: string } | null = null;
let snapshotInputSignature: string | null = null;
let ready = false;
let disposed = false;
let hidden = document.hidden;
let raf = 0;
let dirty = true;
let frameCount = 0;
let renderCount = 0;
let lastRenderedUt: number | null = null;
let lastRenderedMode: SimulationState['viewMode'] | null = null;
let lastRenderedEffectiveView: SimulationState['viewMode'] | null = null;
let lastRenderedSelection: ObjectId | null = null;
let lastRenderedReferenceLock: ReferenceLock | null = null;
let scienceDirty = true;
let previousFrameMs: number | null = null;
let previousRenderMs: number | null = null;
let lastScienceMs = -Infinity;
let lastUiMs = -Infinity;
let lastPublishedUt = state.time.utDaysJ2000;
const frameIntervals: number[] = [];
const renderedIntervals: number[] = [];
const clock = new SimulationClock();
let science: SnapshotService;
let eventDays: DayEventService;
let teachingEnabled = false;
let objectDayEnabled = false;
let dayCandidate = '';
let currentDayKey: string | null = null;
let requestedDayKey: string | null = null;
let dayResult: { key: string; events: SolarDayEvents } | null = null;
let dayError: string | null = null;
let selectedTargetId: ObjectId | null | undefined;
let selectedTargetResolution: ObjectDayTargetResolution | null = null;
let objectCandidate = '';
let currentObjectKey: string | null = null;
let requestedObjectKey: string | null = null;
let requestedBatchKey: string | null = null;
let objectResult: { key: string; events: ObjectDayEvents } | null = null;
let objectError: string | null = null;
let objectUnsupportedReason: string | null = null;
let persistedPageHideCount = 0;
let disposeCount = 0;
let lunarDay: number | null = null;
let lunarCalendar: LunarCalendarInfo | null = null;
let moonPhases: MoonPhaseSequence | null = null;
let moonPhaseStatus: TeachingData['moonPhaseStatus'];
let moonPhaseError: string | undefined;
let moonPhaseComputeMs = 0;
let moonPhaseSequenceRequest = 0;
let moonPhaseTimer: ReturnType<typeof setTimeout> | null = null;
let loupeAvailabilitySignature = '';
let loupeRectSignature = '';
let appearanceCache: { snapshot: ScienceSnapshot; inputSignature: string; model: SkyAppearance } | null = null;
let graphicsStatusSignature = '';
let actionStatus = '';
const appliedReferenceLocks = {} as Record<ExternalView, ReferenceLock>;
const pendingLocks = new Map<ExternalView, PendingLock>();
let pendingFocus: { mode: ViewMode; selected: ObjectId } | null = null;
let lastFocusSucceeded: boolean | null = null;
let qualityGeneration = 0;
let qualityState = createQualityState(qualityGeneration);
const coarsePointer = matchMedia('(pointer: coarse)');
let qualityConfig = QUALITY_CONFIGS[renderBudgetClass(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight, coarsePointer.matches)];
let qualityCapabilities = NO_RUNTIME_QUALITY_CAPABILITIES;
let qualityEffects: Readonly<RuntimeRenderQuality> = DEFAULT_RUNTIME_RENDER_QUALITY;
const qualitySampler = new RuntimeQualitySampler(qualityGeneration, performance.now());
let qualityPreviousDrawMs: number | null = null;
let qualityLastReason = 'initial';
let qualityStatus = '';
let qualitySamplingWorkMs = 0;
let qualityEventComputeRevision = 0;
let transitionGeneration = 0;
let viewTransition: ViewTransitionController | null = null;
let transitionCanvas: HTMLCanvasElement | null = null;
let transitionFailure: string | null = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function updateStatus(): void {
  const assetStatus = renderer?.getAssetStatus();
  const nextStatus = lastError || [stage.dataset.assetWarning, stage.dataset.graphicsWarning, offlineStatus, actionStatus, qualityStatus,
    science?.mode === 'main-thread-budgeted' ? '计算回退已限频' : '', !ready ? '正在计算天空…' : '',
    assetStatus?.pending.length ? '天空素材正在加载…' : ''].filter(Boolean).join(' · ');
  if (status.textContent !== nextStatus) status.textContent = nextStatus;
}

if (location.hash.startsWith('#scene=')) {
  try { applyState(state, parseState(decodeURIComponent(location.hash.slice(7)))); }
  catch (error) { lastError = error instanceof Error ? error.message : String(error); }
}
clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, state.time.running && !hidden, performance.now());
resetInteractionIntents();

let renderer: GraphicsHost | null = null;
try {
  renderer = new GraphicsHost(stage, {
    webgl: (container, invalidate, select, contextState) => new SkyRenderer(container, invalidate, select, contextState),
    canvas: (container, invalidate, select) => new CanvasSkyRenderer(container, invalidate, select),
  }, invalidate, selected => {
    state.selected = selected;
    onChange('selection');
  });
} catch (error) {
  lastError = '天空绘图不可用；保留同一天文内核的时间地点与日月读数。';
  const fallback = document.createElement('div');
  fallback.className = 'sky-fallback';
  fallback.style.cssText = 'position:absolute;inset:25% 8% 8% 32%;color:#e7e5dc;padding:24px;border:1px solid #33424c;background:#0b1219;';
  fallback.textContent = `${lastError} ${error instanceof Error ? error.message : ''}`;
  stage.append(fallback);
}

setAvailableViews(supportedModes);
const controls = mountControls(panel, state, onChange);
viewTransition = createViewTransition({
  prepare() { renderer?.setStageInputEnabled(false); },
  animate(_ticket, durationMs) {
    if (!renderer?.status.available || renderer.kind !== 'webgl2') {
      settleTransitionSurface();
      return { finished: Promise.resolve(), cancel() {} };
    }
    const canvas = renderer.canvas;
    transitionCanvas = canvas;
    try {
      if (typeof canvas.animate !== 'function') throw new Error('当前浏览器不支持视图淡入，已直接显示目标视图。');
      // The target was drawn in this same RAF; no intermediate paint exposes it.
      canvas.style.opacity = '0';
      const animation = canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durationMs, easing: 'ease-out', fill: 'forwards' });
      return { finished: animation.finished.then(() => { animation.cancel(); }), cancel() { animation.cancel(); } };
    } catch (error) {
      transitionFailure = error instanceof Error ? error.message : String(error);
      settleTransitionSurface();
      return { finished: Promise.resolve(), cancel() {} };
    }
  },
  settle: settleTransitionSurface,
}, { durationMs: 300, reducedMotion: reducedMotion.matches });
resetRuntimeQuality('surface');
syncGraphicsStatus();
science = new SnapshotService((next, inputSignature) => {
  if (hidden) return;
  pendingSnapshot = { snapshot: next, inputSignature };
  dirty = true;
  invalidate();
}, message => {
  cancelViewTransition('science-error');
  resetRuntimeQuality('science-error');
  lastError = `天文计算失败：${message}`;
  state.time.running = false;
  if (snapshot) state.time.utDaysJ2000 = snapshot.utDaysJ2000;
  clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, false, performance.now());
  if (snapshotMatchesState()) updateControls();
  else controls.syncPlayback();
  lastUiMs = performance.now();
  updateStatus();
}, new URLSearchParams(location.search).get('worker') === 'off');
eventDays = new DayEventService(response => {
  if (disposed || hidden) return;
  if (response.component === 'solar') {
    if (!teachingEnabled || response.key !== updateDayKey()) return;
    if (response.status === 'ready') { dayResult = { key: response.key, events: response.result }; dayError = null; }
    else dayError = response.error;
  } else {
    if (!objectDayEnabled || response.key !== updateObjectDayKey()) return;
    if (response.status === 'ready') { objectResult = { key: response.key, events: response.result }; objectError = null; }
    else objectError = response.error;
  }
  updateControls();
}, new URLSearchParams(location.search).get('worker') === 'off' || new URLSearchParams(location.search).get('events-worker') === 'off');

/** Cheap civil-date candidate avoids an IANA day-boundary search on every accepted frame. */
function updateDayKey(): string | null {
  try {
    const local = localCivilParts(state.time.utDaysJ2000, state.observer.displayZone);
    const candidate = JSON.stringify([local.year, local.month, local.day, state.observer.latitudeDeg, state.observer.longitudeDegEast, state.observer.heightMeters, state.observer.displayZone]);
    if (candidate !== dayCandidate) {
      dayCandidate = candidate;
      currentDayKey = eventDays.keyForSolar(state);
      dayError = null;
    }
    return currentDayKey;
  } catch (error) {
    currentDayKey = null;
    dayError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
function objectTarget(): ObjectDayTargetResolution {
  if (selectedTargetId !== state.selected || !selectedTargetResolution) {
    selectedTargetId = state.selected;
    selectedTargetResolution = resolveObjectDayTarget(catalog, state.selected);
  }
  return selectedTargetResolution;
}
function updateObjectDayKey(): string | null {
  const resolution = objectTarget();
  if (!resolution.available) {
    objectUnsupportedReason = resolution.message;
    currentObjectKey = null; objectCandidate = ''; objectError = null;
    return null;
  }
  objectUnsupportedReason = null;
  const dayKey = updateDayKey();
  if (!dayKey) { currentObjectKey = null; objectError = dayError; return null; }
  const candidate = JSON.stringify([dayKey, resolution.target]);
  try {
    if (candidate !== objectCandidate) {
      currentObjectKey = eventDays.keyForObject(state, resolution.target);
      objectCandidate = candidate; objectError = null;
    }
    return currentObjectKey;
  } catch (error) { currentObjectKey = null; objectError = error instanceof Error ? error.message : String(error); return null; }
}
function refreshTeachingRequest(immediate = false): void {
  teachingEnabled = controls.isTeachingVisible() && !hidden;
  objectDayEnabled = controls.isObjectDayVisible() && !hidden;
  const resolution = objectTarget();
  const solarKey = teachingEnabled ? updateDayKey() : null;
  const selectedKey = objectDayEnabled ? updateObjectDayKey() : null;
  requestedDayKey = solarKey; requestedObjectKey = selectedKey;
  const batchKey = JSON.stringify([solarKey, selectedKey]);
  if (requestedBatchKey !== batchKey || immediate) {
    requestedBatchKey = batchKey;
    eventDays.request(state, { solar: solarKey !== null, selected: selectedKey && resolution.available ? resolution.target : null },
      immediate || !state.time.running, { solar: solarKey, selected: selectedKey });
  }
}
function teachingData(): TeachingData {
  const utcMs = utToDate(state.time.utDaysJ2000).getTime();
  const civilDayUtc8 = Math.floor((utcMs + 8 * 3_600_000) / 86_400_000);
  if (civilDayUtc8 !== lunarDay) { lunarDay = civilDayUtc8; lunarCalendar = lookupLunarCalendar(utcMs); }
  const key = controls.isTeachingVisible() ? updateDayKey() : null;
  const objectVisible = controls.isObjectDayVisible();
  const objectKey = objectVisible ? updateObjectDayKey() : null;
  const paired = snapshotMatchesState();
  return {
    lunarCalendar: lunarCalendar ?? undefined,
    moon: paired && snapshot ? computeMoonAppearance(snapshot, renderer?.kind === 'canvas2d' || state.viewMode === 'ground' ? 'topocentric' : 'geocentric') ?? undefined : undefined,
    solarDayKey: key ?? undefined,
    solarDayStatus: controls.isTeachingVisible() ? dayError ? 'error' : dayResult?.key === key ? 'ready' : 'pending' : undefined,
    solarDay: key && dayResult?.key === key ? dayResult.events : undefined,
    solarDayError: dayError ?? undefined,
    objectDayKey: objectKey ?? undefined,
    objectDayStatus: objectVisible ? objectUnsupportedReason ? 'unsupported' : objectError ? 'error' : objectResult?.key === objectKey ? 'ready' : 'pending' : undefined,
    objectDay: objectKey && objectResult?.key === objectKey ? objectResult.events : undefined,
    objectDayError: objectError ?? undefined,
    objectDayUnsupportedReason: objectUnsupportedReason ?? undefined,
    moonPhases: moonPhases ?? undefined, moonPhaseStatus, moonPhaseError,
  };
}
function updateControls(immediate = false): void {
  refreshTeachingRequest(immediate);
  if (snapshot && snapshotMatchesState()) {
    controls.update(snapshot, metrics(), teachingData());
    const appearance = skyAppearanceData();
    if (appearance) controls.updateSkyAppearance(appearance);
    else controls.invalidateSkyAppearance();
  } else controls.invalidateSkyAppearance();
}
/** Only the current derived display model is retained; it has no scientific state or clock. */
function skyAppearanceData(): SkyAppearance | null {
  if (!snapshot || !snapshotMatchesState()) return null;
  const kind = renderer?.kind ?? 'webgl2';
  const inputSignature = JSON.stringify([kind, state.viewMode, state.presentation, state.layers.atmosphere,
    state.environment.artificialSkyBrightness, state.environment.darkSkyLimitingMagnitude, state.environment.moonlightEnabled]);
  if (appearanceCache?.snapshot !== snapshot || appearanceCache.inputSignature !== inputSignature) {
    const displayState = kind === 'canvas2d' ? { ...state, viewMode: 'ground' as const } : state;
    appearanceCache = { snapshot, inputSignature, model: deriveSkyAppearance(displayState, snapshot) };
  }
  return appearanceCache.model;
}
function syncGraphicsStatus(): boolean {
  if (!renderer) return false;
  const graphics = renderer.status;
  const signature = JSON.stringify(graphics);
  if (signature === graphicsStatusSignature) return false;
  cancelViewTransition(graphics.contextLost ? 'context' : 'surface');
  resetRuntimeQuality(graphics.contextLost ? 'context' : 'surface');
  graphicsStatusSignature = signature;
  if (!pendingFocus) actionStatus = '';
  controls.setGraphicsStatus(graphics);
  appearanceCache = null;
  loupeAvailabilitySignature = '';
  updateStatus();
  return true;
}
function syncMoonLoupe(): boolean {
  const info = renderer?.getMoonLoupeDiagnostics();
  const supported = Boolean(renderer?.status.available && renderer.status.capabilities.moonLoupe);
  const availability = !supported ? 'error' : !snapshotMatchesState() ? 'pending' : info?.status ?? 'pending';
  const signature = `${availability}:${state.viewMode}:${info?.magnificationRelativeToMain?.toFixed(1) ?? ''}`;
  if (signature !== loupeAvailabilitySignature) {
    loupeAvailabilitySignature = signature;
    controls.setMoonLoupeAvailability(availability, info?.errorMessage ?? (!supported ? '二维方位图不支持月相放大镜，科学月相读数仍可用。' : undefined), { magnificationRelativeToMain: info?.magnificationRelativeToMain });
  }
  const rect = availability === 'ready' ? controls.getMoonLoupeViewport() : null;
  const nextSignature = rect ? JSON.stringify([rect.left, rect.top, rect.width, rect.height]) : '';
  const changed = nextSignature !== loupeRectSignature;
  loupeRectSignature = nextSignature;
  renderer?.setMoonLoupeViewport(rect);
  return changed;
}

function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}
function metrics(): RuntimeMetrics {
  const base = renderer?.getMetrics();
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    samplingWindowSeconds: frameIntervals.reduce((sum, ms) => sum + ms, 0) / 1000,
    frameMs: { p50: quantile(frameIntervals, .5), p95: quantile(frameIntervals, .95), p99: quantile(frameIntervals, .99) },
    drawCallsPerFrame: base?.drawCallsPerFrame ?? 0,
    visibleLabelCount: base?.visibleLabelCount ?? 0,
    pendingLatestRequestCount: science.pendingLatestRequestCount,
    textureCount: base?.textureCount ?? 0,
    geometryCount: base?.geometryCount ?? 0,
    appOwnedGpuBytesEstimate: base?.appOwnedGpuBytesEstimate ?? 0,
    mainThreadJsHeapBytes: memory?.usedJSHeapSize ?? null,
    workerHeapBytes: null,
    measurementNotes: [...(base?.measurementNotes ?? []).filter(note => !note.startsWith('frameMs')), ...science.notes, 'frameMs来自应用RAF（最近600帧）；renderer CPU提交分位数单独放入diagnostics。暂停空闲无样本。Worker堆和浏览器/驱动GPU内存不可测。'],
  };
}
function settleTransitionSurface(): void {
  if (transitionCanvas) transitionCanvas.style.opacity = '';
  transitionCanvas = null;
  renderer?.setStageInputEnabled(true);
}
function cancelViewTransition(reason: ViewTransitionCancelReason): void {
  viewTransition?.cancel(reason);
}
function resetRuntimeQuality(reason: QualityResetReason, nowMs = performance.now()): void {
  qualityGeneration++;
  qualityConfig = QUALITY_CONFIGS[renderBudgetClass(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight, coarsePointer.matches)];
  qualityCapabilities = renderer?.getRuntimeQualityCapabilities() ?? NO_RUNTIME_QUALITY_CAPABILITIES;
  const result = advanceQuality(qualityState, { kind: 'reset', generation: qualityGeneration, nowMs, reason }, qualityConfig, qualityCapabilities);
  qualityState = result.state; qualityLastReason = result.reason;
  qualitySampler.reset(qualityGeneration, nowMs); qualityPreviousDrawMs = null;
  applyRuntimeQuality(result.effects);
}
function applyRuntimeQuality(next: Readonly<RuntimeRenderQuality>): void {
  if (next.hideOrdinaryBackLabels === qualityEffects.hideOrdinaryBackLabels
    && next.hideOrdinarySecondaryLabels === qualityEffects.hideOrdinarySecondaryLabels
    && next.ordinaryLabelBudgetScale === qualityEffects.ordinaryLabelBudgetScale
    && next.reduceVerifiedDecoration === qualityEffects.reduceVerifiedDecoration
    && next.pixelScale === qualityEffects.pixelScale
    && next.omitOptionalInvisibleStars === qualityEffects.omitOptionalInvisibleStars) return;
  qualityEffects = next;
  renderer?.setRuntimeQuality(next);
  const reduced = [next.hideOrdinarySecondaryLabels || next.ordinaryLabelBudgetScale < 1 ? '减少次要标签' : '',
    next.reduceVerifiedDecoration ? '简化装饰细节' : '', next.pixelScale < 1 ? '降低绘图分辨率' : '',
    next.omitOptionalInvisibleStars ? '省略无贡献的额外暗星' : ''].filter(Boolean);
  qualityStatus = reduced.length ? `为保持流畅，已${reduced.join('、')}` : '';
  updateStatus();
  // Display-only dirty; no clock/science request, no new RAF chain.
  invalidate();
}
function evaluateRuntimeQualityWindow(nowMs: number): number {
  const startedMs = performance.now();
  // Apply completed-window effects before drawing; changing backing size after draw would erase this paint.
  const window = qualitySampler.takeWindow(nowMs, qualityConfig);
  if (window) {
    const result = advanceQuality(qualityState, { kind: 'window', window }, qualityConfig, qualityCapabilities);
    qualityState = result.state; qualityLastReason = result.reason;
    applyRuntimeQuality(result.effects);
  }
  return performance.now() - startedMs;
}
function finishFrameQuality(startedMs: number, nowMs: number, rendered: boolean, accepted: boolean,
  rendererSubmitMs: number | null, frameGeneration: number, evaluationWorkMs = 0): void {
  const samplingStartedMs = performance.now();
  let exclusion: QualityExclusion | null = null;
  const eventComputeRevision = eventDays?.mainThreadComputationRevision ?? 0;
  if (hidden) exclusion = 'hidden';
  else if (!state.time.running) exclusion = 'paused';
  else if (!renderer?.status.available) exclusion = 'unavailable';
  else if (frameGeneration !== qualityGeneration || nowMs < qualityState.settleUntilMs) exclusion = 'settle';
  else if (viewTransition?.diagnostics.phase !== 'idle') exclusion = 'transition';
  else if (science.mode === 'main-thread-budgeted') exclusion = 'science-fallback';
  else if (eventDays?.mainThreadComputationActive || eventComputeRevision !== qualityEventComputeRevision) exclusion = 'event-compute';
  // Accepted snapshot provenance was checked above; avoid serializing that signature again per sample.
  else if (scienceDirty || !snapshot || snapshot.utDaysJ2000 !== state.time.utDaysJ2000) exclusion = 'unpaired';
  else if (!rendered || !accepted) exclusion = 'science-wait';
  else if (qualityPreviousDrawMs === null) exclusion = 'not-adjacent';
  const interval = qualityPreviousDrawMs === null ? null : nowMs - qualityPreviousDrawMs;
  qualitySampler.record({ generation: qualityGeneration, nowMs, rafIntervalMs: interval,
    rendererSubmitMs, appWorkMs: performance.now() - startedMs, exclusion });
  // The first valid draw seeds adjacency; excluded waits never bridge a slow science gap.
  qualityPreviousDrawMs = rendered && accepted && (exclusion === null || exclusion === 'not-adjacent') ? nowMs : null;
  qualityEventComputeRevision = eventComputeRevision;
  qualitySamplingWorkMs = evaluationWorkMs + performance.now() - samplingStartedMs;
  qualitySampler.finishLastAppWork(performance.now() - startedMs);
}
function invalidate(): void {
  if (disposed || hidden) return;
  dirty = true;
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame(nowMs: number): void {
  const startedMs = performance.now();
  const frameGeneration = qualityGeneration;
  let qualityRendered = false, qualityAccepted = false;
  let rendererSubmitMs: number | null = null;
  let qualityEvaluationWorkMs = 0;
  try {
  raf = 0;
  if (disposed || hidden) return;
  frameCount++;
  if (syncGraphicsStatus() && snapshotMatchesState()) { processInteractionIntents(); updateControls(); }
  qualityEvaluationWorkMs = evaluateRuntimeQualityWindow(nowMs);
  if (pendingSnapshot) {
    const next = pendingSnapshot;
    pendingSnapshot = null;
    if (next.inputSignature === scienceInputSignature(state)) {
      const needsImmediateUi = snapshotNeedsImmediateUi(scienceDirty, ready, state.time.running);
      snapshot = next.snapshot;
      qualityAccepted = true;
      snapshotInputSignature = next.inputSignature;
      state.time.utDaysJ2000 = snapshot.utDaysJ2000;
      lastPublishedUt = snapshot.utDaysJ2000;
      scienceDirty = false;
      if (lastError.startsWith('天文计算失败')) lastError = '';
      ready = true;
      processInteractionIntents();
      if (needsImmediateUi) {
        updateControls();
        lastUiMs = nowMs;
      }
      updateStatus();
    } else {
      scienceDirty = true;
      science.request(state);
    }
  }
  if (state.time.running) {
    if (previousFrameMs !== null) {
      frameIntervals.push(nowMs - previousFrameMs);
      if (frameIntervals.length > 600) frameIntervals.shift();
    }
    previousFrameMs = nowMs;
    // Request the exact monotonic target. Display time advances only with its accepted snapshot.
    if (science.activeRequestCount === 0 && science.pendingLatestRequestCount === 0) {
      lastScienceMs = nowMs;
      const requestState = structuredClone(state);
      requestState.time.utDaysJ2000 = clock.sample(nowMs);
      const targetYear = utToDate(requestState.time.utDaysJ2000).getUTCFullYear();
      if (targetYear < -2000 || targetYear > 4000) {
        cancelViewTransition('range-stop');
        resetRuntimeQuality('range-stop', nowMs);
        state.time.running = false;
        clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, false, nowMs);
        lastError = '已到支持日期范围边界（天文纪年 −2000 至 4000）；播放已暂停，保留最后有效天空。';
        updateControls();
        lastUiMs = nowMs;
        updateStatus();
      } else science.request(requestState);
    }
  } else previousFrameMs = null;
  if (snapshot && !scienceDirty && dirty && renderer?.status.available) {
    syncMoonLoupe();
    const displayAppearance = skyAppearanceData();
    const rendererStartedMs = performance.now();
    renderer?.render(state, snapshot, displayAppearance ?? undefined);
    rendererSubmitMs = performance.now() - rendererStartedMs;
    qualityRendered = true;
    renderCount++;
    if (state.time.running && previousRenderMs !== null) {
      renderedIntervals.push(nowMs - previousRenderMs);
      if (renderedIntervals.length > 600) renderedIntervals.shift();
    }
    previousRenderMs = state.time.running ? nowMs : null;
    lastRenderedUt = snapshot.utDaysJ2000;
    lastRenderedMode = state.viewMode;
    lastRenderedEffectiveView = renderer?.kind === 'canvas2d' ? 'ground' : state.viewMode;
    lastRenderedSelection = state.selected;
    lastRenderedReferenceLock = state.viewMode === 'ground' ? null : state.cameras[state.viewMode].referenceLock;
    dirty = false;
    const ticket = viewTransition?.diagnostics.ticket;
    if (ticket?.target === state.viewMode && renderer.kind === 'webgl2') {
      try { viewTransition?.onPairedRender(ticket); }
      catch (error) { transitionFailure = error instanceof Error ? error.message : String(error); cancelViewTransition('latest'); }
    }
    if (syncMoonLoupe()) invalidate();
  }
  if (snapshot && !scienceDirty && uiCadenceDue(nowMs, lastUiMs)) { updateControls(); lastUiMs = nowMs; }
  if (state.time.running && !raf) raf = requestAnimationFrame(frame);
  } finally {
    if (!disposed) finishFrameQuality(startedMs, nowMs, qualityRendered, qualityAccepted, rendererSubmitMs, frameGeneration, qualityEvaluationWorkMs);
  }
}
function onChange(reason = 'state'): void {
  if (disposed) return;
  resetRuntimeQuality(reason === 'view' ? 'view' : state.time.running ? 'input' : 'pause');
  renderer?.resetPointerGestures();
  if (reason === 'import' || reason === 'time-scene' || reason === 'time-reset') {
    cancelViewTransition(reason === 'import' ? 'import' : 'reset');
    resetInteractionIntents();
    moonPhases = null; moonPhaseStatus = undefined; moonPhaseError = undefined;
    moonPhaseSequenceRequest++;
    if (moonPhaseTimer !== null) clearTimeout(moonPhaseTimer);
    moonPhaseTimer = null;
  }
  if (reason === 'reference-lock' && state.viewMode !== 'ground') {
    cancelViewTransition('reference-lock');
    const mode = state.viewMode;
    const nextLock = state.cameras[mode].referenceLock;
    const previousLock = appliedReferenceLocks[mode];
    // Keep canonical camera state exportable while its new observer snapshot is pending.
    state.cameras[mode].referenceLock = previousLock;
    if (nextLock === previousLock) pendingLocks.delete(mode);
    else pendingLocks.set(mode, { previousLock, nextLock });
    processInteractionIntents();
    if (snapshotMatchesState()) updateControls();
    invalidate(); updateStatus();
    return;
  }
  if (['selection', 'view', 'layers', 'presentation', 'density', 'environment-appearance', 'graphics-mode', 'display-zone'].includes(reason)) {
    if (reason === 'selection') { if (pendingFocus?.selected !== state.selected) pendingFocus = null; actionStatus = ''; }
    if (reason === 'view') {
      if (pendingFocus?.mode !== state.viewMode) pendingFocus = null;
      actionStatus = '';
      if (renderer?.status.available && renderer.kind === 'webgl2' && lastRenderedMode !== state.viewMode) {
        transitionFailure = null;
        try { viewTransition?.request({ generation: ++transitionGeneration, target: state.viewMode }); }
        catch (error) { transitionFailure = error instanceof Error ? error.message : String(error); cancelViewTransition('latest'); }
      } else cancelViewTransition(renderer?.kind === 'webgl2' ? 'latest' : 'surface');
    }
    processInteractionIntents();
    if (snapshot && !scienceDirty) updateControls(reason === 'display-zone');
    invalidate();
    updateStatus();
    return;
  }
  if (reason === 'environment-refraction') {
    scienceDirty = true;
    pendingSnapshot = null;
    lastPublishedUt = requestEnvironmentSnapshot(state, clock, science, performance.now());
    controls.invalidateSkyAppearance();
    invalidate();
    updateStatus();
    return;
  }
  const nowMs = performance.now();
  if (reason !== 'import' && !reason.startsWith('time') && state.time.utDaysJ2000 === lastPublishedUt) state.time.utDaysJ2000 = clock.sample(nowMs);
  lastPublishedUt = state.time.utDaysJ2000;
  clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, state.time.running && !hidden, nowMs);
  previousFrameMs = null;
  previousRenderMs = null;
  lastScienceMs = nowMs;
  if (reason !== 'selection') { scienceDirty = true; pendingSnapshot = null; science.request(state); }
  controls.invalidateSkyAppearance();
  refreshTeachingRequest(!state.time.running);
  if (snapshot && !scienceDirty) updateControls();
  invalidate();
}
function resetInteractionIntents(): void {
  for (const mode of ['space', 'globe', 'horizon'] as const) appliedReferenceLocks[mode] = state.cameras[mode].referenceLock;
  pendingLocks.clear();
  pendingFocus = null;
  actionStatus = '';
}
function snapshotMatchesState(): boolean {
  return Boolean(snapshot && !scienceDirty && snapshot.utDaysJ2000 === state.time.utDaysJ2000 && snapshotInputSignature === scienceInputSignature(state));
}
function processInteractionIntents(): void {
  if (!renderer?.status.available || !snapshotMatchesState() || !snapshot) return;
  for (const [mode, transition] of renderer.status.capabilities.referenceLock ? pendingLocks : []) {
    state.cameras[mode].referenceLock = transition.nextLock;
    // A transient view adapter shares the canonical cameras; it owns no clock or science state.
    const viewAdapterState = mode === state.viewMode ? state : { ...state, viewMode: mode };
    renderer.changeReferenceLock(viewAdapterState, snapshot, transition.previousLock);
    appliedReferenceLocks[mode] = transition.nextLock;
    pendingLocks.delete(mode);
    dirty = true;
  }
  if (pendingFocus) {
    const intent = pendingFocus;
    pendingFocus = null;
    if (intent.mode === state.viewMode && intent.selected === state.selected) {
      lastFocusSucceeded = renderer.focusSelection(state, snapshot);
      actionStatus = renderer.kind === 'canvas2d'
        ? lastFocusSucceeded ? '选中对象已在二维方位图中高亮' : '选中对象当前不在几何地平之上'
        : lastFocusSucceeded ? (state.viewMode === 'space' ? '已定位至地球上方可见区域' : '选中对象已定位') : '当前选中对象无法定位';
      dirty = true;
    }
  }
}
function focusSelection(): boolean | null {
  cancelViewTransition('focus');
  resetRuntimeQuality('input');
  if (!state.selected) { actionStatus = '请先搜索或选择一个对象'; updateStatus(); return false; }
  pendingFocus = { mode: state.viewMode, selected: state.selected };
  lastFocusSucceeded = null;
  actionStatus = snapshotMatchesState() ? '' : '正在等待当前时间地点的天空，随后定位…';
  processInteractionIntents();
  invalidate(); updateStatus();
  return lastFocusSucceeded;
}
function capture(): string {
  cancelViewTransition('capture');
  resetRuntimeQuality('capture');
  if (!renderer?.status.available || !snapshot || scienceDirty) throw new Error(renderer?.status.message || '星空画面尚未就绪');
  renderer.render(state, snapshot, skyAppearanceData() ?? undefined);
  return renderer.capture();
}
function downloadCapture(): void {
  try {
    const link = document.createElement('a');
    link.download = `sky-${new Date().toISOString().replaceAll(':', '-')}.png`;
    link.href = capture();
    link.click();
  } catch (error) { lastError = error instanceof Error ? error.message : String(error); updateStatus(); }
}
function shareHash(): string {
  if (__SKY_PORTABLE__ || location.protocol === 'file:') throw new Error('便携版请导出场景 JSON；本机文件地址不是可分享网址。');
  const hash = `#scene=${encodeURIComponent(JSON.stringify(parseState(serializeState(state))))}`;
  try { history.replaceState(null, '', hash); } catch { /* file URL history may be restricted. */ }
  return `${location.href.split('#')[0]}${hash}`;
}
function pause(): void { state.time.utDaysJ2000 = clock.sample(performance.now()); state.time.running = false; onChange('pause'); }
function play(): void { state.time.running = true; onChange('play'); }
function setState(incoming: unknown): void { applyState(state, incoming); controls.rememberCurrentScene(); onChange('import'); }

window.addEventListener('sky:capture', downloadCapture);
window.addEventListener('sky:focus-selection', focusSelection);
window.addEventListener('sky:layout-change', invalidate);
window.addEventListener('sky:share', async () => {
  const request = ++shareRequest;
  if (__SKY_PORTABLE__ || location.protocol === 'file:') {
    controls.showShareResult({ mode: 'portable', json: serializeState(state), copied: false, message: '便携版提供场景 JSON；请导出或手动复制，不分享本机文件地址。' });
    return;
  }
  const url = shareHash();
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* UI provides the full manual-copy URL. */ }
  if (!disposed && request === shareRequest) controls.showShareResult({ mode: 'web', url, copied, message: copied ? '已复制完整场景链接。' : '未能自动复制；可手动复制以下完整场景链接。' });
});
window.addEventListener('sky:retry-3d', () => { renderer?.retry3D(); syncGraphicsStatus(); onChange('graphics-mode'); });
window.addEventListener('sky:teaching-visibility', () => { refreshTeachingRequest(true); updateControls(); invalidate(); });
window.addEventListener('sky:object-day-visibility', () => { if (!eventDays) return; refreshTeachingRequest(true); updateControls(); invalidate(); });
window.addEventListener('sky:moon-loupe', () => { syncMoonLoupe(); invalidate(); });
window.addEventListener('sky:moon-quarter-search', event => {
  const seed = (event as CustomEvent<{ seedUtDaysJ2000?: number }>).detail?.seedUtDaysJ2000 ?? snapshot?.utDaysJ2000;
  if (seed === undefined || !Number.isFinite(seed)) return;
  resetRuntimeQuality('input');
  const request = ++moonPhaseSequenceRequest;
  if (moonPhaseTimer !== null) clearTimeout(moonPhaseTimer);
  moonPhaseStatus = 'pending'; moonPhaseError = undefined; moonPhases = null;
  updateControls();
  moonPhaseTimer = setTimeout(() => {
    moonPhaseTimer = null;
    if (disposed || request !== moonPhaseSequenceRequest) return;
    const started = performance.now();
    try { moonPhases = computeMoonQuarterSequence(seed); moonPhaseStatus = 'ready'; }
    catch (error) { moonPhaseStatus = 'error'; moonPhaseError = error instanceof Error ? error.message : String(error); }
    moonPhaseComputeMs = performance.now() - started;
    resetRuntimeQuality('input');
    updateControls();
  }, 0);
});
document.addEventListener('visibilitychange', () => {
  const now = performance.now();
  if (document.hidden) {
    cancelViewTransition('hidden');
    resetRuntimeQuality('hidden', now);
    state.time.utDaysJ2000 = clock.sample(now);
    lastPublishedUt = state.time.utDaysJ2000;
    hidden = true;
    refreshTeachingRequest();
    pendingSnapshot = null;
    clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, false, now);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    previousFrameMs = null;
    previousRenderMs = null;
  } else {
    resetRuntimeQuality('resume', now);
    hidden = false;
    if (state.time.mode === 'realtime' && state.time.running) state.time.utDaysJ2000 = dateToUt(new Date());
    lastPublishedUt = state.time.utDaysJ2000;
    clock.rebase(state.time.utDaysJ2000, state.time.rateSimSecondsPerRealSecond, state.time.running, now);
    scienceDirty = true;
    controls.invalidateSkyAppearance();
    science.request(state);
    refreshTeachingRequest(!state.time.running);
    invalidate();
  }
});
const onResize = () => { cancelViewTransition('resize'); resetRuntimeQuality('resize'); renderer?.resize(); invalidate(); };
window.addEventListener('resize', onResize);
coarsePointer.addEventListener('change', onResize);
const onReducedMotion = () => { viewTransition?.setReducedMotion(reducedMotion.matches); resetRuntimeQuality('transition'); };
reducedMotion.addEventListener('change', onReducedMotion);
const warningObserver = new MutationObserver(records => {
  if (records.some(record => record.attributeName === 'data-asset-pending' || record.attributeName === 'data-asset-loaded')) resetRuntimeQuality('asset-warmup');
  updateStatus();
});
warningObserver.observe(stage, { attributes: true, attributeFilter: ['data-asset-warning', 'data-graphics-warning', 'data-asset-pending', 'data-asset-loaded'] });
function onPageHide(event: PageTransitionEvent): void {
  cancelViewTransition('pagehide');
  resetRuntimeQuality('hidden');
  if (event.persisted) { persistedPageHideCount++; return; }
  if (disposed) return;
  disposed = true;
  viewTransition?.dispose();
  reducedMotion.removeEventListener('change', onReducedMotion);
  coarsePointer.removeEventListener('change', onResize);
  window.removeEventListener('resize', onResize);
  disposeCount++;
  window.removeEventListener('pagehide', onPageHide);
  if (raf) cancelAnimationFrame(raf);
  science.dispose();
  eventDays.dispose();
  offlineController?.dispose();
  if (moonPhaseTimer !== null) clearTimeout(moonPhaseTimer);
  warningObserver.disconnect();
  controls.dispose();
  renderer?.dispose();
}
window.addEventListener('pagehide', onPageHide);

/** Reproducible QA and scenario APIs; all changes still use the single state/clock/kernel. */
const appApi = {
  get ready() { return ready; },
  get state() { return structuredClone(state); },
  get snapshot() { return snapshot; },
  get selectedDetails() { return snapshotMatchesState() && state.selected && snapshot ? resolveObjectDetails(catalog, state.selected, snapshot) : null; },
  get rendererDiagnostics() { return renderer?.getInteractionDiagnostics() ?? null; },
  get graphicsStatus() { return renderer ? structuredClone(renderer.status) : null; },
  get moonLoupeDiagnostics() { return renderer?.getMoonLoupeDiagnostics() ?? null; },
  get skyAppearance() { const model = skyAppearanceData(); return model ? structuredClone(model) : null; },
  get skyAppearanceDiagnostics() { return renderer?.getSkyAppearanceDiagnostics() ?? null; },
  get teachingData() { return structuredClone(teachingData()); },
  get offlineStatus() { return offlineInfo ? { ...offlineInfo } : null; },
  get metrics() { return metrics(); },
  get diagnostics() {
    return {
      frameCount, renderCount, lastRenderedSelection, lastRenderedReferenceLock,
      snapshotInputSignature, currentInputSignature: scienceInputSignature(state),
      pendingInteractionCount: pendingLocks.size + (pendingFocus ? 1 : 0), lastFocusSucceeded,
      assetStatus: renderer?.getAssetStatus() ?? null, assetWarning: stage.dataset.assetWarning ?? null,
      deliveredFrameMs: { p50: quantile(renderedIntervals, .5), p95: quantile(renderedIntervals, .95), p99: quantile(renderedIntervals, .99) },
      deliveredSamplingWindowSeconds: renderedIntervals.reduce((sum, ms) => sum + ms, 0) / 1000,
      performanceNowMs: performance.now(), lastRenderedUt, lastRenderedMode, lastRenderedEffectiveView, scienceDirty,
      graphics: renderer?.diagnostics ?? null,
      workerMode: science.mode, activeRequestCount: science.activeRequestCount,
      pendingLatestRequestCount: science.pendingLatestRequestCount, requestId: snapshot?.requestId ?? 0,
      scienceRequestCount: science.requestedCount,
      rendererCpuFrameMs: renderer?.getMetrics().frameMs ?? null,
      lastMainThreadComputeMs: science.lastMainThreadComputeMs,
      solarDay: eventDays.solarDiagnostics, solarDayKey: currentDayKey, requestedSolarDayKey: requestedDayKey,
      dayEvents: eventDays.diagnostics, objectDayKey: currentObjectKey, requestedObjectDayKey: requestedObjectKey,
      lifecycle: { disposed, persistedPageHideCount, disposeCount },
      runtimeQuality: { state: structuredClone(qualityState), effects: { ...qualityEffects }, capabilities: { ...qualityCapabilities },
        config: { ...qualityConfig }, lastReason: qualityLastReason, samplingWorkMsLast: qualitySamplingWorkMs,
        sampling: qualitySampler.diagnostics },
      viewTransition: viewTransition ? { ...viewTransition.diagnostics, failure: transitionFailure } : null,
      moonPhaseComputeMs, clockRebaseCount: clock.rebaseCount,
      workerCountMax: 2, workerCount: disposed ? 0 : (science.mode === 'worker' ? 1 : 0) + eventDays.diagnostics.workerCount, hidden,
    };
  },
  setState, pause, play, invalidate, capture, shareHash, focusSelection,
  checkForOfflineUpdate: () => offlineController?.checkForUpdate() ?? Promise.resolve(),
};
(window as Window & { skyApp?: typeof appApi }).skyApp = appApi;
science.request(state);
invalidate();
updateStatus();
void registerOffline(info => { if (disposed) return; offlineInfo = info; offlineStatus = info.message; controls.setOfflineStatus(info); updateStatus(); })
  .then(controller => { if (disposed) controller.dispose(); else offlineController = controller; });
