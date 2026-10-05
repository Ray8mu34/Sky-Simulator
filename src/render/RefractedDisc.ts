import type { Mat3,Vec3 } from '../contracts';
import type { RefractionProfile } from '../core/refraction';
import { refractEnuDirection,unrefractEnuDirection } from '../core/refraction';
import { applyMatrix,dot,normalize } from '../core/math';
import { enuToThree,threeToEnu } from './DisplayDirection';

const RAD=Math.PI/180;
export interface RefractedDisc {
  /** Columns: physical right/up/Moon-to-observer, in geometric Three world. */
  physicalBasisDisplay:Mat3;
  geometricCentreDisplay:Vec3;
  observedCentreEnu:Vec3;
  physicalTanRadius:number;
  teachingScale:number;
  profile:RefractionProfile;
}
export function createRefractedDisc(basis:Mat3,centre:Vec3,tanRadius:number,scale:number,profile:RefractionProfile):RefractedDisc {
  if(!(tanRadius>0)||!(scale>=1)||!Number.isFinite(tanRadius+scale))throw new RangeError('观测盘需有限正角径与不小于1的教学倍率。');
  return {physicalBasisDisplay:basis,geometricCentreDisplay:normalize(centre),observedCentreEnu:refractEnuDirection(threeToEnu(centre),profile),physicalTanRadius:tanRadius,teachingScale:scale,profile};
}
export function magnifyApparentDirection(ray:Vec3,disc:RefractedDisc,inverse=false):Vec3 {
  const axis=disc.observedCentreEnu,s=inverse?1/disc.teachingScale:disc.teachingScale,axial=dot(ray,axis);
  return normalize(ray.map((v,i)=>s*v+(1-s)*axis[i]!*axial) as unknown as Vec3);
}
/** The mask itself, not its conservative bounding rectangle or a circular pick proxy. */
export function inverseDiscCoordinates(displayRay:Vec3,disc:RefractedDisc):[number,number]|null {
  const geometric=enuToThree(unrefractEnuDirection(magnifyApparentDirection(threeToEnu(displayRay),disc,true),disc.profile));
  const denominator=dot(geometric,disc.geometricCentreDisplay)*disc.physicalTanRadius;
  if(denominator<=0)return null;
  const b=disc.physicalBasisDisplay;
  return [dot(geometric,[b[0][0],b[1][0],b[2][0]])/denominator,dot(geometric,[b[0][1],b[1][1],b[2][1]])/denominator];
}
export function discDisplayRay(x:number,y:number,disc:RefractedDisc):Vec3 {
  const b=disc.physicalBasisDisplay,k=disc.physicalTanRadius;
  const geometric=normalize(disc.geometricCentreDisplay.map((v,i)=>v+k*(x*b[i]![0]+y*b[i]![1])) as unknown as Vec3);
  return enuToThree(magnifyApparentDirection(refractEnuDirection(threeToEnu(geometric),disc.profile),disc));
}
type Interval=readonly[number,number];
function times(a:Interval,b:Interval):Interval {const v=[a[0]*b[0],a[0]*b[1],a[1]*b[0],a[1]*b[1]];return [Math.min(...v),Math.max(...v)];}
function trigonometricRange(low:number,high:number,cosine=false):Interval {
  if(high-low>=Math.PI*2)return [-1,1];
  const fn=cosine?Math.cos:Math.sin,values=[fn(low),fn(high)],offset=cosine?0:Math.PI/2;
  for(let n=Math.ceil((low-offset)/Math.PI);n<=Math.floor((high-offset)/Math.PI);n++)values.push(fn(offset+n*Math.PI));
  return [Math.min(...values),Math.max(...values)];
}
function linearRange(row:Vec3,box:readonly Interval[]):Interval {
  let low=0,high=0;for(let i=0;i<3;i++){const c=row[i]!,r=box[i]!;low+=c>=0?c*r[0]:c*r[1];high+=c>=0?c*r[1]:c*r[0];}return [low,high];
}
/** Conservative interval enclosure. Denominator crossings use the whole viewport, then the exact mask clips. */
export function refractedDiscBounds(disc:RefractedDisc,worldToCamera:Mat3,aspect:number,tanFov:number,pixelMarginNdc:readonly[number,number]=[0,0]):[number,number,number,number]|null {
  const centre=threeToEnu(disc.geometricCentreDisplay),h=Math.atan2(centre[2],Math.hypot(centre[0],centre[1])),beta=Math.atan(disc.physicalTanRadius);
  const low=disc.profile.apparentAltitudeDeg(Math.max(-90,(h-beta)/RAD))*RAD,high=disc.profile.apparentAltitudeDeg(Math.min(90,(h+beta)/RAD))*RAD;
  const az=Math.atan2(centre[0],centre[1]),span=Math.abs(h)+beta>=Math.PI/2?Math.PI:Math.asin(Math.min(1,Math.sin(beta)/Math.cos(h)));
  const cosH=trigonometricRange(low,high,true),sinH=trigonometricRange(low,high);
  const enuBox=[times(cosH,trigonometricRange(az-span,az+span)),times(cosH,trigonometricRange(az-span,az+span,true)),sinH];
  const axis=disc.observedCentreEnu,s=disc.teachingScale;
  // Compose teaching M, ENU→Three, and the actual camera rotation before interval division.
  const cameraBox=worldToCamera.map(row=>{
    const enuRow:Vec3=[row[0],-row[2],row[1]],axial=dot(enuRow,axis);
    return linearRange(enuRow.map((v,i)=>s*v+(1-s)*axial*axis[i]!) as unknown as Vec3,enuBox);
  });
  const z=cameraBox[2]!;if(z[0]>=0)return null;
  if(z[1]>=-1e-12)return [-1,-1,1,1];
  const denominator:Interval=[-z[1],-z[0]],ratio=(r:Interval,factor:number):Interval=>times(r,[1/(denominator[1]*factor),1/(denominator[0]*factor)]);
  const x=ratio(cameraBox[0]!,aspect*tanFov),y=ratio(cameraBox[1]!,tanFov);
  const bounds:[number,number,number,number]=[Math.max(-1,x[0]-pixelMarginNdc[0]),Math.max(-1,y[0]-pixelMarginNdc[1]),Math.min(1,x[1]+pixelMarginNdc[0]),Math.min(1,y[1]+pixelMarginNdc[1])];
  return bounds[0]>bounds[2]||bounds[1]>bounds[3]?null:bounds;
}
export function projectDiscRay(ray:Vec3,worldToCamera:Mat3,aspect:number,tanFov:number):[number,number]|null {
  const local=applyMatrix(worldToCamera,ray);return local[2]>=0?null:[local[0]/(-local[2]*aspect*tanFov),local[1]/(-local[2]*tanFov)];
}
