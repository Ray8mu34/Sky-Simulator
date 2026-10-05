import type { OcclusionBounds, SkyOcclusion } from './Occlusion';

/** A bounded CSS-only caption search. A null result means there is no safe slot. */
export function canvasCaptionLayout(desired: OcclusionBounds, width: number, height: number,
  occluders: readonly OcclusionBounds[], reserved: readonly OcclusionBounds[] = []): OcclusionBounds | null {
  const captionWidth = desired.right - desired.left, captionHeight = desired.bottom - desired.top;
  const margin = 8;
  if (captionWidth > width - margin * 2 || captionHeight > height - margin * 2) return null;
  const intersects = (a: OcclusionBounds, b: OcclusionBounds, gap: number) =>
    a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
  const fits = (a: OcclusionBounds) => a.left >= margin && a.top >= margin && a.right <= width - margin && a.bottom <= height - margin
    && !occluders.some(block => intersects(a, block, margin)) && !reserved.some(block => intersects(a, block, 0));
  if (fits(desired)) return { ...desired };
  const clampX = (value: number) => Math.max(margin, Math.min(width - margin - captionWidth, value));
  const clampY = (value: number) => Math.max(margin, Math.min(height - margin - captionHeight, value));
  const xs = [clampX(desired.left), margin, width - margin - captionWidth];
  const ys = [clampY(desired.top), margin, height - margin - captionHeight];
  for (const block of [...occluders, ...reserved]) {
    xs.push(clampX(block.left - margin - captionWidth), clampX(block.right + margin));
    ys.push(clampY(block.top - margin - captionHeight), clampY(block.bottom + margin));
  }
  // At most 32 × 32 placements, independent of the number of DOM candidates.
  const nearest = (values: number[], origin: number) => [...new Set(values)].sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin)).slice(0, 32);
  let best: OcclusionBounds | null = null, bestCost = Infinity;
  for (const left of nearest(xs, desired.left)) for (const top of nearest(ys, desired.top)) {
    const candidate = { left, top, right: left + captionWidth, bottom: top + captionHeight };
    const cost = Math.abs(left - desired.left) + 4 * Math.abs(top - desired.top);
    if (cost < bestCost && fits(candidate)) { best = candidate; bestCost = cost; }
  }
  return best;
}

/** Visual ink scales with a small CSS disk, without changing stars or limits. */
export function canvasStarSymbol(magnitude: number, chartRadius: number) {
  const t = Math.max(0, Math.min(1, (chartRadius - 50) / 130)), blend = t * t * (3 - 2 * t);
  const weak = Math.max(0, Math.min(1, (magnitude - 1.5) / 2.5)), weakness = weak * weak * (3 - 2 * weak);
  const scale = .43 + .57 * blend, weakAlphaScale = .16 + .84 * blend;
  return { radius: Math.max(.25, Math.max(.55, Math.min(3.4, 2.6 - magnitude * .31)) * scale),
    alpha: Math.max(.1, 10 ** (-.16 * Math.max(0, magnitude))) * (1 - weakness + weakness * weakAlphaScale) };
}
export function canvasTeachingLabelBudget(chartRadius: number, mobile: boolean): number {
  return Math.min(mobile ? 18 : 40, Math.max(chartRadius < 90 ? 3 : 8, Math.floor(Math.PI * chartRadius ** 2 / (mobile ? 4500 : 8000))));
}

/** CSS layout only: the astronomical projection and serialized cameras are untouched. */
export function canvasOverviewLayout(width: number, height: number, mobile: boolean, occluders: readonly SkyOcclusion[]) {
  let left = 40, right = width - 40, top = 76, bottom = height - 88;
  let bottomDock = false;
  let sideBottom = bottom;
  const shortLandscape = mobile && width > height && height <= 600;
  for (const block of occluders) {
    if (block.canvasHud) continue;
    const blockWidth = block.right - block.left, blockHeight = block.bottom - block.top;
    if (block.dock === 'bottom') {
      // Keep the complete disk and its footer above the actual drawer/toolbar.
      bottom = Math.min(bottom, block.top - 72); bottomDock = true;
      if (block.compact) sideBottom = Math.min(sideBottom, block.top - 72);
    } else {
      if (width >= 720 && block.left < width * .25 && blockWidth < width * .5 && blockHeight > height * .33)
        left = Math.max(left, block.right + 32);
      if (mobile && block.compact) {
        if ((block.dock === 'left' || shortLandscape) && block.right < width * .6) left = Math.max(left, block.right + 36);
        else top = Math.max(top, block.bottom + 78);
      }
    }
    if (block.id === 'runtime-status') { bottom = Math.min(bottom, block.top - 70); sideBottom = Math.min(sideBottom, block.top - 70); }
    if (block.modeNote && block.top > height * .55) { bottom = Math.min(bottom, block.top - 70); sideBottom = Math.min(sideBottom, block.top - 70); }
  }
  if (right - left < 100) { left = 24; right = width - 24; }
  if (bottom - top < 100) {
    if (bottomDock) top = Math.max(12, Math.min(top, bottom - 48));
    else { top = 66; bottom = height - 60; }
  }
  let radius = Math.max(8, Math.min(right - left, bottom - top) / 2 - 12), compactHud = false;
  // Short landscape leaves useful sky at the drawer sides even when the strip
  // above it is too shallow. Keep one complete disk in an actual free pocket.
  if (shortLandscape && bottomDock && radius < 50) {
    const intersects = (a: typeof occluders[number], l: number, r: number, t: number, b: number) => a.left < r && a.right > l && a.top < b && a.bottom > t;
    for (const drawer of occluders.filter(block => block.dock === 'bottom' && !block.compact && block.id === 'sky-control-panel')) {
      for (const [pocketLeft, pocketRight] of [[12, drawer.left - 8], [drawer.right + 8, width - 12]]) {
        const candidateRadius = Math.min(pocketRight! - pocketLeft!, sideBottom - 76) / 2 - 12;
        if (candidateRadius <= radius || candidateRadius < 40) continue;
        if (occluders.some(block => !block.canvasHud && intersects(block, pocketLeft!, pocketRight!, 12, sideBottom + 64))) continue;
        left = pocketLeft!; right = pocketRight!; top = 76; bottom = sideBottom; radius = candidateRadius; compactHud = true;
      }
    }
  }
  return { centerX: (left + right) / 2, centerY: (top + bottom) / 2, radius, compactHud, usableBounds: { left, top, right, bottom } };
}
