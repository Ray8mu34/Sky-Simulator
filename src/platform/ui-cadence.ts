/** Reuse the existing UI interval; science and rendering never consult this policy. */
export const UI_UPDATE_INTERVAL_MS = 180;
export function snapshotNeedsImmediateUi(scienceDirty: boolean, ready: boolean, running: boolean): boolean {
  return scienceDirty || !ready || !running;
}
export function uiCadenceDue(nowMs: number, lastUiMs: number): boolean {
  return nowMs - lastUiMs >= UI_UPDATE_INTERVAL_MS;
}
