import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsHost } from '../src/platform/graphics-host';
import type { GraphicsContextState, RendererFactory, RendererPort } from '../src/platform/renderer-port';
import type { ObjectId } from '../src/contracts';
import { createDefaultState } from '../src/state';
import { DEFAULT_RUNTIME_RENDER_QUALITY, type RuntimeRenderQuality } from '../src/platform/runtime-quality-contract';

class FakeElement {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = '';
  append(child: FakeElement) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute() {}
}
const observers: FakeObserver[] = [];
class FakeObserver {
  disconnected = false;
  constructor() { observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
}
Object.assign(globalThis, { document: { createElement: () => new FakeElement() }, MutationObserver: FakeObserver });
class FakeRenderer implements RendererPort {
  readonly canvas = new FakeElement() as unknown as HTMLCanvasElement;
  renderCount = 0;
  disposeCount = 0;
  resizeFails = false;
  quality: Readonly<RuntimeRenderQuality> = DEFAULT_RUNTIME_RENDER_QUALITY;
  inputEnabled = true;
  constructor(readonly invalidate: () => void, readonly select: (id: ObjectId | null) => void,
    readonly context: ((state: GraphicsContextState) => void) | undefined) {}
  render() { this.renderCount++; }
  resize() { if (this.resizeFails) throw new Error('resize failed after construction'); }
  dispose() { this.disposeCount++; }
  capture() { return 'data:image/png;base64,fake'; }
  focusSelection() { return true; }
  changeReferenceLock() {}
  getMetrics() { return {}; }
  getAssetStatus() { return { pending: [], loaded: [], errors: [] }; }
  getInteractionDiagnostics() { return {}; }
  getSkyAppearanceDiagnostics() { return {}; }
  getMoonLoupeDiagnostics() { return null; }
  setMoonLoupeViewport() {}
  setRuntimeQuality(quality: Readonly<RuntimeRenderQuality>) { this.quality = quality; }
  getRuntimeQualityCapabilities() { return { removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false }; }
  setStageInputEnabled(enabled: boolean) { this.inputEnabled = enabled; }
}
function setup(options: { failWebgl?: () => boolean; resizeWebgl?: boolean; resizeCanvas?: boolean } = {}) {
  const stage = new FakeElement();
  const webgl: FakeRenderer[] = [], canvas: FakeRenderer[] = [];
  let invalidations = 0, selection: ObjectId | null = null;
  const factory = (kind: 'webgl' | 'canvas'): RendererFactory => (_container, invalidate, select, context) => {
    if (kind === 'webgl' && options.failWebgl?.()) throw new Error('WebGL disabled');
    const renderer = new FakeRenderer(invalidate, select, context);
    renderer.resizeFails = (kind === 'webgl' ? options.resizeWebgl : options.resizeCanvas) ?? false;
    (kind === 'webgl' ? webgl : canvas).push(renderer);
    return renderer;
  };
  const construct = () => new GraphicsHost(stage as unknown as HTMLElement,
    { webgl: factory('webgl'), canvas: factory('canvas') }, () => invalidations++, id => { selection = id; });
  return { stage, webgl, canvas, construct, get invalidations() { return invalidations; }, get selection() { return selection; } };
}
test('loss/restoration retains one WebGL instance, dispatches only to active renderer and preserves canonical state', () => {
  const env = setup(), host = env.construct(), gl = env.webgl[0];
  const state = createDefaultState(); state.viewMode = 'space';
  const before = JSON.stringify(state);
  gl.context?.('lost');
  assert.equal(host.kind, 'canvas2d'); assert.equal(host.diagnostics.retainedWebglInstanceCount, 1);
  assert.equal(host.diagnostics.webglSurfaceHidden, true); assert.equal(host.status.retry3dAvailable, false);
  host.render(state, {} as Parameters<RendererPort['render']>[1]);
  assert.equal(gl.renderCount, 0); assert.equal(env.canvas[0].renderCount, 1);
  const invalidations = env.invalidations;
  gl.invalidate(); gl.select('hip:11767');
  assert.equal(env.invalidations, invalidations); assert.equal(env.selection, null);
  env.canvas[0].select('hip:11767'); assert.equal(env.selection, 'hip:11767');
  gl.context?.('restored');
  assert.equal(host.kind, 'webgl2'); assert.equal(env.webgl.length, 1);
  assert.equal(host.canvas, gl.canvas); assert.equal(env.canvas[0].disposeCount, 1);
  assert.equal(host.diagnostics.fallbackInstanceCount, 0); assert.equal(env.stage.children.length, 1);
  const restoredInvalidations = env.invalidations;
  env.canvas[0].invalidate(); assert.equal(env.invalidations, restoredInvalidations);
  host.render(state, {} as Parameters<RendererPort['render']>[1]); assert.equal(gl.renderCount, 1);
  assert.equal(JSON.stringify(state), before);
  host.dispose(); assert.equal(gl.disposeCount, 1); assert.equal(host.diagnostics.activeRendererCount, 0);
  gl.context?.('lost'); assert.equal(env.canvas.length, 1);
});
test('initial no-WebGL fallback retries transactionally and removes the previous 2D instance', () => {
  let blocked = true;
  const env = setup({ failWebgl: () => blocked }), host = env.construct();
  assert.equal(host.kind, 'canvas2d'); assert.equal(env.stage.children.length, 1);
  assert.equal(host.status.retry3dAvailable, true);
  blocked = false; assert.equal(host.retry3D(), true);
  assert.equal(host.kind, 'webgl2'); assert.equal(env.canvas[0].disposeCount, 1);
  assert.equal(env.stage.children.length, 1); assert.equal(host.diagnostics.activeRendererCount, 1);
  assert.equal(host.diagnostics.webglConstructorAttempts, 2); host.dispose();
});
test('WebGL resize failure after construction disposes the candidate before 2D activation', () => {
  const env = setup({ resizeWebgl: true }), host = env.construct();
  assert.equal(env.webgl[0].disposeCount, 1); assert.equal(host.kind, 'canvas2d');
  assert.equal(host.diagnostics.retainedWebglInstanceCount, 0);
  assert.equal(env.stage.children.length, 1); assert.equal(host.diagnostics.activeRendererCount, 1);
  host.dispose();
});
test('failed retries replace and dispose prior fallback without retaining failed WebGL surfaces', () => {
  const env = setup({ failWebgl: () => true }), host = env.construct();
  assert.equal(host.retry3D(), false); assert.equal(host.status.reason, 'retry-failed');
  assert.equal(env.canvas[0].disposeCount, 1); assert.equal(env.canvas[1].disposeCount, 0);
  assert.equal(env.stage.children.length, 1); assert.equal(host.diagnostics.fallbackInstanceCount, 1);
  const invalidations = env.invalidations; env.canvas[0].invalidate();
  assert.equal(env.invalidations, invalidations); host.dispose();
});
test('a failed Canvas resize cleans its returned instance and constructor observer', () => {
  const env = setup({ failWebgl: () => true, resizeCanvas: true });
  assert.throws(env.construct, /resize failed/);
  assert.equal(env.canvas[0].disposeCount, 1); assert.equal(env.stage.children.length, 0);
  assert.equal(observers.at(-1)?.disconnected, true);
});
test('Canvas activation failure during context loss is explicit and every unavailable proxy is safe', () => {
  const env = setup({ resizeCanvas: true }), host = env.construct();
  assert.doesNotThrow(() => env.webgl[0].context?.('lost'));
  assert.equal(host.status.available, false); assert.equal(host.diagnostics.activeRendererCount, 0);
  assert.equal(host.diagnostics.retainedWebglInstanceCount, 1); assert.equal(env.canvas[0].disposeCount, 1);
  assert.equal(env.stage.children.length, 1); assert.equal(host.getInteractionDiagnostics(), null);
  assert.equal(host.getMoonLoupeDiagnostics(), null); assert.ok(host.getAssetStatus().errors.length);
  assert.doesNotThrow(() => { host.resize(); host.setMoonLoupeViewport(null); host.render(createDefaultState(), {} as Parameters<RendererPort['render']>[1]); host.getMetrics(); });
  assert.equal(host.focusSelection(createDefaultState(), {} as Parameters<RendererPort['render']>[1]), false);
  assert.throws(() => host.capture(), /二维方位图也暂不可用/);
  env.webgl[0].context?.('restored'); assert.equal(host.status.available, true);
  assert.equal(host.kind, 'webgl2'); assert.equal(env.webgl.length, 1); host.dispose();
});
test('restored resize failure retains the valid Canvas renderer and does not create another WebGL context', () => {
  const env = setup(), host = env.construct(), gl = env.webgl[0];
  gl.context?.('lost'); const canvas = env.canvas[0];
  gl.resizeFails = true; assert.doesNotThrow(() => gl.context?.('restored'));
  assert.equal(host.kind, 'canvas2d'); assert.equal(host.status.available, true);
  assert.equal(host.status.contextLost, false); assert.equal(host.status.reason, 'restore-failed');
  assert.equal(host.canvas, canvas.canvas); assert.equal(canvas.disposeCount, 0);
  assert.equal(env.webgl.length, 1); assert.equal(host.diagnostics.activeRendererCount, 1);
  assert.equal(host.diagnostics.webglSurfaceHidden, true);
  host.render(createDefaultState(), {} as Parameters<RendererPort['render']>[1]); assert.equal(canvas.renderCount, 1);
  assert.ok(host.getMetrics().measurementNotes?.some(note => note.includes('仍保留原三维实例')));
  host.dispose(); assert.equal(canvas.disposeCount, 1); assert.equal(gl.disposeCount, 1);
});
test('quality and stage guard survive loss, restoration and transactional retry without serializing state', () => {
  const env = setup(), host = env.construct(), gl = env.webgl[0];
  const quality = { ...DEFAULT_RUNTIME_RENDER_QUALITY, hideOrdinarySecondaryLabels: true, pixelScale: .70 as const };
  host.setRuntimeQuality(quality); host.setStageInputEnabled(false);
  assert.deepEqual(gl.quality, quality); assert.equal(gl.inputEnabled, false);
  gl.context?.('lost'); assert.deepEqual(env.canvas[0].quality, quality); assert.equal(env.canvas[0].inputEnabled, false);
  host.setStageInputEnabled(true); assert.equal(env.canvas[0].inputEnabled, true); assert.equal(gl.inputEnabled, false);
  gl.context?.('restored'); assert.deepEqual(gl.quality, quality); assert.equal(gl.inputEnabled, true);
  assert.equal(host.getRuntimeQualityCapabilities().pixelScaling, true); host.dispose();
  assert.equal(host.getRuntimeQualityCapabilities().pixelScaling, false);
  let blocked = true; const retry = setup({ failWebgl: () => blocked }), second = retry.construct();
  second.setRuntimeQuality(quality); second.setStageInputEnabled(false); blocked = false; second.retry3D();
  assert.deepEqual(retry.webgl[0].quality, quality); assert.equal(retry.webgl[0].inputEnabled, false); second.dispose();
});
