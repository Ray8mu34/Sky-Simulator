import records from '../../assets/runtime/star-meta.json';
import figures from '../../assets/runtime/constellation-meta.json';
import encodedStars from '../../assets/runtime/stars.b64.txt?raw';
import type { ConstellationMeta, StarCatalog, StarMeta } from './types';

// One static inline record source. No fetch, Worker copies, or random synthetic stars.
const bytesText = atob(encodedStars.trim());
const bytes = new Uint8Array(bytesText.length);
for (let i = 0; i < bytes.length; i++) bytes[i] = bytesText.charCodeAt(i);
const input = new DataView(bytes.buffer);
const count = records.length;
if (bytes.length !== count * 32) throw new Error('亮星数据长度不完整');
const directionsEqj = new Float32Array(count * 3);
const magnitudes = new Float32Array(count);
const colors = new Float32Array(count * 3);
const colorIndices = new Float32Array(count);
for (let i = 0; i < count; i++) {
  const offset = i * 32;
  for (let axis = 0; axis < 3; axis++) {
    directionsEqj[i * 3 + axis] = input.getFloat32(offset + axis * 4, true);
    colors[i * 3 + axis] = input.getFloat32(offset + (axis + 4) * 4, true);
  }
  magnitudes[i] = input.getFloat32(offset + 12, true);
  colorIndices[i] = input.getFloat32(offset + 28, true);
}

const stars: StarMeta[] = records.map((r, index) => ({
  index,
  id: r[0] as StarMeta['id'],
  hygId: r[1] as number,
  hip: r[2] as number | null,
  raHours: r[3] as number,
  decDeg: r[4] as number,
  magnitude: r[5] as number,
  colorIndex: r[6] as number | null,
  nameEn: (r[7] as string | null) ?? undefined,
  nameZh: (r[8] as string | null) ?? undefined,
  aliases: r[9] as string[],
  pmRaMasYr: r[10] as number,
  pmRaCosDecMasYr: r[10] as number,
  pmDecMasYr: r[11] as number,
  qualityFlags: r[12] as number,
  distancePc: r[13] as number | null,
  radialVelocityKmS: r[14] as number | null,
  spaceVelocityEqjPcYr: r[15] as unknown as StarMeta['spaceVelocityEqjPcYr'],
  variableName: r[16] as string | null,
  variableMagnitudeRange: [r[17] as number | null, r[18] as number | null],
  component: r[19] as number,
  componentPrimaryHygId: r[20] as number,
  constellationId: r[21] as string,
}));

export const catalog: StarCatalog = {
  stars,
  directionsEqj,
  magnitudes,
  colors,
  colorIndices,
  lineIndices: new Uint16Array(figures.lineIndices),
  constellations: figures.constellations.map((figure): ConstellationMeta => {
    const direction = figure.directionEqj;
    if (direction.length !== 3 || !direction.every(Number.isFinite)) throw new Error('星座标签方向无效');
    return { ...figure, directionEqj: [direction[0], direction[1], direction[2]] };
  }),
};

export const starById = new Map(stars.map(star => [star.id, star]));
export const starByHip = new Map(stars.filter(star => star.hip !== null).map(star => [star.hip!, star]));
export const constellationLineWeights = new Float32Array(figures.lineWeights);
