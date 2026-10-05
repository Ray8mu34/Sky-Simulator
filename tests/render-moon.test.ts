import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { applyMatrix,cross,dot,normalize,transposeMatrix } from '../src/core/math';
import { computeSnapshot } from '../src/core/astronomy';
import { resolveLunarAppearance } from '../src/core/moon';
import { createDefaultState } from '../src/state';
import type { Mat3,Vec3 } from '../src/contracts';
import { EQJ_TO_THREE } from '../src/render/coordinates';
import { lunarDiscTransform, observationBasis, perspectiveTangentScreenUnit, unmagnifiedDiscDiameter } from '../src/render/LunarDisc';
const close=(a:Vec3,b:Vec3,tol=1e-11)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i]!)<tol,`${a} != ${b}`));
test('observation frames remain orthonormal and right handed, including polar up degeneracy',()=>{
  for(const [eye,up] of [[[1,0,0],[0,0,1]],[[0,0,1],[0,0,1]],[[.3,-.4,.5],[.6,.2,.1]]] as [Vec3,Vec3][]){
    const basis=transposeMatrix(observationBasis(eye,up));
    close(cross(basis[0],basis[1]),basis[2]);close(basis[2],normalize(eye));
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(dot(basis[i]!,basis[j]!)-(i===j?1:0))<1e-12);
  }
});
test('virtual external orbit cannot alter physical observer, phase or displayed lunar hemisphere',()=>{
  const state=createDefaultState();state.time.utDaysJ2000=9585.5;
  const snapshot=computeSnapshot(state,1),appearance=resolveLunarAppearance(snapshot,'globe')!;
  const rotations:Mat3[]=[EQJ_TO_THREE,[[0,1,0],[0,0,1],[1,0,0]]];
  for(const frame of rotations)for(const eye of [[0,0,1],[1,0,0],[.3,-.2,-.6]] as Vec3[])for(const up of [[0,1,0],[.2,.9,.1]] as Vec3[]){
    const t=lunarDiscTransform(appearance,frame,up,eye),R=t.scienceToDisplayBasis;
    close(applyMatrix(R,appearance.observerDirectionEqjUnit),normalize(eye));
    assert.ok(Math.abs(dot(t.sunDirectionDisplay,normalize(eye))-dot(appearance.sunDirectionEqjUnit,appearance.observerDirectionEqjUnit))<1e-12);
    const fixedObserved=applyMatrix(transposeMatrix(appearance.bodyFixedToEqj),appearance.observerDirectionEqjUnit);
    close(applyMatrix(t.discToBodyFixed,[0,0,1]),fixedObserved);
    const threeObserved=applyMatrix(transposeMatrix(t.bodyToDisplay),normalize(eye));
    close(applyMatrix(EQJ_TO_THREE,fixedObserved),threeObserved);
  }
});
test('projected lit-mask area agrees with geometric illuminated fraction, not average Lambert brightness',()=>{
  const size=500;
  for(const phase of [0,30,60,90,120,150,180]){
    const radians=phase*Math.PI/180,sun:Vec3=[Math.sin(radians),0,Math.cos(radians)];let disk=0,lit=0,sum=0;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){const nx=(x+.5)*2/size-1,ny=(y+.5)*2/size-1,z2=1-nx*nx-ny*ny;if(z2<=0)continue;disk++;const mu=nx*sun[0]+Math.sqrt(z2)*sun[2];if(mu>0)lit++;sum+=Math.max(mu,0);}
    const expected=(1+Math.cos(radians))/2;assert.ok(Math.abs(lit/disk-expected)<.001);
    if(phase===90)assert.ok(Math.abs(sum/disk-expected)>.2,'Lambert mean is not lit projected area');
  }
});
test('main angular diameter and lens ratio retain the unscaled field-of-view reference',()=>{
  const angularDiameter=.5,radius=100*Math.tan(angularDiameter*Math.PI/360);
  const diameter=unmagnifiedDiscDiameter(radius,100,65,720);
  assert.ok(Math.abs(diameter-720*Math.tan(.25*Math.PI/180)/Math.tan(32.5*Math.PI/180))<1e-12);
  assert.ok((160/1.28)/diameter>20);
});
test('perspective bright-limb tangent matches independent two-point projection at centre and off axis',()=>{
  for(const aspect of [390/844,1152/720]){
    const width=aspect*720,camera=new PerspectiveCamera(65,aspect,.01,2000);camera.updateMatrixWorld(true);
    for(const center of [[0,0,-100],[0,24,-100],[31,-25,-70]] as Vec3[])for(const tangent of [[1,0,0],[.4,.6,.3],[-.8,.2,-.1]] as Vec3[]){
      const result=perspectiveTangentScreenUnit(center,tangent)!;
      const plus=new Vector3(...center).addScaledVector(new Vector3(...tangent),.0001).project(camera),minus=new Vector3(...center).addScaledVector(new Vector3(...tangent),-.0001).project(camera);
      const dx=(plus.x-minus.x)*width,dy=(plus.y-minus.y)*720,length=Math.hypot(dx,dy);
      assert.ok(Math.hypot(result[0]-dx/length,result[1]-dy/length)<1e-9);
    }
  }
  assert.equal(perspectiveTangentScreenUnit([1,2,-100],[0,0,0]),null);
  assert.equal(perspectiveTangentScreenUnit([1,2,100],[1,0,0]),null);
});
