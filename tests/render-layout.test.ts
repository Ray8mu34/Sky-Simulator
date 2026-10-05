import test from 'node:test';
import assert from 'node:assert/strict';
import { clipOcclusionBounds } from '../src/render/Occlusion';
import type { SkyOcclusion } from '../src/render/Occlusion';
import { canvasCaptionLayout, canvasOverviewLayout, canvasStarSymbol, canvasTeachingLabelBudget } from '../src/render/CanvasOverviewLayout';

const box = (left: number, top: number, right: number, bottom: number, dock?: string): SkyOcclusion =>
  ({ left, top, right, bottom, dock, id: 'sky-control-panel', compact: false, canvasHud: false });

test('occlusion intersects the actual stage and a closed/off-screen drawer reserves nothing', () => {
  const stage = { left: 100, top: 50, right: 490, bottom: 894 };
  assert.deepEqual(clipOcclusionBounds({ left: 90, top: 600, right: 500, bottom: 950 }, stage), { left: 0, top: 550, right: 390, bottom: 844 });
  assert.equal(clipOcclusionBounds({ left: 100, top: 894, right: 490, bottom: 1300 }, stage), null);
  assert.equal(clipOcclusionBounds({ left: 20, top: 50, right: 100, bottom: 300 }, stage), null);
});

test('small chart symbols reduce ink continuously while large charts retain the previous hierarchy', () => {
  for (const magnitude of [-1, 0, 3, 6]) {
    const radii = [50, 59, 74, 89.999, 90.001, 143, 180, 300].map(radius => canvasStarSymbol(magnitude, radius));
    for (let i = 1; i < radii.length; i++) { assert.ok(radii[i]!.radius >= radii[i - 1]!.radius); assert.ok(radii[i]!.alpha >= radii[i - 1]!.alpha); }
    assert.deepEqual(radii.at(-1), radii.at(-2));
    assert.ok(Math.abs(radii[3]!.alpha - radii[4]!.alpha) < .0001);
  }
  assert.equal(canvasTeachingLabelBudget(59, true), 3); assert.equal(canvasTeachingLabelBudget(74, true), 3);
  assert.ok(canvasStarSymbol(6, 59).alpha < .025); assert.equal(canvasStarSymbol(0, 59).alpha, 1);
  assert.equal(canvasStarSymbol(0, 180).radius, 2.6);
});

test('portrait bottom drawer fits the entire fixed overview and footer above its real top', () => {
  const compact = { ...box(8, 780, 382, 836, 'bottom'), compact: true };
  const closed = canvasOverviewLayout(390, 844, true, [compact]);
  const open = canvasOverviewLayout(390, 844, true, [box(8, 430, 382, 770, 'bottom'), compact]);
  assert.ok(open.centerY < closed.centerY);
  assert.ok(open.radius < closed.radius && open.radius > 80);
  assert.ok(open.centerY + open.radius + 79 < 430, 'disk, direction and footer fit before drawer');
  assert.equal(open.centerX, closed.centerX);
  assert.deepEqual(canvasOverviewLayout(390, 844, true, [compact]), closed, 'closing restores the same CSS layout');
});

test('short landscape uses a readable free side pocket and moves the whole HUD with it', () => {
  const drawer = box(162, 93, 682, 288, 'bottom');
  const status = { ...box(10, 308, 834, 322), id: 'runtime-status' };
  const layout = canvasOverviewLayout(844, 390, true, [drawer, { ...box(264, 328, 580, 382, 'bottom'), compact: true }, status]);
  assert.ok(layout.compactHud && layout.radius >= 50);
  assert.ok(layout.centerX + layout.radius < drawer.left, 'disk uses actual free side rather than an 8px top strip');
  assert.ok(layout.centerY - layout.radius > 0);
  assert.ok(layout.centerY + layout.radius + 79 < status.top, 'footer remains above status');
  assert.ok(layout.usableBounds.left >= 0 && layout.usableBounds.right < drawer.left);
  const desktop = canvasOverviewLayout(1152, 720, false, [box(12, 12, 284, 680, 'left')]);
  assert.ok(desktop.centerX - desktop.radius > 284);
});

test('fixed caption retains its old position without a notice and moves with an eight-pixel gap when one appears', () => {
  const desired = { left: 576, top: 26, right: 828, bottom: 62 };
  const panel = box(12, 12, 284, 680, 'left'), notice = { left: 800, top: 12, right: 1140, bottom: 62 };
  const chart = { left: 438, top: 88, right: 966, bottom: 616 };
  assert.deepEqual(canvasCaptionLayout(desired, 1152, 720, [panel], [chart]), desired);
  const moved = canvasCaptionLayout(desired, 1152, 720, [panel, notice], [chart])!;
  assert.equal(moved.top, desired.top); assert.equal(moved.right, notice.left - 8);
  assert.equal(moved.right - moved.left, desired.right - desired.left);
  assert.deepEqual(canvasCaptionLayout(desired, 1152, 720, [panel], [chart]), desired, 'hiding the notice restores the caption, not the circle');
});

test('caption placement uses generic occluders, viewport edges and a bounded no-space result', () => {
  const desired = { left: 250, top: 25, right: 550, bottom: 61 };
  const generic = { left: 225, top: 8, right: 600, bottom: 65 };
  const moved = canvasCaptionLayout(desired, 844, 390, [generic])!;
  assert.ok(moved.right <= 836 && moved.left >= 8 && moved.top >= 8 && moved.bottom <= 382);
  assert.ok(moved.top >= generic.bottom + 8 || moved.right <= generic.left - 8 || moved.left >= generic.right + 8);
  assert.equal(canvasCaptionLayout(desired, 844, 390, [box(0, 0, 844, 390)]), null);
  assert.equal(canvasCaptionLayout({ left: 0, top: 8, right: 900, bottom: 40 }, 844, 390, []), null, 'never compress full text to fit');
});

test('short side-pocket caption remains in its original location when the top-right notice is unrelated', () => {
  const desired = { left: 24, top: 24, right: 138, bottom: 60 };
  assert.deepEqual(canvasCaptionLayout(desired, 844, 390, [box(162, 93, 682, 288), box(492, 12, 832, 64)]), desired);
});
