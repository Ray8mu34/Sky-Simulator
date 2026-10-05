/** Only painted UI boxes occlude the sky; the transparent controls host does not. */
export const SKY_OCCLUDER_SELECTOR = '#sky-control-panel,.controls-compact,.compact-mode-note,#runtime-status,[data-sky-occlusion]';
export interface OcclusionBounds { left: number; top: number; right: number; bottom: number }
export interface SkyOcclusion extends OcclusionBounds { id: string; compact: boolean; modeNote?: boolean; dock: string | undefined; canvasHud: boolean }

/** Stage-local intersection, so off-screen/closed drawers reserve no drawing space. */
export function clipOcclusionBounds(rect: OcclusionBounds, stage: OcclusionBounds): OcclusionBounds | null {
  const left = Math.max(rect.left, stage.left), right = Math.min(rect.right, stage.right);
  const top = Math.max(rect.top, stage.top), bottom = Math.min(rect.bottom, stage.bottom);
  return right > left && bottom > top ? { left: left - stage.left, top: top - stage.top, right: right - stage.left, bottom: bottom - stage.top } : null;
}

export function readSkyOcclusions(container: HTMLElement): SkyOcclusion[] {
  const stage = container.getBoundingClientRect(), result: SkyOcclusion[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(SKY_OCCLUDER_SELECTOR)) {
    if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
    const bounds = clipOcclusionBounds(element.getBoundingClientRect(), stage);
    if (bounds) result.push({ ...bounds, id: element.id, compact: element.matches('.controls-compact'), modeNote: element.matches('.compact-mode-note'), dock: element.dataset.skyDock, canvasHud: element.dataset.canvasSkyHud === 'true' });
  }
  return result;
}
