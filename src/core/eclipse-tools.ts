import * as Engine from 'astronomy-engine';
import type {SimulationState} from '../contracts';
import {makeObserver} from './observer';
import {utToDate} from './time';
export interface EclipseContact {label:string;ut:number}
export interface EclipseResult {type:'solar'|'lunar';kind:string;peak:number;contacts:EclipseContact[];obscuration:number;latitude?:number;longitude?:number}
const names:Record<string,string>={partial:'偏食',total:'全食',annular:'环食',penumbral:'半影食'};
export function searchEclipse(state:SimulationState,type:'solar'|'lunar',local=true):EclipseResult {
  const seed=state.time.utDaysJ2000;
  let result:EclipseResult;
  if(type==='lunar'){
    const e=Engine.SearchLunarEclipse(seed),peak=e.peak.ut,contacts:EclipseContact[]=[];
    for(const [duration,start,end] of [[e.sd_penum,'半影食始','半影食终'],[e.sd_partial,'初亏','复圆'],[e.sd_total,'食既','生光']] as const)
      if(duration>0)contacts.push({label:start,ut:peak-duration/1440},{label:end,ut:peak+duration/1440});
    contacts.push({label:'食甚',ut:peak});contacts.sort((a,b)=>a.ut-b.ut);
    result={type,kind:`月${names[e.kind]??e.kind}`,peak,contacts,obscuration:e.obscuration};
  }else if(local){
    const e=Engine.SearchLocalSolarEclipse(seed,makeObserver(state.observer));
    const contacts=[['初亏',e.partial_begin],['食既',e.total_begin],['食甚',e.peak],['生光',e.total_end],['复圆',e.partial_end]] as const;
    result={type,kind:`当地日${names[e.kind]??e.kind}`,peak:e.peak.time.ut,obscuration:e.obscuration,
      contacts:contacts.flatMap(([label,event])=>event?[{label,ut:event.time.ut}]:[])};
  }else{
    const e=Engine.SearchGlobalSolarEclipse(seed);
    result={type,kind:`全球日${names[e.kind]??e.kind}`,peak:e.peak.ut,contacts:[{label:'全球食甚',ut:e.peak.ut}],obscuration:e.obscuration??0,
      latitude:e.latitude,longitude:e.longitude};
  }
  if(result.contacts.some(c=>utToDate(c.ut).getUTCFullYear()>4000||utToDate(c.ut).getUTCFullYear()< -2000))throw Error('搜索结果超出支持年代。');
  return result;
}

/** Geometric discs in a sky tangent plane; all sizes are angular radii in degrees. */
export function eclipseDiscs(state:SimulationState,type:'solar'|'lunar') {
  const ut=state.time.utDaysJ2000,observer=makeObserver(state.observer);
  const sun=Engine.Equator(Engine.Body.Sun,ut,observer,false,true).vec;
  const moon=Engine.Equator(Engine.Body.Moon,ut,observer,false,true).vec;
  const norm=(v:{x:number;y:number;z:number})=>{const r=Math.hypot(v.x,v.y,v.z);return [v.x/r,v.y/r,v.z/r] as const;};
  const s=norm(sun),m=norm(moon);
  const target=type==='solar'?s:m;
  const east=norm({x:-target[1],y:target[0],z:0});
  const north=[target[1]*east[2]-target[2]*east[1],target[2]*east[0]-target[0]*east[2],target[0]*east[1]-target[1]*east[0]];
  const project=(v:readonly number[])=>{const dot=(b:readonly number[])=>v.reduce((a,x,i)=>a+x*b[i]!,0);const axial=dot(target);return {x:Math.atan2(dot(east),axial)*180/Math.PI,y:Math.atan2(dot(north),axial)*180/Math.PI};};
  const sr=Math.asin(695700/(Math.hypot(sun.x,sun.y,sun.z)*Engine.KM_PER_AU))*180/Math.PI;
  const mr=Math.asin(1737.4/(Math.hypot(moon.x,moon.y,moon.z)*Engine.KM_PER_AU))*180/Math.PI;
  const eqd=Engine.Equator(type==='solar'?Engine.Body.Sun:Engine.Body.Moon,ut,observer,true,true);
  const altitude=Engine.Horizon(ut,observer,eqd.ra,eqd.dec).altitude;
  if(type==='solar')return {targetRadius:sr,occulterRadius:mr,penumbraRadius:0,altitude,...project(m)};
  const geoSun=Engine.GeoVector(Engine.Body.Sun,ut,true),geoMoon=Engine.GeoVector(Engine.Body.Moon,ut,true);
  const distance=Math.hypot(geoMoon.x,geoMoon.y,geoMoon.z),sunDistance=Math.hypot(geoSun.x,geoSun.y,geoSun.z),axis=norm(geoSun);
  // Shadow centre at lunar distance, translated to the observer frame.
  const shift=[moon.x-geoMoon.x,moon.y-geoMoon.y,moon.z-geoMoon.z];
  const shadow=norm({x:-axis[0]*distance+shift[0]!,y:-axis[1]*distance+shift[1]!,z:-axis[2]*distance+shift[2]!});
  const earthRadius=6378.137*1.02,km=distance*Engine.KM_PER_AU;
  return {targetRadius:mr,altitude,occulterRadius:Math.atan((earthRadius-(695700-earthRadius)*distance/sunDistance)/km)*180/Math.PI,
    penumbraRadius:Math.atan((earthRadius+(695700+earthRadius)*distance/sunDistance)/km)*180/Math.PI,...project(shadow)};
}
