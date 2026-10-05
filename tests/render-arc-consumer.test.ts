import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/state';
import {createRefractionDescriptor,deriveRefractionProfile} from '../src/core/refraction';
import {raDecToVector,applyMatrix,normalize} from '../src/core/math';
import {displayDirection} from '../src/render/DisplayDirection';
import {createArcProjector} from '../src/render/ArcProjection';
import {ArcKnotsCache} from '../src/render/ArcKnotsCache';
import {arcAltitudeCrossings} from '../src/render/SphericalArcBuffer';
import type {Mat3,Vec3} from '../src/contracts';
const frame:Mat3=[[1,0,0],[0,0,1],[0,-1,0]],identity:Mat3=[[1,0,0],[0,1,0],[0,0,1]];
test('scratch projection and conservative pre-F behind rejection agree with the full core display mapping',()=>{
  const state=createDefaultState();state.environment.refraction='standard';state.environment.pressureHpa=1200;state.environment.temperatureC=-100;
  const profile=deriveRefractionProfile(createRefractionDescriptor(state.environment)),table=profile.copyTextureData();let maximum=0;
  for(let i=0;i<table.length;i+=2)maximum=Math.max(maximum,table[i]!);
  const projector=createArcProjector(frame,profile,identity,[0,0,0],false,1152,720,.3,maximum);
  for(let i=0;i<24000;i++){
    const dir=raDecToVector(i*.031,89*Math.sin(i*.117)),world=displayDirection(dir,frame,profile),actual=projector(dir);
    if(world[2]>=-1e-8){assert.equal(actual,null);continue;}
    assert.ok(actual,`conservative clipping dropped a front direction ${world}`);
    const expected=[(world[0]/(-world[2]*.3*1.6)+1)*576,(1-world[1]/(-world[2]*.3))*360];
    actual.forEach((value,axis)=>assert.ok(Math.abs(value-expected[axis]!)<=1e-8*Math.max(1,Math.abs(expected[axis]!))));
  }
});
test('epoch-cached knot candidates preserve every canonical crossing, including two-root interior extrema',()=>{
  const directions=new Float32Array(600),indices=new Uint16Array(200);
  for(let i=0;i<200;i++){directions.set(raDecToVector(i*.379,70*Math.sin(i*.431)),i*3);indices[i]=i;}
  const cache=new ArcKnotsCache(indices);cache.updateEpoch(directions);const list=cache.knots;
  for(let n=0;n<200;n++){
    const up=normalize(raDecToVector(n*.079,80*Math.cos(n*.321))),horizon=-.1-n*.007,actual=cache.update(up,horizon);
    assert.equal(actual,list);
    for(let arc=0;arc<100;arc++){
      const a=Array.from(directions.subarray(arc*6,arc*6+3)) as unknown as Vec3,b=Array.from(directions.subarray(arc*6+3,arc*6+6)) as unknown as Vec3;
      const expected=[-1,horizon].flatMap(h=>arcAltitudeCrossings(a,b,up,h));assert.deepEqual(actual[arc]??[],expected);
    }
  }
});
