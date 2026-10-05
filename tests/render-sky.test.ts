import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { intersectDirectionSphere,milkyWayUv,wrapLongitudeDerivative } from '../src/render/MilkyWay';
import { EQJ_TO_THREE,multiplyVector,transpose } from '../src/render/coordinates';
import { normalize } from '../src/core/math';
import type { Vec3 } from '../src/contracts';
const close=(a:readonly number[],b:readonly number[],tol=1e-10)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i]!)<tol,`${a} != ${b}`));
test('NASA celestial sampler orientation follows RA left, Dec north and all fixed calibrations',()=>{
  close(milkyWayUv([1,0,0]),[.5,.5]);close(milkyWayUv([0,1,0]),[.25,.5]);close(milkyWayUv([-1,0,0]),[0,.5]);close(milkyWayUv([0,-1,0]),[.75,.5]);
  close(milkyWayUv([0,0,1]),[.5,1]);close(milkyWayUv([0,0,-1]),[.5,0]);
  const metadata=JSON.parse(readFileSync('assets/runtime/milky-way-meta.json','utf8'));
  for(const sample of metadata.directionAnchors)close(milkyWayUv(sample.directionEqj),sample.threeFlipYSamplerUv);
});
test('finite shell uses true near and far intersections and rejects background outside its silhouette',()=>{
  const center=intersectDirectionSphere([0,0,3.1],[0,0,-1])!;close(center.near,[0,0,1]);close(center.far,[0,0,-1]);assert.ok(Math.abs(center.tNear-2.1)<1e-12);assert.ok(Math.abs(center.tFar-4.1)<1e-12);
  assert.equal(intersectDirectionSphere([0,0,3.1],[0,0,1]),null);assert.equal(intersectDirectionSphere([0,0,3.1],[1,0,0]),null);
  const ray:Vec3=[.2,.1,-1],hit=intersectDirectionSphere([0,0,3.1],ray)!,unit=normalize(ray);
  assert.ok(hit.tNear>0&&hit.tFar>hit.tNear);
  for(const [direction,t] of [[hit.near,hit.tNear],[hit.far,hit.tFar]] as [Vec3,number][]){close(direction,[unit[0]*t,unit[1]*t,3.1+unit[2]*t]);assert.ok(Math.abs(Math.hypot(...direction)-1)<1e-12);}
});
test('atlas directions invert the one shared astronomical frame without another Earth rotation',()=>{
  const eqj:Vec3=normalize([.3,-.7,.2]),world=multiplyVector(EQJ_TO_THREE,eqj);
  close(milkyWayUv(multiplyVector(transpose(EQJ_TO_THREE),world)),milkyWayUv(eqj));
});
test('longitude seam derivatives preserve the narrow mip footprint instead of a whole-map jump',()=>{
  close([wrapLongitudeDerivative(.998),wrapLongitudeDerivative(-.997)],[ -.002,.003]);
  assert.ok(Math.abs(wrapLongitudeDerivative(.002)-.002)<1e-12);
  const above=milkyWayUv([-1,1e-4,0]),below=milkyWayUv([-1,-1e-4,0]);assert.ok(Math.abs(wrapLongitudeDerivative(above[0]-below[0]))<.00004);
});
