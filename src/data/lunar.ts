import encoded from '../../assets/runtime/lunar-months.b64.txt?raw';
import metadata from '../../assets/runtime/lunar-meta.json';

interface LunarCalendarCommon {
  calendarZone: 'UTC+08:00';
  /** Gregorian years audited against HKO; retained differences are marked uncertain. */
  verifiedGregorianYears: readonly [1901, 2100];
  sourceNote: string;
  uncertain: boolean;
}
export type LunarCalendarInfo = LunarCalendarCommon & (
  { available: true; year: number; month: number; day: number; isLeapMonth: boolean;
    monthLengthDays: number; monthNameZh: string; dayNameZh: string; label: string; civilDate: string }
  | { available: false; reason: 'out-of-range' | 'invalid-time'; label: '未提供已验证农历' | '无效时间';
      uncertain: false; civilDate?: string }
);

const text = atob(encoded.trim());
const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
if (bytes.length !== metadata.months * 8) throw new Error('农历月起始表长度不完整');
const records = new DataView(bytes.buffer);
const DAY = 86400000;
const FIRST = Date.UTC(1901, 0, 1) / DAY;
const END = Date.UTC(2101, 0, 1) / DAY;
const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const common: LunarCalendarCommon = { calendarZone: 'UTC+08:00', verifiedGregorianYears: [1901, 2100],
  sourceNote: '固定 lunar-typescript1.8.6（MIT），按UTC+8民用日；HKO1901–2100逐日核验，保留2057年30日差异及未来新月不确定性。', uncertain: false };

/** Pure civil-calendar lookup, independent of observer timezone, lunar phase and ephemerides. */
export function lookupLunarCalendar(utcMilliseconds: number): LunarCalendarInfo {
  if (!Number.isFinite(utcMilliseconds)) return { ...common, available: false, reason: 'invalid-time', label: '无效时间', uncertain: false };
  const civilDay = Math.floor((utcMilliseconds + 8 * 3600000) / DAY);
  const civilTime = civilDay * DAY;
  const civilDate = Number.isFinite(civilTime) && Math.abs(civilTime) <= 8.64e15
    ? new Date(civilTime).toISOString().slice(0, 10) : undefined;
  if (civilDay < FIRST || civilDay >= END || civilDate === undefined)
    return { ...common, available: false, reason: 'out-of-range', label: '未提供已验证农历', uncertain: false, civilDate };
  let low = 0; let high = metadata.months;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (records.getInt32(middle * 8, true) <= civilDay) low = middle + 1;
    else high = middle;
  }
  const offset = (low - 1) * 8;
  const year = records.getUint16(offset + 4, true);
  const flags = records.getUint8(offset + 6);
  const month = flags & 127; const isLeapMonth = (flags & 128) !== 0;
  const monthLengthDays = records.getUint8(offset + 7);
  const day = civilDay - records.getInt32(offset, true) + 1;
  if (day < 1 || day > monthLengthDays) throw new Error('农历月起始表覆盖不完整');
  const monthNameZh = `${isLeapMonth ? '闰' : ''}${MONTH_NAMES[month - 1]}`;
  const dayNameZh = DAY_NAMES[day - 1];
  const uncertain = metadata.hkoComparison.uncertainGregorianYears.includes(Number(civilDate.slice(0, 4)));
  const sourceNote = uncertain
    ? '固定lunar-typescript1.8.6口径；HKO提示该年新月近午夜可能相差1日。2057-09-28至10-27与固定HKO表相差1日，已保留差异，属预报不确定。'
    : common.sourceNote;
  return { ...common, available: true, year, month, day, isLeapMonth, monthLengthDays,
    monthNameZh, dayNameZh, label: `${monthNameZh}${dayNameZh}`, civilDate, uncertain, sourceNote };
}

export const lunarCalendarMetadata = metadata;
