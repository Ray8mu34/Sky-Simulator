import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion,Vector3 } from 'three';
import { createPointerGesture,gestureActiveContacts,MAX_GESTURE_CONTACTS,reducePointerGesture } from '../src/render/PointerGestures';
import type { PointerGestureInput,PointerGestureState } from '../src/render/PointerGestures';
import { applyCameraPan,applyCameraZoom } from '../src/render/CameraGestureActions';
import { createDefaultState,validateState } from '../src/state';
const input=(type:'down'|'move'|'up'|'cancel'|'lost-capture',id:number,x=100,y=100):PointerGestureInput=>({type,id,x,y});
function driver(){let state=createPointerGesture();return {get state(){return state;},send(event:PointerGestureInput){const result=reducePointerGesture(state,event);state=result.state;return result;}};}
test('tap jitter does not rotate; threshold crossing starts from the original baseline and suppresses picking',()=>{
  const d=driver();d.send(input('down',1));assert.equal(d.send(input('move',1,102,101)).action,null);
  assert.deepEqual(d.send(input('up',1,102,101)).action,{type:'tap',x:102,y:101});
  d.send(input('down',2));d.send(input('move',2,102,101));assert.deepEqual(d.send(input('move',2,106,102)).action,{type:'pan',dx:6,dy:2});
  assert.deepEqual(d.send(input('move',2,109,104)).action,{type:'pan',dx:3,dy:2});assert.equal(d.send(input('up',2,109,104)).action,null);
});
test('pinch keeps both contacts, scales inversely with distance and rebases the remaining finger without a jump',()=>{
  const d=driver();d.send(input('down',1,100,100));d.send(input('down',2,200,100));assert.deepEqual(gestureActiveContacts(d.state).map(p=>p.id),[1,2]);
  assert.deepEqual(d.send(input('move',2,250,100)).action,{type:'zoom',scale:2/3});
  assert.equal(d.send(input('up',2,250,100)).action,null);assert.deepEqual(d.send(input('move',1,105,102)).action,{type:'pan',dx:5,dy:2});
  assert.equal(d.send(input('up',1,105,102)).action,null);d.send(input('down',3));assert.equal(d.send(input('up',3)).action?.type,'tap');
});
test('ignored third contacts never move the camera or become a tap and all contact storage stays bounded',()=>{
  const d=driver();d.send(input('down',1));d.send(input('down',2,200));d.send(input('down',3,300));
  assert.equal(d.state.pointers.get(3)!.active,false);assert.equal(d.send(input('move',3,900,800)).action,null);
  assert.equal(d.send(input('move',2,250)).action?.type,'zoom');d.send(input('up',1));d.send(input('up',2));assert.equal(d.send(input('up',3)).action,null);
  for(let id=1;id<=MAX_GESTURE_CONTACTS+5;id++)d.send(input('down',id,id*10));
  assert.equal(d.state.pointers.size,MAX_GESTURE_CONTACTS);assert.equal(gestureActiveContacts(d.state).length,2);
  for(let id=1;id<=MAX_GESTURE_CONTACTS+5;id++)assert.equal(d.send(input('up',id,id*10)).action,null);
  assert.equal(d.state.pointers.size,0);
});
test('cancel, unexpected lost capture and reset release every pointer while expected late events leave a rebase intact',()=>{
  for(const event of [input('cancel',2),input('lost-capture',2),{type:'reset'} as PointerGestureInput]){
    const d=driver();for(let id=1;id<=3;id++)d.send(input('down',id,id*100));const result=d.send(event);
    assert.deepEqual(result.releaseIds,[1,2,3]);assert.equal(d.state.pointers.size,0);assert.equal(d.send(input('up',1)).action,null);
  }
  const d=driver();d.send(input('down',1));d.send(input('down',2,200));d.send(input('up',2,200));
  const previous:PointerGestureState=d.state;assert.equal(d.send(input('lost-capture',2)).state,previous);assert.equal(d.send(input('move',1,110)).action?.type,'pan');
});
test('coincident pinch establishes a finite baseline before emitting zoom',()=>{
  const d=driver();d.send(input('down',1));d.send(input('down',2));assert.equal(d.send(input('move',2,120)).action,null);
  assert.deepEqual(d.send(input('move',2,130)).action,{type:'zoom',scale:2/3});
});
test('camera adapters preserve time, observer, selection and inactive cameras; orbit agrees with independent Three axis rotations',()=>{
  for(const mode of ['ground','space','globe','horizon'] as const){
    const state=createDefaultState();state.viewMode=mode;state.selected='hip:11767';const before=structuredClone(state);
    const expected=mode==='ground'?null:new Quaternion().fromArray(state.cameras[mode].orientationQuaternion)
      .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),-21*.004)).multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),13*.004)).normalize();
    applyCameraPan(state,21,-13,720);applyCameraZoom(state,.75);validateState(state);
    assert.deepEqual(state.time,before.time);assert.deepEqual(state.observer,before.observer);assert.equal(state.selected,before.selected);
    for(const other of ['ground','space','globe','horizon'] as const)if(other!==mode)assert.deepEqual(state.cameras[other],before.cameras[other]);
    if(expected&&mode!=='ground')assert.ok(Math.hypot(...state.cameras[mode].orientationQuaternion.map((v,i)=>v-expected.toArray()[i]!))<1e-12);
    applyCameraZoom(state,.000001);applyCameraZoom(state,1000000);validateState(state);
  }
});
test('horizontal pans preserve exact imported zenith and nadir and obey the full legal altitude range',()=>{
  for(const altitude of [-90,90]){const state=createDefaultState();state.cameras.ground.altitudeDeg=altitude;applyCameraPan(state,15,0,720);assert.equal(state.cameras.ground.altitudeDeg,altitude);
    applyCameraPan(state,0,altitude*100,720);assert.equal(state.cameras.ground.altitudeDeg,altitude);validateState(state);}
});
