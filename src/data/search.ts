import type { ObjectId } from '../contracts';
import type { ConstellationMeta, StarCatalog, StarMeta } from './types';
import { solarObjects } from './solar-objects';
import { deepSkyObjects, deepSkyLabel, deepSkyTypeLabel } from './deep-sky';
import { chineseFigures } from './chinese-sky';

export type ObjectKind = 'star' | 'body' | 'constellation' | 'deep-sky';
export interface ObjectSearchResult {
  id: ObjectId;
  label: string;
  secondary: string;
  kind: ObjectKind;
}

/** Only bodies already displayed by this milestone are searchable and locatable. */
export const drawnSolarObjects = solarObjects.map(object => ({ ...object, id: `body:${object.body}` as const,
  aliases: [object.label, object.english, ...object.aliases] }));

const MAX_RESULTS = 64;
const key = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const starLabel = (star: StarMeta): string => star.nameZh?.trim() || star.nameEn?.trim() || star.id.toUpperCase();
export const constellationLabel = (figure: ConstellationMeta): string => figure.nameZh.trim() || figure.nameEn.trim() || figure.id;

/** Numeric aliases (including HYG for a HIP-backed record) resolve to the catalog's canonical id. */
export function resolveCatalogStar(catalog: StarCatalog, id: string): StarMeta | null {
  const match = /^(hip|hyg)\s*:?\s*(\d+)$/iu.exec(id.normalize('NFKC').trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const namespace = match[1]!.toLowerCase();
  const canonical = catalog.stars.find(star => star.id === `${namespace}:${number}`);
  if (canonical) return canonical;
  const matches = catalog.stars.filter(star => namespace === 'hip' ? star.hip === number : star.hygId === number);
  // A shared HIP without an explicitly canonical record cannot select an arbitrary component.
  return matches.length === 1 ? matches[0]! : null;
}

export function resolveCatalogConstellation(catalog: StarCatalog, id: string): ConstellationMeta | null {
  const match = /^constellation:(.+)$/iu.exec(id.trim());
  if (!match) return null;
  const wanted = key(match[1]!);
  return catalog.constellations.find(figure => key(figure.id) === wanted) ?? null;
}

type RankedResult = { result: ObjectSearchResult; score: number; magnitude: number; number: number };
const kindOrder: Record<ObjectKind, number> = { body: 0, star: 1, constellation: 2, 'deep-sky': 3 };
function compareRank(a: RankedResult, b: RankedResult): number {
  return a.score - b.score || kindOrder[a.result.kind] - kindOrder[b.result.kind] || a.magnitude - b.magnitude ||
    compareText(a.result.id.split(':')[0]!, b.result.id.split(':')[0]!) || a.number - b.number || compareText(a.result.id, b.result.id);
}

/** Pure, offline search. Empty/oversized input returns no results; result storage is capped at 64. */
export function searchObjects(catalog: StarCatalog, query: string, limit = 12): ObjectSearchResult[] {
  if (typeof query !== 'string' || query.length > 512 || !Number.isFinite(limit) || limit <= 0) return [];
  const requested = Math.min(MAX_RESULTS, Math.floor(limit));
  const wanted = key(query.trim());
  if (!wanted || wanted.length > 128 || requested === 0) return [];
  const numbered = /^(hip|hyg):?(\d+)$/u.exec(wanted);
  const bareNumber = /^\d+$/u.test(wanted) ? Number(wanted) : null;
  if (numbered && (!Number.isSafeInteger(Number(numbered[2])) || Number(numbered[2]) <= 0) || bareNumber !== null && (!Number.isSafeInteger(bareNumber) || bareNumber <= 0)) return [];
  const ranked: RankedResult[] = [];
  const seen = new Set<ObjectId>();
  const retain = (entry: RankedResult): void => {
    if (seen.has(entry.result.id)) return;
    seen.add(entry.result.id);
    const position = ranked.findIndex(existing => compareRank(entry, existing) < 0);
    if (position < 0) { if (ranked.length < requested) ranked.push(entry); }
    else { ranked.splice(position, 0, entry); if (ranked.length > requested) ranked.pop(); }
  };
  const score = (identifiers: string[], names: string[]): number | null => {
    if (identifiers.some(identifier => key(identifier) === wanted)) return 0;
    const keys = names.filter(Boolean).map(key);
    if (keys.some(name => name === wanted)) return 1;
    if (keys.some(name => name.startsWith(wanted))) return 2;
    if (keys.some(name => name.includes(wanted))) return 3;
    return null;
  };
  for (const body of drawnSolarObjects) {
    if (numbered || bareNumber !== null) continue;
    const match = score([body.id], [...body.aliases]);
    if (match !== null) retain({ result: { id: body.id, kind: 'body', label: body.label, secondary: body.english }, score: match, magnitude: 0, number: 0 });
  }
  for (const star of catalog.stars) {
    const match = numbered
      ? (numbered[1] === 'hip' ? star.hip === Number(numbered[2]) : star.hygId === Number(numbered[2])) ? star.id === `${numbered[1]}:${Number(numbered[2])}` || numbered[1] === 'hyg' ? 0 : 1 : null
      : bareNumber !== null ? star.hip === bareNumber || star.hygId === bareNumber ? star.id === `hip:${bareNumber}` || star.id === `hyg:${bareNumber}` ? 0 : 1 : null
      : score([star.id, `HYG:${star.hygId}`, ...(star.hip !== null ? [`HIP:${star.hip}`] : [])], [star.nameZh ?? '', star.nameEn ?? '', ...star.aliases, star.variableName ?? '']);
    if (match === null) continue;
    const identifiers = [...(star.hip !== null ? [`HIP ${star.hip}`] : []), `HYG ${star.hygId}`];
    retain({ result: { id: star.id, kind: 'star', label: starLabel(star), secondary: [...(star.nameEn && star.nameEn !== starLabel(star) ? [star.nameEn] : []), ...identifiers].join(' · ') },
      score: match, magnitude: Number.isFinite(star.magnitude) ? star.magnitude : Infinity, number: Number(star.id.split(':')[1]) });
  }
  for (const figure of catalog.constellations) {
    if (numbered || bareNumber !== null) continue;
    const match = score([`constellation:${figure.id}`, figure.id], [figure.nameZh, figure.nameEn]);
    if (match !== null) retain({ result: { id: `constellation:${figure.id}`, kind: 'constellation', label: constellationLabel(figure), secondary: [figure.nameEn, figure.id].filter(Boolean).join(' · ') }, score: match, magnitude: 0, number: 0 });
  }
  if (!numbered && bareNumber === null) for (const object of deepSkyObjects) {
    const match = score([object.id, `M${object.number}`, `Messier${object.number}`, object.catalogName],
      [object.nameZh, ...object.aliases, deepSkyTypeLabel(object.type)]);
    if (match !== null) retain({ result: { id: object.id, kind: 'deep-sky', label: deepSkyLabel(object),
      secondary: `${object.catalogName} · ${deepSkyTypeLabel(object.type)}` }, score: match,
      magnitude: object.magnitude ?? Infinity, number: object.number });
  }
  if (!numbered && bareNumber === null) for (const figure of chineseFigures) {
    const match=score([figure.objectId],[figure.name??'',figure.english??'']);
    if(match!==null)retain({result:{id:figure.objectId,kind:'constellation',label:figure.name??figure.english??figure.id,secondary:'中国星官'},score:match,magnitude:0,number:Number(figure.id)});
  }
  return ranked.map(entry => entry.result);
}
