import {chromium} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startUpdateServer} from './qa-update-server.mjs';
import {installGraphicsProbe,waitGraphicsReady} from './qa-m4a.mjs';

const out=resolve('qa/final-m4b/update-client-probe');await mkdir(out,{recursive:true});
const server=await startUpdateServer({A:resolve('qa/m4b-platform/legacy-m4a-web'),B:resolve('qa/m4b-platform/test-build-b')});server.select('/lesson-one/','A');
const url=server.origin+'/lesson-one/',b=JSON.parse(await readFile('qa/m4b-platform/test-build-b/build-report.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:false}),context=await browser.newContext();await installGraphicsProbe(context,true);
const control=await context.newPage();await control.goto(server.origin);const cdp=await context.newCDPSession(control);
const report={status:'diagnostic-only',url,expectedB:b.buildId,trace:[],checks:[]},versions=new Map();
cdp.on('ServiceWorker.workerVersionUpdated',event=>{report.trace.push({at:new Date().toISOString(),...event});for(const value of event.versions)versions.set(value.versionId,value);});await cdp.send('ServiceWorker.enable');
const registrations=()=>control.evaluate(async url=>{const r=await navigator.serviceWorker.getRegistration(url);return {active:r?.active?.state??null,waiting:r?.waiting?.state??null,installing:r?.installing?.state??null};},url);
async function wait(label,fn){const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await delay(100);}throw Error('Timed out '+label);}
try{
  const page=await context.newPage();await page.goto(url);await waitGraphicsReady(page,'canvas2d');await wait('A active',async()=>(await registrations()).active==='activated');
  await page.reload();await waitGraphicsReady(page,'canvas2d');
  report.before=await page.evaluate(()=>({url:location.href,controller:navigator.serviceWorker.controller?.scriptURL??null,workerCount:window.skyApp.diagnostics.workerCount}));
  server.select('/lesson-one/','B');await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
  await wait('B installed',async()=>(await registrations()).waiting==='installed');
  report.beforeClose={versions:[...versions.values()],targets:await cdp.send('Target.getTargets'),pages:context.pages().map(p=>p.url())};
  await page.close();
  for(let i=0;i<60;i++){
    report.checks.push({at:new Date().toISOString(),registration:await registrations(),versions:[...versions.values()],targets:await cdp.send('Target.getTargets'),pages:context.pages().map(p=>p.url())});
    if((await registrations()).waiting===null)break;await delay(100);
  }
  report.after=await registrations();report.cacheNames=await control.evaluate(()=>caches.keys());
}catch(error){report.error=error.stack??String(error);}
finally{await context.close();await browser.close();await server.close();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log('Client probe: '+resolve(out,'report.json'));}
