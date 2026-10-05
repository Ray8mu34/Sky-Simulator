import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {computeMoonQuarterSequence} from '../src/core/moon.ts';
const out='qa/m3-render';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1152,height:720}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('console',event=>{if(event.type()==='error'&&/shader|WebGL|GL_INVALID/.test(event.text()))errors.push(event.text());});
const url=process.env.SKY_RENDER_URL??'http://127.0.0.1:5173/';await page.goto(url);
await page.waitForFunction(()=>window.skyApp?.ready&&window.skyApp.diagnostics.assetStatus.loaded.includes('uMoon'));
const baseline=await page.evaluate(()=>window.skyApp.state),events=computeMoonQuarterSequence(9580).events;
const phases=[['new',events.find(e=>e.phaseLongitudeDeg===0).utDaysJ2000],['crescent',events.find(e=>e.phaseLongitudeDeg===0).utDaysJ2000+2],['quarter',events.find(e=>e.phaseLongitudeDeg===90).utDaysJ2000],['full',events.find(e=>e.phaseLongitudeDeg===180).utDaysJ2000]];
const ready=()=>page.waitForFunction(()=>!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedMode===window.skyApp.state.viewMode&&window.skyApp.moonLoupeDiagnostics?.status==='ready');
await page.locator('#sky-teaching').evaluate(e=>{e.open=true;});await page.locator('#sky-moon-loupe-toggle').click();await page.waitForTimeout(160);
async function pixels(){return page.evaluate(()=>{
  const diag=window.skyApp.moonLoupeDiagnostics,canvas=document.querySelector('.sky-webgl-canvas'),bounds=canvas.getBoundingClientRect(),rect=diag.viewportCssRect;
  const surface=document.createElement('canvas');surface.width=canvas.width;surface.height=canvas.height;const ctx=surface.getContext('2d');ctx.drawImage(canvas,0,0);const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const ratio=canvas.width/bounds.width,cx=(rect.left-bounds.left+rect.width/2)*ratio,cy=(rect.top-bounds.top+rect.height/2)*ratio,r=diag.loupeDiameterCssPx*ratio/2;
  let disk=0,lit=0,sum=0,momentX=0,momentY=0;const radial=[];
  for(let y=Math.ceil(cy-r);y<cy+r;y++)for(let x=Math.ceil(cx-r);x<cx+r;x++){
    const nx=(x+.5-cx)/r,ny=(cy-y-.5)/r;if(nx*nx+ny*ny>=.999)continue;
    const offset=(y*canvas.width+x)*4,value=Math.max(bytes[offset],bytes[offset+1],bytes[offset+2]);disk++;if(value>2){lit++;momentX+=nx;momentY+=ny;}sum+=value;
    if(Math.abs(ny)<.04)radial.push(value);
  }
  return {diag,ratio,disk,lit,fraction:lit/disk,lambertBrightnessMean:sum/disk,litCentroid:[momentX/Math.max(lit,1),momentY/Math.max(lit,1)],radial,metrics:window.skyApp.metrics,assets:window.skyApp.diagnostics.assetStatus};
});}
const samples=[];
for(const hemisphere of ['north','south'])for(const [phase,ut] of phases){
  await page.evaluate(({baseline,hemisphere,ut})=>{const state=structuredClone(baseline);state.time.utDaysJ2000=ut;state.time.running=false;state.presentation='explanation';state.illustration.bodySizeScale=1;state.viewMode='ground';state.selected='body:Moon';state.observer.latitudeDeg=hemisphere==='north'?30:-30;state.layers.terrain=false;window.skyApp.setState(state);},{baseline,hemisphere,ut});
  await ready();await page.evaluate(()=>window.skyApp.focusSelection());await ready();await page.waitForTimeout(150);
  const sample=await pixels();samples.push({hemisphere,phase,...sample});assert.equal(sample.diag.perspective,'topocentric');
  assert.equal(sample.diag.mainMoonMaterialId,sample.diag.loupeMoonMaterialId);assert.equal(sample.diag.mainMoonGeometryId,sample.diag.loupeMoonGeometryId);
  assert.ok(Math.abs(sample.fraction-sample.diag.illuminatedFraction)<.025,`${phase} actual lit area ${sample.fraction} vs ${sample.diag.illuminatedFraction}`);
  if(phase==='quarter'||phase==='crescent')assert.ok(sample.litCentroid[0]*sample.diag.loupeBrightLimbScreenUnit[0]+sample.litCentroid[1]*sample.diag.loupeBrightLimbScreenUnit[1]>0,'lit pixels point toward physical Sun');
  assert.ok(sample.diag.magnificationRelativeToMain>1);assert.ok(sample.metrics.drawCallsPerFrame<=25);
  await page.screenshot({path:`${out}/${hemisphere}-${phase}.png`});
}
const orbits=[];
for(const mode of ['space','globe','horizon'])for(const [phase,ut] of phases.filter(([phase])=>phase!=='new')){
  await page.evaluate(({baseline,mode,ut})=>{const state=structuredClone(baseline);state.time.utDaysJ2000=ut;state.time.running=false;state.presentation='explanation';state.illustration.bodySizeScale=1;state.viewMode=mode;state.selected='body:Moon';window.skyApp.setState(state);},{baseline,mode,ut});await ready();await page.evaluate(()=>window.skyApp.focusSelection());await ready();await page.waitForTimeout(130);
  const before=await pixels();assert.equal(before.diag.perspective,'geocentric');assert.ok(Math.abs(before.fraction-before.diag.illuminatedFraction)<.025);await page.screenshot({path:`${out}/${mode}-${phase}.png`});
  await page.mouse.move(770,300);await page.mouse.down();for(let i=1;i<=16;i++){await page.mouse.move(770+i*7,300+i*2);await page.waitForTimeout(25);}await page.mouse.up();await page.waitForTimeout(130);
  const after=await pixels();assert.equal(after.diag.utDaysJ2000,before.diag.utDaysJ2000);assert.equal(after.diag.illuminatedFraction,before.diag.illuminatedFraction);assert.ok(Math.abs(after.fraction-before.fraction)<.02,'display orbit must preserve phase area');
  orbits.push({mode,phase,before,after});
}
// A magnified quarter Moon's dark hemisphere must actually occlude stars/lines in the main scene.
await page.evaluate(({baseline,ut})=>{const state=structuredClone(baseline);state.time.running=false;state.time.utDaysJ2000=ut;state.viewMode='ground';state.selected='body:Moon';state.presentation='explanation';state.illustration.bodySizeScale=35;state.layers.terrain=false;state.layers.atmosphere=false;state.layers.constellationLabels=false;state.layers.brightStarNamesZh=false;state.layers.horizon=false;state.layers.ecliptic=false;state.layers.celestialEquator=false;state.layers.celestialPoles=false;window.skyApp.setState(state);},{baseline,ut:phases.find(([name])=>name==='quarter')[1]});
await ready();await page.evaluate(()=>window.skyApp.focusSelection());await ready();await page.evaluate(()=>{const state=window.skyApp.state;state.selected=null;window.skyApp.setState(state);});await ready();await page.waitForTimeout(120);
await page.evaluate(()=>{const canvas=document.querySelector('.sky-webgl-canvas'),ctx=document.createElement('canvas');ctx.width=canvas.width;ctx.height=canvas.height;const c=ctx.getContext('2d');c.drawImage(canvas,0,0);window.__moonOcclusionProbe={on:c.getImageData(0,0,canvas.width,canvas.height).data,hit:window.skyApp.rendererDiagnostics.bodyHitTargets.find(b=>b.id==='body:Moon'),bright:window.skyApp.moonLoupeDiagnostics.mainBrightLimbScreenUnit};});
await page.screenshot({path:`${out}/main-dark-disc-opaque.png`});
await page.evaluate(()=>{const state=window.skyApp.state;state.layers.sunMoon=false;window.skyApp.setState(state);});await ready();await page.waitForTimeout(120);
const occlusion=await page.evaluate(()=>{const canvas=document.querySelector('.sky-webgl-canvas'),bounds=canvas.getBoundingClientRect(),surface=document.createElement('canvas');surface.width=canvas.width;surface.height=canvas.height;const ctx=surface.getContext('2d');ctx.drawImage(canvas,0,0);const off=ctx.getImageData(0,0,canvas.width,canvas.height).data,{on,hit,bright}=window.__moonOcclusionProbe,ratio=canvas.width/bounds.width;let backgroundSignals=0,covered=0,leaked=0;
  for(let y=Math.ceil((hit.y-hit.radius)*ratio);y<(hit.y+hit.radius)*ratio;y++)for(let x=Math.ceil((hit.x-hit.radius)*ratio);x<(hit.x+hit.radius)*ratio;x++){const nx=(x/ratio-hit.x)/hit.radius,ny=(hit.y-y/ratio)/hit.radius;if(nx*nx+ny*ny>.55||nx*bright[0]+ny*bright[1]>-.2)continue;const p=(y*canvas.width+x)*4,a=Math.max(off[p],off[p+1],off[p+2]),b=Math.max(on[p],on[p+1],on[p+2]);if(a>25){backgroundSignals++;if(b<5)covered++;else leaked++;}}
  delete window.__moonOcclusionProbe;return{backgroundSignals,covered,leaked,hit};});
assert.ok(occlusion.backgroundSignals>10,'fixture needs real sky points/lines behind dark disc');assert.equal(occlusion.leaked,0,'no point/line may redraw through opaque lunar dark face');
// Pause loupe close/open cannot change any scientific state or produce an idle redraw loop.
const beforeToggle=await page.evaluate(()=>window.skyApp.state);await page.locator('#sky-moon-loupe-close').click();await page.waitForTimeout(140);const idle=await page.evaluate(()=>window.skyApp.diagnostics.renderCount);await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>window.skyApp.diagnostics.renderCount),idle);assert.deepEqual(await page.evaluate(()=>window.skyApp.state),beforeToggle);
await page.locator('#sky-moon-loupe-toggle').click();await page.waitForTimeout(160);assert.deepEqual(await page.evaluate(()=>window.skyApp.state),beforeToggle);
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.screenshot({path:`${out}/portrait-loupe.png`});
assert.equal(errors.length,0,errors.join('\n'));await writeFile(`${out}/report.json`,JSON.stringify({url,browserVersion:browser.version(),events,samples,orbits,occlusion,errors},null,2));
await context.close();await browser.close();console.log(`M3 render phases/orbits passed: ${out}/report.json`);
