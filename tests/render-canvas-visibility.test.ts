import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ScienceSnapshot } from '../src/contracts';
import { scienceState } from './fixtures/science-state';
import { applyMatrix, horizontalToVector } from '../src/core/math';
import { createRefractionDescriptor, getDisplayRefractionProfile } from '../src/core/refraction';
import { deriveSkyAppearance } from '../src/core/sky-appearance';
import { clipSampleCanvasSkyArcEnu, projectCanvasEqjToSkyDisk } from '../src/render/CanvasSkyProjection';
import { canvasStarSymbol, canvasTeachingLabelBudget } from '../src/render/CanvasOverviewLayout';
import { DEFAULT_RUNTIME_RENDER_QUALITY } from '../src/platform/runtime-quality-contract';
import { runtimeLabelSecondary, runtimeOrdinaryLabelBudget } from '../src/render/RenderQuality';
import { createPointerGesture, reducePointerGesture } from '../src/render/PointerGestures';
import { finalStarAlpha, STAR_ALPHA_DISCARD, starMagnitudeVisibility } from '../src/render/star-visibility';

// Import the actual production methods without Vite's inline catalog loader.
const source = ts.createSourceFile('CanvasSkyRenderer.ts', readFileSync('src/render/CanvasSkyRenderer.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
const sourceClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CanvasSkyRenderer') as ts.ClassDeclaration;
const names = ['render', 'projectDirection', 'pixel', 'starDirection', 'drawConstellationLines', 'constellationLabelVisibility', 'pointerInput', 'blocked', 'drawSelection'];
const members = sourceClass.members.filter(member => member.name && names.includes(member.name.getText(source)));
assert.equal(members.length, names.length);
const compiled = ts.transpileModule(`class Subject{${members.map(member => member.getText(source)).join('\n')}}return Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const stars = [1, 3, 2.05, 2.11, -1, 2.09].map((magnitude, index) => ({ index, id: `hip:${index + 1}`, magnitude, nameZh: `STAR${index}`, nameEn: `EN${index}` }));
const directions = stars.map((_, index) => horizontalToVector(index === 4 ? -20 : 30, 15 + index * 40));
const catalog = { stars, lineIndices: Uint16Array.from([0, 1, 0, 2, 1, 3]), constellations: [
  { id: 'Hidden', lineStart: 0, lineCount: 1 }, { id: 'Fading', lineStart: 1, lineCount: 1 }, { id: 'Dark', lineStart: 2, lineCount: 1 },
] };
const resolveDirection = (_catalog: unknown, id: string | null) => id?.startsWith('hip:') ? directions[stars.findIndex(star => star.id === id)] ?? null
  : id?.startsWith('constellation:') ? horizontalToVector(35, 15) : null;
const resolveDetails = (_catalog: unknown, id: string | null) => { const star = stars.find(star => star.id === id);
  return star ? { id: star.id, kind: 'star', magnitude: star.magnitude, label: star.nameZh } : null; };
const dependencies = { catalog, getDisplayRefractionProfile, projectCanvasEqjToSkyDisk, clipSampleCanvasSkyArcEnu, applyMatrix,
  deriveSkyAppearance, canvasStarSymbol, canvasTeachingLabelBudget, runtimeLabelSecondary, runtimeOrdinaryLabelBudget,
  finalStarAlpha, STAR_ALPHA_DISCARD, starMagnitudeVisibility, reducePointerGesture, cssRgb: () => '#000',
  starLabel: (star: { nameZh: string }) => star.nameZh, constellationLabel: (figure: { id: string }) => figure.id,
  resolveDisplayDirectionEqj: resolveDirection, resolveObjectDetails: resolveDetails, resolveCatalogStar: (_catalog: unknown, id: string) => stars.find(star => star.id === id) };
const Subject = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));

class Context {
  globalAlpha = 1; fillStyle = ''; strokeStyle = ''; lineWidth = 1;
  point: { x: number; y: number; radius: number } | null = null;
  fills: { x: number; y: number; radius: number; alpha: number }[] = [];
  strokes: { style: string; alpha: number }[] = [];
  setTransform() {} fillRect() {} save() {} restore() {} clip() {} moveTo() {} lineTo() {}
  createRadialGradient() { return { addColorStop() {} }; }
  beginPath() { this.point = null; }
  arc(x: number, y: number, radius: number) { this.point = { x, y, radius }; }
  fill() { if (this.point) this.fills.push({ ...this.point, alpha: this.globalAlpha }); }
  stroke() { this.strokes.push({ style: this.strokeStyle, alpha: this.globalAlpha }); }
}
const snapshot = (state = scienceState()) => ({ utDaysJ2000: state.time.utDaysJ2000,
  eqjToHorizontalGeometric: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], observerRefraction: createRefractionDescriptor(state.environment),
  bodies: [{ id: 'Sun', geometricAltitudeDeg: -30 }, { id: 'Moon', geometricAltitudeDeg: -10, illuminatedFraction: 1 }],
} as unknown as ScienceSnapshot);
function renderer() {
  const picks: (string | null)[] = [], candidates: Record<string, any>[] = [];
  const context = new Context(), canvas = { getAttribute: () => '', setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, releasePointerCapture() {} };
  const subject = Object.assign(new Subject(), { disposed: false, context, canvas, viewport: { centerX: 250, centerY: 250, radius: 200 }, width: 500, height: 500, ratio: 1,
    starDirections: Float64Array.from(directions.flat()), starCss: stars.map(() => '#fff'), blocks: [], lastInteractionSignature: '', samples: [],
    gesture: createPointerGesture(), stageInputEnabled: true, resetPointerGestures() {}, resize() {}, updateStarDirections() {},
    drawGridAndExplanation() {}, drawFixedTextOverlay() {}, budgetMobile: () => false, runtimeQuality: DEFAULT_RUNTIME_RENDER_QUALITY,
    labels: { draw(labels: Record<string, any>[]) { candidates.splice(0, candidates.length, ...labels); }, hitTest: () => null },
    onSelect: (id: string | null) => picks.push(id), focusRequestedFor: null, belowHorizonReason: () => 'below horizon' });
  return { subject, context, candidates, picks };
}
function observationState() {
  const state = scienceState(); state.presentation = 'observation'; state.layers.atmosphere = true;
  state.layers.sunMoon = false; state.layers.terrain = false; state.layers.horizon = false;
  state.density = 'reference'; state.layers.secondaryNames = true;
  return state;
}
const observation = { ...deriveSkyAppearance(observationState(), snapshot()), visibilityApplied: true, limitingMagnitude: 2, starVisibility: 1 };

test('Canvas point/name/pick candidates use the shared fade including its positive-magnitude tail', () => {
  const state = observationState(), frame = snapshot(state), { subject, context, candidates, picks } = renderer();
  subject.render(state, frame, observation);
  assert.deepEqual(subject.stars.map((star: { id: string }) => star.id), ['hip:1', 'hip:3']);
  assert.deepEqual(candidates.filter(label => label.id.startsWith('hip:')).map(label => label.id), ['hip:1', 'hip:3']);
  const fading = subject.stars.find((star: { id: string }) => star.id === 'hip:3');
  const fadingInk = context.fills.find(point => point.radius < 10 && point.x === fading.x && point.y === fading.y)!;
  assert.equal(fadingInk.alpha, starMagnitudeVisibility(2.05, 2) * canvasStarSymbol(2.05, 200).alpha);
  assert.equal(candidates.find(label => label.id === 'hip:3')!.alpha, finalStarAlpha(2.05, 2, 1, 1, canvasStarSymbol(2.05, 200).alpha));
  assert.ok(candidates.find(label => label.id === 'hip:3')!.alpha < .4);
  subject.pointerInput({ type: 'down', id: 1, x: fading.x, y: fading.y }); subject.pointerInput({ type: 'up', id: 1, x: fading.x, y: fading.y });
  assert.deepEqual(picks, ['hip:3']);
  const hidden = subject.pixel(projectCanvasEqjToSkyDisk(directions[1]!, frame, getDisplayRefractionProfile(frame, 'ground'))!);
  subject.pointerInput({ type: 'down', id: 2, x: hidden.x, y: hidden.y }); subject.pointerInput({ type: 'up', id: 2, x: hidden.x, y: hidden.y });
  assert.equal(picks.at(-1), null);
});

test('Canvas ordinary and selected constellation arcs use the weaker real endpoint and preserve its exact fade', () => {
  const state = observationState(), frame = snapshot(state), { subject, context } = renderer();
  subject.appearance = observation; subject.refractionProfile = getDisplayRefractionProfile(frame, 'ground');
  subject.segmentCount = subject.segmentPointCount = subject.cappedArcCount = subject.ambiguousArcCount = subject.arcKnotBudgetExceededCount = subject.maximumArcStepDeg = 0;
  subject.drawConstellationLines(state, frame, false);
  assert.equal(context.strokes.length, 1); assert.equal(context.strokes[0]!.alpha, finalStarAlpha(2.05, 2, 1) * .5);
  state.selected = 'constellation:Hidden'; subject.drawConstellationLines(state, frame, true); assert.equal(context.strokes.length, 1);
  state.selected = 'constellation:Fading'; subject.drawConstellationLines(state, frame, true);
  assert.equal(context.strokes.length, 2); assert.equal(context.strokes[1]!.alpha, finalStarAlpha(2.05, 2, 1) * .85);
});

test('Canvas constellation ordinary names follow surviving endpoint pairs while daylight leaves no ordinary objects', () => {
  const state = observationState(), frame = snapshot(state), first = renderer(); first.subject.render(state, frame, observation);
  assert.deepEqual(first.candidates.filter(label => label.id.startsWith('constellation:')).map(label => label.id), ['constellation:Fading']);
  assert.equal(first.candidates.find(label => label.id === 'constellation:Fading')!.alpha, finalStarAlpha(2.05, 2, 1));
  const day = renderer(); day.subject.render(state, frame, { ...observation, starVisibility: 0 });
  assert.equal(day.subject.stars.length, 0); assert.equal(day.subject.segmentCount, 0); assert.equal(day.candidates.length, 0);
});

test('Canvas explanation and atmosphere-off retain complete constellation diagrams and the upper sky restriction', () => {
  for (const mode of ['explanation', 'atmosphere-off'] as const) {
    const state = observationState(); if (mode === 'explanation') state.presentation = 'explanation'; else state.layers.atmosphere = false;
    const frame = snapshot(state), { subject, context, candidates } = renderer(); subject.render(state, frame);
    assert.equal(subject.appearance.visibilityApplied, false);
    assert.equal(subject.segmentCount, 3); assert.deepEqual(context.strokes.map(stroke => stroke.alpha), [.5, .5, .5]);
    assert.equal(candidates.filter(label => label.id.startsWith('constellation:')).length, 3);
    assert.ok(candidates.filter(label => label.id.startsWith('hip:')).every(label => label.alpha === 1), 'diagram names retain their original full text contrast');
    assert.equal(subject.stars.some((star: { id: string }) => star.id === 'hip:5'), false, 'transparent terrain cannot put below-horizon stars on this disk');
  }
});

test('Canvas retains an explicit selected direction marker without claiming its hidden star is rendered', () => {
  const state = observationState(), frame = snapshot(state), { subject, candidates } = renderer();
  state.selected = 'hip:2'; subject.render(state, frame, observation);
  assert.equal(subject.stars.some((star: { id: string }) => star.id === state.selected), false);
  assert.match(subject.focusReason, /当前可见性模型已隐藏该星点/);
  assert.equal(candidates.find(label => label.id === state.selected)!.selected, true);
  state.selected = 'hip:3'; subject.render(state, frame, observation);
  assert.match(subject.focusReason, /高亮不保证肉眼可见/);
  assert.equal(subject.stars.some((star: { id: string }) => star.id === state.selected), true);
});

test('Canvas saved external view applies the actual local sky appearance without changing scientific state', () => {
  const state = observationState(); state.viewMode = 'space'; state.environment.artificialSkyBrightness = 1;
  const frame = snapshot(state), before = structuredClone({ state, frame }), { subject } = renderer(); subject.render(state, frame);
  assert.equal(subject.appearance.visibilityApplied, true); assert.equal(subject.appearance.scope, 'local-observer');
  assert.equal(subject.appearance.limitingMagnitude, 3);
  assert.deepEqual({ state, frame }, before);
});
