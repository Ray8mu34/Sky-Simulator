import type { ExternalCamera, ObjectId, ScienceSnapshot, SimulationState } from '../contracts';
import type { SkyAppearance } from '../core/sky-appearance';
import { CANVAS_CAPABILITIES, WEBGL_CAPABILITIES, type GraphicsContextState, type GraphicsReason,
  type GraphicsStatus, type RendererFactory, type RendererPort } from './renderer-port';
import { DEFAULT_RUNTIME_RENDER_QUALITY, NO_RUNTIME_QUALITY_CAPABILITIES,
  type RuntimeQualityCapabilities, type RuntimeRenderQuality } from './runtime-quality-contract';

interface Surface { element: HTMLDivElement; renderer: RendererPort }
/** Owns render lifetimes only. The canonical state, clock, workers and RAF belong to main. */
export class GraphicsHost implements RendererPort {
  private webgl: Surface | null = null;
  private fallback: Surface | null = null;
  private active: Surface | null = null;
  private disposed = false;
  private reason: GraphicsReason = 'webgl2-unavailable';
  private message = '';
  private lost = false;
  private webglAttempts = 0;
  private webglCreations = 0;
  private canvasCreations = 0;
  private canvasDisposals = 0;
  private losses = 0;
  private restores = 0;
  private retries = 0;
  private readonly cleanupErrors: string[] = [];
  private readonly warningObserver: MutationObserver;
  private runtimeQuality: Readonly<RuntimeRenderQuality> = DEFAULT_RUNTIME_RENDER_QUALITY;
  private stageInputEnabled = true;

  constructor(private readonly container: HTMLElement,
    private readonly factories: { webgl: RendererFactory; canvas: RendererFactory },
    private readonly onInvalidate: () => void,
    private readonly onSelect: (id: ObjectId | null) => void) {
    this.warningObserver = new MutationObserver(() => { this.syncWarnings(); });
    this.warningObserver.observe(container, { attributes: true, subtree: true,
      attributeFilter: ['data-asset-warning', 'data-asset-pending', 'data-asset-loaded', 'data-graphics-warning'] });
    try { this.initializeWebgl(false); }
    catch (error) { this.warningObserver.disconnect(); throw error; }
  }
  get kind(): GraphicsStatus['kind'] { return this.active === this.webgl && this.webgl ? 'webgl2' : 'canvas2d'; }
  get canvas(): HTMLCanvasElement { return this.current().canvas; }
  get status(): GraphicsStatus {
    return { kind: this.kind, available: Boolean(this.active) && !(this.active === this.webgl && this.lost), reason: this.reason, message: this.message,
      retry3dAvailable: !this.disposed && !this.webgl, contextLost: this.lost,
      capabilities: this.kind === 'webgl2' ? WEBGL_CAPABILITIES : CANVAS_CAPABILITIES };
  }
  get diagnostics() {
    return { activeKind: this.kind, activeRendererCount: this.active && !this.disposed ? 1 : 0,
      retainedWebglInstanceCount: this.webgl ? 1 : 0, fallbackInstanceCount: this.fallback ? 1 : 0,
      webglConstructorAttempts: this.webglAttempts, webglCreationCount: this.webglCreations,
      canvasCreationCount: this.canvasCreations, canvasDisposeCount: this.canvasDisposals,
      contextLostCount: this.losses, contextRestoredCount: this.restores, retryCount: this.retries,
      cleanupErrors: [...this.cleanupErrors],
      webglCanvasIdentity: this.webgl?.renderer.canvas.dataset.graphicsInstance ?? null,
      activeCanvasIdentity: this.active?.renderer.canvas.dataset.graphicsInstance ?? null,
      webglSurfaceHidden: Boolean(this.webgl && this.webgl.element.style.visibility === 'hidden'),
      retainedWebglResourceEstimate: this.webgl && this.active !== this.webgl ? this.webgl.renderer.getMetrics() : null };
  }
  private current(): RendererPort {
    if (!this.active || this.disposed) throw new Error('天空绘图实例已不可用');
    return this.active.renderer;
  }
  private createSurface(kind: 'webgl2' | 'canvas2d'): Surface {
    const element = document.createElement('div');
    element.className = `sky-graphics-surface sky-graphics-${kind}`;
    element.dataset.graphicsKind = kind;
    Object.assign(element.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    this.container.append(element);
    let owner: RendererPort | null = null;
    const invalidate = () => { if (!this.disposed && owner && this.active?.renderer === owner) this.onInvalidate(); };
    const select = (id: ObjectId | null) => { if (!this.disposed && owner && this.active?.renderer === owner) this.onSelect(id); };
    const context = (state: GraphicsContextState) => {
      if (!this.disposed && owner && this.webgl?.renderer === owner) this.contextState(state);
    };
    try {
      owner = this.factories[kind === 'webgl2' ? 'webgl' : 'canvas'](element, invalidate, select, context);
      owner.canvas.dataset.graphicsInstance = kind === 'webgl2' ? `webgl-${++this.webglCreations}` : `canvas-${++this.canvasCreations}`;
      return { element, renderer: owner };
    } catch (error) { element.remove(); throw error; }
  }
  private initializeWebgl(retry: boolean): boolean {
    this.webglAttempts++;
    try {
      this.webgl = this.createSurface('webgl2');
      this.reason = 'webgl2-ready'; this.message = ''; this.lost = false;
      this.activate(this.webgl);
      return true;
    } catch (error) {
      if (this.webgl) {
        this.active = null;
        this.release(this.webgl);
      }
      this.webgl = null;
      this.reason = retry ? 'retry-failed' : 'webgl2-unavailable';
      this.message = `三维模式不可用；已使用二维方位图。${retry ? '重试仍失败，可稍后再试。' : ''}`;
      this.container.dataset.webglFailure = error instanceof Error ? error.message : String(error);
      try {
        this.fallback = this.createSurface('canvas2d');
        this.activate(this.fallback);
        return false;
      } catch (fallbackError) { this.active = null; this.disposeFallback(); throw fallbackError; }
    }
  }
  private activate(surface: Surface): void {
    surface.renderer.setRuntimeQuality(this.runtimeQuality);
    surface.renderer.setStageInputEnabled(this.stageInputEnabled);
    surface.renderer.resize();
    surface.renderer.resetPointerGestures?.();
    this.active = surface;
    for (const candidate of [this.webgl, this.fallback]) {
      if (!candidate) continue;
      const active = candidate === surface;
      // Preserve dimensions while the original lost GL instance is retained.
      candidate.element.style.visibility = active ? 'visible' : 'hidden';
      candidate.element.style.pointerEvents = active ? 'auto' : 'none';
      candidate.element.setAttribute('aria-hidden', String(!active));
    }
    this.container.dataset.activeGraphics = this.kind;
    this.syncWarnings();
    this.onInvalidate();
  }
  private contextState(state: GraphicsContextState): void {
    if (state === 'lost') {
      if (this.lost) return;
      this.lost = true; this.losses++;
      this.reason = 'context-lost';
      this.message = '三维图形上下文已丢失；暂用二维方位图，时间与科学读数继续保留。';
      try {
        this.fallback ??= this.createSurface('canvas2d');
        this.activate(this.fallback);
      } catch (error) {
        this.active = null; this.disposeFallback();
        if (this.webgl) { this.webgl.element.style.visibility = 'hidden'; this.webgl.element.style.pointerEvents = 'none'; }
        this.message = `三维上下文已丢失，二维方位图也暂不可用；科学读数仍保留。${error instanceof Error ? error.message : ''}`;
        this.container.dataset.activeGraphics = 'unavailable';
        this.syncWarnings(); this.onInvalidate();
      }
    } else {
      if (!this.lost || !this.webgl) return;
      this.restores++;
      try {
        this.activate(this.webgl);
        this.lost = false; this.reason = 'webgl2-ready'; this.message = '';
        this.disposeFallback(); this.syncWarnings();
      } catch (error) {
        this.lost = false; this.reason = 'restore-failed';
        this.message = `三维恢复失败；${this.fallback ? '继续使用二维方位图' : '保留科学读数'}。${error instanceof Error ? error.message : ''}`;
        this.syncWarnings(); this.onInvalidate();
      }
    }
  }
  private disposeFallback(): void {
    if (!this.fallback) return;
    const fallback = this.fallback; this.fallback = null;
    if (this.active === fallback) this.active = null;
    this.release(fallback); this.canvasDisposals++;
  }
  private release(surface: Surface): void {
    try { surface.renderer.dispose(); }
    catch (error) {
      this.cleanupErrors.push(error instanceof Error ? error.message : String(error));
      if (this.cleanupErrors.length > 4) this.cleanupErrors.shift();
    } finally { surface.element.remove(); }
  }
  /** Only available after initial/explicit construction failure, never beside a retained GL instance. */
  retry3D(): boolean {
    if (this.disposed || this.webgl) return false;
    this.retries++;
    this.active = null;
    this.disposeFallback();
    return this.initializeWebgl(true);
  }
  private syncWarnings(): void {
    const surface = this.active?.element;
    for (const key of ['assetWarning', 'assetPending', 'assetLoaded'] as const) {
      const value = surface?.dataset[key];
      if (value !== undefined) { if (this.container.dataset[key] !== value) this.container.dataset[key] = value; }
      else if (this.container.dataset[key] !== undefined) delete this.container.dataset[key];
    }
    const warning = this.message || surface?.dataset.graphicsWarning;
    if (warning) { if (this.container.dataset.graphicsWarning !== warning) this.container.dataset.graphicsWarning = warning; }
    else if (this.container.dataset.graphicsWarning !== undefined) delete this.container.dataset.graphicsWarning;
  }
  render(state: SimulationState, snapshot: ScienceSnapshot, appearance?: SkyAppearance): void { if (this.status.available) this.current().render(state, snapshot, appearance); }
  resize(): void { if (this.status.available) this.current().resize(); }
  capture(appearance?: SkyAppearance): string { if (!this.status.available) throw new Error(this.message || '天空绘图不可用，无法截图。'); return this.current().capture(appearance); }
  focusSelection(state: SimulationState, snapshot: ScienceSnapshot): boolean { return this.status.available && this.current().focusSelection(state, snapshot); }
  changeReferenceLock(state: SimulationState, snapshot: ScienceSnapshot, previousLock: ExternalCamera['referenceLock']): void {
    if (this.status.available && this.status.capabilities.referenceLock) this.current().changeReferenceLock(state, snapshot, previousLock);
  }
  getMetrics() {
    const base = this.status.available ? this.current().getMetrics() : {};
    const notes = [...(base.measurementNotes ?? [])];
    if (this.webgl && this.active !== this.webgl) notes.push('当前二维port的WebGL资源字段为0；应用仍保留原三维实例，保留资源估算另见graphics诊断，非实测驱动当前显存。');
    if (!this.status.available) notes.push('当前绘图不可用；这些空测量不代表成功绘制。');
    return { ...base, measurementNotes: notes };
  }
  getAssetStatus() { return this.status.available ? this.current().getAssetStatus() : { pending: [], loaded: [], errors: [this.message || '绘图不可用'] }; }
  getInteractionDiagnostics() { return this.status.available ? this.current().getInteractionDiagnostics() : null; }
  getSkyAppearanceDiagnostics() { return this.status.available ? this.current().getSkyAppearanceDiagnostics() : null; }
  getMoonLoupeDiagnostics() { return this.status.available ? this.current().getMoonLoupeDiagnostics() : null; }
  setMoonLoupeViewport(rect: DOMRect | null): void { if (this.status.available) this.current().setMoonLoupeViewport(rect); }
  setRuntimeQuality(quality: Readonly<RuntimeRenderQuality>): void {
    this.runtimeQuality = Object.freeze({ ...quality });
    if (this.status.available) this.current().setRuntimeQuality(this.runtimeQuality);
  }
  getRuntimeQualityCapabilities(): Readonly<RuntimeQualityCapabilities> {
    return this.status.available ? this.current().getRuntimeQualityCapabilities() : NO_RUNTIME_QUALITY_CAPABILITIES;
  }
  setStageInputEnabled(enabled: boolean): void {
    this.stageInputEnabled = enabled;
    // A retained lost surface must not preserve an active gesture during backend changes.
    this.webgl?.renderer.setStageInputEnabled(enabled && this.active === this.webgl && !this.lost);
    this.fallback?.renderer.setStageInputEnabled(enabled && this.active === this.fallback);
  }
  resetPointerGestures(): void { this.webgl?.renderer.resetPointerGestures?.(); this.fallback?.renderer.resetPointerGestures?.(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.warningObserver.disconnect(); this.active = null;
    this.disposeFallback();
    if (this.webgl) { this.release(this.webgl); this.webgl = null; }
  }
}
