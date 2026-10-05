import * as Engine from 'astronomy-engine';
import type { EnvironmentState, RefractionDescriptor, ScienceSnapshot, Vec3, ViewMode } from '../contracts';
import { DEG_TO_RAD, RAD_TO_DEG } from './math';
export type { RefractionDescriptor } from '../contracts';

export const REFRACTION_POLICY_VERSION = 'ae-normal-nonnegative-pt-v1';
export const REFRACTION_PROFILE_VERSION = 'paired-f32-4096-inverse5deg-v1';
const nodeCount = 4096, lastIndex = 4095, inverseSplitIndex = 2047;
const forwardIndexPerDegree = lastIndex / 91;

export interface RefractionLayout {
  readonly nodeCount: 4096;
  readonly geometricJoinDeg: -1;
  readonly geometricMaximumDeg: 90;
  readonly apparentJoinDeg: number;
  readonly apparentSplitDeg: number;
  readonly inverseSplitIndex: 2047;
  readonly forwardIndexPerDegree: number;
  readonly inverseLowIndexPerDegree: number;
  readonly inverseHighIndexPerDegree: number;
  /** Scaled, Float32-pinned correction(-1)/89 for the affine continuation. */
  readonly lowSlope: number;
}
export interface RefractionProfile {
  readonly key: string;
  readonly profileVersion: string;
  readonly descriptor: RefractionDescriptor;
  readonly identity: boolean;
  readonly scale: number;
  /** Exact inverse of this forward table at apparent altitude0, for continuous CPU clipping. */
  readonly geometricHorizonDeg: number;
  readonly layout: RefractionLayout;
  apparentAltitudeDeg(geometricAltitudeDeg: number): number;
  geometricAltitudeDeg(apparentAltitudeDeg: number): number;
  /** RG32F correction data. The copy cannot mutate the private CPU table. Identity returns empty. */
  copyTextureData(): Float32Array;
}

function validateDescriptor(d: RefractionDescriptor): void {
  if (!d || d.definitionVersion !== REFRACTION_POLICY_VERSION || d.profileVersion !== REFRACTION_PROFILE_VERSION) throw new RangeError('折射policy/profile版本不匹配，不能解释此快照。');
  if (d.mode !== 'none' && d.mode !== 'standard' || !Number.isFinite(d.pressureHpa) || d.pressureHpa < 0 || d.pressureHpa > 1200 || !Number.isFinite(d.temperatureC) || d.temperatureC < -100 || d.temperatureC > 80) throw new RangeError('折射需有效模式、气压0–1200hPa和温度−100–80℃。');
}
function validateAltitude(h: number): void {
  if (!Number.isFinite(h) || h < -90 || h > 90) throw new RangeError('折射高度须为−90至90度的有限值。');
}
const scaleFor = (d: RefractionDescriptor): number => d.mode === 'none' ? 0 : (d.pressureHpa / 1010) * (283 / (273 + d.temperatureC));
export function createRefractionDescriptor(environment: EnvironmentState): RefractionDescriptor {
  const d = { definitionVersion: REFRACTION_POLICY_VERSION, profileVersion: REFRACTION_PROFILE_VERSION,
    mode: environment.refraction, pressureHpa: environment.pressureHpa, temperatureC: environment.temperatureC };
  validateDescriptor(d); return Object.freeze(d);
}

/** Exact new empirical policy for scientific comparison; actual display uses the common Float32 profile. */
export function refractionPolicyCorrectionDeg(h: number, descriptor: RefractionDescriptor): number {
  validateAltitude(h); validateDescriptor(descriptor);
  const scale = scaleFor(descriptor);
  return scale === 0 || h === -90 || h === 90 ? 0 : Math.max(0, Engine.Refraction('normal', h)) * scale;
}
const profileKey = (d: RefractionDescriptor): string => JSON.stringify([d.definitionVersion, d.profileVersion, d.mode, d.pressureHpa, d.temperatureC]);
const identityLayout: RefractionLayout = Object.freeze({ nodeCount, geometricJoinDeg: -1, geometricMaximumDeg: 90, apparentJoinDeg: -1, apparentSplitDeg: 5,
  inverseSplitIndex, forwardIndexPerDegree, inverseLowIndexPerDegree: inverseSplitIndex / 6, inverseHighIndexPerDegree: (lastIndex - inverseSplitIndex) / 85, lowSlope: 0 });
function identityProfile(descriptor: RefractionDescriptor): RefractionProfile {
  const identity = (h: number): number => { validateAltitude(h); return h; };
  return Object.freeze({ key: profileKey(descriptor), profileVersion: REFRACTION_PROFILE_VERSION, descriptor, identity: true, scale: 0, geometricHorizonDeg: 0,
    layout: identityLayout, apparentAltitudeDeg: identity, geometricAltitudeDeg: identity, copyTextureData: () => new Float32Array(0) });
}
const externalIdentity = identityProfile(Object.freeze({ definitionVersion: REFRACTION_POLICY_VERSION, profileVersion: REFRACTION_PROFILE_VERSION, mode: 'none', pressureHpa: 0, temperatureC: 10 }));
let lastProfile: RefractionProfile | null = null, profileBuilds = 0, cacheHits = 0;
export function refractionCacheDiagnostics() {
  return { entries: lastProfile ? 1 : 0, maxEntries: 1, profileBuilds, cacheHits, key: lastProfile?.key ?? null, privateFloat32Bytes: lastProfile && !lastProfile.identity ? nodeCount * 2 * 4 : 0 };
}

/** One last-key cache; no time/observer history and no LUT in a ScienceSnapshot. */
export function deriveRefractionProfile(input: RefractionDescriptor): RefractionProfile {
  validateDescriptor(input);
  const key = profileKey(input);
  if (lastProfile?.key === key) { cacheHits++; return lastProfile; }
  const descriptor = Object.freeze({ ...input }), scale = scaleFor(descriptor);
  if (scale === 0) { profileBuilds++; return lastProfile = identityProfile(descriptor); }
  const rg = new Float32Array(nodeCount * 2);
  const geometricNode = (i: number): number => i === lastIndex ? 90 : -1 + 91 * i / lastIndex;
  for (let i = 0; i < nodeCount; i++) rg[2 * i] = refractionPolicyCorrectionDeg(geometricNode(i), descriptor);
  const interpolate = (coordinate: number, channel: 0 | 1): number => {
    const q = Math.max(0, Math.min(lastIndex, coordinate)), i = Math.min(lastIndex - 1, Math.floor(q)), fraction = q - i;
    return rg[2 * i + channel]! * (1 - fraction) + rg[2 * (i + 1) + channel]! * fraction;
  };
  const lowSlope = rg[0]! / 89, apparentJoinDeg = -1 + rg[0]!;
  const forward = (h: number): number => {
    validateAltitude(h);
    if (h === -90 || h === 90) return h;
    if (h === -1) return apparentJoinDeg;
    return h + (h <= -1 ? lowSlope * (h + 90) : interpolate((h + 1) * forwardIndexPerDegree, 0));
  };
  const apparentSplitDeg = forward(5), inverseLowIndexPerDegree = inverseSplitIndex / (apparentSplitDeg - apparentJoinDeg), inverseHighIndexPerDegree = (lastIndex - inverseSplitIndex) / (90 - apparentSplitDeg);
  const inverseNode = (i: number): number => i === lastIndex ? 90 : i <= inverseSplitIndex ? apparentJoinDeg + i / inverseLowIndexPerDegree : apparentSplitDeg + (i - inverseSplitIndex) / inverseHighIndexPerDegree;
  const exactForwardInverse = (a: number): number => {
    if (a === -90 || a === 90) return a;
    if (a <= apparentJoinDeg) return (a - 90 * lowSlope) / (1 + lowSlope);
    let low = 0, high = lastIndex;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (geometricNode(middle) + rg[2 * middle]! <= a) low = middle; else high = middle;
    }
    const hLow = geometricNode(low), hHigh = geometricNode(high), aLow = hLow + rg[2 * low]!, aHigh = hHigh + rg[2 * high]!;
    return hLow + (hHigh - hLow) * ((a - aLow) / (aHigh - aLow));
  };
  for (let i = 0; i < nodeCount; i++) { const a = inverseNode(i); rg[2 * i + 1] = i === lastIndex ? 0 : Math.max(0, a - exactForwardInverse(a)); }
  const inverse = (a: number): number => {
    validateAltitude(a);
    if (a === -90 || a === 90) return a;
    if (a === apparentJoinDeg) return -1;
    if (a === apparentSplitDeg) return 5;
    if (a <= apparentJoinDeg) return (a - 90 * lowSlope) / (1 + lowSlope);
    const coordinate = a <= apparentSplitDeg ? (a - apparentJoinDeg) * inverseLowIndexPerDegree : inverseSplitIndex + (a - apparentSplitDeg) * inverseHighIndexPerDegree;
    return a - interpolate(coordinate, 1);
  };
  // Check every table cell, not a sparse altitude sampling verdict.
  for (let i = 1; i < nodeCount; i++) {
    if (!(geometricNode(i) + rg[2 * i]! > geometricNode(i - 1) + rg[2 * (i - 1)]!) || !(inverseNode(i) - rg[2 * i + 1]! > inverseNode(i - 1) - rg[2 * (i - 1) + 1]!)) throw new RangeError('折射表不单调，不能用于可逆显示。');
  }
  const layout: RefractionLayout = Object.freeze({ nodeCount, geometricJoinDeg: -1, geometricMaximumDeg: 90, apparentJoinDeg, apparentSplitDeg, inverseSplitIndex, forwardIndexPerDegree, inverseLowIndexPerDegree, inverseHighIndexPerDegree, lowSlope });
  const profile: RefractionProfile = Object.freeze({ key, profileVersion: REFRACTION_PROFILE_VERSION, descriptor, identity: false, scale, geometricHorizonDeg: exactForwardInverse(0), layout,
    apparentAltitudeDeg: forward, geometricAltitudeDeg: inverse, copyTextureData: () => rg.slice() });
  profileBuilds++; lastProfile = profile; return profile;
}

export function getDisplayRefractionProfile(snapshot: ScienceSnapshot, viewMode: ViewMode): RefractionProfile {
  validateDescriptor(snapshot.observerRefraction);
  if (viewMode === 'ground') return deriveRefractionProfile(snapshot.observerRefraction);
  if (viewMode === 'space' || viewMode === 'globe' || viewMode === 'horizon') return externalIdentity;
  throw new RangeError('折射显示视图无效。');
}
export type RefractionDirectionOutput = number[] | Float64Array;
function mapEnuInto<T extends RefractionDirectionOutput>(direction: ArrayLike<number>, profile: RefractionProfile, inverse: boolean, out: T): T {
  if (direction.length < 3 || out.length < 3) throw new RangeError('折射方向输入和输出缓冲至少须有3个元素。');
  // Read before writing: caller may reuse one scratch buffer for input and output.
  const x = direction[0]!, y = direction[1]!, z = direction[2]!, length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('方向必须是有限非零向量。');
  const east = x / length, north = y / length, up = z / length, horizontal = Math.hypot(east, north);
  let mappedEast = east, mappedNorth = north, mappedUp = up;
  if (!profile.identity && horizontal >= 1e-12) {
    const h = Math.atan2(up, horizontal) * RAD_TO_DEG;
    const mapped = (inverse ? profile.geometricAltitudeDeg(h) : profile.apparentAltitudeDeg(h)) * DEG_TO_RAD, factor = Math.cos(mapped) / horizontal;
    mappedEast *= factor; mappedNorth *= factor; mappedUp = Math.sin(mapped);
  }
  out[0] = mappedEast; out[1] = mappedNorth; out[2] = mappedUp; return out;
}
/** Allocation-free ENU forward mapping; first3 scalar inputs, caller-owned double output and alias-safe. */
export function refractEnuDirectionInto<T extends RefractionDirectionOutput>(direction: ArrayLike<number>, profile: RefractionProfile, out: T): T {
  return mapEnuInto(direction, profile, false, out);
}
export const refractEnuDirection = (direction: Vec3, profile: RefractionProfile): Vec3 => refractEnuDirectionInto<[number, number, number]>(direction, profile, [0, 0, 0]);
export const unrefractEnuDirection = (direction: Vec3, profile: RefractionProfile): Vec3 => mapEnuInto<[number, number, number]>(direction, profile, true, [0, 0, 0]);

/** GLSL ES3.00/WebGL2 only. No #version or main; all angles named Deg are degrees. */
export function getRefractionShaderChunk(): string {
  return `
uniform sampler2D uRefractionLut;
uniform bool uRefractionEnabled;
uniform vec4 uRefractionForward;
uniform vec4 uRefractionInverseLow;
uniform vec4 uRefractionInverseHigh;
float skyRefractionSample(float coordinate, int channel) {
  float q=clamp(coordinate,0.0,4095.0);
  int i=min(4094,int(floor(q)));
  vec2 first=texelFetch(uRefractionLut,ivec2(i,0),0).rg;
  vec2 second=texelFetch(uRefractionLut,ivec2(i+1,0),0).rg;
  return mix(first[channel],second[channel],q-float(i));
}
float skyRefractionForwardCorrectionDeg(float h) {
  if (!uRefractionEnabled || h<=-90.0 || h>=90.0) return 0.0;
  if (h==uRefractionForward.x) return skyRefractionSample(0.0,0);
  if (h<uRefractionForward.x) return uRefractionForward.w*(h+90.0);
  return skyRefractionSample((h-uRefractionForward.x)*uRefractionForward.z,0);
}
float skyRefractionInverseCorrectionDeg(float a) {
  if (!uRefractionEnabled || a<=-90.0 || a>=90.0) return 0.0;
  if (a<=uRefractionInverseLow.x) return uRefractionForward.w*(a+90.0)/(1.0+uRefractionForward.w);
  vec4 grid=a<=uRefractionInverseLow.y?uRefractionInverseLow:uRefractionInverseHigh;
  return skyRefractionSample(grid.z+(a-grid.x)*grid.w,1);
}
float skyRefractionForwardAltitudeDeg(float h) {
  if (!uRefractionEnabled || h<=-90.0 || h>=90.0) return h;
  if (h==uRefractionForward.x) return uRefractionInverseLow.x;
  return h+skyRefractionForwardCorrectionDeg(h);
}
float skyRefractionInverseAltitudeDeg(float a) {
  if (!uRefractionEnabled || a<=-90.0 || a>=90.0) return a;
  if (a==uRefractionInverseLow.x) return uRefractionForward.x;
  if (a==uRefractionInverseLow.y) return 5.0;
  if (a<=uRefractionInverseLow.x) return (a-90.0*uRefractionForward.w)/(1.0+uRefractionForward.w);
  return a-skyRefractionInverseCorrectionDeg(a);
}
vec3 skyRefractionRotateEnu(vec3 unit, float horizontal, float correctionDeg) {
  float delta=correctionDeg*0.017453292519943295;
  float c=cos(delta), s=sin(delta);
  float mappedHorizontal=horizontal*c-unit.z*s;
  float mappedUp=unit.z*c+horizontal*s;
  return vec3(unit.xy*(mappedHorizontal/horizontal),mappedUp);
}
vec3 skyRefractEnu(vec3 direction) {
  vec3 unit=normalize(direction); float horizontal=length(unit.xy);
  if (!uRefractionEnabled || horizontal<1.0e-12) return unit;
  float h=atan(unit.z,horizontal)*57.29577951308232;
  return skyRefractionRotateEnu(unit,horizontal,skyRefractionForwardCorrectionDeg(h));
}
vec3 skyUnrefractEnu(vec3 direction) {
  vec3 unit=normalize(direction); float horizontal=length(unit.xy);
  if (!uRefractionEnabled || horizontal<1.0e-12) return unit;
  float a=atan(unit.z,horizontal)*57.29577951308232;
  return skyRefractionRotateEnu(unit,horizontal,-skyRefractionInverseCorrectionDeg(a));
}
`;
}
