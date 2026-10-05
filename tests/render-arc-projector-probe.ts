/** One Node-only exact projector comparison and paired directional microbench. No browser/GPU. */
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
import {Euler,Matrix3,PerspectiveCamera} from 'three';
import {createRefractionDescriptor,deriveRefractionProfile,getDisplayRefractionProfile,refractEnuDirectionInto} from '../src/core/refraction';
import {computeSnapshot} from '../src/core/astronomy';
import {createDefaultState} from '../src/state';
import {cameraFrameForState} from '../src/render/CameraActions';
import {cachedStarEpoch,writeStarDirectionBuffer} from '../src/render/StarDirectionBuffer';
import {ArcKnotsCache} from '../src/render/ArcKnotsCache';
import {createSphericalArcBuffer,updateSphericalArcBuffer,writeConstellationHighlight} from '../src/render/SphericalArcBuffer';
import type {Mat3,Vec3} from '../src/contracts';
import type {RefractionProfile} from '../src/core/refraction';
import type {StarAstrometry} from '../src/core/stars';
import type {SphericalArcFigure} from '../src/render/SphericalArcBuffer';

const out=process.env.SKY_PROJECTOR_OUT??'qa/m6-render/arc-projector-gate';mkdirSync(out,{recursive:true});
const source=readFileSync('src/render/ArcProjection.ts','utf8'),sha=(v:string|ArrayBufferView)=>createHash('sha256').update(typeof v==='string'?v:new Uint8Array(v.buffer,v.byteOffset,v.byteLength)).digest('hex');
const normalized=source.replace(/\r\n/g,'\n'),oldCull='if(!finite&&geometricZ>Math.hypot(x,y,z)*behindBound+1e-12)return null;';
assert.equal(normalized.split(oldCull).length,2);
const gateSource=normalized.replace(oldCull,'if(!finite&&!(behindBound>=0&&geometricZ<=0)&&geometricZ>Math.hypot(x,y,z)*behindBound+1e-12)return null;');
const candidate=gateSource.replace('const [a,b,c]=direction;','const a=direction[0],b=direction[1],c=direction[2];')
  .replace('screen[0]=((rx[0]*x+rx[1]*y+rx[2]*z)/(-depth*tanFov*aspect)+1)*width/2;','const depthScale=-depth*tanFov;\n    screen[0]=((rx[0]*x+rx[1]*y+rx[2]*z)/(depthScale*aspect)+1)*width/2;')
  .replace('screen[1]=(1-(ry[0]*x+ry[1]*y+ry[2]*z)/(-depth*tanFov))*height/2;','screen[1]=(1-(ry[0]*x+ry[1]*y+ry[2]*z)/depthScale)*height/2;');
type Factory=(frame:Mat3,profile:RefractionProfile,rotation:Mat3,position:Vec3,finite:boolean,width:number,height:number,tan:number,maximum:number)=>(direction:Vec3)=>readonly[number,number]|null;
function compile(text:string):Factory{
  const body=text.replace(/^import[^;]+;\s*/gm,'').replace('export function createArcProjector','function createArcProjector');
  const compiled=ts.transpileModule(body+'\nreturn createArcProjector;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function('refractEnuDirectionInto',compiled)(refractEnuDirectionInto);
}
const previous=compile(normalized),gated=compile(gateSource),optimized=compile(candidate),DEG=Math.PI/180;
const frames:Mat3[]=[[[1,0,0],[0,0,1],[0,-1,0]],[[0,1,0],[0,0,1],[1,0,0]]],cameraAngles=[-90,-20,0,20,90,179.9];
const profiles=[{refraction:'none' as const,pressureHpa:1200,temperatureC:-100},{refraction:'standard' as const,pressureHpa:1010,temperatureC:10},{refraction:'standard' as const,pressureHpa:1200,temperatureC:-100}].map(v=>deriveRefractionProfile(createRefractionDescriptor({...createDefaultState().environment,...v})));
const dot=(a:readonly number[],b:readonly number[])=>a[0]!*b[0]!+a[1]!*b[1]!+a[2]!*b[2]!,enu=(h:number,a:number):Vec3=>[Math.cos(h*DEG)*Math.sin(a*DEG),Math.cos(h*DEG)*Math.cos(a*DEG),Math.sin(h*DEG)];
const maxCorrection=(profile:RefractionProfile)=>{let maximum=0;const data=profile.copyTextureData();for(let i=0;i<data.length;i+=2)maximum=Math.max(maximum,data[i]!);return maximum;};
function outcome(project:ReturnType<Factory>,direction:Vec3){try{const value=project(direction);return {value:value&&[value[0],value[1]],error:null};}catch(e){return {value:null,error:{name:(e as Error).name,message:(e as Error).message}};}}
let normalComparisons=0,edgeComparisons=0;
const projectorCases:object[]=[];
for(const profile of profiles)for(const finite of [false,true])for(const frame of frames)for(const angle of cameraAngles){
  const a=angle*DEG,rotation:Mat3=[[Math.cos(a),0,-Math.sin(a)],[0,1,0],[Math.sin(a),0,Math.cos(a)]],position:Vec3=finite?[.2,.1,3.1]:[0,0,0],maximum=maxCorrection(profile),tan=Math.tan(32.5*DEG);
  const old=previous(frame,profile,rotation,position,finite,1152,720,tan,maximum),next=optimized(frame,profile,rotation,position,finite,1152,720,tan,maximum);
  const directions:Vec3[]=[];
  for(const behindAngle of [-maximum-1e-8,-maximum,0,maximum,maximum+1e-8,maximum+1e-5]){
    const local=[Math.cos(behindAngle*DEG),0,Math.sin(behindAngle*DEG)],world=[0,1,2].map(i=>dot([rotation[0][i]!,rotation[1][i]!,rotation[2][i]!],local));
    directions.push([0,1,2].map(i=>dot([frame[0][i]!,frame[1][i]!,frame[2][i]!],world)) as unknown as Vec3);
  }
  for(const h of [-89,-2,-1,-.5,0,.5,10,89])for(let az=0;az<360;az+=15)directions.push(enu(h,az));
  for(const direction of directions){assert.deepEqual(outcome(next,direction),outcome(old,direction),'Float64/null/throw must remain Object.is equivalent');normalComparisons++;}
  projectorCases.push({profile:profile.key,finite,frame,angle,count:directions.length});
}
assert.equal(normalComparisons,14256);
const identity:Mat3=[[1,0,0],[0,1,0],[0,0,1]],oddVectors:Vec3[]=[[1,0,0],[0,0,-1],[0,0,1],[-0,0,-0],[0,0,0],[Number.MIN_VALUE,0,0],[1e150,-2e150,3e150],[1e308,1e308,-1e308],[NaN,1,0],[Infinity,0,0],[-Infinity,Infinity,0]];
for(const profile of [profiles[0]!,profiles[1]!])for(const finite of [false,true])for(const maximum of [-90,-1,-0,0,90,180,NaN,Infinity,-Infinity])for(const [width,height,tan]of [[1152,720,.3],[0,0,0],[-1152,720,-.3],[Infinity,720,Infinity],[1152,NaN,NaN]]){
  const old=previous(frames[0]!,profile,identity,[.2,.1,3.1],finite,width!,height!,tan!,maximum),next=optimized(frames[0]!,profile,identity,[.2,.1,3.1],finite,width!,height!,tan!,maximum);
  for(const direction of oddVectors){assert.deepEqual(outcome(next,direction),outcome(old,direction));edgeComparisons++;}
}

const records:unknown[][]=JSON.parse(readFileSync('assets/runtime/star-meta.json','utf8')),figures:{lineIndices:number[],constellations:SphericalArcFigure[]}=JSON.parse(readFileSync('assets/runtime/constellation-meta.json','utf8'));
const stars:StarAstrometry[]=records.map(record=>({id:record[0] as StarAstrometry['id'],raHours:record[3] as number,decDeg:record[4] as number,pmRaCosDecMasYr:record[10] as number,pmDecMasYr:record[11] as number,qualityFlags:record[12] as number,distancePc:record[13] as number|null,radialVelocityKmS:record[14] as number|null}));
const byteEqual=(a:ArrayBufferView,b:ArrayBufferView)=>assert.ok(Buffer.from(a.buffer,a.byteOffset,a.byteLength).equals(Buffer.from(b.buffer,b.byteOffset,b.byteLength)));
const arcCases:object[]=[],pool:Vec3[]=[];let benchArgs:Parameters<Factory>|undefined;
for(const mode of ['ground','space','globe','horizon'] as const)for(const low of [false,true]){
  const state=createDefaultState();state.viewMode=mode;state.environment.refraction='standard';state.cameras.ground.azimuthDegNorthEast=low?265:0;state.cameras.ground.altitudeDeg=low?12:25;state.cameras.ground.verticalFovDeg=low?75:65;
  if(mode!=='ground'){state.cameras[mode].distanceDisplayUnits=low?2.1:4;state.cameras[mode].verticalFovDeg=low?20:65;state.cameras[mode].referenceLock=mode==='horizon'?'local-horizon':'inertial';}
  const snapshot=computeSnapshot(state,1),profile=getDisplayRefractionProfile(snapshot,mode),frame=cameraFrameForState(state,snapshot),camera=new PerspectiveCamera(state.cameras[mode].verticalFovDeg,1152/720,.01,2000);
  if(mode==='ground')camera.quaternion.setFromEuler(new Euler(state.cameras.ground.altitudeDeg*DEG,-state.cameras.ground.azimuthDegNorthEast*DEG,0,'YXZ'));else camera.position.set(0,0,state.cameras[mode].distanceDisplayUnits);
  camera.updateMatrixWorld(true);const e=new Matrix3().setFromMatrix4(camera.matrixWorldInverse).elements,rotation:Mat3=[[e[0]!,e[3]!,e[6]!],[e[1]!,e[4]!,e[7]!],[e[2]!,e[5]!,e[8]!]];
  const args:Parameters<Factory>=[frame,profile,rotation,camera.position.toArray(),mode==='globe'||mode==='horizon',1152,720,Math.tan(camera.fov*DEG/2),maxCorrection(profile)],options={starCount:stars.length,lineIndices:figures.lineIndices,figures:figures.constellations,maxSegmentsPerArc:128};
  const oldBuffer=createSphericalArcBuffer(options),newBuffer=createSphericalArcBuffer(options);writeStarDirectionBuffer(stars,cachedStarEpoch(snapshot.utDaysJ2000),oldBuffer.starDirections);newBuffer.starDirections.set(oldBuffer.starDirections);
  const knotCache=new ArcKnotsCache(figures.lineIndices);knotCache.updateEpoch(oldBuffer.starDirections);const knots=profile.identity?undefined:knotCache.update(snapshot.localZenithEqjUnit,profile.geometricHorizonDeg);
  const oldProject=previous(...args),newProject=optimized(...args),collect=mode==='ground'&&low;
  for(const [buffer,project]of [[oldBuffer,oldProject],[newBuffer,newProject]] as const){updateSphericalArcBuffer(buffer,{maxAngularStepDeg:.5,extraKnotsByArc:knots,screenError:{maxErrorPx:.35,project:direction=>{if(collect&&buffer===oldBuffer)pool.push([direction[0],direction[1],direction[2]]);return project(direction);}}});}
  for(const key of ['positions','ordinaryIndex','arcSegmentCounts','arcIndexStarts','arcDiagnostics'] as const)byteEqual(oldBuffer[key],newBuffer[key]);assert.deepEqual(oldBuffer.result,newBuffer.result);assert.deepEqual([...oldBuffer.figureRanges],[...newBuffer.figureRanges]);
  for(const figure of figures.constellations){assert.equal(writeConstellationHighlight(oldBuffer,figure.id),writeConstellationHighlight(newBuffer,figure.id));byteEqual(oldBuffer.highlightIndex,newBuffer.highlightIndex);}
  arcCases.push({mode,low,positionsSha256:sha(oldBuffer.positions),indicesSha256:sha(oldBuffer.ordinaryIndex),result:{...oldBuffer.result},byteIdentical:true});if(collect)benchArgs=args;
}
assert.ok(benchArgs&&pool.length>10000);
const oldBench=previous(...benchArgs),gateBench=gated(...benchArgs),newBench=optimized(...benchArgs);
function batch(project:ReturnType<Factory>,loops:number){let checksum=0;const start=performance.now();for(let loop=0;loop<loops;loop++)for(const direction of pool){const point=project(direction);if(point)checksum+=point[0]*.00001+point[1]*.00001;}return {ms:performance.now()-start,checksum};}
for(let i=0;i<8;i++){batch(oldBench,2);batch(gateBench,2);batch(newBench,2);}
const pilot=batch(oldBench,4),loops=Math.max(1,Math.min(24,Math.ceil(4*15/pilot.ms))),rounds:{oldMs:number,gateMs:number,newMs:number,gateRatio:number,newRatio:number}[]=[];
for(let i=0;i<16;i++){
  const values=i%2?[batch(newBench,loops),batch(gateBench,loops),batch(oldBench,loops)].reverse():[batch(oldBench,loops),batch(gateBench,loops),batch(newBench,loops)];
  assert.equal(values[0]!.checksum,values[1]!.checksum);assert.equal(values[0]!.checksum,values[2]!.checksum);
  const [a,b,c]=values;rounds.push({oldMs:a!.ms,gateMs:b!.ms,newMs:c!.ms,gateRatio:b!.ms/a!.ms,newRatio:c!.ms/a!.ms});
}
const median=(v:number[])=>{const s=[...v].sort((a,b)=>a-b);return(s[(s.length-1)>>1]!+s[s.length>>1]!)/2;};
function hypotCalls(project:ReturnType<Factory>){let count=0;const original=Math.hypot;Math.hypot=(...values:number[])=>{count++;return original(...values);};try{for(const direction of pool)project(direction);}finally{Math.hypot=original;}return count;}
const oldHypot=hypotCalls(oldBench),newHypot=hypotCalls(newBench);assert.ok(newHypot<oldHypot);
writeFileSync(`${out}/ArcProjection.before.ts`,source);writeFileSync(`${out}/ArcProjection.proposed.ts`,candidate);
const report={status:'passed-exact-projector-equivalence',scope:'Node-only source candidate proof and one paired microbench, not wholemain or GPU performance acceptance',node:process.version,sourceBeforeSha256:sha(source),candidateSha256:sha(candidate),
  normalComparisons,edgeComparisons,projectorCases,arcCases,hypotCallsPerActualPool:{previous:oldHypot,candidate:newHypot},
  microbench:{source:'Actual current 676-arc ground-low projector callback directions',directionsPerLoop:pool.length,loopsPerRound:loops,pairedRounds:rounds.length,medianGateRatio:median(rounds.map(v=>v.gateRatio)),medianCandidateRatio:median(rounds.map(v=>v.newRatio)),rounds},browserCreated:false};
writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,normalComparisons,edgeComparisons,arcCases:arcCases.length,microbench:report.microbench,hypot:report.hypotCallsPerActualPool,output:out},null,2));
