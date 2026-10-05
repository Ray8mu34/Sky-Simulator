/** Node-only paired writer probe. Extracts the actual production method; creates no renderer/context. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
import * as THREE from 'three';
import {createDefaultState} from '../src/state';
import {computeSnapshot} from '../src/core/astronomy';
import {getDisplayRefractionProfile,deriveRefractionProfile,createRefractionDescriptor} from '../src/core/refraction';
import {cameraFrameForState} from '../src/render/CameraActions';
import {multiplyVector} from '../src/render/coordinates';
import {createMinorArcSampler,minorArcAltitudeCrossings,minorArcDirectionAt} from '../src/render/SphericalArcBuffer';
import type {Mat3,SimulationState,ScienceSnapshot,Vec3} from '../src/contracts';

const root=process.cwd(),sourcePath=resolve(root,'src/render/SkyRenderer.ts');
const output=resolve(root,process.env.SKY_WRITER_OUT??'qa/m5c-render/reference-writer-optimization');
const baselinePath=resolve(root,process.env.SKY_WRITER_BASELINE??sourcePath);
const baseline=readFileSync(baselinePath,'utf8'),current=readFileSync(sourcePath,'utf8');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const oldBlock='      this.referencePositions.set(a, offset); this.referencePositions.set(b, offset + 3);\n      this.referenceColors.set(color, offset); this.referenceColors.set(color, offset + 3);';
const newBlock='      this.referencePositions[offset]=a[0];this.referencePositions[offset+1]=a[1];this.referencePositions[offset+2]=a[2];\n      this.referencePositions[offset+3]=b[0];this.referencePositions[offset+4]=b[1];this.referencePositions[offset+5]=b[2];\n      this.referenceColors[offset]=color[0];this.referenceColors[offset+1]=color[1];this.referenceColors[offset+2]=color[2];\n      this.referenceColors[offset+3]=color[0];this.referenceColors[offset+4]=color[1];this.referenceColors[offset+5]=color[2];';
const normalized=baseline.replace(/\r\n/g,'\n');
assert.equal(normalized.split(oldBlock).length,2,'Baseline must contain exactly the four production tuple.set calls.');
const proposed=normalized.replace(oldBlock,newBlock);
const candidate=process.env.SKY_WRITER_VERIFY_CURRENT==='1'?current.replace(/\r\n/g,'\n'):proposed;
assert.equal(candidate,proposed,'Only the four tuple writes may change; all remaining source must be identical.');

function extract(source:string){
  const tree=ts.createSourceFile('SkyRenderer.ts',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
  const renderer=tree.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='SkyRenderer') as ts.ClassDeclaration;
  const method=renderer.members.find(s=>ts.isMethodDeclaration(s)&&s.name.getText(tree)==='updateReferences') as ts.MethodDeclaration;
  const constants=tree.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>['RAD','referenceCos','referenceSin','referenceAltitudeGuard','asThree'].includes(d.name.getText(tree)))).map(s=>s.getText(tree)).join('\n');
  let segment:ts.VariableDeclaration|undefined;
  function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='segment')segment=node;ts.forEachChild(node,visit);}
  visit(method);
  assert.ok(segment?.initializer);
  const deps=['THREE','multiplyVector','createMinorArcSampler','minorArcAltitudeCrossings','minorArcDirectionAt'];
  const values=[THREE,multiplyVector,createMinorArcSampler,minorArcAltitudeCrossings,minorArcDirectionAt];
  const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const update=new Function(...deps,compile(`${constants}\nclass ReferenceHarness {${method.getText(tree)}}\nreturn ReferenceHarness.prototype.updateReferences;`))(...values) as (this:Owner,state:SimulationState,snapshot:ScienceSnapshot)=>void;
  const makeWriter=new Function(compile(`let offset=0;const segment=${segment.initializer.getText(tree)};return {write:segment,reset(){offset=0;},getOffset(){return offset;}};`)) as (this:Owner)=>Writer;
  return {update,makeWriter};
}
interface Writer {write:(a:Vec3,b:Vec3,color:Vec3,celestial?:boolean)=>void;reset:()=>void;getOffset:()=>number}
interface Owner {
  lastReferenceKey:string;finite:boolean;frame:Mat3;refractionProfile:ReturnType<typeof deriveRefractionProfile>;
  referencePositions:Float32Array;referenceColors:Float32Array;referenceClasses:Float32Array;
  referenceLines:THREE.LineSegments;horizonPlane:THREE.Object3D;
}
function owner(state:SimulationState,snapshot:ScienceSnapshot,length=18000):Owner {
  const positions=new Float32Array(length).fill(-123.456),colors=new Float32Array(length).fill(-123.456),classes=new Float32Array(Math.ceil(length/3)).fill(-123.456);
  const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(positions,3)).setAttribute('lineColor',new THREE.BufferAttribute(colors,3)).setAttribute('refractionClass',new THREE.BufferAttribute(classes,1));
  return {lastReferenceKey:'',finite:state.viewMode==='globe'||state.viewMode==='horizon',frame:cameraFrameForState(state,snapshot),refractionProfile:getDisplayRefractionProfile(snapshot,state.viewMode),
    referencePositions:positions,referenceColors:colors,referenceClasses:classes,referenceLines:new THREE.LineSegments(geometry,new THREE.LineBasicMaterial()),horizonPlane:new THREE.Object3D()};
}
function equalOwners(a:Owner,b:Owner){
  for(const key of ['referencePositions','referenceColors','referenceClasses'] as const){
    const aa=a[key],bb=b[key];assert.ok(Buffer.from(aa.buffer,aa.byteOffset,aa.byteLength).equals(Buffer.from(bb.buffer,bb.byteOffset,bb.byteLength)),key+' bytes differ');
  }
  assert.deepEqual(a.referenceLines.geometry.drawRange,b.referenceLines.geometry.drawRange);
  assert.equal(a.referenceLines.visible,b.referenceLines.visible);assert.equal(a.horizonPlane.visible,b.horizonPlane.visible);
  assert.deepEqual(a.horizonPlane.quaternion.toArray(),b.horizonPlane.quaternion.toArray());
  for(const key of ['position','lineColor','refractionClass'])assert.equal((a.referenceLines.geometry.getAttribute(key) as THREE.BufferAttribute).version,(b.referenceLines.geometry.getAttribute(key) as THREE.BufferAttribute).version);
}
const previous=extract(normalized),next=extract(candidate);
const cases:{id:string,vertices:number}[]=[];
let request=1,standardJoinCrossings=0,standardHorizonCrossings=0;
const modes=['ground','space','globe','horizon'] as const;
const environments=[{refraction:'none' as const,pressureHpa:1013.25,temperatureC:15},
  {refraction:'standard' as const,pressureHpa:0,temperatureC:15},
  {refraction:'standard' as const,pressureHpa:1013.25,temperatureC:15},
  {refraction:'standard' as const,pressureHpa:1200,temperatureC:-100},
  {refraction:'standard' as const,pressureHpa:1,temperatureC:80}];
for(const mode of modes)for(let environment=0;environment<environments.length;environment++)for(const latitude of [-31,0,30.25])for(const ut of [9752.913194444445,-146097]){
  const state=createDefaultState();state.viewMode=mode;Object.assign(state.environment,environments[environment]);state.observer.latitudeDeg=latitude;state.time.utDaysJ2000=ut;
  Object.assign(state.layers,{ecliptic:true,celestialEquator:true,celestialPoles:true,horizon:true,meridian:true});
  const snapshot=computeSnapshot(state,request++),a=owner(state,snapshot),b=owner(state,snapshot);
  previous.update.call(a,state,snapshot);next.update.call(b,state,snapshot);equalOwners(a,b);
  cases.push({id:`${mode}/environment${environment}/lat${latitude}/ut${ut}`,vertices:a.referenceLines.geometry.drawRange.count});
  if(mode==='ground'&&!a.refractionProfile.identity){
    const up=snapshot.localZenithEqjUnit;
    for(const threshold of [-1,a.refractionProfile.geometricHorizonDeg]){
      // Exercise canonical two-threshold insertion on the actual celestial circles.
      let count=0;
      for(const basis of [[multiplyVector(snapshot.eclipticOfDateToEqj,[1,0,0]),multiplyVector(snapshot.eclipticOfDateToEqj,[0,1,0])],
        [multiplyVector(snapshot.earthFixedToEqj,[1,0,0]),multiplyVector(snapshot.earthFixedToEqj,[0,1,0])]] as [Vec3,Vec3][]){
        const point=(i:number):Vec3=>basis[0].map((v,axis)=>v*Math.cos(i*Math.PI/360)+basis[1][axis]!*Math.sin(i*Math.PI/360)) as unknown as Vec3;
        for(let i=0;i<720;i++){const sampler=createMinorArcSampler(point(i),point(i+1));if(sampler)count+=minorArcAltitudeCrossings(sampler,up,threshold).length;}
      }
      if(threshold===-1)standardJoinCrossings+=count;else standardHorizonCrossings+=count;
    }
  }
  // The cache-hit path must leave both writers' arrays and attribute versions unchanged.
  previous.update.call(a,state,snapshot);next.update.call(b,state,snapshot);equalOwners(a,b);
  a.referenceLines.geometry.dispose();b.referenceLines.geometry.dispose();
}
assert.ok(standardJoinCrossings>0&&standardHorizonCrossings>0,'Both standard breakpoints must actually insert knots.');
const guardState=createDefaultState();Object.assign(guardState.layers,{ecliptic:true,celestialEquator:true,horizon:true,meridian:true});
const guardSnapshot=computeSnapshot(guardState,request++);
for(const capacity of [0,5,6,13]){const a=owner(guardState,guardSnapshot,capacity),b=owner(guardState,guardSnapshot,capacity);previous.update.call(a,guardState,guardSnapshot);next.update.call(b,guardState,guardSnapshot);equalOwners(a,b);cases.push({id:`capacity-guard-${capacity}`,vertices:a.referenceLines.geometry.drawRange.count});}
// Capture the actual old production circle's ordinary tuple inputs once, outside timing.
const traced=owner(guardState,guardSnapshot),positionCalls:Vec3[]=[],colorCalls:Vec3[]=[];
traced.referencePositions.set=function(this:Float32Array,input:ArrayLike<number>,offset?:number){positionCalls.push(input as unknown as Vec3);Float32Array.prototype.set.call(this,input,offset);};
traced.referenceColors.set=function(this:Float32Array,input:ArrayLike<number>,offset?:number){colorCalls.push(input as unknown as Vec3);Float32Array.prototype.set.call(this,input,offset);};
previous.update.call(traced,guardState,guardSnapshot);
const trace=Array.from({length:positionCalls.length/2},(_,i)=>({a:positionCalls[i*2]!,b:positionCalls[i*2+1]!,color:colorCalls[i*2]!,celestial:traced.referenceClasses[i*2]===1}));
const oldOwner=owner(guardState,guardSnapshot),newOwner=owner(guardState,guardSnapshot),oldWriter=previous.makeWriter.call(oldOwner),newWriter=next.makeWriter.call(newOwner);
function batch(writer:Writer,frames:number){const start=performance.now();for(let frame=0;frame<frames;frame++){writer.reset();for(const v of trace)writer.write(v.a,v.b,v.color,v.celestial);}return performance.now()-start;}
for(let i=0;i<12;i++){batch(oldWriter,8);batch(newWriter,8);}
const pilot=batch(oldWriter,32),frames=Math.max(16,Math.min(256,Math.ceil(32*15/Math.max(.1,pilot))));
const rounds:{oldMs:number,newMs:number,ratio:number}[]=[];
for(let i=0;i<16;i++){let oldMs:number,newMs:number;if(i%2){newMs=batch(newWriter,frames);oldMs=batch(oldWriter,frames);}else{oldMs=batch(oldWriter,frames);newMs=batch(newWriter,frames);}rounds.push({oldMs,newMs,ratio:newMs/oldMs});}
equalOwners(oldOwner,newOwner);assert.equal(oldWriter.getOffset(),newWriter.getOffset());
const median=(numbers:number[])=>{const sorted=[...numbers].sort((a,b)=>a-b);return (sorted[(sorted.length-1)>>1]!+sorted[sorted.length>>1]!)/2;};
mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'SkyRenderer.before.ts'),baseline);
writeFileSync(resolve(output,'SkyRenderer.proposed.ts'),candidate);
const report={status:'passed-reference-writer-byte-equivalence',scope:'Node-only actual extracted production writer and updateReferences; no browser/context, no whole-frame performance conclusion',
  node:process.version,platform:process.platform,architecture:process.arch,baselinePath,sourcePath,baselineSha256:sha(baseline),proposedSha256:sha(candidate),currentSha256:sha(current),
  actualWholeMethodCases:cases.length,standardJoinCrossings,standardHorizonCrossings,cases,
  microbench:{ordinaryTupleSource:'Actual old updateReferences circle output; all tuple generation occurs before measurement',segmentsPerFrame:trace.length,framesPerBatch:frames,pairedRounds:rounds.length,
    medianOldBatchMs:median(rounds.map(v=>v.oldMs)),medianNewBatchMs:median(rounds.map(v=>v.newMs)),medianPairedRatio:median(rounds.map(v=>v.ratio)),rounds},
  sourceChange:'Exactly four 3-element Float32Array.set writes replaced with 12 scalar indexed writes; guard, order, circle and offset code unchanged',browserCreated:false};
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,cases:cases.length,standardJoinCrossings,standardHorizonCrossings,microbench:report.microbench,output},null,2));
