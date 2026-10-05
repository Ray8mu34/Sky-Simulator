import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler,Matrix3,Matrix4,Quaternion } from 'three';
import { createDefaultState } from '../src/state';
import { createRefractionDescriptor,deriveRefractionProfile } from '../src/core/refraction';
import { horizontalToVector,angularSeparationDeg } from '../src/core/math';
import { enuToThree,displayDirection,geometricDisplayRay } from '../src/render/DisplayDirection';
import { observationBasis } from '../src/render/LunarDisc';
import { createRefractedDisc,discDisplayRay,inverseDiscCoordinates,refractedDiscBounds,projectDiscRay } from '../src/render/RefractedDisc';
import { RefractionGpuBridge } from '../src/render/RefractionGpuBridge';
import type { Mat3 } from '../src/contracts';
const identity:Mat3=[[1,0,0],[0,1,0],[0,0,1]];
function cameraRows(q:Quaternion):Mat3 {const e=new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q.clone().invert())).elements;return [[e[0]!,e[3]!,e[6]!],[e[1]!,e[4]!,e[7]!],[e[2]!,e[5]!,e[8]!]];}
test('the one Three↔ENU adapter maps and inverts without mirroring',()=>{
  const state=createDefaultState();state.environment.refraction='standard';const profile=deriveRefractionProfile(createRefractionDescriptor(state.environment));
  for(const h of [-90,-1,-.25,0,5,89,90])for(const az of [0,77,180,299]){
    const geometric=enuToThree(horizontalToVector(h,az)),display=displayDirection(geometric,identity,profile);
    assert.ok(angularSeparationDeg(geometric,geometricDisplayRay(display,profile))*3600<.1);
    assert.deepEqual(displayDirection(geometric,identity,profile,true),geometric);
  }
});
test('inverse rays recover physical disc coordinates while teaching changes only apparent rays',()=>{
  const state=createDefaultState();state.environment.refraction='standard';const profile=deriveRefractionProfile(createRefractionDescriptor(state.environment));
  for(const h of [-1.2,-.2,0,1,6,75,90])for(const scale of [1,8,35]){
    const centre=enuToThree(horizontalToVector(h,67)),basis=observationBasis(centre.map(v=>-v) as [number,number,number],[0,1,0]);
    const disc=createRefractedDisc(basis,centre,Math.tan(.27*Math.PI/180),scale,profile);
    for(const [x,y] of [[0,0],[.1,.7],[-.8,0],[0,-1],[1,0]]){
      const p=inverseDiscCoordinates(discDisplayRay(x!,y!,disc),disc)!;
      assert.ok(Math.hypot(p[0]-x!,p[1]-y!)<.00006,`${h}/${scale}: ${p}`);
    }
    assert.equal(disc.physicalTanRadius,Math.tan(.27*Math.PI/180));assert.deepEqual(disc.physicalBasisDisplay,basis);
  }
});
test('conservative bounds cover every sampled edge at poles, low altitude, off-axis and perspective crossings',()=>{
  const state=createDefaultState();state.environment.refraction='standard';state.environment.pressureHpa=1200;state.environment.temperatureC=-100;
  const profile=deriveRefractionProfile(createRefractionDescriptor(state.environment));let visible=0;
  for(const h of [-2,-1,0,5,88,90])for(const az of [0,67,180])for(const scale of [1,35])for(const cameraAlt of [0,55,90]){
    const centre=enuToThree(horizontalToVector(h,az)),basis=observationBasis(centre.map(v=>-v) as [number,number,number],[0,1,0]);
    const disc=createRefractedDisc(basis,centre,Math.tan(.27*Math.PI/180),scale,profile),camera=cameraRows(new Quaternion().setFromEuler(new Euler(cameraAlt*Math.PI/180,-az*Math.PI/180,0,'YXZ')));
    const bounds=refractedDiscBounds(disc,camera,.46,Math.tan(50*Math.PI/360));
    for(let n=0;n<360;n++){
      const a=n*Math.PI/180,p=projectDiscRay(discDisplayRay(Math.cos(a),Math.sin(a),disc),camera,.46,Math.tan(50*Math.PI/360));
      if(!p||Math.abs(p[0])>1||Math.abs(p[1])>1)continue;visible++;assert.ok(bounds);
      assert.ok(p[0]>=bounds[0]-1e-10&&p[0]<=bounds[2]+1e-10&&p[1]>=bounds[1]-1e-10&&p[1]<=bounds[3]+1e-10);
    }
  }assert.ok(visible>1000);
});
test('GPU bridge reuses one texture and uploads only distinct active profiles',()=>{
  const state=createDefaultState(),bridge=new RefractionGpuBridge(),texture=bridge.texture;
  const none=deriveRefractionProfile(createRefractionDescriptor(state.environment));bridge.update(none);assert.equal(bridge.getDiagnostics().uploadGeneration,0);
  state.environment.refraction='standard';const p=deriveRefractionProfile(createRefractionDescriptor(state.environment));bridge.update(p);bridge.update(p);
  assert.equal(bridge.getDiagnostics().uploadGeneration,1);bridge.update(none);assert.equal(bridge.uniforms.uRefractionEnabled.value,false);
  state.environment.pressureHpa=900;bridge.update(deriveRefractionProfile(createRefractionDescriptor(state.environment)));
  assert.equal(bridge.texture,texture);assert.equal(bridge.getDiagnostics().uploadGeneration,2);assert.equal((bridge.texture.image.data as Float32Array).byteLength,32768);
  texture.dispose();
});
