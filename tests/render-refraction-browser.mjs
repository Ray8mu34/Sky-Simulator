import { chromium } from '@playwright/test';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {measureRefractionGpu} from './render-refraction-gpu-probe.mjs';
import {measureSunMask} from './render-refraction-pixel-probe.mjs';
import {measureHeavyScene} from './render-refraction-heavy-probe.mjs';
const out=process.env.SKY_RENDER_OUT??'qa/m5c-render/isolated-development';await mkdir(out,{recursive:true});
const headless=process.env.SKY_RENDER_HEADED!=='1';const browser=await chromium.launch({channel:'chrome',headless});const context=await browser.newContext({viewport:{width:1152,height:720}});
const errors=[],samples=[];
const files=['src/core/refraction.ts','src/render/shaders.ts','src/render/SkyRenderer.ts','src/render/RefractionGpuBridge.ts','src/render/RefractedDisc.ts','src/render/SphericalArcBuffer.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const report={scope:'Isolated development single-context shader/mask/native-pick smoke; no UI guard modification or hardware performance claim',sourceBefore:await hashes(),browser:{version:browser.version(),headless},samples,errors};let failure;
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  // An origin-matched document with no application renderer: the probe owns exactly one context.
  await context.route('**/favicon.ico',route=>route.fulfill({status:204}));
  await page.goto('http://127.0.0.1:5173/src/core/refraction.ts');await page.setContent('<link rel="icon" href="data:,"><style>html,body{margin:0;width:100%;height:100%;background:#000}#stage{position:relative;width:100%;height:100%}</style><div id="stage"></div>');
  await page.evaluate(async()=>{
    const [{SkyRenderer},{createDefaultState},{computeSnapshot},{deriveRefractionProfile},{createRefractionDescriptor}]=await Promise.all([
      import('/src/render/SkyRenderer.ts'),import('/src/state.ts'),import('/src/core/astronomy.ts'),import('/src/core/refraction.ts'),import('/src/core/refraction.ts')]);
    window.probe={state:createDefaultState(),computeSnapshot,deriveRefractionProfile,createRefractionDescriptor};
    const p=window.probe;p.state.time.running=false;p.state.presentation='explanation';p.state.illustration.bodySizeScale=35;p.state.environment.refraction='standard';
    p.state.layers.terrain=false;p.state.layers.atmosphere=false;p.state.layers.constellationLabels=false;p.state.layers.brightStarNamesZh=false;
    p.state.time.utDaysJ2000=9752.918523890945;p.state.selected='body:Sun';p.state.cameras.ground.verticalFovDeg=20;
    p.snapshot=computeSnapshot(p.state,1);p.renderer=new SkyRenderer(document.getElementById('stage'),()=>{if(p.renderer)p.renderer.render(p.state,p.snapshot);},id=>{p.state.selected=id;p.renderer.render(p.state,p.snapshot);});
    p.renderer.focusSelection(p.state,p.snapshot);p.renderer.render(p.state,p.snapshot);
  });
  await page.waitForFunction(()=>window.probe.renderer.getAssetStatus().pending.length===0);await page.waitForTimeout(150);
  samples.push(await page.evaluate(()=>({name:'sun-horizon-standard',state:window.probe.state,renderer:window.probe.renderer.getInteractionDiagnostics(),metrics:window.probe.renderer.getMetrics()})));
  await page.screenshot({path:`${out}/sun-horizon-standard.png`});
  assert.equal(samples[0].renderer.groundBodyDiscs.length,2);assert.equal(samples[0].renderer.refraction.enabled,true);
  assert.ok(samples[0].metrics.drawCallsPerFrame<=25);
  const gpu=await measureRefractionGpu(page);
  assert.ok(gpu.maxForwardArcsec<=.25&&gpu.maxInverseArcsec<=.25);report.gpu=gpu;
  report.gpuProfiles=[gpu];
  for(const input of [{refraction:'standard',pressureHpa:1200,temperatureC:-100},{refraction:'standard',pressureHpa:1,temperatureC:80},{refraction:'standard',pressureHpa:0,temperatureC:-100},{refraction:'none',pressureHpa:1200,temperatureC:-100}]){
    await page.evaluate(input=>{const p=window.probe;Object.assign(p.state.environment,input);p.snapshot=p.computeSnapshot(p.state,4);p.renderer.render(p.state,p.snapshot);},input);
    const result=await measureRefractionGpu(page);report.gpuProfiles.push(result);assert.ok(result.maxForwardArcsec<=.25&&result.maxInverseArcsec<=.25);
    assert.equal(result.identity,input.pressureHpa===0||input.refraction==='none');assert.equal(result.enabled,!result.identity);
  }
  await page.evaluate(()=>{const p=window.probe;Object.assign(p.state.environment,{refraction:'standard',pressureHpa:1013.25,temperatureC:15});p.snapshot=p.computeSnapshot(p.state,5);p.renderer.render(p.state,p.snapshot);});
  const sunMask=await measureSunMask(page);await writeFile(`${out}/mask-probe.json`,JSON.stringify({sunMask,gpu},null,2));assert.equal(sunMask.interiorWrongPixels,0);assert.equal(sunMask.backgroundHoles,0);
  report.sunMask=sunMask;
  const native=await page.evaluate(()=>window.probe.renderer.getInteractionDiagnostics().selectionMarkerPixel);await page.mouse.click(native.x,native.y);
  assert.equal(await page.evaluate(()=>window.probe.state.selected),'body:Sun');
  for(const mode of ['none','standard']){
    await page.evaluate(mode=>{const p=window.probe;p.state.environment.refraction=mode;p.state.selected='body:Moon';
      p.state.time.utDaysJ2000=9758.5;
      // Derive a low-altitude fixture solely for this rendering test; this is not an event/golden solver.
      const altitude=lon=>{p.state.observer.longitudeDegEast=lon;return p.computeSnapshot(p.state,2).bodies.find(b=>b.id==='Moon').geometricAltitudeDeg;};
      let lo=-180,hi=-175,last=altitude(lo);for(;hi<=180;lo=hi,hi+=5){const next=altitude(hi);if(last>0&&next<=0)break;last=next;}
      for(let n=0;n<25;n++){const middle=(lo+hi)/2;if(altitude(middle)>0)lo=middle;else hi=middle;}p.state.observer.longitudeDegEast=(lo+hi)/2;
      p.snapshot=p.computeSnapshot(p.state,3);p.renderer.focusSelection(p.state,p.snapshot);p.renderer.render(p.state,p.snapshot);
    },mode);await page.waitForTimeout(100);
    samples.push(await page.evaluate(mode=>({name:`moon-horizon-${mode}`,state:window.probe.state,snapshot:window.probe.snapshot,renderer:window.probe.renderer.getInteractionDiagnostics(),moon:window.probe.renderer.getMoonLoupeDiagnostics(),metrics:window.probe.renderer.getMetrics()}),mode));
    await page.screenshot({path:`${out}/moon-horizon-${mode}.png`});
  }
  if(process.env.SKY_RENDER_EXTENDED==='1'){
    report.physicalScaleSamples=[];
    for(const id of ['Sun','Moon'])for(const mode of ['none','standard']){
      await page.evaluate(({id,mode})=>{const p=window.probe;p.state.viewMode='ground';p.state.environment.refraction=mode;p.state.illustration.bodySizeScale=1;p.state.layers.terrain=true;p.state.layers.atmosphere=true;p.state.selected=`body:${id}`;
        p.state.time.utDaysJ2000=id==='Sun'?9752.918523890945:9764.5;p.state.observer.longitudeDegEast=120.17;
        if(id==='Sun'){
          const altitude=ut=>{p.state.time.utDaysJ2000=ut;return p.computeSnapshot(p.state,10).bodies.find(b=>b.id==='Sun').geometricAltitudeDeg;};
          let lo=9752.918523890945-.01,hi=9752.918523890945;for(let n=0;n<25;n++){const mid=(lo+hi)/2;if(altitude(mid)>.3)lo=mid;else hi=mid;}p.state.time.utDaysJ2000=(lo+hi)/2;
        }
        if(id==='Moon'){
          const altitude=lon=>{p.state.observer.longitudeDegEast=lon;return p.computeSnapshot(p.state,10).bodies.find(b=>b.id==='Moon').geometricAltitudeDeg;};
          let lo=-180,hi=-175,last=altitude(lo);for(;hi<=180;lo=hi,hi+=5){const next=altitude(hi);if(last>1&&next<=1)break;last=next;}
          for(let n=0;n<25;n++){const mid=(lo+hi)/2;if(altitude(mid)>1)lo=mid;else hi=mid;}p.state.observer.longitudeDegEast=(lo+hi)/2;
        }
        p.snapshot=p.computeSnapshot(p.state,11);p.renderer.focusSelection(p.state,p.snapshot);p.renderer.render(p.state,p.snapshot);
      },{id,mode});
      const diagnostic=await page.evaluate(()=>window.probe.renderer.getInteractionDiagnostics());
      report.physicalScaleSamples.push({id,mode,diagnostic,state:await page.evaluate(()=>window.probe.state),snapshot:await page.evaluate(()=>window.probe.snapshot)});
      await page.screenshot({path:`${out}/physical-${id.toLowerCase()}-${mode}-terrain.png`});
      await page.screenshot({path:`${out}/physical-${id.toLowerCase()}-${mode}-terrain-crop.png`,clip:{x:510,y:312,width:132,height:96}});
      if(id==='Sun'&&mode==='standard'){const result=await measureSunMask(page);report.physicalSunMask=result;assert.equal(result.interiorWrongPixels,0);assert.equal(result.backgroundHoles,0);}
      await page.evaluate(()=>{const p=window.probe;p.state.layers.terrain=false;p.renderer.render(p.state,p.snapshot);});
      await page.screenshot({path:`${out}/physical-${id.toLowerCase()}-${mode}-full-disc.png`,clip:{x:510,y:312,width:132,height:96}});
      if(id==='Sun'&&mode==='standard'){report.physicalSunFullMask=await measureSunMask(page);assert.ok(report.physicalSunFullMask.deepInteriorSamples>0);assert.equal(report.physicalSunFullMask.backgroundHoles,0);}
    }
    report.externalIdentity=[];
    for(const mode of ['space','globe','horizon']){
      const hashes=[];for(const refraction of ['none','standard']){
        hashes.push(await page.evaluate(async({mode,refraction})=>{const p=window.probe;p.state.viewMode=mode;p.state.environment.refraction=refraction;p.state.layers.terrain=false;p.state.layers.atmosphere=true;p.state.illustration.bodySizeScale=1;p.snapshot=p.computeSnapshot(p.state,12);p.renderer.render(p.state,p.snapshot);
          const gl=p.renderer.renderer.getContext(),data=new Uint8Array(p.renderer.canvas.width*p.renderer.canvas.height*4);gl.readPixels(0,0,p.renderer.canvas.width,p.renderer.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
          const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');return {hash,diagnostic:p.renderer.getInteractionDiagnostics()};
        },{mode,refraction}));
      }assert.equal(hashes[0].hash,hashes[1].hash);report.externalIdentity.push({mode,hash:hashes[0].hash,identity:hashes[1].diagnostic.refraction.identity});
      await page.screenshot({path:`${out}/${mode}-geometric-standard.png`});
    }
    report.hiddenRecovery=await page.evaluate(async()=>{
      const {catalog}=await import('/src/data/catalog.ts');const p=window.probe;p.state.viewMode='ground';p.state.layers.constellationLines=false;p.state.selected=null;
      p.state.environment.pressureHpa=1200;p.state.environment.temperatureC=-100;p.state.cameras.ground.verticalFovDeg=20;
      const before=p.renderer.getInteractionDiagnostics();let maxPending=0;
      const indexCounts=[];for(let i=0;i<24;i++){p.state.cameras.ground.azimuthDegNorthEast=i*15;p.state.cameras.ground.altitudeDeg=i*3-30;p.state.time.utDaysJ2000+=3;p.snapshot=p.computeSnapshot(p.state,20+i);p.renderer.render(p.state,p.snapshot);const d=p.renderer.getInteractionDiagnostics();indexCounts.push(d.sphericalArcs.indexCount);maxPending=Math.max(maxPending,d.pendingBufferUpdates.ordinaryIndices.length);}
      p.state.layers.constellationLines=true;const ids=[];for(const figure of catalog.constellations){p.state.selected=`constellation:${figure.id}`;p.renderer.render(p.state,p.snapshot);const d=p.renderer.getInteractionDiagnostics();ids.push({geometry:d.highlightGeometryId,index:d.highlightIndexAttributeId,shared:d.highlightPositionAttributeIsShared,count:d.highlightDrawRangeCount});}
      const after=p.renderer.getInteractionDiagnostics(),gl=p.renderer.renderer.getContext(),original=gl.drawElements;let gpuReadback=null;
      gl.drawElements=function(mode,count,type,offset){
        if(mode===gl.LINES&&type===gl.UNSIGNED_INT&&count===p.renderer.arcBuffer.result.indexCount){
          const indices=new Uint32Array(count);gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER,offset,indices);
          const location=gl.getAttribLocation(gl.getParameter(gl.CURRENT_PROGRAM),'position'),buffer=gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),previous=gl.getParameter(gl.ARRAY_BUFFER_BINDING);
          const positions=new Float32Array(p.renderer.arcBuffer.positions.length);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.getBufferSubData(gl.ARRAY_BUFFER,0,positions);gl.bindBuffer(gl.ARRAY_BUFFER,previous);
          let indexMismatches=0,positionMismatches=0;for(let i=0;i<count;i++){
            if(indices[i]!==p.renderer.arcBuffer.ordinaryIndex[i])indexMismatches++;
            const at=indices[i]*3;for(let component=0;component<3;component++)if(positions[at+component]!==p.renderer.arcBuffer.positions[at+component])positionMismatches++;
          }gpuReadback={indexCount:count,indexMismatches,positionMismatches,glError:gl.getError()};
        }return original.call(gl,mode,count,type,offset);
      };
      try{p.renderer.render(p.state,p.snapshot);}finally{gl.drawElements=original;}
      return {maxPending,indexCounts,before,after,ids,gpuReadback,indexVersion:p.renderer.constellationLines.geometry.index.version};
    });
    assert.equal(report.hiddenRecovery.maxPending,1);assert.ok(new Set(report.hiddenRecovery.indexCounts).size>1);assert.equal(report.hiddenRecovery.after.pendingBufferUpdates.ordinaryIndices.length,0);
    assert.equal(new Set(report.hiddenRecovery.ids.map(id=>id.geometry)).size,1);assert.equal(new Set(report.hiddenRecovery.ids.map(id=>id.index)).size,1);assert.ok(report.hiddenRecovery.ids.every(id=>id.shared&&id.count>0));
    assert.ok(report.hiddenRecovery.gpuReadback);assert.equal(report.hiddenRecovery.gpuReadback.indexMismatches,0);assert.equal(report.hiddenRecovery.gpuReadback.positionMismatches,0);assert.equal(report.hiddenRecovery.gpuReadback.glError,0);
  }
  if(process.env.SKY_RENDER_HEAVY==='1'){report.heavy=await measureHeavyScene(page);assert.ok(report.heavy.rows.every(row=>row.drawCalls<=25&&row.ownedGpuEstimate<=96*1024*1024));}
  assert.deepEqual(errors,[]);
}catch(error){failure=error;report.failure=String(error);}
finally{await context.close();await browser.close();report.browserClosed=true;report.sourceAfter=await hashes();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));}
assert.deepEqual(report.sourceAfter,report.sourceBefore);if(failure)throw failure;
console.log(`${out}/report.json; browser closed`);
