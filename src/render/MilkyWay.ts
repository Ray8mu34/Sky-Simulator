import type { Vec3 } from '../contracts';
import { dot, mod, normalize } from '../core/math';

/** NASA celestial map: RA0 at centre, RA increases left, image north up and Texture.flipY=true. */
export function milkyWayUv(directionEqj:Vec3):[number,number] {
  const [x,y,z]=normalize(directionEqj);
  return [mod(.5-Math.atan2(y,x)/(2*Math.PI),1),.5+Math.asin(Math.max(-1,Math.min(1,z)))/Math.PI];
}

/** The two actual intersections of a view ray with the finite direction shell. */
export function intersectDirectionSphere(originDisplay:Vec3,rayDisplay:Vec3,radius=1):{near:Vec3;far:Vec3;tNear:number;tFar:number}|null {
  const ray=normalize(rayDisplay),b=dot(originDisplay,ray),c=dot(originDisplay,originDisplay)-radius*radius,discriminant=b*b-c;
  if(discriminant<0)return null;
  const root=Math.sqrt(discriminant),tNear=-b-root,tFar=-b+root;
  if(tNear<0)return null;
  const direction=(t:number):Vec3=>normalize(originDisplay.map((v,i)=>v+t*ray[i]!) as unknown as Vec3);
  return {near:direction(tNear),far:direction(tFar),tNear,tFar};
}

/** Correct texture longitude derivatives across the RA12h wrap; latitude never wraps. */
export function wrapLongitudeDerivative(deltaU:number):number {return deltaU-Math.floor(deltaU+.5);}
