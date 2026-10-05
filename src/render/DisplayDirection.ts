import type { Mat3,Vec3 } from '../contracts';
import type { RefractionProfile } from '../core/refraction';
import { refractEnuDirection,unrefractEnuDirection } from '../core/refraction';
import { applyMatrix } from '../core/math';

export const threeToEnu=(v:Vec3):Vec3=>[v[0],-v[2],v[1]];
export const enuToThree=(v:Vec3):Vec3=>[v[0],v[2],-v[1]];
export function displayDirection(eqj:Vec3,frame:Mat3,profile:RefractionProfile,localReference=false):Vec3 {
  const geometric=applyMatrix(frame,eqj);
  return localReference||profile.identity?geometric:enuToThree(refractEnuDirection(threeToEnu(geometric),profile));
}
export function geometricDisplayRay(displayRay:Vec3,profile:RefractionProfile):Vec3 {
  return profile.identity?displayRay:enuToThree(unrefractEnuDirection(threeToEnu(displayRay),profile));
}
