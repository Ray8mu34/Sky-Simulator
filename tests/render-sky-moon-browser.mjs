import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {computeMoonQuarterSequence} from '../src/core/moon.ts';
import {createDefaultState,loadSkyTeachingScene} from '../src/state.ts';
const out=process.env.SKY_RENDER_OUT??'qa/m3b-render';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1152,height:720}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error'&&/shader|WebGL|GL_INVALID/.test(e.text()))errors.push(e.text());});
const url=process.env.SKY_RENDER_URL??'http://127.0.0.1:5173/';
const quarter=computeMoonQuarterSequence(9580).events.find(e=>e.phaseLongitudeDeg===90).utDaysJ2000;
const samples=[];
const ready=()=>page.waitForFunction(()=>window.skyApp.ready&&!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedUt===window.skyApp.state.time.utDaysJ2000&&window.skyApp.skyAppearanceDiagnostics.textureLoaded);
try{
  await page.goto(url);await ready();
  for(const id of ['G01','G03']){await page.evaluate(state=>window.skyApp.setState(state),loadSkyTeachingScene(id));await ready();await page.waitForTimeout(140);await page.screenshot({path:`${out}/${id}.png`});samples.push({name:id,diagnostics:await page.evaluate(()=>window.skyApp.skyAppearanceDiagnostics)});}
  const finite=loadSkyTeachingScene('G01');finite.viewMode='globe';await page.evaluate(state=>window.skyApp.setState(state),finite);await ready();await page.waitForTimeout(140);
  const finiteDiagnostic=await page.evaluate(()=>window.skyApp.skyAppearanceDiagnostics);assert.equal(finiteDiagnostic.nearGalaxyPassVisible,true);assert.equal(finiteDiagnostic.nearGalaxyGeometryId,finiteDiagnostic.backgroundGeometryId);assert.equal(finiteDiagnostic.nearGalaxySharesTextureUniform,true);
  samples.push({name:'finite-split-galaxy',diagnostics:finiteDiagnostic});await page.screenshot({path:`${out}/finite-split-galaxy.png`});
  for(const [name,hoursEarlier,presentation,scale] of [['city-night-moon',6.3,'observation',1],['day-moon',11.3,'observation',1],['day-explanation-close-moon',11.3,'explanation',10]]){
    const state=createDefaultState();state.time.running=false;state.time.utDaysJ2000=quarter-hoursEarlier/24;state.presentation=presentation;state.illustration.bodySizeScale=scale;state.environment.artificialSkyBrightness=1;state.cameras.ground.verticalFovDeg=20;state.selected='body:Moon';
    await page.evaluate(state=>window.skyApp.setState(state),state);await ready();const count=await page.evaluate(()=>window.skyApp.diagnostics.renderCount);await page.evaluate(()=>window.skyApp.focusSelection());await page.waitForFunction(count=>window.skyApp.diagnostics.renderCount>count,count);await ready();
    await page.evaluate(()=>{const state=window.skyApp.state;state.selected=null;window.skyApp.setState(state);});await ready();await page.waitForTimeout(140);
    if(name==='city-night-moon'){await page.locator('#sky-teaching').evaluate(e=>{e.open=true;});await page.locator('#sky-moon-loupe-toggle').click();await page.waitForTimeout(140);}
    const sample=await page.evaluate(()=>{
      const diag=window.skyApp.moonLoupeDiagnostics,sky=window.skyApp.skyAppearanceDiagnostics,hit=window.skyApp.rendererDiagnostics.bodyHitTargets.find(b=>b.id==='body:Moon'),canvas=document.querySelector('.sky-webgl-canvas'),bounds=canvas.getBoundingClientRect();
      const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;const ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);const image=ctx.getImageData(0,0,c.width,c.height),ratio=c.width/bounds.width;
      const radius=diag.mainUnmagnifiedDiameterCssPx/2*(window.skyApp.state.presentation==='explanation'?window.skyApp.state.illustration.bodySizeScale:1),bright=diag.mainBrightLimbScreenUnit;
      const read=(x,y)=>{const ix=Math.floor(x*ratio),iy=Math.floor(y*ratio),values=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const i=((iy+dy)*c.width+ix+dx)*4;values.push([image.data[i],image.data[i+1],image.data[i+2]]);}return [0,1,2].map(channel=>values.map(v=>v[channel]).sort((a,b)=>a-b)[4]);};
      const lens=diag.viewportCssRect,lensBright=diag.loupeBrightLimbScreenUnit,lensRadius=diag.loupeDiameterCssPx/2;
      return {sky,moon:diag,hit,radius,darkFaceRgb:read(hit.x-bright[0]*radius*.55,hit.y+bright[1]*radius*.55),adjacentSkyRgb:read(hit.x+radius*2.2,hit.y),
        loupeDarkFaceRgb:lens?read(lens.left-bounds.left+lens.width/2-lensBright[0]*lensRadius*.55,lens.top-bounds.top+lens.height/2+lensBright[1]*lensRadius*.55):null,state:window.skyApp.state};
    });samples.push({name,...sample});await page.screenshot({path:`${out}/${name}.png`});
    assert.ok(sample.sky.model.moonAltitudeDeg>0,'risk fixture must have a physically visible Moon');
    assert.ok(sample.darkFaceRgb.every((value,i)=>Math.abs(value-sample.adjacentSkyRgb[i])<=2),'main dark hemisphere must carry the same foreground sky scatter');
    if(sample.loupeDarkFaceRgb)assert.ok(sample.loupeDarkFaceRgb.every(value=>value<=1),'teaching loupe must retain its unlit black hemisphere');
  }
  assert.equal(errors.length,0,errors.join('\n'));assert.ok(samples.every(s=>s.diagnostics?.sharedFrameMatchesInverse??s.sky.sharedFrameMatchesInverse));
  await writeFile(`${out}/moon-risk-report.json`,JSON.stringify({url,samples,errors},null,2));
  console.log(JSON.stringify(samples.filter(s=>s.darkFaceRgb).map(s=>({name:s.name,moonAlt:s.sky.model.moonAltitudeDeg,sunAlt:s.sky.model.sunAltitudeDeg,dark:s.darkFaceRgb,sky:s.adjacentSkyRgb})),null,2));
}finally{await context.close();await browser.close();}
