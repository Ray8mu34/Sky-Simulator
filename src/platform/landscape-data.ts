export interface Landscape { version: 1; name: string; dataUrl: string; northOffsetDeg: number; enabled: boolean }
export const LANDSCAPE_MAX_BYTES = 12_000_000;
export function parseLandscape(value: unknown): Landscape {
  if (!value || typeof value !== 'object') throw new Error('地景包无效：需要 PNG/WebP 全景。');
  const raw = value as Landscape;
  if (raw.version !== 1 || typeof raw.name !== 'string' || raw.name.length > 120 || typeof raw.dataUrl !== 'string'
    || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw.dataUrl) || raw.dataUrl.length > LANDSCAPE_MAX_BYTES
    || !Number.isFinite(raw.northOffsetDeg) || Math.abs(raw.northOffsetDeg) > 360 || typeof raw.enabled !== 'boolean') {
    throw new Error('地景包无效：需要 PNG/WebP 全景，偏角 −360 至 360°，大小不超过 12 MB。');
  }
  return { version: 1, name: raw.name, dataUrl: raw.dataUrl, northOffsetDeg: raw.northOffsetDeg, enabled: raw.enabled };
}
