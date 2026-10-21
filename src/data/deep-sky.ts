import records from '../../assets/runtime/messier.json';
import { raDecToVector } from '../core/math';
import type { Vec3 } from '../contracts';

export interface DeepSkyObject {
  id: `messier:${number}`; number: number; catalogName: string; type: string;
  raHours: number; decDeg: number; magnitude: number | null;
  majorArcmin: number | null; minorArcmin: number | null; positionAngleDeg: number | null;
  nameZh: string; aliases: string[]; note: string; directionEqj: Vec3;
}
export const deepSkyObjects: readonly DeepSkyObject[] = records.map(row => ({ ...row,
  id: `messier:${row.number}`, directionEqj: raDecToVector(row.raHours, row.decDeg) }));
export const deepSkyLabel = (object: DeepSkyObject): string => `M${object.number}${object.nameZh ? ` · ${object.nameZh}` : ''}`;
const typeLabels: Record<string,string> = { G:'星系', OCl:'疏散星团', GCl:'球状星团', PN:'行星状星云',
  Neb:'星云', HII:'发射星云', RfN:'反射星云', SNR:'超新星遗迹', 'Cl+N':'星团与星云', '*Ass':'恒星云', '**':'双星', Other:'星群' };
export const deepSkyTypeLabel = (type: string): string => typeLabels[type] ?? '深空天体';
export function resolveDeepSky(id: string | null): DeepSkyObject | null {
  return id?.startsWith('messier:') ? deepSkyObjects.find(object => object.id === id) ?? null : null;
}
