import input from '../../assets/runtime/chinese-sky.json';
import {normalize,raDecToVector} from '../core/math';
import type {Vec3} from '../contracts';
export const chineseFigures=input.filter(f=>f.pairs.length).map(figure=>({...figure,
  objectId:`chinese:${figure.id}` as const,
  directionEqj:normalize(figure.pairs.flat().reduce((v,p)=>{const d=raDecToVector(p[0]!,p[1]!);return [v[0]!+d[0],v[1]!+d[1],v[2]!+d[2]];},[0,0,0]) as unknown as Vec3)}));
export const resolveChineseFigure=(id:string)=>chineseFigures.find(f=>f.objectId===id)??null;
