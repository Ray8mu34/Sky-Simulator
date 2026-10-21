import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=await chromium.launch({headless:true,channel:'chrome'});
const report=[];
await mkdir('qa/catalog-expansion',{recursive:true});
try {
  for(const mode of ['webgl','canvas','portable']) {
    const context=await browser.newContext({viewport:{width:1152,height:768}});
    if(mode==='canvas')await context.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:get.call(this,type,...args);};});
    if(mode==='portable')await context.setOffline(true);
    const page=await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(mode==='portable'?pathToFileURL(resolve('dist-portable/三维全景夜空.html')).href:'http://127.0.0.1:4175/');
    await page.waitForFunction(()=>window.skyApp?.ready);
    assert.equal(await page.evaluate(()=>window.skyApp.graphicsStatus.kind),mode==='canvas'?'canvas2d':'webgl2');
    for(const [query,id] of [['金星','body:Venus'],['木星','body:Jupiter'],['M31','messier:31'],['NGC 1976','messier:42'],['M110','messier:110']]) {
      await page.locator('#sky-search').fill(query);
      await page.locator(`[data-object-id="${id}"]`).click();
      await page.waitForFunction(id=>window.skyApp.selectedDetails?.id===id,id);
      assert.equal(await page.locator('[data-action="focus-selection"]').isEnabled(),true);
      if(id.startsWith('body:'))await page.waitForFunction(()=>window.skyApp.teachingData.objectDayStatus==='ready');
    }
    for(const view of mode==='canvas'?['ground']:['ground','space','globe','horizon']) {
      for(const id of ['body:Mercury','body:Venus','body:Mars','body:Jupiter','body:Saturn','messier:31']) {
        await page.evaluate(({view,id})=>{const s=window.skyApp.state;s.viewMode=view;s.selected=id;s.layers.terrain=false;s.layers.backHemisphere=true;s.presentation='explanation';s.environment.refraction='standard';window.skyApp.setState(s);},{view,id});
        await page.waitForFunction(id=>window.skyApp.diagnostics.lastRenderedSelection===id&&!window.skyApp.diagnostics.scienceDirty,id);
        await page.evaluate(()=>window.skyApp.focusSelection());
        if(mode!=='canvas')await page.waitForFunction(()=>window.skyApp.rendererDiagnostics.selectedVisible);
        assert.equal(await page.evaluate(()=>window.skyApp.selectedDetails!==null),true);
      }
    }
    if(mode!=='canvas') {
      await page.evaluate(()=>{const s=window.skyApp.state;s.viewMode='ground';s.selected='body:Jupiter';s.layers.terrain=false;s.layers.planets=true;window.skyApp.setState(s);});
      await page.waitForFunction(()=>window.skyApp.diagnostics.lastRenderedSelection==='body:Jupiter'&&!window.skyApp.diagnostics.scienceDirty);
      await page.evaluate(()=>window.skyApp.focusSelection());
      await page.waitForFunction(()=>window.skyApp.rendererDiagnostics.bodyHitTargets.some(p=>p.id==='body:Jupiter'));
      const point=await page.evaluate(()=>window.skyApp.rendererDiagnostics.bodyHitTargets.find(p=>p.id==='body:Jupiter'));
      await page.locator('[data-action="clear-selection"]').click();
      await page.mouse.click(point.x,point.y);
      await page.waitForFunction(()=>window.skyApp.state.selected==='body:Jupiter');
      await page.locator('[data-layer="planets"]').uncheck();
      await page.waitForFunction(()=>!window.skyApp.rendererDiagnostics.bodyHitTargets.some(p=>p.id==='body:Jupiter'));
      await page.locator('[data-layer="planets"]').check();
      await page.waitForFunction(()=>window.skyApp.rendererDiagnostics.bodyHitTargets.some(p=>p.id==='body:Jupiter'));
    }
    await page.locator('#sky-search').fill('M42');await page.locator('[data-object-id="messier:42"]').click();
    await page.locator('.object-image-details summary').click();
    await page.waitForFunction(()=>{const img=document.querySelector('.object-image img');return img?.complete&&img.naturalWidth===640;});
    await page.screenshot({path:`qa/catalog-expansion/${mode}.png`});
    if(mode==='webgl') {
      await page.setViewportSize({width:390,height:844});
      await page.locator('[data-action="open-search"]').click();
      await page.locator('#sky-search').fill('M1');await page.locator('[data-object-id="messier:1"]').click();
      await page.locator('.object-image-details summary').click();
      await page.waitForFunction(()=>{const img=document.querySelector('.object-image img');return img?.complete&&img.naturalWidth===640;});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:'qa/catalog-expansion/mobile.png'});
    }
    assert.deepEqual(errors,[]);
    report.push({mode,passed:true,errors});await context.close();
  }
  await writeFile('qa/catalog-expansion/report.json',JSON.stringify(report,null,2));
  console.log(report);
} finally {await browser.close();}
