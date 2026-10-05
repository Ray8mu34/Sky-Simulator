import type { Mat3, Vec3 } from '../contracts';

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

export function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('方向必须是有限非零向量。');
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** Mat3 stores mathematical rows; vectors are columns: result = matrix × vector. */
export function applyMatrix(matrix: Mat3, vector: Vec3): Vec3 {
  return [dot(matrix[0], vector), dot(matrix[1], vector), dot(matrix[2], vector)];
}

export function transposeMatrix(matrix: Mat3): Mat3 {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]],
  ];
}

export function multiplyMatrices(a: Mat3, b: Mat3): Mat3 {
  const columns = transposeMatrix(b);
  return a.map(row => columns.map(column => dot(row, column))) as unknown as Mat3;
}

/** Right-handed EQJ: X=RA 0h, Y=RA 6h, Z=north celestial pole. */
export function raDecToVector(raHours: number, decDeg: number): Vec3 {
  if (!Number.isFinite(raHours) || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90) {
    throw new RangeError('赤经必须有限，赤纬必须在 ±90° 内。');
  }
  const ra = raHours * 15 * DEG_TO_RAD;
  const dec = decDeg * DEG_TO_RAD;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

/** Right-handed local components E,N,U (E × N = U); it is not an EQJ vector. */
export function vectorToHorizontal(vector: Vec3): { altitudeDeg: number; azimuthDeg: number | null } {
  const [east, north, up] = normalize(vector);
  const horizontalLength = Math.hypot(east, north);
  return {
    altitudeDeg: Math.atan2(up, horizontalLength) * RAD_TO_DEG,
    azimuthDeg: horizontalLength < 1e-12 ? null : mod(Math.atan2(east, north) * RAD_TO_DEG, 360),
  };
}

export function horizontalToVector(altitudeDeg: number, azimuthDeg: number): Vec3 {
  const alt = altitudeDeg * DEG_TO_RAD;
  const az = azimuthDeg * DEG_TO_RAD;
  return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
}

export function angularSeparationDeg(a: Vec3, b: Vec3): number {
  const ua = normalize(a), ub = normalize(b);
  return Math.atan2(Math.hypot(...cross(ua, ub)), dot(ua, ub)) * RAD_TO_DEG;
}
