import { utToDate } from './time';

/** Whole-day precision wording is invariant for every instant with the same day key. */
export function precisionNoteForDay(startUt: number, endUt: number): string {
  const firstYear = utToDate(startUt).getUTCFullYear(), lastYear = utToDate(endUt).getUTCFullYear();
  return firstYear < 1900 || lastYear > 2100
    ? '完整民用日及辅助日界涉及现代主区间外：扩展探索事件为长期近似，未提供现代精度担保。'
    : '独立参考仅覆盖已列出的固定地点与日期；不声称整个现代区间验证完毕。';
}
