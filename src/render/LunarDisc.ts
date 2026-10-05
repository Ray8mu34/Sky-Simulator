import type { Mat3, MoonAppearance, Vec3 } from '../contracts';
import { applyMatrix, cross, dot, multiplyMatrices, normalize, transposeMatrix } from '../core/math';
import { EQJ_TO_THREE } from './coordinates';

/** Columns are screen-right, screen-up, and Moon-to-observer; determinant +1. */
export function observationBasis(observer: Vec3, preferredUp: Vec3): Mat3 {
  const eye=normalize(observer), project=(up:Vec3):Vec3=>up.map((v,i)=>v-dot(up,eye)*eye[i]!) as unknown as Vec3;
  let up=project(preferredUp);
  if(Math.hypot(...up)<1e-10) up=project(Math.abs(eye[2])<.9?[0,0,1]:[0,1,0]);
  const right=normalize(cross(up,eye)); up=cross(eye,right);
  return transposeMatrix([right,up,eye]);
}

/** Maps a physical observed lunar disc into a drawing location without changing the observer. */
export function lunarDiscTransform(appearance:MoonAppearance, frame:Mat3, cameraUpDisplay:Vec3, displayObserver:Vec3) {
  const physical=observationBasis(appearance.observerDirectionEqjUnit,applyMatrix(transposeMatrix(frame),cameraUpDisplay));
  const display=observationBasis(displayObserver,cameraUpDisplay);
  const scienceToDisplayBasis=multiplyMatrices(display,transposeMatrix(physical));
  return {scienceToDisplayBasis,physicalBasis:physical,displayBasis:display,
    discToBodyFixed:multiplyMatrices(transposeMatrix(appearance.bodyFixedToEqj),physical),
    bodyToDisplay:multiplyMatrices(multiplyMatrices(scienceToDisplayBasis,appearance.bodyFixedToEqj),transposeMatrix(EQJ_TO_THREE)),
    sunDirectionDisplay:applyMatrix(scienceToDisplayBasis,appearance.sunDirectionEqjUnit)};
}

export function brightLimbScreenUnit(sun:Vec3,right:Vec3,up:Vec3,observer?:Vec3):[number,number]|null {
  const tangent=observer?sun.map((v,i)=>v-dot(sun,observer)*observer[i]!) as unknown as Vec3:sun;
  const x=dot(tangent,right),y=dot(tangent,up),length=Math.hypot(x,y);
  return length<1e-10?null:[x/length,y/length];
}

/** CSS screen tangent under the actual perspective projection; screen y points up. */
export function perspectiveTangentScreenUnit(centerCamera:Vec3,tangentCamera:Vec3):[number,number]|null {
  if(centerCamera[2]>=-1e-10||Math.hypot(...tangentCamera)<1e-10)return null;
  // x_ndc=-fx*x/z. CSS width/aspect equals CSS height, so the two positive scale factors cancel.
  const x=-(tangentCamera[0]*centerCamera[2]-centerCamera[0]*tangentCamera[2]);
  const y=-(tangentCamera[1]*centerCamera[2]-centerCamera[1]*tangentCamera[2]);
  const length=Math.hypot(x,y);return length<1e-10?null:[x/length,y/length];
}

/** CSS diameter of the unscaled lunar disc at its actual drawing position. */
export function unmagnifiedDiscDiameter(radius:number,eyeDistance:number,verticalFovDeg:number,viewportHeight:number):number {
  return viewportHeight*radius/(eyeDistance*Math.tan(verticalFovDeg*Math.PI/360));
}
