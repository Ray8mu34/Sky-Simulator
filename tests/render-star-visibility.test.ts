import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import {createDefaultState} from '../src/state';
import {DEFAULT_RUNTIME_RENDER_QUALITY} from '../src/platform/runtime-quality-contract';
import {runtimeLabelSecondary,runtimeLabelIsHiddenBack,runtimeOrdinaryLabelBudget} from '../src/render/RenderQuality';
import {EQJ_TO_THREE,rayHitsSphere,sphereFacing} from '../src/render/coordinates';
import {displayDirection} from '../src/render/DisplayDirection';
import {createRefractionDescriptor,deriveRefractionProfile} from '../src/core/refraction';
import {createSphericalArcBuffer,createSphericalArcScalarAttribute,updateSphericalArcBuffer,writeConstellationHighlight} from '../src/render/SphericalArcBuffer';
import {finalStarAlpha,starMagnitudeVisibility,STAR_ALPHA_DISCARD,STAR_VISIBILITY_GLSL} from '../src/render/star-visibility';
import {starVertex,starFragment,lineVertex,lineFragment} from '../src/render/shaders';

const rendererSource=readFileSync('src/render/SkyRenderer.ts','utf8');
const bytes=(array:ArrayBufferView)=>new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
const pointBytes=(array:Float32Array,index:number)=>bytes(array.subarray(index*3,index*3+3));
function members(names:readonly string[],deps:Record<string,unknown>){
  const tree=ts.createSourceFile('SkyRenderer.ts',rendererSource,ts.ScriptTarget.ES2022,true);
  const source=tree.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='SkyRenderer') as ts.ClassDeclaration;
  const selected=source.members.filter(member=>member.name&&names.includes(member.name.getText(tree))).map(member=>member.getText(tree)).join('\n');
  const code=ts.transpileModule(`class Subject{${selected}}return Subject;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function(...Object.keys(deps),code)(...Object.values(deps));
}

test('CPU visibility shares shader thresholds, intrinsic brightness and exact discard boundary',()=>{
  const limit=3;
  assert.equal(starMagnitudeVisibility(limit-.25,limit),1);
  assert.equal(starMagnitudeVisibility(limit+.1,limit),0);
  assert.ok(finalStarAlpha(limit+.02,limit)>STAR_ALPHA_DISCARD,'soft-band star above the nominal limit remains displayed');
  let previous=1;
  for(let i=0;i<=100;i++){
    const magnitude=limit-.25+i*.0035,actual=starMagnitudeVisibility(magnitude,limit);
    const t=Math.max(0,Math.min(1,(magnitude-(limit-.25))/((limit+.1)-(limit-.25))));
    assert.equal(actual,1-t*t*(3-2*t));assert.ok(actual<=previous+1e-14);previous=actual;
  }
  assert.equal(finalStarAlpha(1,limit,STAR_ALPHA_DISCARD),STAR_ALPHA_DISCARD);
  assert.ok(finalStarAlpha(1,limit,STAR_ALPHA_DISCARD*.999)<STAR_ALPHA_DISCARD);
  assert.equal(finalStarAlpha(5,6.5,.5,.28),.62*.5*.28);
  assert.equal(finalStarAlpha(5,6.5,.5,1,.2),.1,'Canvas uses its actual existing symbol alpha');
  assert.ok(starVertex.includes(STAR_VISIBILITY_GLSL));assert.ok(starFragment.includes(STAR_VISIBILITY_GLSL));
  assert.ok(lineVertex.includes(STAR_VISIBILITY_GLSL));assert.ok(lineFragment.includes('alpha*=vArcAlpha'));
});

test('all catalog arcs retain identical indexed Float32 positions and fixed 88 highlight resources with aliases',()=>{
  const records=JSON.parse(readFileSync('assets/runtime/star-meta.json','utf8')) as unknown[];
  const figures=JSON.parse(readFileSync('assets/runtime/constellation-meta.json','utf8')) as {constellations:{id:string,lineStart:number,lineCount:number}[],lineIndices:number[]};
  const binary=readFileSync('assets/runtime/stars.bin'),data=new DataView(binary.buffer,binary.byteOffset,binary.byteLength);
  const options={starCount:records.length,lineIndices:figures.lineIndices,figures:figures.constellations};
  const ordinary=createSphericalArcBuffer(options),aliased=createSphericalArcBuffer({...options,endpointAliases:true});
  const magnitudes=new Float32Array(records.length);
  for(let star=0;star<records.length;star++){
    for(let axis=0;axis<3;axis++)ordinary.starDirections[star*3+axis]=data.getFloat32(star*32+axis*4,true);
    magnitudes[star]=data.getFloat32(star*32+12,true);
  }
  aliased.starDirections.set(ordinary.starDirections);
  const prefix=bytes(aliased.starDirections).slice(),positionIdentity=aliased.positions,indexIdentity=aliased.highlightIndex;
  const weak=Float32Array.from({length:aliased.arcCount},(_,arc)=>Math.max(magnitudes[figures.lineIndices[arc*2]!]!,magnitudes[figures.lineIndices[arc*2+1]!]!));
  const attribute=createSphericalArcScalarAttribute(aliased,weak);
  updateSphericalArcBuffer(ordinary);updateSphericalArcBuffer(aliased);
  assert.deepEqual(aliased.result,ordinary.result);assert.deepEqual([...aliased.figureRanges],[...ordinary.figureRanges]);
  assert.deepEqual(bytes(aliased.positions.subarray(0,ordinary.positions.length)),bytes(ordinary.positions));
  assert.deepEqual(bytes(aliased.starDirections),prefix);assert.equal(aliased.positions.byteLength-ordinary.positions.byteLength,aliased.arcCount*2*3*4);
  for(let arc=0;arc<aliased.arcCount;arc++){
    const start=aliased.arcIndexStarts[arc]!,count=aliased.arcSegmentCounts[arc]!;
    for(let index=start;index<start+count*2;index++){
      const ai=aliased.ordinaryIndex[index]!,oi=ordinary.ordinaryIndex[index]!;
      assert.deepEqual(pointBytes(aliased.positions,ai),pointBytes(ordinary.positions,oi));
      assert.equal(attribute[ai],weak[arc]);
    }
  }
  for(const figure of figures.constellations){
    const count=writeConstellationHighlight(aliased,figure.id),range=aliased.figureRanges.get(figure.id)!;
    assert.equal(count,range.indexCount);assert.equal(aliased.positions,positionIdentity);assert.equal(aliased.highlightIndex,indexIdentity);
    assert.deepEqual(aliased.highlightIndex.subarray(0,count),aliased.ordinaryIndex.subarray(range.indexStart,range.indexStart+count));
  }
});

test('actual WebGL geometry uses one position and static arc-magnitude attribute; reference grids have no magnitude define',()=>{
  const start=rendererSource.indexOf('    const geometry = new THREE.BufferGeometry();'),end=rendererSource.indexOf('    this.background =',start);
  const compiled=ts.transpileModule(`return function(){${rendererSource.slice(start,end)}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const catalog={stars:[{}, {}, {}],magnitudes:new Float32Array([1,2,5]),colors:new Float32Array(9)};
  const arcBuffer=createSphericalArcBuffer({starCount:3,lineIndices:[0,1,0,2],figures:[{id:'A',lineStart:0,lineCount:2}],endpointAliases:true});
  const arcMagnitudes=createSphericalArcScalarAttribute(arcBuffer,[2,5]);
  const subject:any={arcBuffer,arcMagnitudes,scene:new THREE.Scene(),sharedUniforms:{},referencePositions:new Float32Array(6),referenceColors:new Float32Array(6),referenceClasses:new Float32Array(2)};
  new Function('THREE','catalog','starVertex','starFragment','lineVertex','lineFragment',compiled)(THREE,catalog,starVertex,starFragment,lineVertex,lineFragment).call(subject);
  const positions=subject.stars.geometry.getAttribute('position'),magnitudes=subject.constellationLines.geometry.getAttribute('arcMagnitude');
  assert.equal(positions.array,arcBuffer.positions);assert.equal(subject.stars.geometry.drawRange.count,3);
  assert.equal(subject.constellationLines.geometry.getAttribute('position'),positions);assert.equal(subject.selectionLines.geometry.getAttribute('position'),positions);
  assert.equal(subject.selectionLines.geometry.getAttribute('arcMagnitude'),magnitudes);assert.equal(magnitudes.array,arcMagnitudes);
  assert.equal(magnitudes.usage,THREE.StaticDrawUsage);assert.equal(magnitudes.version,0);
  for(const mesh of [subject.constellationLines,subject.selectionLines]){
    assert.equal(mesh.material.defines.CONSTELLATION_VISIBILITY,1);assert.equal(mesh.material.uniforms.uLimit,subject.starMaterial.uniforms.uLimit);
    assert.equal(mesh.material.uniforms.uVisibility,subject.starMaterial.uniforms.uVisibility);assert.equal(mesh.material.uniforms.uApplyStarVisibility,subject.lineMaterial.uniforms.uApplyStarVisibility);
  }
  assert.equal(subject.referenceLines.geometry.getAttribute('arcMagnitude'),undefined);assert.equal(subject.referenceMaterial.defines.CONSTELLATION_VISIBILITY,undefined);
  for(const mesh of [subject.stars,subject.constellationLines,subject.selectionLines,subject.referenceLines]){mesh.geometry.dispose();mesh.material.dispose();}
});

test('actual labels and native star pick agree through the soft fade, and terrain=false permits lower sky',()=>{
  const mag=2.84,catalog={stars:[{id:'hip:1',index:0,magnitude:mag,nameZh:'测试星'}],magnitudes:new Float32Array([mag]),constellations:[]};
  const hillHeight=(d:THREE.Vector3)=>{const a=Math.atan2(d.x,-d.z);return .010+.007*Math.sin(a*7+1.4)+.008*Math.sin(a*3-1)+.003*Math.sin(a*13);};
  const Subject=members(['displayVector','projectDirection','drawLabels','pickStarAt','constellationLabelVisibility'],{THREE,catalog,displayDirection,asThree:(v:number[])=>new THREE.Vector3(...v),hillHeight,rayHitsSphere,sphereFacing,
    finalStarAlpha,STAR_ALPHA_DISCARD,runtimeLabelSecondary,runtimeLabelIsHiddenBack,runtimeOrdinaryLabelBudget,resolveDisplayDirectionEqj:()=>null});
  const state=createDefaultState();state.layers.terrain=false;state.layers.horizon=false;state.layers.celestialPoles=false;state.layers.brightStarNamesZh=true;
  const angle=-10*Math.PI/180,direction=[0,Math.cos(angle),Math.sin(angle)],camera=new THREE.PerspectiveCamera(20,1000/720,.01,1000);
  camera.lookAt(0,Math.sin(angle),-Math.cos(angle));camera.updateMatrixWorld();
  let labels:any[]=[];
  const subject=new Subject();Object.assign(subject,{state,camera,width:1000,height:720,finite:false,frame:EQJ_TO_THREE,refractionProfile:deriveRefractionProfile(createRefractionDescriptor({...state.environment,refraction:'none'})),
    starDirections:new Float32Array(direction),canonicalSelected:null,constellationDirections:new Map(),starMaterial:{uniforms:{uLimit:{value:2.8},uVisibility:{value:1}}},skyAppearance:{visibilityApplied:true,limitingMagnitude:2.8,starVisibility:1},
    runtimeQuality:DEFAULT_RUNTIME_RENDER_QUALITY,budgetClass:'desktop',bodies:new Map(),groundDiscs:new Map(),labels:{draw:(value:any[])=>labels=value}});
  const snapshot={bodies:[]};
  const projected=subject.projectDirection(direction,state);assert.ok(projected&&projected.direction.y<0);
  subject.drawLabels(state,snapshot,1);assert.equal(labels.length,1);assert.ok(labels[0].alpha>=STAR_ALPHA_DISCARD);
  assert.equal(subject.pickStarAt(projected.x,projected.y),'hip:1','soft-band mag>limit remains genuinely pickable');
  subject.starMaterial.uniforms.uLimit.value=6.5;subject.skyAppearance.limitingMagnitude=6.5;
  subject.starMaterial.uniforms.uVisibility.value=.01;subject.skyAppearance.starVisibility=.01;
  subject.drawLabels(state,snapshot,.01);assert.equal(labels.length,1);assert.equal(subject.pickStarAt(projected.x,projected.y),'hip:1','no old visibility<.05 hard cut');
  subject.starMaterial.uniforms.uVisibility.value=.001;subject.skyAppearance.starVisibility=.001;
  subject.drawLabels(state,snapshot,.001);assert.equal(labels.length,0);assert.equal(subject.pickStarAt(projected.x,projected.y),null);
  subject.starMaterial.uniforms.uVisibility.value=1;subject.skyAppearance.starVisibility=1;subject.skyAppearance.visibilityApplied=false;
  subject.drawLabels(state,snapshot,1);assert.equal(labels[0].alpha,projected.alpha,'diagram label retains its original contrast');
  state.layers.terrain=true;subject.drawLabels(state,snapshot,1);assert.equal(labels.length,0);assert.equal(subject.pickStarAt(projected.x,projected.y),null);
});

test('ordinary constellation name follows a surviving whole pair, and diagram mode ignores endpoint limits',()=>{
  const Subject=members(['constellationLabelVisibility'],{finalStarAlpha}),subject=new Subject(),figure={lineStart:0,lineCount:2};
  Object.assign(subject,{arcWeakMagnitudes:new Float32Array([5,6]),skyAppearance:{visibilityApplied:true,limitingMagnitude:3,starVisibility:1}});
  assert.equal(subject.constellationLabelVisibility(figure),0,'isolated bright endpoint cannot preserve a floating name');
  subject.skyAppearance.limitingMagnitude=5;assert.equal(subject.constellationLabelVisibility(figure),finalStarAlpha(5,5));
  subject.skyAppearance.starVisibility=0;assert.equal(subject.constellationLabelVisibility(figure),0);
  subject.skyAppearance.visibilityApplied=false;assert.equal(subject.constellationLabelVisibility(figure),1);
});
