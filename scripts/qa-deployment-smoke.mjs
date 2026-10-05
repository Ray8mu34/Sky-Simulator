import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url=process.env.SKY_DEPLOY_URL ?? 'https://sky.zjuaaa.cn/';
const out=process.env.SKY_DEPLOY_QA_OUT ?? '_local-archive/deployment-20261005/browser';
await mkdir(out,{recursive:true});
const capture=JSON.parse(await readFile('media/screenshots/capture-manifest.json','utf8'));
const scene=capture.captures.find(c=>c.file==='overview-ground.png').state;
const report={url,buildId:capture.buildId,scope:'Public HTTPS deployment smoke; not a performance, device or full scientific matrix.',errors:[],views:[],browserClosed:false};
const browser=await chromium.launch({channel:'chrome',headless:false});
let context;
try {
  context=await browser.newContext({viewport:{width:1280,height:800}});
  let page=await context.newPage();
  const observe=p=>p.on('pageerror',e=>report.errors.push(e.message));observe(page);
  const ready=p=>p.waitForFunction(()=>{const a=window.skyApp;return a?.ready&&!a.diagnostics.scienceDirty&&a.diagnostics.lastRenderedMode===a.state.viewMode&&a.diagnostics.lastRenderedUt===a.state.time.utDaysJ2000&&a.diagnostics.assetStatus.pending.length===0&&a.diagnostics.assetStatus.errors.length===0;},null,{timeout:90000});
  const moduleResponse=page.waitForResponse(r=>r.url().endsWith('/'+capture.moduleName),{timeout:90000});
  await page.goto(url+'#scene='+encodeURIComponent(JSON.stringify(scene)),{timeout:90000});await ready(page);
  const response=await moduleResponse;
  report.moduleSha256=createHash('sha256').update(await response.body()).digest('hex');
  assert.equal(report.moduleSha256,capture.moduleSha256);
  assert.equal(await page.locator('meta[name="sky-build-id"]').getAttribute('content'),capture.buildId);
  await page.waitForFunction(()=>window.skyApp.offlineStatus?.phase==='ready',null,{timeout:90000});
  report.online=await page.evaluate(()=>({secureContext:isSecureContext,offline:window.skyApp.offlineStatus,graphics:window.skyApp.diagnostics.graphics.activeKind}));
  assert.equal(report.online.secureContext,true);assert.equal(report.online.graphics,'webgl2');
  for(const mode of ['ground','space','globe','horizon']) {
    await page.locator(`[data-view="${mode}"]`).click();await ready(page);
    report.views.push(await page.evaluate(()=>({mode:window.skyApp.state.viewMode,drawn:window.skyApp.diagnostics.lastRenderedMode,ut:window.skyApp.state.time.utDaysJ2000})));
  }
  await page.waitForFunction(()=>window.skyApp.diagnostics.viewTransition?.phase==='idle');
  await page.screenshot({path:out+'/online-horizon.png'});
  await page.close();await context.setOffline(true);page=await context.newPage();observe(page);
  const navigation=await page.goto(url,{timeout:30000});await ready(page);
  report.offline={status:navigation.status(),fromServiceWorker:navigation.fromServiceWorker(),buildId:await page.locator('meta[name="sky-build-id"]').getAttribute('content')};
  assert.equal(report.offline.fromServiceWorker,true);assert.equal(report.offline.status,200);assert.equal(report.offline.buildId,capture.buildId);
  await page.locator('[data-view="space"]').click();await ready(page);
  await page.waitForFunction(()=>window.skyApp.diagnostics.viewTransition?.phase==='idle');
  await page.screenshot({path:out+'/offline-space.png'});
  assert.equal(report.errors.length,0);report.status='passed-public-https-and-offline-smoke';
} catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally {if(context)await context.close();await browser.close();report.browserClosed=true;await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
