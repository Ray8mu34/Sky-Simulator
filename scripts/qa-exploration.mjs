import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browser=await chromium.launch({headless:true,channel:'chrome'}),results=[];
await mkdir('qa/exploration',{recursive:true});
try{for(const mode of ['webgl','canvas','portable']){
  const context=await browser.newContext({viewport:{width:1152,height:768}});
  if(mode==='canvas')await context.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:get.call(this,type,...args);};});
  if(mode==='portable')await context.setOffline(true);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(mode==='portable'?pathToFileURL(resolve('dist-portable/三维全景夜空.html')).href:'http://127.0.0.1:4175/');await page.waitForFunction(()=>window.skyApp?.ready);
  await page.evaluate(()=>{const s=window.skyApp.state;s.selected='body:Mars';s.layers.terrain=false;Object.assign(s.layers,{motionTrack:true,chineseSky:true,constellationBoundaries:true,equatorialGrid:true,horizontalGrid:true,eclipticGrid:true});window.skyApp.setState(s);});
  await page.waitForFunction(()=>window.skyApp.diagnostics.lastRenderedSelection==='body:Mars'&&!window.skyApp.diagnostics.scienceDirty);
  await page.locator('#sky-search').fill('北斗');await page.locator('[data-object-id^="chinese:"]').first().click();
  await page.waitForFunction(()=>window.skyApp.selectedDetails?.id.startsWith('chinese:'));
  await page.locator('[data-action="focus-selection"]').click();
  if(mode!=='canvas')await page.waitForFunction(()=>window.skyApp.rendererDiagnostics.selectedVisible);
  await page.evaluate(()=>{const s=window.skyApp.state;s.selected='body:Mars';window.skyApp.setState(s);});
  for(const view of mode==='canvas'?['ground']:['ground','space','globe','horizon']){await page.evaluate(view=>{const s=window.skyApp.state;s.viewMode=view;window.skyApp.setState(s);},view);await page.waitForFunction(view=>window.skyApp.diagnostics.lastRenderedMode===view,view);}
  await page.locator('.exploration-section > summary').click();await page.locator('.altitude-tools > summary').click();
  await page.waitForFunction(()=>document.querySelector('.altitude-chart polyline')?.getAttribute('points').split(' ').length===97);
  const download=page.waitForEvent('download');await page.locator('[data-explore="csv"]').click();assert.equal((await download).suggestedFilename(),'altitude.csv');
  await page.locator('.eclipse-tools > summary').click();
  await page.evaluate(()=>{const s=window.skyApp.state;s.time.utDaysJ2000=(Date.parse('2024-04-01T00:00:00Z')-Date.parse('2000-01-01T12:00:00Z'))/86400000;window.skyApp.setState(s);});
  await page.locator('[data-explore="solar-global"]').click();await page.waitForFunction(()=>document.querySelector('.eclipse-status')?.textContent.includes('全球日全食'));
  await page.getByRole('button',{name:'前往食甚地点',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.eclipse-caption')?.textContent.includes('盘面相交')&&!document.querySelector('.eclipse-caption')?.textContent.includes('无盘面'));
  await page.screenshot({path:`qa/exploration/${mode}.png`});
  await page.locator('[data-explore="solar-local"]').click();await page.waitForFunction(()=>document.querySelector('.eclipse-status')?.textContent.startsWith('当地日'));
  await page.locator('[data-explore="lunar"]').click();await page.waitForFunction(()=>document.querySelector('.eclipse-status')?.textContent.startsWith('月'));
  await page.getByRole('button',{name:'食甚',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.eclipse-caption')?.textContent.includes('盘面相交'));
  assert.deepEqual(errors,[]);results.push({mode,passed:true,errors});await context.close();
}await writeFile('qa/exploration/report.json',JSON.stringify(results,null,2));console.log(results);}finally{await browser.close();}
