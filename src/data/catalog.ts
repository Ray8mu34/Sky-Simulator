import records from '../../assets/runtime/star-meta.json';
import figures from '../../assets/runtime/constellation-meta.json';
import encodedStars from '../../assets/runtime/stars.b64.txt?raw';
import encodedExtendedStars from '../../assets/runtime/extended-stars.b64.txt?raw';
import extendedMeta from '../../assets/runtime/extended-star-meta.json';
import type { ConstellationMeta, StarCatalog, StarMeta } from './types';

// Both catalogs are static inline data, including in the portable build.
function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const text = atob(encoded.trim());
  const result = new Uint8Array(text.length);
  for (let i = 0; i < result.length; i++) result[i] = text.charCodeAt(i);
  return result;
}
const bytes = decodeBase64(encodedStars);
const input = new DataView(bytes.buffer);
export const baseStarCount = records.length;
export const extendedStarCount = extendedMeta.count;
export const extendedStarMagnitudeLimit = extendedMeta.magnitudeLimit;
const count = baseStarCount + extendedStarCount;
if (bytes.length !== baseStarCount * 32) throw new Error('亮星数据长度不完整');
const directionsEqj = new Float32Array(count * 3);
const magnitudes = new Float32Array(count);
const colors = new Float32Array(count * 3);
const colorIndices = new Float32Array(count);
for (let i = 0; i < baseStarCount; i++) {
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

/** Same restrained linear RGB interpolation as scripts/data_build.py. */
const colorKnots: readonly (readonly [number, readonly [number, number, number]])[] = [
  [-0.4, [0.68, 0.77, 1]], [0, [0.82, 0.87, 1]], [0.6, [1, 0.98, 0.91]],
  [1.5, [1, 0.76, 0.57]], [2.2, [1, 0.65, 0.44]],
];
function extendedColor(bv: number | null): readonly number[] {
  if (bv === null) return [1, 1, 1];
  const value = Math.max(-0.4, Math.min(2.2, bv));
  for (let i = 1; i < colorKnots.length; i++) {
    const [left, a] = colorKnots[i - 1]!;
    const [right, b] = colorKnots[i]!;
    if (value <= right) {
      const t = (value - left) / (right - left);
      return a.map((channel, axis) => channel + t * (b[axis]! - channel));
    }
  }
  return colorKnots[colorKnots.length - 1]![1];
}

const extendedBytes = decodeBase64(encodedExtendedStars);
const constellationCodes = decodeBase64(extendedMeta.constellationIndices);
if (extendedMeta.recordBytes !== 40 || extendedBytes.length !== extendedStarCount * 40 || constellationCodes.length !== extendedStarCount) {
  throw new Error('扩展恒星数据长度不完整');
}
const extendedInput = new DataView(extendedBytes.buffer);
const sparseDetails = new Map(extendedMeta.details.map(detail => [detail[0] as number, detail]));
const masToRadians = Math.PI / (180 * 3_600_000);
const kmSToPcYr = 1.022712165045695e-6;
for (let localIndex = 0; localIndex < extendedStarCount; localIndex++) {
  const index = baseStarCount + localIndex, offset = localIndex * 40;
  const hygId = extendedInput.getUint32(offset, true), signedHip = extendedInput.getInt32(offset + 4, true);
  const hip = signedHip === 0 ? null : Math.abs(signedHip);
  const raHours = extendedInput.getFloat32(offset + 8, true), decDeg = extendedInput.getFloat32(offset + 12, true);
  const magnitude = extendedInput.getFloat32(offset + 16, true);
  const readOptional = (byteOffset: number): number | null => {
    const value = extendedInput.getFloat32(offset + byteOffset, true);
    return Number.isFinite(value) ? value : null;
  };
  const colorIndex = readOptional(20), pmRa = extendedInput.getFloat32(offset + 24, true), pmDec = extendedInput.getFloat32(offset + 28, true);
  const distancePc = readOptional(32), radialVelocityKmS = readOptional(36);
  const ra = raHours * Math.PI / 12, dec = decDeg * Math.PI / 180;
  const direction = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const color = extendedColor(colorIndex);
  directionsEqj.set(direction, index * 3);
  colors.set(color, index * 3);
  magnitudes[index] = magnitude;
  colorIndices[index] = colorIndex ?? NaN;
  const detail = sparseDetails.get(localIndex);
  const nameEn = (detail?.[1] as string | null | undefined) ?? undefined;
  const bayerFlamsteed = detail?.[2] as string | null | undefined;
  const east = [-Math.sin(ra), Math.cos(ra), 0], north = [-Math.cos(ra) * Math.sin(dec), -Math.sin(ra) * Math.sin(dec), Math.cos(dec)];
  // Unavailable velocities remain explicit NaN, rather than inventing a zero RV/distance.
  // Propagation uses the scalar values and quality flags, never this diagnostic field.
  const velocity = distancePc === null || radialVelocityKmS === null ? [NaN, NaN, NaN]
    : direction.map((u, axis) => distancePc * masToRadians * (pmRa * east[axis]! + pmDec * north[axis]!) + radialVelocityKmS * kmSToPcYr * u);
  const constellationId = extendedMeta.constellations[constellationCodes[localIndex]!];
  if (constellationId === undefined) throw new Error('扩展恒星星座编号无效');
  stars.push({
    index, id: signedHip > 0 ? `hip:${signedHip}` : `hyg:${hygId}`, hygId, hip,
    raHours, decDeg, magnitude, colorIndex, nameEn,
    aliases: [...new Set([bayerFlamsteed, nameEn].filter((name): name is string => Boolean(name)))],
    pmRaMasYr: pmRa, pmRaCosDecMasYr: pmRa, pmDecMasYr: pmDec,
    qualityFlags: (colorIndex === null ? 1 : 0) | (distancePc === null ? 2 : 0) | (radialVelocityKmS === null ? 4 : 0),
    distancePc, radialVelocityKmS, spaceVelocityEqjPcYr: [velocity[0]!, velocity[1]!, velocity[2]!],
    variableName: (detail?.[3] as string | null | undefined) ?? null,
    variableMagnitudeRange: [(detail?.[4] as number | null | undefined) ?? null, (detail?.[5] as number | null | undefined) ?? null],
    component: (detail?.[6] as number | undefined) ?? 1,
    componentPrimaryHygId: (detail?.[7] as number | undefined) ?? hygId, constellationId,
  });
}

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
export const starByHip = new Map(stars.filter(star => star.id.startsWith('hip:')).map(star => [star.hip!, star]));
export const constellationLineWeights = new Float32Array(figures.lineWeights);
