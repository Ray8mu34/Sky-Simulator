import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='qa/m2-render';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1152,height:720},recordVideo:{dir:`${out}/video`,size:{width:1152,height:720}}});
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('console',event=>{if(event.type()==='error'&&/shader|WebGL|GL_INVALID/.test(event.text()))errors.push(event.text());});
const url=process.env.SKY_RENDER_URL??'http://127.0.0.1:5173/';
await page.goto(url);await page.waitForFunction(()=>window.skyApp?.ready&&['uDay','uNight','uClouds'].every(slot=>window.skyApp.diagnostics.assetStatus.loaded.includes(slot)));
const baseline=await page.evaluate(()=>window.skyApp.state);
const ready=()=>page.waitForFunction(()=>!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedMode===window.skyApp.state.viewMode&&window.skyApp.diagnostics.lastRenderedSelection===window.skyApp.state.selected);
const samples=[];
for(const mode of ['ground','space','globe','horizon']){
  await page.evaluate(({mode,baseline})=>{const state=structuredClone(baseline);state.viewMode=mode;state.time.running=false;state.density='teaching';state.selected=null;
    state.layers.celestialEquator=true;state.layers.ecliptic=true;state.layers.celestialPoles=true;state.layers.meridian=mode==='horizon';
    if(mode==='space')state.cameras.space.distanceDisplayUnits=5;window.skyApp.setState(state);},{mode,baseline});
  await ready();await page.waitForTimeout(180);await page.screenshot({path:`${out}/${mode}.png`});
  samples.push(await page.evaluate(()=>({state:window.skyApp.state,snapshot:window.skyApp.snapshot,diagnostics:window.skyApp.rendererDiagnostics,metrics:window.skyApp.metrics})));
}
const nativeLabel=await page.evaluate(()=>window.skyApp.rendererDiagnostics.labelHitBoxes.find(label=>label.id.startsWith('constellation:')));
assert.ok(nativeLabel);await page.mouse.click(nativeLabel.x+nativeLabel.w/2,nativeLabel.y+nativeLabel.h/2);await ready();
assert.equal(await page.evaluate(()=>window.skyApp.state.selected),nativeLabel.id);
await page.screenshot({path:`${out}/native-constellation-label.png`});
const canonical=[];
for(const [selected,expected] of [['hyg:11734','hip:11767'],['constellation:ori','constellation:Ori'],['body:Moon','body:Moon']]){
  await page.evaluate(({selected,baseline})=>{const state=structuredClone(baseline);state.viewMode='globe';state.selected=selected;state.layers.constellationLabels=false;state.layers.brightStarNamesZh=false;window.skyApp.setState(state);},{selected,baseline});
  await ready();await page.evaluate(()=>window.skyApp.focusSelection());await page.waitForTimeout(180);await ready();
  const diagnostic=await page.evaluate(()=>window.skyApp.rendererDiagnostics);canonical.push(diagnostic);
  assert.equal(diagnostic.canonicalSelectedId,expected);assert.equal(diagnostic.selectedOnNearHemisphere,true);assert.equal(diagnostic.selectedVisible,true);
  assert.ok(Math.hypot(...diagnostic.selectedProjectedNdc)<1e-6);
  assert.ok(diagnostic.labelHitBoxes.some(label=>label.id===expected),'selected label must survive ordinary-label toggles');
  if(expected.startsWith('constellation:'))assert.deepEqual(diagnostic.highlightedConstellationIds,['Ori']);
  await page.screenshot({path:`${out}/selected-${expected.split(':')[0]}.png`});
}
await page.evaluate(()=>{const state=window.skyApp.state;state.selected=null;window.skyApp.setState(state);});await ready();
const moonPoint=canonical.at(-1).selectedProjectedNdc;
await page.mouse.click((moonPoint[0]+1)*576,(1-moonPoint[1])*360);await ready();
assert.equal(await page.evaluate(()=>window.skyApp.state.selected),'body:Moon');
const locks=[];
for(const [mode,lock] of [['globe','earth-fixed'],['globe','inertial'],['horizon','inertial'],['horizon','local-horizon']]){
  await page.evaluate(mode=>{const state=window.skyApp.state;state.viewMode=mode;window.skyApp.setState(state);},mode);await ready();
  const before=await page.evaluate(()=>({state:window.skyApp.state,diagnostic:window.skyApp.rendererDiagnostics}));
  await page.locator('#sky-reference-lock').selectOption(lock);await page.waitForTimeout(120);await ready();
  const after=await page.evaluate(()=>({state:window.skyApp.state,diagnostic:window.skyApp.rendererDiagnostics}));
  assert.ok(Math.hypot(...after.diagnostic.viewForwardEqj.map((value,i)=>value-before.diagnostic.viewForwardEqj[i]))<1e-7);
  assert.equal(after.state.time.utDaysJ2000,before.state.time.utDaysJ2000);assert.equal(after.state.selected,before.state.selected);locks.push({lock,before,after});
}
const beforeCollapse=await page.evaluate(()=>window.skyApp.diagnostics.renderCount);
await page.locator('[aria-label="收起控制面板"]').click();await page.waitForTimeout(220);
const afterCollapse=await page.evaluate(()=>({renderCount:window.skyApp.diagnostics.renderCount,labels:window.skyApp.rendererDiagnostics.labelHitBoxes}));
assert.ok(afterCollapse.renderCount>beforeCollapse,'paused occlusion change must invalidate sky once');
await page.waitForTimeout(220);assert.equal(await page.evaluate(()=>window.skyApp.diagnostics.renderCount),afterCollapse.renderCount,'collapsed paused sky must return to idle');
await page.screenshot({path:`${out}/collapsed-labels.png`});
await page.evaluate(()=>{const state=window.skyApp.state;state.selected=null;state.layers.constellationLabels=true;state.layers.brightStarNamesZh=true;window.skyApp.setState(state);});await ready();await page.waitForTimeout(120);
await page.mouse.move(780,290);await page.mouse.down();for(let i=1;i<=24;i++){await page.mouse.move(780+i*5,290+i*2);await page.waitForTimeout(45);}await page.mouse.up();
await page.screenshot({path:`${out}/slow-drag.png`});
await page.evaluate(baseline=>{const state=structuredClone(baseline);state.viewMode='globe';state.selected=null;state.time.running=true;state.time.rateSimSecondsPerRealSecond=600;window.skyApp.setState(state);},baseline);
await ready();const start=await page.evaluate(()=>({renders:window.skyApp.diagnostics.renderCount,layout:window.skyApp.rendererDiagnostics.labelCache.layoutCount}));
await page.waitForTimeout(4000);const end=await page.evaluate(()=>({renders:window.skyApp.diagnostics.renderCount,layout:window.skyApp.rendererDiagnostics.labelCache.layoutCount,cache:window.skyApp.rendererDiagnostics.labelCache}));
assert.ok(end.layout-start.layout<end.renders-start.renders,'collision layout must not run every render');assert.ok(end.cache.glyphBytes<=4*1024*1024);assert.ok(end.cache.placementCount<=512);
await page.evaluate(()=>window.skyApp.pause());await page.waitForTimeout(180);
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await page.screenshot({path:`${out}/portrait-globe.png`});
assert.equal(errors.length,0,errors.join('\n'));
await writeFile(`${out}/report.json`,JSON.stringify({url,browserVersion:browser.version(),samples,canonical,locks,afterCollapse,layoutCadence:{start,end},errors},null,2));
const video=page.video();await context.close();if(video)await video.saveAs(`${out}/four-views-selection-slow-drag.webm`);await browser.close();
console.log(`M2 render passed: ${out}/report.json; layout ${end.layout-start.layout} / ${end.renders-start.renders} renders in 4s`);
