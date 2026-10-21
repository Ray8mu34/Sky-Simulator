import * as Engine from 'astronomy-engine';
import type {ObjectId, SimulationState, SolarBody, Vec3} from '../contracts';
import type {StarCatalog} from '../data/types';
import {resolveCatalogStar} from '../data/search';
import {resolveDeepSky} from '../data/deep-sky';
import {propagateStarDirection} from './stars';
import {makeObserver} from './observer';
import {computeObserverFrame} from './observer-frame';
import {applyMatrix,normalize,vectorToHorizontal} from './math';
import {localDayBounds,utToDate} from './time';

export function objectDirectionAt(catalog:StarCatalog,id:ObjectId,ut:number,state:SimulationState,geocentric=false):Vec3|null {
  if(id.startsWith('body:')){
    const body=Engine.Body[id.slice(5) as SolarBody];
    const vector=geocentric?Engine.GeoVector(body,ut,true):Engine.Equator(body,ut,makeObserver(state.observer),false,true).vec;
    return normalize([vector.x,vector.y,vector.z]);
  }
  const star=resolveCatalogStar(catalog,id);
  return star?propagateStarDirection(star,ut):resolveDeepSky(id)?.directionEqj??null;
}
export interface AltitudeSample {ut:number; altitude:number; sunAltitude:number}
export function altitudeCurve(catalog:StarCatalog,state:SimulationState):AltitudeSample[]{
  if(!state.selected)return [];
  const {startUt,endUt}=localDayBounds(state.time.utDaysJ2000,state.observer.displayZone),samples:AltitudeSample[]=[];
  for(let i=0;i<=96;i++){
    const ut=startUt+(endUt-startUt)*i/96;
    if(utToDate(ut).getUTCFullYear() < -2000 || utToDate(ut).getUTCFullYear()>4000)continue;
    const direction=objectDirectionAt(catalog,state.selected,ut,state);if(!direction)return [];
    const frame=computeObserverFrame(ut,state.observer);
    samples.push({ut,altitude:vectorToHorizontal(applyMatrix(frame.eqjToHorizontalGeometric,direction)).altitudeDeg,
      sunAltitude:vectorToHorizontal(applyMatrix(frame.eqjToHorizontalGeometric,objectDirectionAt(catalog,'body:Sun',ut,state)!)).altitudeDeg});
  }
  return samples;
}
export function motionTrack(catalog:StarCatalog,state:SimulationState):Vec3[]{
  if(!state.selected)return [];
  const span=state.selected==='body:Moon'?7:state.selected.startsWith('body:')?180:30;
  const points:Vec3[]=[];
  for(let i=0;i<=120;i++){
    const ut=state.time.utDaysJ2000+span*(i/120-.5),year=utToDate(ut).getUTCFullYear();
    if(year< -2000||year>4000)continue;
    const p=objectDirectionAt(catalog,state.selected,ut,state,true);if(p)points.push(p);
  }
  return points;
}
