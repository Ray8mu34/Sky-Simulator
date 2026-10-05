import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, SphereGeometry, Vector3 } from 'three';
import { cappedPixelRatio, EQJ_TO_THREE, geographicToThree, geographicUV, horizontalFrame, multiplyMatrix, multiplyVector, rayHitsSphere, sphereFacing, transpose } from '../src/render/coordinates';
import { cameraFrameForState, changeReferenceLockCamera, finiteCameraDistance, focusDirectionCamera } from '../src/render/CameraActions';
import { createDefaultState } from '../src/state';
import { createRefractionDescriptor } from '../src/core/refraction';
import type { Mat3, ScienceSnapshot, Vec3 } from '../src/contracts';

function close(a: Vec3, b: Vec3, tolerance = 1e-6): void { a.forEach((value, i) => assert.ok(Math.abs(value - b[i]!) < tolerance, `${a} != ${b}`)); }
test('one right-handed EQJ and local horizontal adapters', () => {
  close(multiplyVector(EQJ_TO_THREE, [1, 0, 0]), [1, 0, 0]);
  close(multiplyVector(EQJ_TO_THREE, [0, 1, 0]), [0, 0, -1]);
  close(multiplyVector(EQJ_TO_THREE, [0, 0, 1]), [0, 1, 0]);
  close(multiplyVector(horizontalFrame([[1,0,0],[0,1,0],[0,0,1]]), [0,1,0]), [0,0,-1]);
});
test('actual Three sphere UV matches Greenwich, east longitude and north', () => {
  const geometry = new SphereGeometry(1, 64, 32), uv = geometry.getAttribute('uv'), position = geometry.getAttribute('position');
  for (const [lat, lon] of [[0,0],[0,90],[0,-90],[45,90],[-45,-90]]) {
    const [u,v] = geographicUV(lat!,lon!);
    const index = Array.from({length:uv.count}, (_, i) => i).find(i => Math.abs(uv.getX(i) - u) < 1e-6 && Math.abs(uv.getY(i) - v) < 1e-6)!;
    close([position.getX(index),position.getY(index),position.getZ(index)], geographicToThree(lat!,lon!));
  }
  geometry.dispose();
});
test('texture observer normal transforms to the same scientific zenith', () => {
  const rotation: Mat3 = [[0,-1,0],[1,0,0],[0,0,1]];
  const rendered = multiplyMatrix(multiplyMatrix(EQJ_TO_THREE, rotation), transpose(EQJ_TO_THREE));
  const latitude = 30, longitude = 120;
  const normal = geographicToThree(latitude,longitude);
  const fixed = multiplyVector(transpose(EQJ_TO_THREE), normal);
  close(multiplyVector(rendered, normal), multiplyVector(EQJ_TO_THREE, multiplyVector(rotation,fixed)));
});
test('DPR is capped simultaneously by device, quality, and framebuffer budget', () => {
  assert.equal(cappedPixelRatio(1152,720,3,false),1.5);
  assert.equal(cappedPixelRatio(390,844,3,true),1.25);
  assert.ok(cappedPixelRatio(3840,2160,3,false)**2 *3840*2160<=3_000_000.0001);
});
test('Earth occludes infinite sky and far finite hemisphere but not near shell', () => {
  assert.equal(rayHitsSphere([0,0,3],[0,0,-1],1),true);
  assert.equal(rayHitsSphere([0,0,3],[0,0,1],1),false);
  assert.equal(rayHitsSphere([0,0,3.4],[0,0,-1],.075,2.4),false);
  assert.equal(rayHitsSphere([0,0,3.4],[0,0,-1],.075,4.4),true);
});
const snapshot:ScienceSnapshot={requestId:1,utDaysJ2000:0,ttDaysJ2000:0,gastHours:0,lstHours:0,
  observerRefraction:createRefractionDescriptor(createDefaultState().environment),eclipticOfDateToEqj:[[1,0,0],[0,1,0],[0,0,1]], // Synthetic identity ecliptic for camera-only tests.
  eqjToHorizontalGeometric:[[0,1,0],[0,0,1],[1,0,0]],earthFixedToEqj:[[0,-1,0],[1,0,0],[0,0,1]],localZenithEqjUnit:[1,0,0],bodies:[],warnings:[],accuracyTier:'unvalidated'};
test('perspective shell facing rejects the far intersection despite a positive centre-plane dot',()=>{
  const direction:Vec3=[Math.sqrt(.96),0,.2],camera:Vec3=[0,0,3.1];
  assert.ok(direction[2]>0);assert.ok(sphereFacing(direction,camera)<0);
  assert.ok(sphereFacing([0,0,1],camera)>0);
  const tangent:Vec3=[Math.sqrt(1-1/3.1**2),0,1/3.1];assert.ok(Math.abs(sphereFacing(tangent,camera))<1e-12);
});
test('reference lock changes preserve all physical camera axes and inactive state',()=>{
  const state=createDefaultState();state.viewMode='horizon';state.cameras.horizon.referenceLock='inertial';
  const old=structuredClone(state),oldFrame=cameraFrameForState(state,snapshot),oldQ=new Quaternion().fromArray(state.cameras.horizon.orientationQuaternion);
  state.cameras.horizon.referenceLock='local-horizon';changeReferenceLockCamera(state,snapshot,'inertial');
  const newFrame=cameraFrameForState(state,snapshot),newQ=new Quaternion().fromArray(state.cameras.horizon.orientationQuaternion);
  for(const axis of [[1,0,0],[0,1,0],[0,0,-1]] as Vec3[]){
    close(multiplyVector(transpose(oldFrame),new Vector3(...axis).applyQuaternion(oldQ).toArray()),multiplyVector(transpose(newFrame),new Vector3(...axis).applyQuaternion(newQ).toArray()),1e-12);
  }
  assert.deepEqual(state.time,old.time);assert.deepEqual(state.observer,old.observer);assert.equal(state.selected,old.selected);
  assert.deepEqual(state.cameras.ground,old.cameras.ground);assert.deepEqual(state.cameras.space,old.cameras.space);assert.deepEqual(state.cameras.globe,old.cameras.globe);
  assert.equal(state.cameras.horizon.distanceDisplayUnits,old.cameras.horizon.distanceDisplayUnits);
});
test('ground focus has exact zenith/nadir without a lookAt singularity',()=>{
  for(const sign of [1,-1]){const state=createDefaultState();state.cameras.ground.azimuthDegNorthEast=123;
    focusDirectionCamera(state,snapshot,[sign,0,0]);assert.equal(state.cameras.ground.altitudeDeg,sign*90);assert.equal(state.cameras.ground.azimuthDegNorthEast,123);
    const q=new Quaternion().setFromEuler(new Euler(state.cameras.ground.altitudeDeg*Math.PI/180,-state.cameras.ground.azimuthDegNorthEast*Math.PI/180,0,'YXZ'));
    close(new Vector3(0,0,-1).applyQuaternion(q).toArray(),[0,sign,0],1e-12);
  }
});
test('finite focus chooses the near shell; space focus leaves a visible direction above Earth',()=>{
  const direction:Vec3=[.36,.48,.8];
  for(const mode of ['space','globe','horizon'] as const){const state=createDefaultState();state.viewMode=mode;state.cameras[mode].distanceDisplayUnits=mode==='space'?2.1:3.1;
    const before=structuredClone(state);focusDirectionCamera(state,snapshot,direction);
    const camera=state.cameras[mode],q=new Quaternion().fromArray(camera.orientationQuaternion),world=new Vector3(...multiplyVector(cameraFrameForState(state,snapshot),direction));
    const position=new Vector3(0,0,camera.distanceDisplayUnits).applyQuaternion(q);
    if(mode==='space'){assert.equal(rayHitsSphere(position.toArray(),world.toArray(),1),false);const local=world.clone().applyQuaternion(q.clone().invert());assert.ok(local.y>0&&local.z<0);assert.ok(Math.abs(local.y/local.z)/Math.tan(camera.verticalFovDeg*Math.PI/360)<.9);}
    else {close(position.clone().normalize().toArray(),world.toArray(),1e-12);assert.ok(sphereFacing(world.toArray(),position.toArray())>0);assert.equal(camera.distanceDisplayUnits,before.cameras[mode].distanceDisplayUnits);}
    assert.deepEqual(state.time,before.time);assert.deepEqual(state.observer,before.observer);assert.equal(state.selected,before.selected);
  }
});
test('portrait finite sphere uses the smaller viewport dimension while stored zoom stays unchanged',()=>{
  const base=3.1,aspect=390/844,distance=finiteCameraDistance(base,aspect);
  assert.ok(Math.abs(Math.sqrt(base*base-1)/Math.sqrt(distance*distance-1)-aspect)<1e-12);
  assert.equal(finiteCameraDistance(base,1152/720),base);
});
