import desktop from '../../assets/runtime/milky-way-2k.webp?inline';
import mobile from '../../assets/runtime/milky-way-1k.webp?inline';
import metadata from '../../assets/runtime/milky-way-meta.json';

/** The renderer chooses one texture; never decode or keep both resolutions resident. */
export const desktopUrl: string = desktop;
export const mobileUrl: string = mobile;
export const milkyWay2kUrl = desktopUrl;
export const milkyWay1kUrl = mobileUrl;
export const milkyWayMetadata = metadata;
export const milkyWayCoordinateAnchors = metadata.directionAnchors;
export { metadata };
export const directionSamples = metadata.directionAnchors;

/** Source IMAGE UV, v increases down the image. Texture.flipY=true uses sampler1-v. */
export function eqjToMilkyWayImageUv(direction: readonly [number, number, number]): readonly [number, number] {
  const [x, y, z] = direction;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('银河方向必须是有限非零EQJ向量');
  const unwrapped = .5 - Math.atan2(y, x) / (2 * Math.PI);
  return [((unwrapped % 1) + 1) % 1, .5 - Math.asin(Math.max(-1, Math.min(1, z / length))) / Math.PI];
}
