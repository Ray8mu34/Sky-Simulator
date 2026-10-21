import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepSkyObjects, resolveDeepSky } from '../src/data/deep-sky';
import { searchObjects } from '../src/data/search';
import { computeSnapshot } from '../src/core/astronomy';
import { computeObjectDayEvents } from '../src/core/object-day-events';
import { resolveObjectDetails } from '../src/core/object-details';
import { createDefaultState, parseState, serializeState } from '../src/state';
import { scienceState } from './fixtures/science-state';
import type { StarCatalog } from '../src/data/types';
const catalog:StarCatalog={stars:[],directionsEqj:new Float32Array(),magnitudes:new Float32Array(),colors:new Float32Array(),colorIndices:new Float32Array(),lineIndices:new Uint16Array(),constellations:[]};
test('Messier coverage, source units, special identifications and aliases',()=>{
  assert.deepEqual(deepSkyObjects.map(o=>o.number),Array.from({length:110},(_,i)=>i+1));
  for(const object of deepSkyObjects){assert.ok(object.raHours>=0&&object.raHours<24);assert.ok(Math.abs(object.decDeg)<=90);assert.ok(Math.abs(Math.hypot(...object.directionEqj)-1)<1e-12);}
  assert.ok(Math.abs(resolveDeepSky('messier:31')!.raHours-0.7123)<.001);
  assert.ok(resolveDeepSky('messier:102')!.note.includes('争议'));
  assert.equal(resolveDeepSky('messier:40')!.type,'**');
  assert.equal(resolveDeepSky('messier:73')!.type,'Other');
  for(const query of ['M31','M 31','Ｍ３１','Messier31','NGC 224','仙女座星系'])assert.equal(searchObjects(catalog,query)[0]?.id,'messier:31');
  assert.equal(searchObjects(catalog,'昴星团')[0]?.id,'messier:45');
  assert.equal(resolveDeepSky('messier:111'),null);
});
test('new objects survive scene export/import; legacy scenes keep their contract',()=>{
  const state=createDefaultState(); state.selected='messier:110';state.layers.planets=false;
  assert.deepEqual(parseState(serializeState(state)),state);
  delete state.layers.planets;delete state.layers.deepSky;
  assert.deepEqual(parseState(serializeState(state)),state);
  assert.throws(()=>parseState({...state,selected:'messier:111'}));
});
test('planet events cross the declared standard horizon and vary by body',()=>{
  const state=scienceState(), times:number[]=[];
  for(const name of ['Mercury','Venus','Mars','Jupiter','Saturn'] as const){
    const id=`body:${name}` as const, result=computeObjectDayEvents(state,{kind:'body',id});
    assert.equal(result.state,'events');assert.equal(result.crossings.length,2);
    times.push(result.crossings[0]!.utDaysJ2000);
    for(const crossing of result.crossings){
      const before={...state,time:{...state.time,utDaysJ2000:crossing.utDaysJ2000-30/86400}};
      const after={...state,time:{...state.time,utDaysJ2000:crossing.utDaysJ2000+30/86400}};
      const a=resolveObjectDetails(catalog,id,computeSnapshot(before,1))!,b=resolveObjectDetails(catalog,id,computeSnapshot(after,2))!;
      assert.ok(crossing.kind==='rise'?b.geometricAltitudeDeg>a.geometricAltitudeDeg:b.geometricAltitudeDeg<a.geometricAltitudeDeg);
      assert.ok(Math.abs((a.geometricAltitudeDeg+b.geometricAltitudeDeg)/2+34/60)<.03);
    }
  }
  assert.equal(new Set(times).size,5);
});
