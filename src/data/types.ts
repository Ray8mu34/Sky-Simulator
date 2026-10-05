/** Scientific EQJ: X=RA 0h, Y=RA 6h, Z=north pole; all directions are unit vectors. */
export type EqjDirection = readonly [number, number, number];
/** EQJ Cartesian velocity in pc per Julian year; never a unit direction. */
export type EqjVelocityPcYr = readonly [number, number, number];

export interface StarMeta {
  index: number;
  id: `hip:${number}` | `hyg:${number}`;
  hygId: number;
  hip: number | null;
  raHours: number;
  decDeg: number;
  magnitude: number;
  colorIndex: number | null;
  nameZh?: string;
  nameEn?: string;
  aliases: string[];
  /** HYG pmra = mu_alpha*cos(dec), in milliarcseconds per Julian year. */
  pmRaMasYr: number;
  pmRaCosDecMasYr: number;
  pmDecMasYr: number;
  /** bit 0: missing B-V; bit 1: unavailable distance; bit 2: missing radial velocity. */
  qualityFlags: number;
  distancePc: number | null;
  radialVelocityKmS: number | null;
  spaceVelocityEqjPcYr: EqjVelocityPcYr;
  variableName: string | null;
  variableMagnitudeRange: readonly [number | null, number | null];
  component: number;
  componentPrimaryHygId: number;
  constellationId: string;
}

export interface ConstellationMeta {
  id: string;
  nameZh: string;
  nameEn: string;
  /** Normalized mean of unique line endpoints; label anchor, not an IAU boundary centre. */
  directionEqj: EqjDirection;
  /** Offset/count in LINE SEGMENTS, each represented by two adjacent lineIndices. */
  lineStart: number;
  lineCount: number;
}

export interface StarCatalog {
  stars: readonly StarMeta[];
  directionsEqj: Float32Array;
  magnitudes: Float32Array;
  /** Linear sRGB colour, restrained mapping of B-V; missing B-V is neutral white. */
  colors: Float32Array;
  colorIndices: Float32Array;
  lineIndices: Uint16Array;
  constellations: readonly ConstellationMeta[];
}
