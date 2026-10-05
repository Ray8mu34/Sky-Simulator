// Promotional captures of the unchanged frozen application, not an acceptance/performance suite.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createDefaultState, loadAcceptanceScene, loadSkyTeachingScene } from '../src/state.ts';

const out='media/screenshots',url='http://127.0.0.1:4173/';
const buildId='2966df95ea4fbc32',moduleName='index-DrZppIQ6.js';
const moduleSha='ea9a85063d60ea6c8cc01bd8b3d915f63957a2e8acb81a5e633cb753889bef26';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
mkdirSync(out,{recursive:true});
const ground=loadAcceptanceScene('V01');ground.density='teaching';ground.time.running=false;
const earth=JSON.parse(readFileSync('qa/final-release/scenes-chrome/V02-calibration.json')).state;earth.density='teaching';
const celestial=JSON.parse(readFileSync('qa/final-release/scenes-chrome/V03-calibration.json')).state;
celestial.density='teaching';celestial.layers.horizon=false;celestial.layers.celestialEquator=true;celestial.layers.ecliptic=true;
const horizon=createDefaultState();horizon.time.utDaysJ2000=ground.time.utDaysJ2000;horizon.time.running=false;
horizon.viewMode='horizon';horizon.presentation='explanation';horizon.density='teaching';horizon.layers.celestialEquator=true;horizon.layers.meridian=true;
const moon=JSON.parse(readFileSync('qa/m3b-render/moon-risk-report.json')).samples.find(s=>s.name==='city-night-moon').state;
moon.presentation='explanation';moon.illustration.bodySizeScale=20;moon.environment.artificialSkyBrightness=0;
moon.layers.atmosphere=false;moon.layers.terrain=false;moon.layers.horizon=false;moon.layers.constellationLines=false;
moon.layers.constellationLabels=false;moon.layers.brightStarNamesZh=false;moon.layers.milkyWay=false;
moon.selected='body:Moon';moon.cameras.ground.verticalFovDeg=20;moon.density='teaching';
const galaxy=loadSkyTeachingScene('G01');galaxy.density='teaching';galaxy.time.running=false;
galaxy.layers.constellationLines=false;galaxy.layers.constellationLabels=false;galaxy.layers.brightStarNamesZh=false;
const cases=[
  {name:'overview-ground',state:ground,ui:true,title:'地表：当地地平与北天星图'},
  {name:'overview-earth',state:earth,ui:false,title:'太空：地球受光、云层与背光城市夜灯'},
  {name:'overview-celestial',state:celestial,ui:false,title:'天球：恒星方向、黄道与天赤道'},
  {name:'overview-horizon',state:horizon,ui:true,title:'地平天球：当地水平面与天球参考线'},
  {name:'feature-moon',state:moon,ui:false,moon:true,title:'月相：20×教学月盘与同快照科学放大镜'},
  {name:'feature-milky-way',state:galaxy,ui:false,title:'银河：暗夜场景中的低饱和积分背景'}
];
const manifest={buildId,moduleName,moduleSha256:moduleSha,viewport:[1920,1080],pixelSource:'Unmodified production application; real page screenshots',
  scope:'Promotional media only; no new accuracy/performance acceptance claims',captures:[],errors:[],browserClosed:false,contextClosed:false};
let browser,context;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});manifest.browserVersion=browser.version();
  context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  const page=await context.newPage();page.on('pageerror',e=>manifest.errors.push(e.message));
  const ready=()=>page.waitForFunction(()=>{const a=window.skyApp;return a?.ready&&!a.diagnostics.scienceDirty
    &&a.diagnostics.lastRenderedUt===a.state.time.utDaysJ2000&&a.diagnostics.lastRenderedMode===a.state.viewMode
    &&a.diagnostics.assetStatus.pending.length===0&&a.diagnostics.assetStatus.errors.length===0;});
  for(const entry of cases){
    // A new document is required: changing only #scene is a same-document URL navigation.
    await page.goto('about:blank');
    const moduleResponsePromise=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/'+moduleName)).catch(()=>null);
    await page.goto(url+'#scene='+encodeURIComponent(JSON.stringify(entry.state)));await ready();
    assert.equal(await page.evaluate(()=>window.skyApp.state.viewMode),entry.state.viewMode);
    assert.equal(await page.locator('meta[name="sky-build-id"]').getAttribute('content'),buildId);
    const response=await moduleResponsePromise;assert.ok(response);assert.equal(sha(await response.body()),moduleSha);
    if(entry.moon){
      const prior=await page.evaluate(()=>window.skyApp.diagnostics.renderCount);
      await page.locator('[data-action="focus-selection"]').click();
      await page.waitForFunction(n=>window.skyApp.diagnostics.renderCount>n,prior);await ready();
      await page.locator('#sky-teaching > summary').click();
      await page.locator('#sky-moon-loupe-toggle').click();
      await page.waitForFunction(()=>!document.querySelector('#sky-moon-loupe').hidden&&window.skyApp.moonLoupeDiagnostics.status==='ready');
    }
    if(!entry.ui)await page.locator('#sky-control-panel [data-action="close"]').click();
    await page.waitForTimeout(240);
    const data=await page.evaluate(()=>{const a=window.skyApp;return {state:a.state,
      utc:new Date(946728000000+a.snapshot.utDaysJ2000*86400000).toISOString(),
      sunAltitudeDeg:a.snapshot.bodies.find(b=>b.id==='Sun').geometricAltitudeDeg,
      moonAltitudeDeg:a.snapshot.bodies.find(b=>b.id==='Moon').geometricAltitudeDeg,
      moonIlluminatedFraction:a.moonLoupeDiagnostics?.illuminatedFraction,
      scopeNote:document.querySelector('.compact-mode-note')?.textContent};});
    const path=`${out}/${entry.name}.png`;await page.screenshot({path});
    manifest.captures.push({file:`${entry.name}.png`,title:entry.title,fullSidebarVisible:entry.ui,
      sha256:sha(readFileSync(path)),...data});
    console.log(`${entry.name}.png: ${data.utc}, Moon altitude ${data.moonAltitudeDeg.toFixed(1)}°`);
  }
}catch(e){manifest.failure=e.stack;process.exitCode=1;}
finally{
  try{if(context){await context.close();manifest.contextClosed=true;}}
  finally{if(browser){await browser.close();manifest.browserClosed=true;}}
  writeFileSync(`${out}/capture-manifest.json`,JSON.stringify(manifest,null,2));
}
console.log(JSON.stringify({captures:manifest.captures.map(x=>x.file),errors:manifest.errors,failure:manifest.failure,browserClosed:manifest.browserClosed}));
