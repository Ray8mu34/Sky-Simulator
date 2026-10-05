// Explicit-token, final-bundle-only QA. Reads public getters; changes only the native night checkbox.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SphereGeometry } from 'three';
import { chromium } from '@playwright/test';

const expectedBuild = process.env.SKY_EARTH_NIGHT_BUILD;
assert.ok(expectedBuild, 'Root build/token required: SKY_EARTH_NIGHT_BUILD; do not run against development');
const expectedModule = process.env.SKY_EARTH_NIGHT_ENTRY;
const expectedModuleSha = process.env.SKY_EARTH_NIGHT_MODULE_SHA;
assert.ok(expectedModule && /^[a-f0-9]{64}$/.test(expectedModuleSha ?? ''), 'Explicit module filename and SHA256 required before browser launch');
const url = process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:4173/';
const out = process.env.SKY_RENDER_OUT ?? 'qa/final-earth-night-terminator/gpu';
const calibrationPath = process.env.SKY_EARTH_NIGHT_SCENE ?? 'qa/final-release/scenes-chrome/V02-calibration.json';
const calibrationBytes = readFileSync(calibrationPath), calibration = JSON.parse(calibrationBytes);
const state = calibration.state;
assert.equal(state.viewMode, 'space'); assert.equal(state.time.running, false);
assert.equal(state.layers.earthNightLights, true);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['src/render/shaders.ts', 'src/render/SkyRenderer.ts', 'src/main.ts', 'src/ui/controls.ts'];
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(path))]));
const sourceBefore = sources();
assert.equal(sourceBefore['src/render/shaders.ts'], '386400c222f0fdf9db6110abf71aea70f22c90e83d4dddc1babfda36db1f996f');
const require = createRequire(import.meta.url), testRequire = createRequire(require.resolve('@playwright/test'));
const playRequire = createRequire(testRequire.resolve('playwright'));
const { PNG } = require(join(dirname(playRequire.resolve('playwright-core')), 'lib/utilsBundle.js'));
mkdirSync(out, { recursive: true });

const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const unit = a => { const n=Math.hypot(...a); return a.map(x=>x/n); };
const multiply = (m,v) => m.map(row=>dot(row,v));
const rotate = (q,v) => {
  const [x,y,z,w]=q, [a,b,c]=v;
  const tx=2*(y*c-z*b), ty=2*(z*a-x*c), tz=2*(x*b-y*a);
  return [a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];
};
// Same fixed mesh tessellation as Earth, used only to bound analytic-sphere vs planar-face normals.
// No renderer/WebGL/context is created by this CPU geometry construction.
const geometry = new SphereGeometry(1,96,64), vertices=geometry.getAttribute('position').array, indices=geometry.index.array;
let innerRadius=1;
for(let i=0;i<indices.length;i+=3){
  const a=Array.from(vertices.slice(indices[i]*3,indices[i]*3+3));
  const b=Array.from(vertices.slice(indices[i+1]*3,indices[i+1]*3+3));
  const c=Array.from(vertices.slice(indices[i+2]*3,indices[i+2]*3+3));
  const u=b.map((x,k)=>x-a[k]),v=c.map((x,k)=>x-a[k]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);
  if(length>1e-12)innerRadius=Math.min(innerRadius,Math.abs(dot(n,a))/length);
}
geometry.dispose();

const report={scope:'Final V02 native night checkbox on/off: actual main WebGL PNG pixels, independent ray/sphere Sun classification; no performance or broad astronomy claim',
  url,expectedBuild,expectedModule,expectedModuleSha,calibrationPath,calibrationSha256:sha(calibrationBytes),calibrationCameraFormulaUsed:false,
  sourceBefore,browserStarted:false,browserClosed:false,contextClosed:false,errors:[],
  maskPolicy:{sunlitMuMinimum:.01,oldLeakBandMu:[.01,.04],darkSideMuMaximum:-.17,
    minimumEyeIncidence:.6,maximumMeshNormalErrorBound:.008,meshInnerRadius:innerRadius,
    exactMuZeroScope:'CPU shader contract tests cover exact zero; GPU pixels exclude AA/mesh/normal rounding boundaries',
    boundDerivation:'Mesh faces enclose inner sphere r_min and lie inside unit sphere; real ray hit is between both near roots. |unit(p_mesh)-unit(p_sphere)| <= 2*rootDelta/r_min. Only samples with this bound <=.008 and eye incidence >=.6 are admitted; .01 mu margin leaves >=.002 before floating-point error.'}};
let browser, context;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});report.browserStarted=true;report.browserVersion=browser.version();report.headless=true;
  context=await browser.newContext({viewport:{width:1152,height:720},deviceScaleFactor:1});
  const page=await context.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/shader|GL_INVALID/i.test(m.text()))report.errors.push(m.text());});
  const moduleResponsePromise=page.waitForResponse(response=>new URL(response.url()).pathname.split('/').at(-1)===expectedModule).catch(()=>null);
  // Uses the ordinary share/import route, not skyApp.setState or private production setters.
  await page.goto(url.split('#')[0]+'#scene='+encodeURIComponent(JSON.stringify(state)));
  const ready=()=>page.waitForFunction(()=>{
    const a=window.skyApp;
    return a?.ready&&!a.diagnostics.scienceDirty&&a.diagnostics.lastRenderedUt===a.state.time.utDaysJ2000
      &&a.graphicsStatus.kind==='webgl2'&&a.diagnostics.assetStatus.pending.length===0&&a.diagnostics.assetStatus.errors.length===0;
  });
  await ready();
  const metadata=await page.evaluate(()=>({buildId:document.querySelector('meta[name="sky-build-id"]')?.content,
    moduleSources:[...document.querySelectorAll('script[type="module"][src]')].map(x=>x.src),
    userAgent:navigator.userAgent,platform:navigator.platform,viewport:[innerWidth,innerHeight],devicePixelRatio}));
  assert.equal(metadata.buildId,expectedBuild);report.environment=metadata;
  assert.ok(metadata.moduleSources.some(x=>new URL(x).pathname.split('/').at(-1)===expectedModule));
  const moduleResponse=await moduleResponsePromise;assert.ok(moduleResponse&&moduleResponse.ok(),'actual loaded module response');
  const moduleBytes=await moduleResponse.body();report.module={url:moduleResponse.url(),sha256:sha(moduleBytes),bytes:moduleBytes.length,status:moduleResponse.status()};
  assert.equal(report.module.sha256,expectedModuleSha,'actual browser-loaded bundle bytes match the frozen artifact');
  const read=async(name)=>{
    const value=await page.evaluate(()=>{
      const a=window.skyApp,c=document.querySelector('.sky-webgl-canvas'),r=c.getBoundingClientRect();
      return {state:a.state,snapshot:a.snapshot,interaction:a.rendererDiagnostics,sky:a.skyAppearanceDiagnostics,
        assets:a.diagnostics.assetStatus,renderCount:a.diagnostics.renderCount,
        stage:{x:r.x,y:r.y,width:r.width,height:r.height},backing:[c.width,c.height],dataUrl:c.toDataURL('image/png')};
    });
    const pngBytes=Buffer.from(value.dataUrl.split(',')[1],'base64');delete value.dataUrl;
    writeFileSync(`${out}/${name}-main.png`,pngBytes);await page.screenshot({path:`${out}/${name}-view.png`});
    return {...value,png:{path:`${out}/${name}-main.png`,sha256:sha(pngBytes)},image:PNG.sync.read(pngBytes)};
  };
  const on=await read('night-on');assert.deepEqual(on.state,state);assert.ok(on.assets.loaded.includes('uNight'));
  const checkbox=page.locator('[data-layer="earthNightLights"]');assert.equal(await checkbox.isChecked(),true);
  const prior=on.renderCount;await checkbox.uncheck();
  await page.waitForFunction(count=>window.skyApp.diagnostics.renderCount>count&&window.skyApp.rendererDiagnostics.earthLayers.nightEnabled===false,prior);
  await ready();const off=await read('night-off');
  const offExpected=structuredClone(state);offExpected.layers.earthNightLights=false;assert.deepEqual(off.state,offExpected);
  assert.deepEqual(off.snapshot,on.snapshot);assert.deepEqual(off.interaction.cameraOrientationQuaternion,on.interaction.cameraOrientationQuaternion);
  assert.deepEqual(off.interaction.cameraPositionDisplay,on.interaction.cameraPositionDisplay);assert.deepEqual(off.sky.frameToDisplay,on.sky.frameToDisplay);
  assert.deepEqual(off.backing,on.backing);assert.deepEqual(off.stage,on.stage);
  const restoreCount=off.renderCount;await checkbox.check();
  await page.waitForFunction(count=>window.skyApp.diagnostics.renderCount>count&&window.skyApp.rendererDiagnostics.earthLayers.nightEnabled===true,restoreCount);
  await ready();assert.deepEqual(await page.evaluate(()=>window.skyApp.state),state);report.originalStateRestored=true;

  const {width,height}=on.image,origin=on.interaction.cameraPositionDisplay,q=on.interaction.cameraOrientationQuaternion;
  const frame=on.sky.frameToDisplay,sunEqj=on.snapshot.bodies.find(b=>b.id==='Sun').geocentricEqjAU;
  const sun=unit(multiply(frame,sunEqj)),fov=on.state.cameras.space.verticalFovDeg;
  const tan=Math.tan(fov*Math.PI/360),aspect=on.stage.width/on.stage.height;
  const stats=()=>({sampleCount:0,changedPixelCount:0,maximumRgbDifference:0,sumAbsoluteRgbDifference:0,minMu:Infinity,maxMu:-Infinity,representativeSamples:[]});
  const categories={sunlit:stats(),formerPositiveLeakBand:stats(),darkSide:stats()};
  const mask=new PNG({width,height});let sphereHits=0,excludedBoundary=0,maximumAcceptedNormalErrorBound=0;
  const add=(target,x,y,mu,differences)=>{
    target.sampleCount++;target.minMu=Math.min(target.minMu,mu);target.maxMu=Math.max(target.maxMu,mu);
    const maximum=Math.max(...differences);target.maximumRgbDifference=Math.max(target.maximumRgbDifference,maximum);
    target.sumAbsoluteRgbDifference+=differences.reduce((a,b)=>a+b,0);if(maximum>0)target.changedPixelCount++;
    if(target.representativeSamples.length<8&&(target.sampleCount%113===0||maximum>0)){
      const at=(y*width+x)*4;target.representativeSamples.push({x,y,mu,on:Array.from(on.image.data.slice(at,at+3)),off:Array.from(off.image.data.slice(at,at+3)),maximumRgbDifference:maximum});
    }
  };
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=(y*width+x)*4;mask.data[at+3]=255;
    const ray=unit(rotate(q,[(2*(x+.5)/width-1)*aspect*tan,(1-2*(y+.5)/height)*tan,-1]));
    const b=dot(origin,ray),discriminant=b*b-(dot(origin,origin)-1);if(discriminant<0)continue;
    const t=-b-Math.sqrt(discriminant);if(t<=0)continue;sphereHits++;
    const n=unit(origin.map((v,k)=>v+t*ray[k])),eyeIncidence=-dot(n,ray);
    const innerDiscriminant=b*b-(dot(origin,origin)-innerRadius*innerRadius);
    if(eyeIncidence<.6||innerDiscriminant<0){excludedBoundary++;continue;}
    const innerT=-b-Math.sqrt(innerDiscriminant),errorBound=2*(innerT-t)/innerRadius;
    if(errorBound>.008){excludedBoundary++;continue;}
    maximumAcceptedNormalErrorBound=Math.max(maximumAcceptedNormalErrorBound,errorBound);
    const mu=dot(n,sun),differences=[0,1,2].map(c=>Math.abs(on.image.data[at+c]-off.image.data[at+c]));
    if(mu>=.01){
      add(categories.sunlit,x,y,mu,differences);mask.data[at]=30;mask.data[at+1]=150;mask.data[at+2]=70;
      if(mu<=.04){add(categories.formerPositiveLeakBand,x,y,mu,differences);mask.data[at]=40;mask.data[at+1]=160;mask.data[at+2]=240;}
    }else if(mu<=-.17){add(categories.darkSide,x,y,mu,differences);mask.data[at]=150;mask.data[at+1]=50;mask.data[at+2]=60;}
  }
  writeFileSync(`${out}/classification-mask.png`,PNG.sync.write(mask));
  report.model={originDisplay:origin,cameraQuaternion:q,frameEqjToDisplay:frame,sunGeocentricEqjAU:sunEqj,sunDisplayUnit:sun,
    sphereRadius:1,verticalFovDeg:fov,cssStage:on.stage,actualBacking:on.backing,
    rayFormula:'pixel centre→NDC→(x*aspect*tan(FOV/2),y*tan(FOV/2),-1)→actual quaternion→unit; near root of |camera+t*ray|=1; normal=unit(hit); mu=normal·unit(frame*Sun.geocentricEqjAU)',
    sphereHits,excludedBoundary,maximumAcceptedNormalErrorBound,classificationMask:'classification-mask.png',
    maskLegend:{green:'mu>=.01 sunlit',blue:'mu .01..04 included within sunlit',red:'mu<=-.17 night',black:'outside/admission-boundary/unused twilight'}};
  report.pixelCategories=categories;
  const summarize=sample=>{const {image,...rest}=sample;return rest;};report.on=summarize(on);report.off=summarize(off);
  assert.ok(categories.sunlit.sampleCount>=1000,'sunlit verification is nonempty');
  assert.ok(categories.formerPositiveLeakBand.sampleCount>=100,'old positive leakage interval has actual admitted pixels');
  assert.equal(categories.sunlit.maximumRgbDifference,0,'every admitted sunlit RGB pixel is identical night on/off');
  assert.equal(categories.formerPositiveLeakBand.maximumRgbDifference,0);
  assert.ok(categories.darkSide.sampleCount>=1000&&categories.darkSide.changedPixelCount>=10&&categories.darkSide.maximumRgbDifference>0,'actual night texture changes dark-side pixels; no empty or unloaded-layer pass');
  assert.equal(report.errors.length,0,report.errors.join('\n'));report.status='passed-final-bundle-actual-pixel-contract';
}catch(error){report.status='failed-evidence-retained';report.failure=error.stack;process.exitCode=1;}
finally{
  try{if(context){await context.close();report.contextClosed=true;}}
  finally{if(browser){await browser.close();report.browserClosed=true;}}
  report.sourceAfter=sources();report.sourceStable=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);
  if(!report.sourceStable){report.status='failed-source-changed';process.exitCode=1;}
  writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({status:report.status,build:report.environment?.buildId,pixels:report.pixelCategories,
  browserClosed:report.browserClosed,contextClosed:report.contextClosed,sourceStable:report.sourceStable,failure:report.failure},null,2));
