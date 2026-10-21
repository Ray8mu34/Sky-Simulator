import test from 'node:test';
import assert from 'node:assert/strict';
import {altitudeCurve,motionTrack} from '../src/core/observation-tools';
import {searchEclipse,eclipseDiscs} from '../src/core/eclipse-tools';
import {scienceState} from './fixtures/science-state';
import {dateToUt,utToDate} from '../src/core/time';
import {parseState,serializeState} from '../src/state';
import type {StarCatalog} from '../src/data/types';
import {chineseFigures} from '../src/data/chinese-sky';
import {searchObjects} from '../src/data/search';
import boundaries from '../assets/runtime/iau-boundaries.json';
const catalog:StarCatalog={stars:[],directionsEqj:new Float32Array(),magnitudes:new Float32Array(),colors:new Float32Array(),colorIndices:new Float32Array(),lineIndices:new Uint16Array(),constellations:[]};
test('2024 April 8 global total eclipse and 2025 March 14 lunar total eclipse',()=>{
  const state=scienceState('2024-04-01T00:00:00Z');
  const e=searchEclipse(state,'solar',false);assert.ok(e.kind.includes('全食'));assert.equal(utToDate(e.peak).toISOString().slice(0,10),'2024-04-08');
  assert.ok(e.latitude!==undefined&&e.longitude!==undefined);
  state.observer.latitudeDeg=e.latitude!;state.observer.longitudeDegEast=e.longitude!;state.time.utDaysJ2000=e.peak;
  const discs=eclipseDiscs(state,'solar');assert.ok(Math.hypot(discs.x,discs.y)<.03);assert.ok(discs.occulterRadius>discs.targetRadius);
  state.time.utDaysJ2000=dateToUt(new Date('2025-03-01T00:00:00Z'));
  const lunar=searchEclipse(state,'lunar');assert.ok(lunar.kind.includes('全食'));assert.equal(utToDate(lunar.peak).toISOString().slice(0,10),'2025-03-14');assert.equal(lunar.contacts.length,7);
  state.time.utDaysJ2000=lunar.peak;const shadow=eclipseDiscs(state,'lunar');assert.ok(Math.hypot(shadow.x,shadow.y)+shadow.targetRadius<shadow.occulterRadius);
});
test('height curves preserve DST day length, have finite values and no scene mutation',()=>{
  const state=scienceState('2026-03-08T12:00:00Z');state.selected='body:Jupiter';state.observer.displayZone={kind:'iana',name:'America/New_York',versionNote:'host'};
  const before=structuredClone(state),curve=altitudeCurve(catalog,state);assert.equal(curve.length,97);assert.ok(Math.abs((curve.at(-1)!.ut-curve[0]!.ut)*24-23)<1e-8);
  assert.ok(curve.every(p=>Number.isFinite(p.altitude)&&Math.abs(p.altitude)<=90));assert.deepEqual(state,before);
  const track=motionTrack(catalog,state);assert.equal(track.length,121);assert.ok(track.every(v=>Math.abs(Math.hypot(...v)-1)<1e-12));
});
test('all new optional layers round-trip while old schema stays valid',()=>{
  const state=scienceState();Object.assign(state.layers,{motionTrack:true,chineseSky:true,constellationBoundaries:true,equatorialGrid:true,horizontalGrid:true,eclipticGrid:true});assert.deepEqual(parseState(serializeState(state)),state);
});
test('Chinese asterisms and IAU boundaries retain finite source coordinates and searchable Chinese names',()=>{
  assert.equal(chineseFigures.length,312);assert.equal(boundaries.length,782);
  assert.ok(chineseFigures.every(f=>Math.abs(Math.hypot(...f.directionEqj)-1)<1e-12));
  assert.ok(searchObjects(catalog,'北斗').some(r=>r.id.startsWith('chinese:')));
  assert.ok(searchObjects(catalog,'紫微').some(r=>r.id.startsWith('chinese:')));
  const regions=new Set(boundaries.flatMap(arc=>arc.regions).map(r=>r.startsWith('SER')?'SER':r));assert.equal(regions.size,88);
  assert.ok(boundaries.every(arc=>arc.points.every(p=>Number.isFinite(p[0])&&p[0]!>=0&&p[0]!<=24&&Math.abs(p[1]!)<=90)));
});
