import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const out=process.env.SKY_RENDER_OUT??'qa/m6-render/development';await mkdir(out,{recursive:true});
const files=['src/render/SkyRenderer.ts','src/render/LabelLayer.ts','src/render/RenderQuality.ts','src/render/shaders.ts','src/core/refraction.ts','src/render/SphericalArcBuffer.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const report={scope:'Development, one isolated real renderer, quality/capture/native input function checks; no frame-rate or physical-device claim',sourceBefore:await hashes(),samples:[],errors:[],emulation:{viewport:[1152,720],deviceScaleFactor:1.5}};
const browser=await chromium.launch({channel:'chrome',headless:false});report.browserVersion=browser.version();
const context=await browser.newContext({viewport:{width:1152,height:720},deviceScaleFactor:1.5});let failure;
try{
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
  await context.route('**/favicon.ico',route=>route.fulfill({status:204}));
  await page.goto('http://127.0.0.1:5173/src/core/refraction.ts');await page.setContent('<link rel="icon" href="data:,"><style>html,body{margin:0;width:100%;height:100%;background:#020407}#stage{position:relative;width:100%;height:100%}#fixture-close{position:fixed;right:8px;bottom:8px;z-index:10}</style><div id="stage"></div><button id="fixture-close">关闭夹具面板</button>');
  await page.evaluate(async()=>{
    const [{SkyRenderer},{createDefaultState},{computeSnapshot},{DEFAULT_RUNTIME_RENDER_QUALITY}]=await Promise.all([import('/src/render/SkyRenderer.ts'),import('/src/state.ts'),import('/src/core/astronomy.ts'),import('/src/platform/runtime-quality-contract.ts')]);
    const p=window.probe={state:createDefaultState(),baseQuality:DEFAULT_RUNTIME_RENDER_QUALITY,invalidations:0,picks:[],closeClicks:0};
    p.state.time.running=false;p.state.viewMode='globe';p.state.density='reference';p.state.layers.secondaryNames=true;p.state.layers.backHemisphere=true;p.state.selected='hip:11767';
    p.snapshot=computeSnapshot(p.state,1);p.renderer=new SkyRenderer(document.getElementById('stage'),()=>p.invalidations++,id=>p.picks.push(id));
    p.renderer.focusSelection(p.state,p.snapshot);p.renderer.render(p.state,p.snapshot);
    document.getElementById('fixture-close').addEventListener('click',()=>p.closeClicks++);
  });
  await page.waitForFunction(()=>window.probe.renderer.getAssetStatus().pending.length===0);await page.waitForTimeout(100);
  report.identity=await page.evaluate(()=>{const p=window.probe,gl=p.renderer.canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');p.renderer.render(p.state,p.snapshot);return{state:JSON.stringify(p.state),snapshot:JSON.stringify(p.snapshot),vendor:gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),capabilities:p.renderer.getRuntimeQualityCapabilities()};});
  let baselineMarker,baselineLabelSize,baselineSceneIds,baselineLookupCost,baselineSecondaryCount;
  for(const [name,labels,pixelScale] of [['baseline',false,1],['labels',true,1],['pixels85',true,.85],['pixels70',true,.70],['pixels55',true,.55],['restored',false,1]]){
    const sample=await page.evaluate(({name,labels,pixelScale})=>{
      const p=window.probe,r=p.renderer,quality={...p.baseQuality,hideOrdinaryBackLabels:labels,hideOrdinarySecondaryLabels:labels,ordinaryLabelBudgetScale:labels ? .5 : 1,pixelScale};
      const before=r.getInteractionDiagnostics().labelCache;r.setRuntimeQuality(quality);r.render(p.state,p.snapshot);r.render(p.state,p.snapshot);
      const diagnostics=r.getInteractionDiagnostics(),capture=r.capture();
      return{name,diagnostics,metrics:r.getMetrics(),state:JSON.stringify(p.state),snapshot:JSON.stringify(p.snapshot),capture,
        widthLookupDelta:diagnostics.labelCache.widthLookupCount-before.widthLookupCount,measuredWidthDelta:diagnostics.labelCache.measuredWidthCount-before.measuredWidthCount,glyphDelta:diagnostics.labelCache.rasterizedGlyphCount-before.rasterizedGlyphCount};
    },{name,labels,pixelScale});
    assert.equal(sample.state,report.identity.state);assert.equal(sample.snapshot,report.identity.snapshot);
    const d=sample.diagnostics,q=d.runtimeQualityConsumption;assert.equal(q.effectivePixelRatio,q.baselinePixelRatio*pixelScale);assert.deepEqual(q.cssViewportSize,[1152,720]);
    assert.equal(q.starDprUniform,q.effectivePixelRatio);assert.equal(d.labelCache.labelPixelRatio,q.baselinePixelRatio);
    if(name==='baseline'){baselineMarker=d.selectionMarkerPixel;baselineLabelSize=q.labelBackingSize;baselineSceneIds=[d.starMotion.positionAttributeId,d.highlightGeometryId,d.highlightIndexAttributeId];baselineSecondaryCount=d.labelCache.secondaryCandidateCount;baselineLookupCost=sample.widthLookupDelta;}
    assert.deepEqual(d.selectionMarkerPixel,baselineMarker);assert.deepEqual(q.labelBackingSize,baselineLabelSize);assert.deepEqual([d.starMotion.positionAttributeId,d.highlightGeometryId,d.highlightIndexAttributeId],baselineSceneIds);
    assert.ok(d.labelHitBoxes.some(box=>box.id==='hip:11767'));assert.ok(d.labelCache.protectedVisibleCount>0);
    if(labels){assert.ok(q.ordinarySecondaryCandidatesOmitted>0);assert.ok(q.ordinaryBackCandidatesSkipped>0);assert.ok(d.labelCache.secondaryCandidateCount<baselineSecondaryCount);assert.ok(d.labelCache.ordinaryVisibleCount<=30);assert.ok(sample.widthLookupDelta<baselineLookupCost);}
    const png=Buffer.from(sample.capture.split(',')[1],'base64');assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],baselineLabelSize);await writeFile(`${out}/${name}-capture.png`,png);
    delete sample.capture;report.samples.push(sample);
    await page.mouse.click(baselineMarker.x,baselineMarker.y);assert.equal(await page.evaluate(()=>window.probe.picks.at(-1)),'hip:11767');
  }
  // Native capture in progress must be released before late up/wheel/keyboard events.
  await page.mouse.move(300,300);await page.mouse.down();
  const active=await page.evaluate(()=>window.probe.renderer.getInteractionDiagnostics().gesture);assert.ok(active.capturedPointerIds.length>0);
  const guardBefore=await page.evaluate(()=>{const p=window.probe;p.renderer.setStageInputEnabled(false);return{state:JSON.stringify(p.state),picks:p.picks.length,diagnostics:p.renderer.getInteractionDiagnostics()};});
  assert.equal(guardBefore.diagnostics.gesture.capturedPointerIds.length,0);assert.equal(guardBefore.diagnostics.gesture.activePointerIds.length,0);
  await page.mouse.move(360,330);await page.mouse.up();await page.mouse.wheel(0,150);await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');
  await page.locator('#fixture-close').click();
  const guardAfter=await page.evaluate(()=>({state:JSON.stringify(window.probe.state),picks:window.probe.picks.length,closeClicks:window.probe.closeClicks}));
  assert.equal(guardAfter.state,guardBefore.state);assert.equal(guardAfter.picks,guardBefore.picks);assert.equal(guardAfter.closeClicks,1);
  await page.evaluate(()=>window.probe.renderer.setStageInputEnabled(true));await page.mouse.click(baselineMarker.x,baselineMarker.y);assert.equal(await page.evaluate(()=>window.probe.picks.at(-1)),'hip:11767');
  report.stageGuard={nativeCapturedBefore:active.capturedPointerIds,afterDisable:guardBefore.diagnostics.gesture,lateInputsIgnored:true,fixtureControlStillEnabled:true,enabledNativePickRestored:true};
  // Ground consumes exactly the same override without modifying atmosphere/science geometry.
  const ground=await page.evaluate(()=>{const p=window.probe;p.state.viewMode='ground';p.renderer.setRuntimeQuality({...p.baseQuality,hideOrdinarySecondaryLabels:true,hideOrdinaryBackLabels:true,ordinaryLabelBudgetScale:.5,pixelScale:.55});p.renderer.focusSelection(p.state,p.snapshot);p.renderer.render(p.state,p.snapshot);return{diagnostics:p.renderer.getInteractionDiagnostics(),capture:p.renderer.capture(),snapshot:JSON.stringify(p.snapshot)};});
  assert.equal(ground.snapshot,report.identity.snapshot);await writeFile(`${out}/ground-pixels55.png`,Buffer.from(ground.capture.split(',')[1],'base64'));delete ground.capture;report.ground=ground;
  assert.equal(report.errors.length,0);assert.deepEqual(await hashes(),report.sourceBefore);report.status='passed-development-quality-capture-native-input';
}catch(error){failure=error;report.status='failed';report.failure=error.stack??String(error);}
finally{
  for(const page of context.pages())try{await page.evaluate(()=>window.probe?.renderer?.dispose());}catch{}
  await context.close();await browser.close();report.browserClosed=true;report.sourceAfter=await hashes();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({status:report.status,browserClosed:report.browserClosed,samples:report.samples.length,output:out,failure:report.failure}));if(failure)throw failure;
