import { parseLandscape } from './landscape-data';
import type { Landscape } from './landscape-data';
import { createLocalDraft, teachingStorage } from './teaching-storage';
export type { Landscape } from './landscape-data';

export interface PreparedLandscape { current: Landscape | null; pixels: ImageData | null }
let current: Landscape | null = null, pixels: ImageData | null = null, generation = 0, intent = 0;
let restoring: Promise<void> | undefined;
const announce = (name: string) => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(name)); };
const saved = createLocalDraft<Landscape | null>(teachingStorage, 'landscape', value => value === null ? null : parseLandscape(value),
  () => announce('sky:landscape-save'));
export const landscapeState = () => ({ current, pixels, generation });
export const landscapeSaveStatus = () => saved.status();
export async function retryLandscapeSave(): Promise<void> {
  const token = intent, value = await saved.retry();
  if (token !== intent || value === null) return;
  try {
    const prepared = await prepareLandscape(value);
    if (token === intent) applyPreparedLandscape(prepared, false);
  } catch { if (token === intent) saved.rejectLoadedValue('已保存地景无法读取，原记录已保留；请重新导入图片。'); }
}
export const captureLandscape = (): PreparedLandscape => ({ current: current ? { ...current } : null, pixels });

/** Validation/decode never mutates the live view: course imports can commit atomically. */
export async function prepareLandscape(value: Landscape | null): Promise<PreparedLandscape> {
  if (value === null) return { current: null, pixels: null };
  const next = parseLandscape(value), img = new Image();
  img.src = next.dataUrl;
  try { await img.decode(); } catch { throw new Error('无法读取地景图片；请重新选择 PNG/WebP 全景。'); }
  if (img.width < 2 || img.height < 2 || img.width > 8192 || img.height > 4096 || Math.abs(img.width / img.height - 2) > .05) {
    throw new Error('请使用 2:1 等距柱状全景，最大 8192×4096，天空区域透明。');
  }
  const canvas = document.createElement('canvas'); canvas.width = Math.min(2048, img.width); canvas.height = canvas.width / 2;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法准备地景，请重试或改用较小的图片。');
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { current: next, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
}
export function applyPreparedLandscape(value: PreparedLandscape, persist = true): void {
  intent++; current = value.current ? { ...value.current } : null; pixels = value.pixels; generation++;
  if (persist) { saved.allowReplacement(); void saved.save(current); }
  announce('sky:landscape');
}
export async function setLandscape(value: Landscape | null): Promise<void> {
  const token = ++intent, next = await prepareLandscape(value);
  if (token === intent) applyPreparedLandscape(next);
}
export function updateLandscape(patch: Partial<Pick<Landscape, 'enabled' | 'northOffsetDeg'>>): void {
  intent++;
  if (!current) return;
  current = parseLandscape({ ...current, ...patch }); generation++;
  void saved.save(current); announce('sky:landscape');
}
export function restoreLandscape(): Promise<void> {
  return restoring ??= (async () => {
    const token = intent, value = await saved.load();
    if (token !== intent || value === null) return;
    try {
      const next = await prepareLandscape(value);
      if (token === intent) applyPreparedLandscape(next, false);
    } catch {
      if (token !== intent) return;
      saved.rejectLoadedValue('已保存地景无法读取，原记录已保留；请重新导入图片。');
      announce('sky:landscape-restore-error');
    }
  })();
}
export function landscapeAlpha(azimuth: number, altitude: number): number {
  if (!current?.enabled || !pixels) return 0;
  const u = ((azimuth - current.northOffsetDeg) % 360 + 360) % 360 / 360, v = (90 - altitude) / 180;
  const x = Math.min(pixels.width - 1, Math.floor(u * pixels.width)), y = Math.max(0, Math.min(pixels.height - 1, Math.floor(v * pixels.height)));
  return pixels.data[(y * pixels.width + x) * 4 + 3]! / 255;
}
