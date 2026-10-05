import type { Mat3, Vec3 } from '../contracts';
export { applyMatrix as multiplyVector, multiplyMatrices as multiplyMatrix, transposeMatrix as transpose } from '../core/math';

/** A single right-handed adapter: astronomical (X,Y,Z) -> Three (X,Z,-Y). */
export const EQJ_TO_THREE: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
/** Astronomy's horizontal output is E,N,U; the camera world is E,U,-N. */
export function horizontalFrame(m: Mat3): Mat3 {
  return [m[0], m[2], [-m[1][0], -m[1][1], -m[1][2]]];
}
/** Geographic equirectangular image: Greenwich u=.5, east right, north at v=1. */
export function geographicToThree(latitudeDeg: number, longitudeDeg: number): [number, number, number] {
  const lat = latitudeDeg * Math.PI / 180, lon = longitudeDeg * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
}
export function geographicUV(latitudeDeg: number, longitudeDeg: number): [number, number] {
  return [(longitudeDeg + 180) / 360, (latitudeDeg + 90) / 180];
}
export function cappedPixelRatio(width: number, height: number, deviceRatio: number, mobile: boolean): number {
  return Math.min(deviceRatio, mobile ? 1.25 : 1.5, Math.sqrt((mobile ? 1_500_000 : 3_000_000) / Math.max(1, width * height)));
}
/** Orthogonal ray/sphere occlusion for infinite direction labels. */
export function rayHitsSphere(origin: Vec3, direction: Vec3, radius: number, maxDistance = Infinity): boolean {
  const b = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2];
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - radius ** 2;
  const discriminant = b * b - c;
  if (b >= 0 || discriminant < 0) return false;
  const hitDistance = -b - Math.sqrt(discriminant);
  return hitDistance >= 0 && hitDistance < maxDistance;
}

/** Perspective front surface: normal dot the direction from this shell point to the camera. */
export function sphereFacing(direction: Vec3, cameraPosition: Vec3, radius = 1): number {
  const length = Math.hypot(...direction);
  const normal = direction.map(value => value / length) as unknown as Vec3;
  const eye = cameraPosition.map((value, axis) => value - normal[axis]! * radius) as unknown as Vec3;
  const eyeLength = Math.hypot(...eye);
  return (normal[0] * eye[0] + normal[1] * eye[1] + normal[2] * eye[2]) / eyeLength;
}
