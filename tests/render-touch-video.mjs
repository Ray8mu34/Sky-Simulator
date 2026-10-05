import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='qa/m4-render';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,deviceScaleFactor:1,recordVideo:{dir:`${out}/video`,size:{width:390,height:844}}});
const page=await context.newPage(),errors=[],samples=[],url=process.env.SKY_RENDER_URL??'http://127.0.0.1:4173/';page.on('pageerror',error=>errors.push(error.message));
const point=(id,x,y)=>({id,x,y,radiusX:2,radiusY:2,force:1});let video;
try{
  await page.goto(url);await page.waitForFunction(()=>window.skyApp?.ready&&!window.skyApp.diagnostics.scienceDirty&&window.skyApp.rendererDiagnostics?.gesture);
  const state=await page.evaluate(()=>window.skyApp.state);state.viewMode='ground';state.time.running=false;state.selected='hip:11767';state.cameras.ground.verticalFovDeg=72;state.cameras.ground.altitudeDeg=30;
  await page.evaluate(state=>window.skyApp.setState(state),state);await page.waitForFunction(()=>!window.skyApp.diagnostics.scienceDirty&&window.skyApp.diagnostics.lastRenderedMode==='ground');
  // Test-only contact indicators observe trusted browser events, never dispatch product events.
  await page.evaluate(()=>{
    window.__touchVideoEvents=[];const markers=new Map();
    const caption=document.createElement('div');caption.textContent='CDP 触摸模拟 · 双指缩放 → 单指续拖 → 取消';Object.assign(caption.style,{position:'fixed',left:'12px',top:'76px',font:'11px sans-serif',color:'#c8dfed',pointerEvents:'none',zIndex:'9999'});document.body.append(caption);
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])window.addEventListener(type,event=>{
      if(event.pointerType!=='touch'||!event.isTrusted||!(event.target instanceof HTMLCanvasElement))return;
      window.__touchVideoEvents.push({type,id:event.pointerId,x:event.clientX,y:event.clientY,isTrusted:event.isTrusted});
      if(type==='pointerup'||type==='pointercancel'){markers.get(event.pointerId)?.remove();markers.delete(event.pointerId);return;}
      let marker=markers.get(event.pointerId);if(!marker){marker=document.createElement('div');Object.assign(marker.style,{position:'fixed',width:'24px',height:'24px',border:'1px solid #c8dfed',borderRadius:'50%',background:'rgba(150,196,222,.15)',pointerEvents:'none',zIndex:'9999',transform:'translate(-50%,-50%)'});document.body.append(marker);markers.set(event.pointerId,marker);}
      marker.style.left=`${event.clientX}px`;marker.style.top=`${event.clientY}px`;
    },true);
  });
  const cdp=await context.newCDPSession(page),touch=async(type,points=[])=>{await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});await page.waitForTimeout(90);};
  const read=async name=>{const value=await page.evaluate(()=>({state:window.skyApp.state,interaction:window.skyApp.rendererDiagnostics}));samples.push({name,...value});return value;};
  const baseline=await read('baseline');await touch('touchStart',[point(1,90,500)]);await touch('touchStart',[point(1,90,500),point(2,260,500)]);
  for(let i=1;i<=8;i++)await touch('touchMove',[point(1,90-i*3,500),point(2,260+i*3,500)]);
  const zoomed=await read('pinched');assert.ok(Math.abs(zoomed.state.cameras.ground.verticalFovDeg-72*170/218)<1e-8);
  await touch('touchStart',[point(1,66,500),point(2,284,500),point(3,310,630)]);await touch('touchMove',[point(1,66,500),point(2,284,500),point(3,325,650)]);
  assert.deepEqual((await read('third-ignored')).state,zoomed.state);
  // Measured Chrome154 CDP contract: nonempty touchEnd lists released contacts, not survivors.
  await touch('touchEnd',[point(3,325,650)]);await touch('touchEnd',[point(1,66,500)]);
  assert.deepEqual((await read('partial-lift-no-jump')).state,zoomed.state);
  for(let i=1;i<=7;i++)await touch('touchMove',[point(2,284+i*2,500+i*2)]);
  await page.screenshot({path:`${out}/pinch-to-single.png`});await touch('touchEnd');const single=await read('single-ended');assert.equal(single.state.selected,baseline.state.selected);
  await touch('touchStart',[point(4,90,550)]);await touch('touchStart',[point(4,90,550),point(5,230,550)]);await touch('touchMove',[point(4,80,550),point(5,240,550)]);
  const beforeCancel=await read('before-cancel');await touch('touchCancel');const cancelled=await read('cancelled');assert.deepEqual(cancelled.state,beforeCancel.state);assert.deepEqual(cancelled.interaction.gesture.activePointerIds,[]);assert.deepEqual(cancelled.interaction.gesture.capturedPointerIds,[]);
  await page.screenshot({path:`${out}/cancel-released.png`});await touch('touchStart',[point(6,150,550)]);await touch('touchMove',[point(6,170,565)]);await touch('touchEnd');const recovered=await read('fresh-drag-after-cancel');
  assert.notDeepEqual(recovered.state.cameras.ground,cancelled.state.cameras.ground);assert.deepEqual(recovered.state.time,baseline.state.time);assert.deepEqual(recovered.state.observer,baseline.state.observer);assert.equal(recovered.state.selected,baseline.state.selected);
  for(const mode of ['space','globe','horizon'])assert.deepEqual(recovered.state.cameras[mode],baseline.state.cameras[mode]);
  const events=await page.evaluate(()=>window.__touchVideoEvents);assert.ok(events.length>20&&events.every(event=>event.isTrusted));assert.equal(errors.length,0);
  await writeFile(`${out}/gesture-video-report.json`,JSON.stringify({url,browserVersion:browser.version(),scope:'CDP native pointer events with test-only visual contact markers; physical phone and long performance untested.',samples,events,errors},null,2));
  video=page.video();
}finally{await context.close();if(video)await video.saveAs(`${out}/pinch-single-cancel.webm`);await browser.close();}
console.log(`${out}/pinch-single-cancel.webm`);
