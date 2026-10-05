import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const outDir=resolve(process.env.SKY_QA_OUT_DIR??'qa/final-m4b/mobile-recording'); await mkdir(outDir,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:false});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,recordVideo:{dir:outDir,size:{width:390,height:844}}});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const report={status:'running',url:process.env.SKY_QA_URL??'http://127.0.0.1:4173/',viewport:[390,844],videoSize:[390,844],device:'Chrome mobile/touch emulation; not a physical phone',scope:'Actual browser viewport, native size, no synthetic frames',startedAt:new Date().toISOString()};
try{
  await page.goto(report.url,{waitUntil:'load'});
  await page.waitForFunction(()=>window.skyApp?.ready&&!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.assetStatus.pending.length===0&&window.skyApp.diagnostics.assetStatus.errors.length===0,undefined,{timeout:30000});
  const before=await page.evaluate(()=>window.skyApp.state);report.before=before;
  await page.waitForTimeout(450);await page.locator('[data-action="open-time"]').tap();
  await page.locator('#sky-time-span').selectOption('day');await page.locator('[data-time-step="1"]').tap();
  await page.waitForFunction(()=>!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedUt===window.skyApp.state.time.utDaysJ2000);
  const step=await page.evaluate(()=>window.skyApp.state);assert.equal(step.time.utDaysJ2000,before.time.utDaysJ2000+1);report.stepped=step;
  await page.waitForTimeout(450);await page.screenshot({path:resolve(outDir,'bottom-drawer-native-390.png')});
  await page.locator('[data-action="close"]').tap();await page.waitForTimeout(350);await page.locator('.compact-reset').tap();
  await page.waitForFunction(()=>!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedUt===window.skyApp.state.time.utDaysJ2000);
  assert.deepEqual(await page.evaluate(()=>window.skyApp.state),before);await page.waitForTimeout(450);
  await page.screenshot({path:resolve(outDir,'restored-sky-native-390.png')});
  report.buildId=await page.locator('meta[name="sky-build-id"]').getAttribute('content');report.userAgent=await page.evaluate(()=>navigator.userAgent);
  assert.equal(errors.length,0);report.status='recorded-native-size-functional-checks-passed-awaiting-review';
}catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
finally{
  const video=page.video();await context.close();const path=resolve(outDir,'bottom-drawer.webm');await video.saveAs(path);await browser.close();
  report.video={path,bytes:(await stat(path)).size};report.errors=errors;report.finishedAt=new Date().toISOString();await writeFile(resolve(outDir,'report.json'),JSON.stringify(report,null,2));console.log(`Mobile video: ${report.status}; ${path}`);
}
