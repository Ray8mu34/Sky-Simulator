import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LabelLayer } from '../src/render/LabelLayer';
import { canvasRuntimeRaster, CANVAS_RUNTIME_QUALITY_CAPABILITIES } from '../src/render/CanvasRuntimeQuality';
import { runtimeLabelSecondary, runtimeOrdinaryLabelBudget } from '../src/render/RenderQuality';
import { DEFAULT_RUNTIME_RENDER_QUALITY, renderBudgetClass } from '../src/platform/runtime-quality-contract';
import { createPointerGesture, reducePointerGesture } from '../src/render/PointerGestures';
import { sameRuntimeRenderQuality } from '../src/render/RenderQuality';
import { cappedPixelRatio } from '../src/render/coordinates';
import { applyMatrix } from '../src/core/math';

class FakeContext {
  transform = [1, 0, 0, 1, 0, 0];
  textBaseline = 'top'; textAlign = 'left'; globalAlpha = .4; font = ''; fillStyle = '';
  texts: { text: string; transform: number[]; textBaseline: string; alpha: number }[] = [];
  images: unknown[][] = [];
  stack: { transform: number[]; textBaseline: string; textAlign: string; globalAlpha: number; font: string; fillStyle: string }[] = [];
  setTransform(...values: number[]) { this.transform = values; }
  clearRect() { this.texts = []; this.images = []; }
  save() { this.stack.push({ transform: [...this.transform], textBaseline: this.textBaseline, textAlign: this.textAlign, globalAlpha: this.globalAlpha, font: this.font, fillStyle: this.fillStyle }); }
  restore() { Object.assign(this, this.stack.pop()); }
  fillText(text: string) { this.texts.push({ text, transform: [...this.transform], textBaseline: this.textBaseline, alpha: this.globalAlpha }); }
  drawImage(...args: unknown[]) { this.images.push(args); }
  measureText(text: string) { return { width: text.length * 8 }; }
  beginPath() {} arc() {} stroke() {}
}
class FakeCanvas {
  width = 1; height = 1; style = {}; className = '';
  context = new FakeContext();
  captured: number[] = []; released: number[] = [];
  getContext() { return this.context; }
  setPointerCapture(id: number) { this.captured.push(id); }
  releasePointerCapture(id: number) { this.released.push(id); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  remove() {}
  toDataURL() { return `data:image/png;fixture-dimensions=${this.width}x${this.height}`; }
}
const canvases: FakeCanvas[] = [];
const oldDocument = globalThis.document, oldWindow = globalThis.window;
const oldMutation = globalThis.MutationObserver, oldResize = globalThis.ResizeObserver;
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  document: { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; }, querySelector: () => null, querySelectorAll: () => [] },
  window: { addEventListener() {}, removeEventListener() {} }, MutationObserver: FakeObserver, ResizeObserver: FakeObserver,
});
test.after(() => Object.assign(globalThis, { document: oldDocument, window: oldWindow, MutationObserver: oldMutation, ResizeObserver: oldResize }));
/** Exercise actual production methods without importing the Vite inline star asset or constructing a browser. */
const source = ts.createSourceFile('CanvasSkyRenderer.ts', readFileSync('src/render/CanvasSkyRenderer.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
const sourceClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CanvasSkyRenderer') as ts.ClassDeclaration;
const names = ['setRuntimeQuality', 'getRuntimeQualityCapabilities', 'setStageInputEnabled', 'pointerInput', 'resetPointerGestures', 'drawFixedTextOverlay', 'capture', 'onKeyDown', 'blocked', 'resize', 'budgetMobile', 'drawSelection'];
const members = sourceClass.members.filter(member => member.name && names.includes(member.name.getText(source)));
assert.equal(members.length, names.length);
const compiled = ts.transpileModule(`class Subject{${members.map(member => member.getText(source)).join('\n')}}return Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let selectedKind: 'star' | 'body' = 'star';
const Subject = new Function('sameRuntimeRenderQuality', 'canvasRuntimeRaster', 'CANVAS_RUNTIME_QUALITY_CAPABILITIES', 'reducePointerGesture', 'document',
  'renderBudgetClass', 'cappedPixelRatio', 'window', 'resolveObjectDetails', 'resolveDisplayDirectionEqj', 'resolveCatalogStar', 'catalog', 'applyMatrix', compiled)
  (sameRuntimeRenderQuality, canvasRuntimeRaster, CANVAS_RUNTIME_QUALITY_CAPABILITIES, reducePointerGesture, document,
    renderBudgetClass, cappedPixelRatio, window,
    () => ({ id: selectedKind === 'star' ? 'hip:1' : 'body:Moon', kind: selectedKind, label: 'SELECTED', magnitude: 1 }),
    () => [0, 0, 1], () => ({ nameEn: 'REQUESTED-SELECTED-SECONDARY' }), {}, applyMatrix);
const stubRenderer = (fields: Record<string, unknown>): Record<string, any> => Object.assign(new Subject(), fields);

test('Canvas quality lowers only main backing density and keeps baseline label/HUD density for every pixel tier', () => {
  for (const [width, height, base] of [[1152, 720, 1.5], [390, 844, 1.25], [1153, 721, 1.5]]) {
    const baseline = canvasRuntimeRaster(width!, height!, base!, 1);
    let lastPixels = Infinity;
    for (const scale of [1, .85, .70, .55] as const) {
      const raster = canvasRuntimeRaster(width!, height!, base!, scale);
      assert.equal(raster.labelPixelRatio, base);
      assert.equal(raster.labelWidth, baseline.labelWidth); assert.equal(raster.labelHeight, baseline.labelHeight);
      assert.equal(raster.baseWidth, baseline.baseWidth); assert.equal(raster.baseHeight, baseline.baseHeight);
      assert.ok(raster.mainWidth * raster.mainHeight < lastPixels); lastPixels = raster.mainWidth * raster.mainHeight;
    }
  }
  assert.equal(CANVAS_RUNTIME_QUALITY_CAPABILITIES.pixelScaling, true);
  assert.equal(CANVAS_RUNTIME_QUALITY_CAPABILITIES.verifiedDecorationReduction, false);
  assert.equal(CANVAS_RUNTIME_QUALITY_CAPABILITIES.optionalInvisibleStars, false);
  assert.throws(() => canvasRuntimeRaster(1, 1, NaN, .55), RangeError);
  assert.throws(() => canvasRuntimeRaster(0, 1, 1, .55), RangeError);
  assert.throws(() => canvasRuntimeRaster(1, 1, 1, .4 as .55), RangeError);
});

test('protected selected/body/direction/teaching secondary text survives ordinary reductions', () => {
  const quality = { ...DEFAULT_RUNTIME_RENDER_QUALITY, hideOrdinarySecondaryLabels: true, ordinaryLabelBudgetScale: .5 };
  assert.equal(runtimeLabelSecondary({ id: 'hip:1' }, 'ordinary', quality), undefined);
  for (const identity of [{ id: 'hip:1', selected: true }, { id: 'body:Moon' }, { id: 'direction:N' }, { id: 'teaching:fixture', qualityProtected: true }])
    assert.equal(runtimeLabelSecondary(identity, 'protected', quality), 'protected');
  assert.equal(runtimeOrdinaryLabelBudget(60, quality), 30);
  assert.equal(runtimeOrdinaryLabelBudget(3, quality), 1);
  assert.equal(runtimeOrdinaryLabelBudget(18, DEFAULT_RUNTIME_RENDER_QUALITY), 18);
});

test('Canvas setter is runtime-only, copies effects, and an identical overlay requests no extra frame', () => {
  let invalidations = 0, resizes = 0, layouts = 0;
  const state = { viewMode: 'space', cameras: { saved: [1, 2, 3] } }, snapshot = { ut: 123 };
  const renderer = stubRenderer({ disposed: false, runtimeQuality: DEFAULT_RUNTIME_RENDER_QUALITY,
    width: 1152, height: 720, baseRatio: 1.5, state, snapshot,
    labels: { invalidateLayout: () => layouts++ }, resize: () => resizes++, onInvalidate: () => invalidations++ });
  const quality = { ...DEFAULT_RUNTIME_RENDER_QUALITY, pixelScale: .55 as const, ordinaryLabelBudgetScale: .5 };
  renderer.setRuntimeQuality(quality); assert.equal(invalidations, 1); assert.equal(resizes, 1); assert.equal(layouts, 1);
  quality.ordinaryLabelBudgetScale = .25;
  assert.equal(renderer.runtimeQuality.ordinaryLabelBudgetScale, .5);
  renderer.setRuntimeQuality({ ...renderer.runtimeQuality }); assert.equal(invalidations, 1);
  assert.equal(renderer.state, state); assert.equal(renderer.snapshot, snapshot);
  assert.throws(() => renderer.setRuntimeQuality({ ...DEFAULT_RUNTIME_RENDER_QUALITY, ordinaryLabelBudgetScale: NaN }), RangeError);
  assert.equal(invalidations, 1);
});

test('stage guard releases captured contacts and blocks pointer/keyboard picking until explicitly restored', () => {
  const canvas = new FakeCanvas(), selections: unknown[] = [];
  const renderer = stubRenderer({ canvas, disposed: false, stageInputEnabled: true, gesture: createPointerGesture(),
    blocks: [], stars: [{ id: 'hip:1', x: 100, y: 100, radius: 11, magnitude: 1 }], bodies: [], labels: null,
    onSelect: (id: unknown) => selections.push(id), state: null, snapshot: null });
  renderer.pointerInput({ type: 'down', id: 7, x: 100, y: 100 }); assert.deepEqual(canvas.captured, [7]);
  renderer.setStageInputEnabled(false); assert.deepEqual(canvas.released, [7]); assert.equal(renderer.gesture.pointers.size, 0);
  renderer.pointerInput({ type: 'up', id: 7, x: 100, y: 100 });
  renderer.pointerInput({ type: 'down', id: 8, x: 100, y: 100 }); renderer.pointerInput({ type: 'up', id: 8, x: 100, y: 100 });
  renderer.onKeyDown({ key: 'Escape', preventDefault: () => assert.fail('disabled stage does not consume keyboard actions') });
  assert.deepEqual(selections, []); assert.deepEqual(canvas.captured, [7]);
  renderer.setStageInputEnabled(true);
  renderer.pointerInput({ type: 'down', id: 9, x: 100, y: 100 }); renderer.pointerInput({ type: 'up', id: 9, x: 100, y: 100 });
  assert.deepEqual(selections, ['hip:1']);
});

test('existing label canvas clears old captions and receives all fixed text at baseline ratio with context restored', () => {
  const layer = new LabelLayer({ append() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1152, bottom: 720 }) } as unknown as HTMLElement); layer.resize(1152, 720, 1.5);
  const ctx = layer.canvas.getContext('2d') as unknown as FakeContext;
  const renderer = stubRenderer({ labels: layer, baseRatio: 1.5, ratio: .825,
    viewport: { centerX: 576, centerY: 360, radius: 240, compactHud: false },
    header: { box: { left: 400, right: 752, top: 26 }, lines: [{ text: 'OLD-CAPTION', color: '#fff', font: '13px sans-serif' }], baselineOffset: 14, lineHeight: 18 },
    footer: { box: null, lines: [] } });
  layer.draw([], false, 40, 20); const before = [...ctx.transform]; renderer.drawFixedTextOverlay();
  assert.ok(ctx.texts.some(item => item.text === 'OLD-CAPTION'));
  assert.ok(ctx.texts.every(item => item.transform[0] === 1.5 && item.transform[3] === 1.5 && item.alpha === 1 && item.textBaseline === 'alphabetic'));
  assert.deepEqual(ctx.transform, before); assert.equal(ctx.stack.length, 0);
  renderer.header = { box: null, lines: [] };
  layer.draw([], false, 40, 20); renderer.drawFixedTextOverlay();
  assert.ok(!ctx.texts.some(item => item.text === 'OLD-CAPTION'));
  for (const text of ['北 N', '南 S', '东 E', '西 W', '天顶', '高度 30°']) assert.ok(ctx.texts.some(item => item.text === text));
  layer.dispose();
});

test('capture expands the current low main raster into baseline output and composites labels without cropping', () => {
  const main = new FakeCanvas(), labels = new FakeCanvas(); main.width = 950; main.height = 594; labels.width = 1728; labels.height = 1080;
  const renderer = stubRenderer({ disposed: false, canvas: main, labels: { canvas: labels }, state: null, snapshot: null,
    width: 1152, height: 720, baseRatio: 1.5, runtimeQuality: { ...DEFAULT_RUNTIME_RENDER_QUALITY, pixelScale: .55 } });
  const result = renderer.capture(), output = canvases.at(-1)!;
  assert.equal(result, 'data:image/png;fixture-dimensions=1728x1080');
  assert.deepEqual(output.context.images[0], [main, 0, 0, 1728, 1080]);
  assert.deepEqual(output.context.images[1], [labels, 0, 0]);
  assert.equal(main.width, 950); assert.equal(main.height, 594); assert.equal(renderer.runtimeQuality.pixelScale, .55);
});

test('actual Canvas resize uses the shared 720/coarse budget class while pixel-only changes preserve label backing', () => {
  const budgetWindow = window as unknown as { devicePixelRatio: number; matchMedia(query: string): { matches: boolean } };
  budgetWindow.devicePixelRatio = 3;
  for (const [width, height, coarse, mobile] of [[700, 900, false, true], [720, 900, false, false], [1024, 600, true, true], [1024, 601, true, false]] as const) {
    budgetWindow.matchMedia = () => ({ matches: coarse });
    const canvas = new FakeCanvas(), labelCanvas = new FakeCanvas(); let labelResizes = 0;
    const renderer = stubRenderer({ disposed: false, canvas, container: { clientWidth: width, clientHeight: height },
      width: 1, height: 1, baseRatio: 1, ratio: 1, runtimeQuality: DEFAULT_RUNTIME_RENDER_QUALITY, stageInputEnabled: true, gesture: createPointerGesture(),
      updateViewport() {}, labels: { canvas: labelCanvas, resize(w: number, h: number, ratio: number) { labelResizes++; labelCanvas.width = Math.round(w * ratio); labelCanvas.height = Math.round(h * ratio); } } });
    renderer.resize(); assert.equal(renderer.budgetMobile(), mobile);
    assert.equal(renderer.baseRatio, mobile ? 1.25 : 1.5); assert.equal(labelResizes, 1);
    const beforeLabels = [labelCanvas.width, labelCanvas.height], beforeMainPixels = canvas.width * canvas.height;
    renderer.runtimeQuality = { ...DEFAULT_RUNTIME_RENDER_QUALITY, pixelScale: .55 }; renderer.resize();
    assert.ok(canvas.width * canvas.height < beforeMainPixels); assert.deepEqual([labelCanvas.width, labelCanvas.height], beforeLabels); assert.equal(labelResizes, 1);
  }
});

test('actual Canvas selected label preserves requested star secondary and body direction explanation under reductions', () => {
  const renderer = stubRenderer({ context: new FakeContext(), appearance: { limitingMagnitude: 6.5, starVisibility: 1 },
    projectDirection: () => ({ x: 0, y: 0, radius: 0 }), pixel: () => ({ x: 100, y: 100 }), blocks: [], focusRequestedFor: null,
    runtimeQuality: { ...DEFAULT_RUNTIME_RENDER_QUALITY, hideOrdinarySecondaryLabels: true, ordinaryLabelBudgetScale: 0 } });
  const snapshot = { eqjToHorizontalGeometric: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  selectedKind = 'star'; let candidates: Record<string, unknown>[] = [];
  renderer.drawSelection({ selected: 'hip:1', layers: { secondaryNames: true } }, snapshot, candidates);
  assert.equal(candidates[0]!.secondary, 'REQUESTED-SELECTED-SECONDARY'); assert.equal(candidates[0]!.selected, true);
  candidates = []; renderer.drawSelection({ selected: 'hip:1', layers: { secondaryNames: false } }, snapshot, candidates);
  assert.equal(candidates[0]!.secondary, undefined);
  selectedKind = 'body'; candidates = []; renderer.drawSelection({ selected: 'body:Moon', layers: { secondaryNames: false } }, snapshot, candidates);
  assert.equal(candidates[0]!.secondary, '方向标记'); assert.equal(candidates[0]!.selected, true);
});
