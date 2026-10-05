import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import {createDefaultState} from '../src/state';
import {DEFAULT_RUNTIME_RENDER_QUALITY,renderBudgetClass} from '../src/platform/runtime-quality-contract';
import type {RuntimeRenderQuality} from '../src/platform/runtime-quality-contract';
import {isProtectedRuntimeLabel,runtimeLabelSecondary,runtimeLabelIsHiddenBack,runtimeOrdinaryLabelBudget,sameRuntimeRenderQuality,WEBGL_RUNTIME_QUALITY_CAPABILITIES} from '../src/render/RenderQuality';
import {createPointerGesture,reducePointerGesture} from '../src/render/PointerGestures';
import {EXTERNAL_CAMERA_LIMITS} from '../src/camera-limits';
import {LabelLayer} from '../src/render/LabelLayer';
import type {LabelCandidate} from '../src/render/LabelLayer';
import {cappedPixelRatio} from '../src/render/coordinates';

const reduced:Readonly<RuntimeRenderQuality>={...DEFAULT_RUNTIME_RENDER_QUALITY,hideOrdinaryBackLabels:true,hideOrdinarySecondaryLabels:true,ordinaryLabelBudgetScale:.5,pixelScale:.55};
test('runtime label filtering preserves selected/reference/body/explicit teaching before text measurement',()=>{
  const protectedLabels=[{id:'hip:11767',selected:true},{id:'direction:N'},{id:'pole:N'},{id:'body:Moon'},{id:'teaching:phase',qualityProtected:true}];
  for(const label of protectedLabels){assert.equal(isProtectedRuntimeLabel(label),true);assert.equal(runtimeLabelSecondary(label,'Protected subtext',reduced),'Protected subtext');assert.equal(runtimeLabelIsHiddenBack(label,-.2,true,reduced),false);}
  const ordinary={id:'constellation:Ori'};
  assert.equal(runtimeLabelSecondary(ordinary,'Ordinary subtext',reduced),undefined);
  assert.equal(runtimeLabelIsHiddenBack(ordinary,-.2,true,reduced),true);
  assert.equal(runtimeLabelIsHiddenBack(ordinary,.1,true,reduced),false);
  assert.equal(runtimeLabelIsHiddenBack(ordinary,-.2,false,reduced),false);
  assert.equal(runtimeOrdinaryLabelBudget(60,reduced),30);assert.equal(runtimeOrdinaryLabelBudget(18,reduced),9);
  assert.equal(WEBGL_RUNTIME_QUALITY_CAPABILITIES.verifiedDecorationReduction,false);assert.equal(WEBGL_RUNTIME_QUALITY_CAPABILITIES.optionalInvisibleStars,false);
});

function installFakeDom(){
  const descriptors=new Map<string,PropertyDescriptor|undefined>(),measured:string[]=[],draws:unknown[][]=[];
  const context=()=>new Proxy({measureText:(text:string)=>{measured.push(text);return{width:text.length*4};},drawImage:(...args:unknown[])=>draws.push(args)},
    {get:(target,key)=>key in target?Reflect.get(target,key):()=>{},set:(target,key,value)=>Reflect.set(target,key,value)});
  const canvases:Record<string,unknown>[]=[];
  const createCanvas=()=>{const ctx=context(),canvas={width:1,height:1,style:{},className:'',getContext:()=>ctx,remove:()=>{}};canvases.push(canvas);return canvas;};
  const globals:Record<string,unknown>={document:{createElement:createCanvas,querySelector:()=>null,querySelectorAll:()=>[]},window:{addEventListener:()=>{},removeEventListener:()=>{}},
    MutationObserver:class{observe(){}disconnect(){}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}};
  for(const [key,value]of Object.entries(globals)){descriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  return {measured,draws,canvases,createCanvas,restore(){for(const [key,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}};
}
test('actual LabelLayer ordinary budget skips measurement, while protected labels keep text and baseline raster resolution',()=>{
  const dom=installFakeDom();
  try{
    const layer=new LabelLayer({append:()=>{},getBoundingClientRect:()=>({left:0,top:0,right:1024,bottom:720,width:1024,height:720})} as unknown as HTMLElement);layer.resize(1024,720,1.5);
    const labels:LabelCandidate[]=[{id:'hip:11767',text:'Selected',secondary:'Selected sub',x:100,y:100,priority:100,selected:true},
      {id:'direction:N',text:'North',secondary:'Reference sub',x:270,y:100,priority:90},
      {id:'body:Moon',text:'Moon',secondary:'Body sub',x:440,y:100,priority:80},
      {id:'teaching:phase',text:'Teaching',secondary:'Teaching sub',x:660,y:100,priority:1,qualityProtected:true},
      ...Array.from({length:8},(_,i)=>({id:`hip:${i+1}`,text:`Ordinary ${i}`,secondary:runtimeLabelSecondary({id:`hip:${i+1}`},`Ordinary sub ${i}`,reduced),x:100+i%4*190,y:300+Math.floor(i/4)*150,priority:40-i}))];
    layer.draw(labels,true,4,2);
    const metrics=layer.getCacheMetrics();assert.equal(metrics.ordinaryVisibleCount,2);assert.equal(metrics.protectedVisibleCount,4);
    assert.equal(metrics.secondaryCandidateCount,4);assert.equal(metrics.labelPixelRatio,1.5);assert.equal(metrics.labelCanvasBytes,1536*1080*4);
    assert.ok(!dom.measured.some(t=>t.startsWith('Ordinary sub')));assert.ok(!dom.measured.includes('Ordinary 2'));
    for(const id of ['hip:11767','direction:N','body:Moon','teaching:phase'])assert.ok(layer.getVisibleHitBoxes().some(box=>box.id===id));
    layer.invalidateLayout();layer.draw(labels,true,4,0);assert.equal(layer.getCacheMetrics().ordinaryVisibleCount,0);assert.equal(layer.getCacheMetrics().protectedVisibleCount,4);
    layer.dispose();
  }finally{dom.restore();}
});

/** Extract actual production members without WebGL construction or inline asset imports. */
function rendererMembers(names:readonly string[],deps:Record<string,unknown>={}){
  const tree=ts.createSourceFile('SkyRenderer.ts',readFileSync('src/render/SkyRenderer.ts','utf8'),ts.ScriptTarget.ES2022,true);
  const sourceClass=tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='SkyRenderer') as ts.ClassDeclaration;
  const members=sourceClass.members.filter(m=>m.name&&names.includes(m.name.getText(tree))).map(m=>m.getText(tree)).join('\n');
  const compiled=ts.transpileModule(`class Subject{${members}}return Subject;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function(...Object.keys(deps),compiled)(...Object.values(deps));
}
test('actual WebGL quality setter changes only backing and uDpr; labels/camera/state stay unchanged and capture uses baseline CSS mapping',()=>{
  const dom=installFakeDom();
  try{
    const Subject=rendererMembers(['setRuntimeQuality','applyBackingQuality','getRuntimeQualityCapabilities','capture'],{sameRuntimeRenderQuality,WEBGL_RUNTIME_QUALITY_CAPABILITIES});
    const state=createDefaultState(),stateBefore=JSON.stringify(state),subject=new Subject(),main={width:1728,height:1080},label={width:1728,height:1080};let ratio=1.5,invalidations=0,layouts=0,resizes=0;
    Object.assign(subject,{disposed:false,runtimeQuality:DEFAULT_RUNTIME_RENDER_QUALITY,baselineRatio:1.5,width:1152,height:720,canvas:main,labels:{canvas:label,invalidateLayout:()=>layouts++},
      starMaterial:{uniforms:{uDpr:{value:1.5}}},renderer:{setPixelRatio:(r:number)=>ratio=r,setSize:(w:number,h:number)=>{resizes++;main.width=Math.floor(w*ratio);main.height=Math.floor(h*ratio);}},onCameraChange:()=>invalidations++,
      state,snapshot:null,loupeViewport:null,loupeDiameter:0});
    for(const pixelScale of [1,.85,.70,.55,1] as const){
      const quality={...reduced,pixelScale};subject.setRuntimeQuality(quality);assert.equal(main.width,Math.floor(1152*(1.5*pixelScale)));assert.equal(main.height,Math.floor(720*(1.5*pixelScale)));
      assert.equal(subject.starMaterial.uniforms.uDpr.value,1.5*pixelScale);assert.deepEqual(label,{width:1728,height:1080});assert.equal(JSON.stringify(state),stateBefore);
      const output=dom.createCanvas();Object.assign(output,{toDataURL:()=>`data:${output.width}x${output.height}`});
      const savedCreate=document.createElement;document.createElement=(()=>output) as unknown as typeof document.createElement;
      const before=dom.draws.length;assert.equal(subject.capture(),'data:1728x1080');document.createElement=savedCreate;
      assert.deepEqual(dom.draws.slice(before).map(args=>args.slice(1)),[[0,0,1728,1080],[0,0,1728,1080]]);
    }
    const before=[resizes,invalidations,layouts];subject.setRuntimeQuality({...subject.runtimeQuality});assert.deepEqual([resizes,invalidations,layouts],before);
    assert.equal(subject.getRuntimeQualityCapabilities(),WEBGL_RUNTIME_QUALITY_CAPABILITIES);
  }finally{dom.restore();}
});
test('actual WebGL resize uses the shared coarse-landscape mobile budgets without changing its texture tier or saved camera',()=>{
  const dom=installFakeDom();
  try{
    Object.assign(window,{devicePixelRatio:3,matchMedia:()=>({matches:true})});
    const Subject=rendererMembers(['resize','applyBackingQuality'],{renderBudgetClass,cappedPixelRatio}),subject=new Subject(),state=createDefaultState(),before=JSON.stringify(state);
    const labels:number[][]=[],tiers:string[]=[],main={width:0,height:0};let ratio=0;
    Object.assign(subject,{state,container:{clientWidth:840,clientHeight:390},runtimeQuality:reduced,clearGesture:()=>{},
      renderer:{setPixelRatio:(r:number)=>ratio=r,setSize:(w:number,h:number)=>{main.width=Math.floor(w*ratio);main.height=Math.floor(h*ratio);}},
      labels:{resize:(...args:number[])=>labels.push(args)},starMaterial:{uniforms:{uDpr:{value:0}}},camera:{aspect:1,updateProjectionMatrix:()=>{}},loadMilkyWayTier:(tier:string)=>tiers.push(tier)});
    subject.resize();assert.equal(subject.budgetClass,'mobile');assert.equal(subject.baselineRatio,1.25);assert.equal(ratio,1.25*.55);assert.deepEqual(labels,[[840,390,1.25]]);assert.deepEqual(tiers,['2k']);assert.equal(JSON.stringify(state),before);
    assert.ok(840*390*subject.baselineRatio**2<=1_500_000);
  }finally{dom.restore();}
});
test('actual stage guard releases captures and rejects pointer/wheel/keyboard, while enabling restores stage controls',()=>{
  const Subject=rendererMembers(['setStageInputEnabled','clearGesture','releasePointer','validGestureView','onPointerDown','onPointerMove','onPointerUp','onWheel','onKeyDown'],{THREE,createPointerGesture,EXTERNAL_CAMERA_LIMITS});
  const subject=new Subject(),state=createDefaultState(),before=JSON.stringify(state),captured=new Set([1,2]),released:number[]=[];
  let gesture=createPointerGesture();gesture=reducePointerGesture(gesture,{type:'down',id:1,x:20,y:20}).state;gesture=reducePointerGesture(gesture,{type:'down',id:2,x:80,y:20}).state;
  let invalidations=0,selections=0,inputs=0,prevented=0;
  Object.assign(subject,{state,stageInputEnabled:true,disposed:false,contextLost:false,gesture,gestureView:'ground',capturedPointers:new Set(captured),height:720,
    canvas:{hasPointerCapture:(id:number)=>captured.has(id),releasePointerCapture:(id:number)=>{released.push(id);captured.delete(id);},focus:()=>{}},
    uiBlocksPoint:()=>false,applyPointerInput:()=>inputs++,onCameraChange:()=>invalidations++,onSelect:()=>selections++});
  subject.setStageInputEnabled(false);assert.deepEqual(released,[1,2]);assert.equal(captured.size,0);assert.equal(subject.gesture.pointers.size,0);
  const pointer={button:0,pointerId:1,clientX:20,clientY:20,preventDefault:()=>prevented++};
  subject.onPointerDown(pointer);subject.onPointerMove(pointer);subject.onPointerUp(pointer);subject.onWheel({...pointer,deltaY:100});subject.onKeyDown({key:'ArrowRight',preventDefault:()=>prevented++});subject.onKeyDown({key:'Escape',preventDefault:()=>prevented++});
  assert.equal(JSON.stringify(state),before);assert.equal(invalidations,0);assert.equal(selections,0);assert.equal(inputs,0);assert.equal(prevented,0);
  subject.setStageInputEnabled(true);subject.onKeyDown({key:'ArrowRight',preventDefault:()=>prevented++});assert.equal(state.cameras.ground.azimuthDegNorthEast,createDefaultState().cameras.ground.azimuthDegNorthEast+5);assert.equal(invalidations,1);
  subject.onPointerDown(pointer);assert.equal(inputs,1);assert.equal(prevented,2);
});
