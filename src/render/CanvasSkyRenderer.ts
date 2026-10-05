import type { ExternalCamera, ObjectId, RuntimeMetrics, ScienceSnapshot, SimulationState, Vec3 } from '../contracts';
import { catalog } from '../data/catalog';
import { constellationLabel, resolveCatalogStar, starLabel } from '../data/search';
import { writeStarDirectionBuffer } from './StarDirectionBuffer';
import { ASTROMETRY_MODEL_VERSION, deriveStarMotionModel } from '../core/stars';
import { resolveDisplayDirectionEqj, resolveObjectDetails } from '../core/object-details';
import { applyMatrix } from '../core/math';
import { deriveSkyAppearance } from '../core/sky-appearance';
import type { SkyAppearance } from '../core/sky-appearance';
import type { SkyDiskPoint } from '../core/sky-map-projection';
import { getDisplayRefractionProfile } from '../core/refraction';
import type { RefractionProfile } from '../core/refraction';
import { clipSampleCanvasSkyArcEnu, projectCanvasEqjToSkyDisk } from './CanvasSkyProjection';
import { CANVAS_CAPABILITIES } from '../platform/renderer-port';
import type { RendererPort } from '../platform/renderer-port';
import { cappedPixelRatio } from './coordinates';
import { LabelLayer } from './LabelLayer';
import type { LabelCandidate } from './LabelLayer';
import { readSkyOcclusions } from './Occlusion';
import { canvasCaptionLayout, canvasOverviewLayout, canvasStarSymbol, canvasTeachingLabelBudget } from './CanvasOverviewLayout';
import { createPointerGesture, gestureMode, reducePointerGesture } from './PointerGestures';
import type { PointerGestureInput } from './PointerGestures';
import { DEFAULT_RUNTIME_RENDER_QUALITY, renderBudgetClass } from '../platform/runtime-quality-contract';
import type { RuntimeRenderQuality } from '../platform/runtime-quality-contract';
import { runtimeLabelSecondary, runtimeOrdinaryLabelBudget, sameRuntimeRenderQuality } from './RenderQuality';
import { CANVAS_RUNTIME_QUALITY_CAPABILITIES, canvasRuntimeRaster } from './CanvasRuntimeQuality';

interface Viewport { centerX: number; centerY: number; radius: number; width: number; height: number; pixelRatio: number; compactHud: boolean; layoutRegion: Block | null }
interface HitTarget { id: ObjectId; x: number; y: number; radius: number; magnitude?: number }
interface Block { left: number; top: number; right: number; bottom: number }
interface CaptionLine { text: string; font: string; color: string }
interface Caption { box: Block | null; lines: CaptionLine[]; lineHeight: number; baselineOffset: number; status: 'complete' | 'primary-only' | 'hidden' }
const linearChannel = (value: number): number => Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055));
const cssRgb = (color: Vec3): string => `rgb(${color.map(value => linearChannel(Math.max(0, Math.min(1, value)))).join(' ')})`;

/** Fixed observer overview. Owns no clock, worker, ephemeris or WebGL resources. */
export class CanvasSkyRenderer implements RendererPort {
  readonly canvas: HTMLCanvasElement;
  readonly capabilities = CANVAS_CAPABILITIES;
  private readonly context: CanvasRenderingContext2D;
  private labels: LabelLayer | null = null;
  private readonly hudBlocks: HTMLDivElement[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private state: SimulationState | null = null;
  private snapshot: ScienceSnapshot | null = null;
  private appearance: SkyAppearance | null = null;
  private refractionProfile: RefractionProfile | null = null;
  private readonly starDirections = new Float64Array(catalog.stars.length * 3);
  private readonly starCss = catalog.stars.map(star => cssRgb([
    catalog.colors[star.index * 3]!, catalog.colors[star.index * 3 + 1]!, catalog.colors[star.index * 3 + 2]!,
  ]));
  private lastStarUt = NaN;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private baseRatio = 1;
  private runtimeQuality: Readonly<RuntimeRenderQuality> = DEFAULT_RUNTIME_RENDER_QUALITY;
  private stageInputEnabled = true;
  private ordinaryLabelBudget = 0;
  private viewport: Viewport = { centerX: .5, centerY: .5, radius: .1, width: 1, height: 1, pixelRatio: 1, compactHud: false, layoutRegion: null };
  private blocks: Block[] = [];
  private actualOccluders: Block[] = [];
  private header: Caption = { box: null, lines: [], lineHeight: 18, baselineOffset: 14, status: 'hidden' };
  private footer: Caption = { box: null, lines: [], lineHeight: 16, baselineOffset: 12, status: 'hidden' };
  private stars: HitTarget[] = [];
  private bodies: HitTarget[] = [];
  private selectedPoint: { x: number; y: number } | null = null;
  private selectedDirection: Vec3 | null = null;
  private canonicalSelected: ObjectId | null = null;
  private selectedAboveHorizon = false;
  private selectedGeometricallyAboveHorizon = false;
  private focusReason = '固定全天总览：定位仅高亮方向，不改变三维视角。';
  private focusRequestedFor: ObjectId | null = null;
  private readonly samples: number[] = [];
  private segmentCount = 0;
  private segmentPointCount = 0;
  private cappedArcCount = 0;
  private ambiguousArcCount = 0;
  private arcKnotBudgetExceededCount = 0;
  private maximumArcStepDeg = 0;
  private gesture = createPointerGesture();
  private lastInteractionSignature = '';
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly onInvalidate: () => void, private readonly onSelect?: (id: ObjectId | null) => void) {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('此浏览器无法建立二维星图。');
    this.context = context;
    this.canvas.className = 'sky-canvas2d-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '二维全天方位星图，天顶在中心，北上东左；点击选择，固定总览不拖动缩放。太阳月球为方向标记。');
    this.canvas.tabIndex = 0;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'manipulation' });
    try {
      container.append(this.canvas);
      this.labels = new LabelLayer(container, () => { if (!this.disposed) this.onInvalidate(); });
      for (let index = 0; index < 9; index++) {
        const block = document.createElement('div'); block.dataset.skyOcclusion = 'true'; block.dataset.canvasSkyHud = 'true'; block.setAttribute('aria-hidden', 'true');
        Object.assign(block.style, { position: 'absolute', pointerEvents: 'none', background: 'transparent' });
        container.append(block); this.hudBlocks.push(block);
      }
      this.canvas.addEventListener('pointerdown', this.onPointerDown);
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerup', this.onPointerUp);
      this.canvas.addEventListener('pointercancel', this.onPointerCancel);
      this.canvas.addEventListener('lostpointercapture', this.onLostCapture);
      this.canvas.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('blur', this.onBlur);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      this.resizeObserver = new ResizeObserver(() => { this.resize(); if (!this.disposed) this.onInvalidate(); });
      this.resizeObserver.observe(container);
      this.resize();
    } catch (error) {
      this.dispose();
      // LabelLayer can fail before assignment; this surface is owned by this renderer.
      for (const abandoned of container.querySelectorAll('.sky-label-canvas')) abandoned.remove();
      throw error;
    }
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    const budgetMobile = renderBudgetClass(width, height, window.matchMedia('(pointer: coarse)').matches) === 'mobile';
    const baseRatio = cappedPixelRatio(width, height, window.devicePixelRatio || 1, budgetMobile);
    const raster = canvasRuntimeRaster(width, height, baseRatio, this.runtimeQuality.pixelScale);
    const labelSizeChanged = width !== this.width || height !== this.height || baseRatio !== this.baseRatio
      || this.labels?.canvas.width !== raster.labelWidth || this.labels?.canvas.height !== raster.labelHeight;
    if (labelSizeChanged || raster.mainPixelRatio !== this.ratio) {
      this.resetPointerGestures();
      this.width = width; this.height = height; this.ratio = raster.mainPixelRatio; this.baseRatio = baseRatio;
      this.canvas.width = raster.mainWidth; this.canvas.height = raster.mainHeight;
      if (labelSizeChanged) this.labels?.resize(width, height, baseRatio);
    }
    this.updateViewport();
  }

  private isMobile(): boolean {
    return window.matchMedia('(max-width: 640px), (pointer: coarse) and (max-height: 600px)').matches;
  }
  private budgetMobile(): boolean {
    return renderBudgetClass(this.width, this.height, window.matchMedia('(pointer: coarse)').matches) === 'mobile';
  }

  private updateViewport(): void {
    const occluders = readSkyOcclusions(this.container);
    this.actualOccluders = occluders.filter(block => !block.canvasHud).map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
    this.blocks = occluders.filter(block => !block.canvasHud).map(block => ({ left: block.left - 4, top: block.top - 4, right: block.right + 4, bottom: block.bottom + 4 }));
    const layout = canvasOverviewLayout(this.width, this.height, this.isMobile(), occluders);
    this.viewport = { centerX: layout.centerX, centerY: layout.centerY, radius: layout.radius, width: this.width, height: this.height, pixelRatio: this.ratio,
      compactHud: layout.compactHud, layoutRegion: layout.compactHud ? { ...layout.usableBounds, top: 12, bottom: layout.usableBounds.bottom + 64 } : null };
  }

  private updateFixedHud(): void {
    const v = this.viewport, titleY = Math.max(38, v.centerY - v.radius - 48), footerY = Math.min(this.height - 53, v.centerY + v.radius + 39);
    const refracted = this.refractionProfile?.identity === false;
    const reserved = [
      { left: v.centerX - v.radius, right: v.centerX + v.radius, top: v.centerY - v.radius, bottom: v.centerY + v.radius },
      { left: v.centerX - 24, right: v.centerX + 24, top: v.centerY - v.radius - 25, bottom: v.centerY - v.radius - 9 },
      { left: v.centerX - 24, right: v.centerX + 24, top: v.centerY + v.radius + 8, bottom: v.centerY + v.radius + 23 },
    ];
    const place = (lines: CaptionLine[], baseline: number, lineHeight: number, baselineOffset: number, other: Block | null): Caption => {
      // Try the full text first, then the primary line. Never squeeze the map or fonts.
      for (const count of [lines.length, 1]) {
        const shown = lines.slice(0, count);
        const width = Math.max(...shown.map(line => { this.context.font = line.font; return this.context.measureText(line.text).width; })) + 8;
        const desired = { left: v.centerX - width / 2, right: v.centerX + width / 2, top: baseline - baselineOffset, bottom: baseline - baselineOffset + count * lineHeight };
        const box = canvasCaptionLayout(desired, this.width, this.height, this.actualOccluders, other ? [...reserved, other] : reserved);
        if (box) return { box, lines: shown, lineHeight, baselineOffset, status: count === lines.length ? 'complete' : 'primary-only' };
      }
      return { box: null, lines: [], lineHeight, baselineOffset, status: 'hidden' };
    };
    this.header = place([
      { text: v.compactHud ? refracted ? '全天图 · 标准折射' : '全天图 · 几何'
        : refracted ? '二维全天方位星图 · 标准折射' : '二维全天方位星图 · 几何', font: '13px "Microsoft YaHei",sans-serif', color: '#dbe5ec' },
      { text: v.compactHud ? '北上东左 · 固定仰视' : `北上东左 · 天顶在中心 · 仅${refracted ? '视' : '几何'}地平线上方`, font: '10px "Microsoft YaHei",sans-serif', color: '#a6b8c7' },
    ], titleY, 18, 14, null);
    const footerLines = [
      { text: v.compactHud ? '日月仅方向标记' : '日月仅方向标记 · 不表示真实角径或月相', font: '10px "Microsoft YaHei",sans-serif', color: '#a6b8c7' },
      { text: v.compactHud ? '点击选择 · 不缩放' : '点击选择 · 定位只高亮 · 不拖动缩放', font: '10px "Microsoft YaHei",sans-serif', color: '#a6b8c7' },
    ];
    if (this.state?.selected) footerLines.push({ text: v.compactHud ? (this.selectedAboveHorizon ? '定位只高亮方向' : '所选在地平线下') : this.focusReason,
      font: '10px "Microsoft YaHei",sans-serif', color: '#bed5e7' });
    this.footer = place(footerLines, footerY, 16, 12, this.header.box);
    const captionBox = (caption: Caption) => caption.box ? [caption.box.left, caption.box.top, caption.box.right - caption.box.left, caption.box.bottom - caption.box.top] : [0, 0, 0, 0];
    const boxes = [
      captionBox(this.header),
      [v.centerX - 32, v.centerY - v.radius - 29, 64, 22],
      [v.centerX - 32, v.centerY + v.radius + 5, 64, 22],
      [v.centerX - v.radius + (v.compactHud ? 3 : -45), v.centerY - 10, 45, 24],
      [v.centerX + v.radius + (v.compactHud ? -48 : 2), v.centerY - 10, 46, 24],
      captionBox(this.footer),
      ...[0, 30, 60].map(altitude => [v.centerX + 3, v.centerY - (90 - altitude) / 90 * v.radius + 1, 25, 15]),
    ];
    this.hudBlocks.forEach((block, index) => { const box = boxes[index]!;
      const visible = index === 0 ? !!this.header.box : index === 5 ? !!this.footer.box : index < 6 || v.radius < 90 && index === 6;
      Object.assign(block.style, { display: visible ? 'block' : 'none', left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2]}px`, height: `${box[3]}px` }); });
  }

  private blocked(x: number, y: number): boolean {
    return this.blocks.some(block => x >= block.left && x <= block.right && y >= block.top && y <= block.bottom);
  }
  private pixel(point: SkyDiskPoint): { x: number; y: number } {
    return { x: this.viewport.centerX + point.x * this.viewport.radius, y: this.viewport.centerY + point.y * this.viewport.radius };
  }
  private starDirection(index: number): Vec3 {
    return [this.starDirections[index * 3]!, this.starDirections[index * 3 + 1]!, this.starDirections[index * 3 + 2]!];
  }
  private projectDirection(direction: Vec3, snapshot: ScienceSnapshot): SkyDiskPoint | null {
    const profile = this.snapshot === snapshot && this.refractionProfile ? this.refractionProfile : getDisplayRefractionProfile(snapshot, 'ground');
    return projectCanvasEqjToSkyDisk(direction, snapshot, profile);
  }
  private belowHorizonReason(snapshot: ScienceSnapshot): string {
    return getDisplayRefractionProfile(snapshot, 'ground').identity
      ? '所选对象在几何地平线下，全天图不可见。' : '所选对象在视地平线下，标准折射全天图不可见。';
  }
  private updateStarDirections(ut: number): void {
    if (ut === this.lastStarUt) return;
    writeStarDirectionBuffer(catalog.stars, ut, this.starDirections);
    this.lastStarUt = ut;
  }

  render(state: SimulationState, snapshot: ScienceSnapshot, appearance?: SkyAppearance): void {
    if (this.disposed) return;
    const start = performance.now();
    const signature = JSON.stringify([state.viewMode, state.selected, state.observer, state.layers, snapshot.observerRefraction, state.presentation, state.density, state.time.mode, state.time.rateSimSecondsPerRealSecond]);
    if (signature !== this.lastInteractionSignature) this.resetPointerGestures();
    this.lastInteractionSignature = signature;
    this.state = state; this.snapshot = snapshot;
    this.refractionProfile = getDisplayRefractionProfile(snapshot, 'ground');
    const aria = `二维全天方位星图，${this.refractionProfile.identity ? '几何' : '标准折射'}地平总览，天顶在中心，北上东左；点击选择，固定总览不拖动缩放。太阳月球为方向标记。`;
    if (this.canvas.getAttribute('aria-label') !== aria) this.canvas.setAttribute('aria-label', aria);
    this.appearance = appearance ?? deriveSkyAppearance({ ...state, viewMode: 'ground' }, snapshot);
    this.resize(); this.updateStarDirections(snapshot.utDaysJ2000);
    this.stars = []; this.bodies = []; this.segmentCount = 0; this.segmentPointCount = 0;
    this.cappedArcCount = 0; this.ambiguousArcCount = 0; this.arcKnotBudgetExceededCount = 0; this.maximumArcStepDeg = 0;
    const ctx = this.context, view = this.viewport, model = this.appearance;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.globalAlpha = 1; ctx.fillStyle = '#070d14'; ctx.fillRect(0, 0, this.width, this.height);
    const gradient = ctx.createRadialGradient(view.centerX, view.centerY, 0, view.centerX, view.centerY, view.radius);
    gradient.addColorStop(0, cssRgb(model.backgroundLinearRgb));
    gradient.addColorStop(1, cssRgb(model.horizonGlowLinearRgb));
    ctx.beginPath(); ctx.arc(view.centerX, view.centerY, view.radius, 0, Math.PI * 2); ctx.fillStyle = gradient; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(view.centerX, view.centerY, view.radius, 0, Math.PI * 2); ctx.clip();

    if (state.layers.constellationLines && model.starVisibility > .0001) this.drawConstellationLines(state, snapshot, model.starVisibility, false);
    // M2 selection is a separate direction overlay, even when ordinary lines are hidden.
    if (state.selected?.startsWith('constellation:')) this.drawConstellationLines(state, snapshot, 1, true);
    const labels: LabelCandidate[] = [];
    for (const star of catalog.stars) {
      if (star.magnitude > model.limitingMagnitude || model.starVisibility <= .0001) continue;
      const projection = this.projectDirection(this.starDirection(star.index), snapshot);
      if (!projection) continue;
      const point = this.pixel(projection);
      if (this.blocked(point.x, point.y)) continue;
      const symbol = canvasStarSymbol(star.magnitude, view.radius);
      // Symbol contrast is an explicit visual hierarchy, not a calibrated flux model.
      ctx.globalAlpha = model.starVisibility * symbol.alpha; ctx.fillStyle = this.starCss[star.index]!;
      ctx.beginPath(); ctx.arc(point.x, point.y, symbol.radius, 0, Math.PI * 2); ctx.fill();
      this.stars.push({ id: star.id, ...point, radius: 11, magnitude: star.magnitude });
      if (state.layers.brightStarNamesZh && star.nameZh) labels.push({ id: star.id, text: starLabel(star),
        secondary: runtimeLabelSecondary({ id: star.id }, state.layers.secondaryNames ? star.nameEn : undefined, this.runtimeQuality), ...point, priority: 30 - star.magnitude,
        color: '#cbd8e3', alpha: Math.max(.4, model.starVisibility) });
    }
    ctx.globalAlpha = 1;
    if (state.layers.constellationLabels && model.starVisibility > .0001) {
      for (const figure of catalog.constellations) {
        const id = `constellation:${figure.id}` as const;
        const direction = resolveDisplayDirectionEqj(catalog, id, snapshot, 'ground');
        const projection = direction ? this.projectDirection(direction, snapshot) : null;
        if (!projection) continue;
        const point = this.pixel(projection);
        if (this.blocked(point.x, point.y)) continue;
        labels.push({ id, text: constellationLabel(figure), ...point, priority: 45, color: '#afbfce', alpha: Math.max(.4, model.starVisibility) });
      }
    }
    if (state.layers.sunMoon) this.drawBodyMarkers(snapshot, labels);
    this.drawSelection(state, snapshot, labels);
    ctx.restore();
    this.drawGridAndExplanation();
    const uniqueLabels = new Map<string, LabelCandidate>();
    for (const label of labels) if (!uniqueLabels.has(label.id) || uniqueLabels.get(label.id)!.priority < label.priority) uniqueLabels.set(label.id, label);
    const mobile = this.budgetMobile();
    const teachingBudget = canvasTeachingLabelBudget(view.radius, mobile);
    const baseBudget = state.density === 'reference' ? mobile ? 24 : 60 : teachingBudget;
    this.ordinaryLabelBudget = runtimeOrdinaryLabelBudget(baseBudget, this.runtimeQuality);
    this.labels?.draw([...uniqueLabels.values()], state.density === 'reference', baseBudget, this.ordinaryLabelBudget);
    this.drawFixedTextOverlay();
    this.samples.push(performance.now() - start);
    if (this.samples.length > 240) this.samples.shift();
  }

  private drawConstellationLines(state: SimulationState, snapshot: ScienceSnapshot, visibility: number, selectedOnly: boolean): void {
    const ctx = this.context;
    for (const figure of catalog.constellations) {
      const selected = state.selected?.toLowerCase() === `constellation:${figure.id}`.toLowerCase();
      if (selectedOnly && !selected) continue;
      ctx.strokeStyle = selectedOnly ? '#bbd9ef' : '#546c81'; ctx.lineWidth = selectedOnly ? 1.6 : .7; ctx.globalAlpha = visibility * (selectedOnly ? .85 : .5);
      for (let segment = figure.lineStart; segment < figure.lineStart + figure.lineCount; segment++) {
        const a = catalog.lineIndices[segment * 2]!, b = catalog.lineIndices[segment * 2 + 1]!;
        const arc = clipSampleCanvasSkyArcEnu(applyMatrix(snapshot.eqjToHorizontalGeometric, this.starDirection(a)), applyMatrix(snapshot.eqjToHorizontalGeometric, this.starDirection(b)), this.refractionProfile!);
        this.cappedArcCount += arc.sampling.capLimited ? 1 : 0;
        this.ambiguousArcCount += arc.sampling.ambiguousMinorArc ? 1 : 0;
        this.arcKnotBudgetExceededCount += arc.sampling.knotBudgetExceeded ? 1 : 0;
        this.maximumArcStepDeg = Math.max(this.maximumArcStepDeg, arc.sampling.actualMaxAngularStepDeg);
        for (const path of arc.paths) {
          if (path.length < 2) continue;
          ctx.beginPath(); path.forEach((projection, index) => { const point = this.pixel(projection); if (index) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y); });
          ctx.stroke(); this.segmentCount++; this.segmentPointCount += path.length;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawBodyMarkers(snapshot: ScienceSnapshot, labels: LabelCandidate[]): void {
    const ctx = this.context;
    for (const [name, label, color] of [['Sun', '太阳', '#f7d17b'], ['Moon', '月球', '#d8e1eb']] as const) {
      const id = `body:${name}` as const;
      const direction = resolveDisplayDirectionEqj(catalog, id, snapshot, 'ground');
      const projection = direction ? this.projectDirection(direction, snapshot) : null;
      if (!projection) continue;
      const point = this.pixel(projection);
      if (this.blocked(point.x, point.y)) continue;
      const radius = name === 'Sun' ? 6 : 5;
      ctx.lineWidth = 1.7; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.stroke();
      if (name === 'Sun') {
        ctx.beginPath(); ctx.moveTo(point.x - 10, point.y); ctx.lineTo(point.x + 10, point.y); ctx.moveTo(point.x, point.y - 10); ctx.lineTo(point.x, point.y + 10); ctx.stroke();
      }
      this.bodies.push({ id, ...point, radius: 15 });
      labels.push({ id, text: label, secondary: '方向标记', ...point, priority: 85, color });
    }
  }

  private drawSelection(state: SimulationState, snapshot: ScienceSnapshot, labels: LabelCandidate[]): void {
    const details = resolveObjectDetails(catalog, state.selected, snapshot);
    this.canonicalSelected = details?.id ?? null;
    this.selectedDirection = resolveDisplayDirectionEqj(catalog, state.selected, snapshot, 'ground');
    const projection = this.selectedDirection ? this.projectDirection(this.selectedDirection, snapshot) : null;
    this.selectedAboveHorizon = projection !== null;
    this.selectedGeometricallyAboveHorizon = !!this.selectedDirection && applyMatrix(snapshot.eqjToHorizontalGeometric, this.selectedDirection)[2] >= 0;
    this.selectedPoint = projection ? this.pixel(projection) : null;
    if (!state.selected) this.focusReason = '固定全天总览：定位仅高亮方向，不改变三维视角。';
    else if (!details) this.focusReason = '未找到该对象，无法标记方向。';
    else if (!projection) this.focusReason = this.belowHorizonReason(snapshot);
    else if (this.selectedPoint && this.blocked(this.selectedPoint.x, this.selectedPoint.y)) this.focusReason = '所选方向被面板遮挡，请收起面板查看。';
    else this.focusReason = details.kind === 'star' && (details.magnitude! > this.appearance!.limitingMagnitude || this.appearance!.starVisibility <= .0001)
      ? '所选仅作方向标记；当前可见性模型已隐藏该星点。' : '已标记所选方向；高亮不保证肉眼可见。';
    if (!details || !this.selectedPoint || this.blocked(this.selectedPoint.x, this.selectedPoint.y)) return;
    const ctx = this.context, point = this.selectedPoint;
    ctx.globalAlpha = 1; ctx.strokeStyle = '#d3eafa'; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.arc(point.x, point.y, this.focusRequestedFor === details.id ? 13 : 10, 0, Math.PI * 2); ctx.stroke();
    const selectedStar = details.kind === 'star' ? resolveCatalogStar(catalog, details.id) : null;
    const secondary = details.kind === 'body' ? '方向标记' : state.layers.secondaryNames ? selectedStar?.nameEn : undefined;
    labels.push({ id: details.id, text: details.label, secondary, ...point, priority: 1000, selected: true, color: '#e4f2fc' });
  }

  private drawGridAndExplanation(): void {
    const ctx = this.context, view = this.viewport;
    this.updateFixedHud();
    ctx.globalAlpha = 1; ctx.lineWidth = .8; ctx.strokeStyle = '#354c60';
    for (const altitude of [0, 30, 60]) {
      const radius = (90 - altitude) / 90 * view.radius;
      ctx.beginPath(); ctx.arc(view.centerX, view.centerY, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([3, 5]); ctx.beginPath();
    ctx.moveTo(view.centerX, view.centerY - view.radius); ctx.lineTo(view.centerX, view.centerY + view.radius);
    ctx.moveTo(view.centerX - view.radius, view.centerY); ctx.lineTo(view.centerX + view.radius, view.centerY);
    ctx.stroke(); ctx.setLineDash([]);
  }

  /** LabelLayer.draw clears once each frame. All fixed text follows it at the unchanged label density. */
  private drawFixedTextOverlay(): void {
    const ctx = this.labels?.canvas.getContext('2d');
    if (!ctx) return;
    const view = this.viewport;
    ctx.save(); ctx.setTransform(this.baseRatio, 0, 0, this.baseRatio, 0, 0);
    ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
    ctx.font = '10px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#8aa0b4'; ctx.textAlign = 'left';
    for (const altitude of [0, 30, 60]) {
      const radius = (90 - altitude) / 90 * view.radius;
      if (view.radius >= 90 || altitude === 0) ctx.fillText(view.radius < 90 ? '0°' : altitude === 0 ? '地平 0°' : `高度 ${altitude}°`, view.centerX + 5, view.centerY - radius + 12);
    }
    ctx.font = '12px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#c1cfdd';
    ctx.fillText('北 N', view.centerX, view.centerY - view.radius - 13);
    ctx.fillText('南 S', view.centerX, view.centerY + view.radius + 20);
    ctx.fillText('东 E', view.centerX - view.radius + (view.compactHud ? 22 : -22), view.centerY + 4);
    ctx.fillText('西 W', view.centerX + view.radius + (view.compactHud ? -22 : 22), view.centerY + 4);
    ctx.font = '10px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#72899e'; ctx.fillText('天顶', view.centerX, view.centerY - 7);
    for (const caption of [this.header, this.footer]) if (caption.box) {
      caption.lines.forEach((line, index) => { ctx.fillStyle = line.color; ctx.font = line.font;
        ctx.fillText(line.text, (caption.box!.left + caption.box!.right) / 2, caption.box!.top + caption.baselineOffset + index * caption.lineHeight); });
    }
    ctx.restore();
  }

  focusSelection(state: SimulationState, snapshot: ScienceSnapshot): boolean {
    this.resetPointerGestures();
    const details = resolveObjectDetails(catalog, state.selected, snapshot);
    const direction = resolveDisplayDirectionEqj(catalog, state.selected, snapshot, 'ground');
    this.focusRequestedFor = details?.id ?? null;
    this.focusReason = !details ? '未找到该对象，无法标记方向。'
      : !direction || !this.projectDirection(direction, snapshot) ? this.belowHorizonReason(snapshot)
      : '已标记所选方向；固定总览不改变三维视角。';
    this.labels?.invalidateLayout(); this.onInvalidate();
    return !!(details && direction && this.projectDirection(direction, snapshot));
  }

  private pointerInput(input: PointerGestureInput): void {
    if (!this.stageInputEnabled && input.type !== 'reset') return;
    const result = reducePointerGesture(this.gesture, input);
    this.gesture = result.state;
    for (const id of result.captureIds) { try { this.canvas.setPointerCapture(id); } catch { /* detached/inactive contact */ } }
    for (const id of result.releaseIds) { try { this.canvas.releasePointerCapture(id); } catch { /* already released */ } }
    if (result.action?.type !== 'tap') return; // Fixed overview has no pan or zoom action.
    const rect = this.canvas.getBoundingClientRect(), x = result.action.x - rect.left, y = result.action.y - rect.top;
    if (this.blocked(x, y)) return;
    const label = this.labels?.hitTest(x, y);
    const labelDetails = label && this.snapshot ? resolveObjectDetails(catalog, label as ObjectId, this.snapshot) : null;
    if (labelDetails) { this.onSelect?.(labelDetails.id); return; }
    const body = this.bodies.find(target => Math.hypot(x - target.x, y - target.y) <= target.radius);
    if (body) { this.onSelect?.(body.id); return; }
    const star = this.stars.filter(target => Math.hypot(x - target.x, y - target.y) <= target.radius)
      .sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y) || a.magnitude! - b.magnitude!)[0];
    this.onSelect?.(star?.id ?? null);
  }
  resetPointerGestures(): void { this.pointerInput({ type: 'reset' }); }
  private readonly onPointerDown = (event: PointerEvent): void => { if (event.button === 0) this.pointerInput({ type: 'down', id: event.pointerId, x: event.clientX, y: event.clientY }); };
  private readonly onPointerMove = (event: PointerEvent): void => { this.pointerInput({ type: 'move', id: event.pointerId, x: event.clientX, y: event.clientY }); };
  private readonly onPointerUp = (event: PointerEvent): void => { this.pointerInput({ type: 'up', id: event.pointerId, x: event.clientX, y: event.clientY }); };
  private readonly onPointerCancel = (event: PointerEvent): void => { this.pointerInput({ type: 'cancel', id: event.pointerId, x: event.clientX, y: event.clientY }); };
  private readonly onLostCapture = (event: PointerEvent): void => { this.pointerInput({ type: 'lost-capture', id: event.pointerId, x: event.clientX, y: event.clientY }); };
  private readonly onBlur = (): void => { this.resetPointerGestures(); };
  private readonly onVisibilityChange = (): void => { if (document.hidden) this.resetPointerGestures(); };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.stageInputEnabled) return;
    if (event.key === 'Escape') { event.preventDefault(); this.onSelect?.(null); }
    else if (event.key === 'Enter' && this.state && this.snapshot) { event.preventDefault(); this.focusSelection(this.state, this.snapshot); }
  };

  getAssetStatus() { return { pending: [], loaded: [], errors: [] }; }
  setRuntimeQuality(quality: Readonly<RuntimeRenderQuality>): void {
    if (this.disposed || sameRuntimeRenderQuality(this.runtimeQuality, quality)) return;
    if (!Number.isFinite(quality.ordinaryLabelBudgetScale) || quality.ordinaryLabelBudgetScale < 0 || quality.ordinaryLabelBudgetScale > 1)
      throw new RangeError('普通标签运行预算系数须在0至1之间。');
    canvasRuntimeRaster(this.width, this.height, this.baseRatio, quality.pixelScale);
    this.runtimeQuality = Object.freeze({ ...quality });
    this.resize(); this.labels?.invalidateLayout(); this.onInvalidate();
  }
  getRuntimeQualityCapabilities() { return CANVAS_RUNTIME_QUALITY_CAPABILITIES; }
  setStageInputEnabled(enabled: boolean): void {
    if (this.disposed || this.stageInputEnabled === enabled) return;
    this.resetPointerGestures(); this.stageInputEnabled = enabled;
  }
  getMoonLoupeDiagnostics(): null { return null; }
  setMoonLoupeViewport(_rect: DOMRect | null): void { /* Capability is unavailable; no substitute moon view. */ }
  changeReferenceLock(_state: SimulationState, _snapshot: ScienceSnapshot, _previousLock: ExternalCamera['referenceLock']): void { /* Retain original camera state for3D recovery. */ }
  getInteractionDiagnostics() {
    const cache = this.labels?.getCacheMetrics();
    const selectedStar = this.state?.selected ? resolveCatalogStar(catalog, this.state.selected) : null;
    const cachedDirection = selectedStar && Number.isFinite(this.lastStarUt) ? this.starDirection(selectedStar.index) : null;
    const cachedProjection = cachedDirection && this.snapshot ? this.projectDirection(cachedDirection, this.snapshot) : null;
    return { rendererKind: 'canvas2d', projection: 'zenith-centered azimuthal equidistant; north-up east-left',
      geometricHemisphereOnly: this.refractionProfile?.identity ?? true, apparentHemisphereOnly: true,
      actualDisplayViewMode: 'ground', sourceStateViewMode: this.state?.viewMode ?? null,
      refraction: this.refractionProfile ? { key: this.refractionProfile.key, identity: this.refractionProfile.identity, descriptor: this.refractionProfile.descriptor,
        sharedCpuProfileBytesEstimate: this.refractionProfile.identity ? 0 : this.refractionProfile.layout.nodeCount * 8,
        canvasOwnedLutCopies: 0, textureCount: 0 } : null,
      chartViewport: { ...this.viewport }, selectedId: this.state?.selected ?? null,
      canonicalSelectedId: this.canonicalSelected, selectedDirectionEqj: this.selectedDirection,
      selectedProjectedNdc: this.selectedPoint ? [2 * this.selectedPoint.x / this.width - 1, 1 - 2 * this.selectedPoint.y / this.height] : null,
      selectedVisible: !!this.selectedPoint && !this.blocked(this.selectedPoint.x, this.selectedPoint.y),
      selectedGeometricallyAboveHorizon: this.selectedGeometricallyAboveHorizon,
      selectedApparentAboveHorizon: this.selectedAboveHorizon, focusReason: this.focusReason,
      projectedStars: this.stars.map(star => ({ ...star })), bodyHitTargets: this.bodies.map(body => ({ ...body })),
      visibleBodyIds: this.bodies.map(body => body.id), labelHitBoxes: this.labels?.getVisibleHitBoxes() ?? [], labelOcclusionRects: this.labels?.getBlockedRects() ?? [],
      fixedHudCaptions: { header: structuredClone(this.header), footer: structuredClone(this.footer) },
      starMotion: { consumerModelVersion: ASTROMETRY_MODEL_VERSION, selectedModel: selectedStar ? deriveStarMotionModel(selectedStar) : null,
        cachedUtDaysJ2000: Number.isFinite(this.lastStarUt) ? this.lastStarUt : null, snapshotUtDaysJ2000: this.snapshot?.utDaysJ2000 ?? null, cacheStepDays: 0,
        cachedSelectedDirectionEqj: cachedDirection, cachedSelectedPixel: cachedProjection ? this.pixel(cachedProjection) : null,
        constellationAnchorUtDaysJ2000: Number.isFinite(this.lastStarUt) ? this.lastStarUt : null, directionBufferBytes: this.starDirections.byteLength,
        motionCacheBoundArcsec: 0, float32DirectionBoundArcsec: 0, combinedDirectionBoundArcsec: 0,
        boundScope: 'Float64 actual-UT directions; no temporal bucket or Float32 upload; excludes source/scientific and pixel projection error' },
      labelCache: cache ?? null, labelRasterBytesTotal: cache?.labelRasterBytesTotal ?? 0,
      canvasRasterBytes: this.canvas.width * this.canvas.height * 4,
      sampledConstellationSegments: this.segmentCount, sampledConstellationPointCount: this.segmentPointCount,
      constellationArcSampling: { desiredMaxAngularStepDeg: this.refractionProfile?.identity === false ? 1 : 3, maxSegmentsPerArc: 64, cappedArcCount: this.cappedArcCount,
        ambiguousArcCount: this.ambiguousArcCount, mandatoryKnotBudgetExceededCount: this.arcKnotBudgetExceededCount, actualMaximumAngularStepDeg: this.maximumArcStepDeg,
        scope: 'Geometric minor-arc sampling; finite angular budget, not a bound on screen-pixel error.' },
      starSymbolContrast: 'base magnitude contrast × continuous small-chart weak-star alpha × same appearance.starVisibility; qualitative display hierarchy',
      starSymbolExamples: [0, 3, 6].map(magnitude => ({ magnitude, ...canvasStarSymbol(magnitude, this.viewport.radius) })), teachingLabelBudget: canvasTeachingLabelBudget(this.viewport.radius, this.budgetMobile()),
      highlightedConstellationIds: this.canonicalSelected?.startsWith('constellation:') ? [this.canonicalSelected.slice(14)] : [],
      activePointerCount: this.gesture.pointers.size, gestureMode: gestureMode(this.gesture), stageInputEnabled: this.stageInputEnabled,
      runtimeQuality: { requested: { ...this.runtimeQuality }, capabilities: this.getRuntimeQualityCapabilities(), ordinaryLabelBudget: this.ordinaryLabelBudget,
        basePixelRatio: this.baseRatio, mainPixelRatio: this.ratio, labelPixelRatio: this.baseRatio,
        baseMainCanvasPixels: Math.max(1, Math.floor(this.width * this.baseRatio)) * Math.max(1, Math.floor(this.height * this.baseRatio)),
        effectiveMainCanvasPixels: this.canvas.width * this.canvas.height, fixedTextLayer: 'unchanged-resolution LabelLayer overlay',
        ignoredOrdinaryBackLabels: this.runtimeQuality.hideOrdinaryBackLabels, backLabelReason: '实际为当地地平总览，没有外部背面标签。' },
      capabilities: this.capabilities, cameraOrientationQuaternion: null, cameraPositionDisplay: null,
      utDaysJ2000: this.snapshot?.utDaysJ2000 ?? null, disposed: this.disposed };
  }
  getSkyAppearanceDiagnostics() {
    return { rendererKind: 'canvas2d', utDaysJ2000: this.snapshot?.utDaysJ2000 ?? null, model: this.appearance,
      displayFrame: this.refractionProfile?.identity === false ? 'observer-standard-refraction-horizon' : 'observer-geometric-horizon', sourceStateViewMode: this.state?.viewMode ?? null,
      uniforms: this.appearance ? { limitingMagnitude: this.appearance.limitingMagnitude, starVisibility: this.appearance.starVisibility,
        backgroundLinearRgb: this.appearance.backgroundLinearRgb, horizonGlowLinearRgb: this.appearance.horizonGlowLinearRgb } : null,
      milkyWayEnabled: false, textureLoaded: false, residentMilkyWayTextureCount: 0,
      bodyMarkersOnly: true, linearRgbConvertedToSrgb: true };
  }
  getMetrics(): Partial<RuntimeMetrics> {
    const sorted = [...this.samples].sort((a, b) => a - b), percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
    return { samplingWindowSeconds: 0, frameMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) },
      drawCallsPerFrame: 0, visibleLabelCount: this.labels?.visibleCount ?? 0, textureCount: 0, geometryCount: 0, appOwnedGpuBytesEstimate: 0,
      mainThreadJsHeapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
      measurementNotes: ['二维全天总览：frameMs为最近240次Canvas绘制与标签的CPU耗时，非GPU时间或显示帧间隔。',
        `主画布${this.canvas.width}×${this.canvas.height}，DPR${this.ratio.toFixed(2)}；没有WebGL draw call/geometry/texture。`,
        'GPU字段0表示未分配WebGL资源，不代表浏览器内部没有Canvas加速内存；主Canvas与标签栅格字节在rendererDiagnostics单独记录。'] };
  }
  capture(appearance?: SkyAppearance): string {
    if (this.disposed) throw new Error('二维星图已释放，无法截图。');
    if (this.state && this.snapshot) this.render(this.state, this.snapshot, appearance ?? this.appearance ?? undefined);
    const output = document.createElement('canvas');
    output.width = this.labels?.canvas.width ?? Math.max(1, Math.round(this.width * this.baseRatio));
    output.height = this.labels?.canvas.height ?? Math.max(1, Math.round(this.height * this.baseRatio));
    const context = output.getContext('2d');
    if (!context) throw new Error('无法生成二维星图截图。');
    context.drawImage(this.canvas, 0, 0, output.width, output.height); if (this.labels) context.drawImage(this.labels.canvas, 0, 0);
    return output.toDataURL('image/png');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.resetPointerGestures();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown); this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp); this.canvas.removeEventListener('pointercancel', this.onPointerCancel); this.canvas.removeEventListener('lostpointercapture', this.onLostCapture); this.canvas.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onBlur); document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.labels?.dispose(); this.labels = null; this.canvas.remove(); this.canvas.width = 1; this.canvas.height = 1;
    this.hudBlocks.forEach(block => block.remove()); this.hudBlocks.length = 0;
    this.stars = []; this.bodies = []; this.samples.length = 0;
    this.state = null; this.snapshot = null; this.appearance = null; this.refractionProfile = null;
  }
}
