import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('qa/render', { recursive: true });
const context = await browser.newContext({ viewport: { width: 1152, height: 720 }, recordVideo: { dir: 'qa/render/video', size:{width:1152,height:720} } });
const page = await context.newPage();
const errors = [];
page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
await page.addInitScript(() => {
  const original = WebGL2RenderingContext.prototype.linkProgram;
  window.__renderPrograms = [];
  WebGL2RenderingContext.prototype.linkProgram = function(program) { window.__renderPrograms.push(program); return original.call(this, program); };
});
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.skyApp?.ready);
await page.waitForFunction(() => ['uDay','uNight','uClouds'].every(slot => window.skyApp?.diagnostics.assetStatus.loaded.includes(slot)));
const baseline = await page.evaluate(() => window.skyApp.state);
const diagnostics = await page.evaluate(async () => {
  const gl = document.querySelector('#sky-stage canvas').getContext('webgl2');
  const { catalog } = await import('/src/data/catalog.ts');
  const state = window.skyApp.state;
  state.viewMode = 'ground'; state.time.running = false; state.density = 'reference'; state.presentation = 'explanation';
  for (const key of Object.keys(state.layers)) state.layers[key] = false;
  state.cameras.ground.azimuthDegNorthEast = 0; state.cameras.ground.altitudeDeg = 25;
  window.skyApp.setState(state);
  const program = window.__renderPrograms.find(program => gl.getAttachedShaders(program).some(shader => gl.getShaderSource(shader).includes('attribute float magnitude')));
  const uniforms = Object.fromEntries(['uDpr','uLimit','uVisibility','uFinite','uGround','uTerrain','uBackAlpha'].map(name => [name,gl.getUniform(program,gl.getUniformLocation(program,name))]));
  return { range: [...gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)], uniforms, polaris: catalog.stars.find(s => s.hip === 11767), colors: [...catalog.colors.slice(0,12)] };
});
await page.waitForTimeout(350);
await page.screenshot({ path: 'qa/render/stars-only.png' });
const scenes = [];
for (const mode of ['ground','space','globe','horizon']) {
  await page.evaluate(({mode,baseline}) => {
    const state = structuredClone(baseline); state.density='reference'; state.viewMode=mode;
    if(mode==='space') state.cameras.space.distanceDisplayUnits=5;
    if(mode==='globe'||mode==='horizon') {
      state.layers.celestialEquator=true; state.layers.ecliptic=true; state.layers.celestialPoles=true;
      state.layers.meridian=mode==='horizon';
    }
    window.skyApp.setState(state);
  },{mode,baseline});
  await page.waitForTimeout(300);
  await page.screenshot({ path:`qa/render/${mode}.png` });
  scenes.push(await page.evaluate(()=>({state:window.skyApp.state,snapshot:window.skyApp.snapshot,metrics:window.skyApp.metrics})));
}
await page.evaluate(baseline => window.skyApp.setState(baseline), baseline);
await page.waitForTimeout(300);
await page.mouse.move(780,290); await page.mouse.down();
await page.mouse.move(1040,380,{steps:24}); await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({path:'qa/render/ground-dragged.png'});
const cameraAfterDrag = await page.evaluate(()=>window.skyApp.state.cameras.ground);
await page.setViewportSize({width:390,height:844});
await page.evaluate(() => { const state=window.skyApp.state; state.density='teaching'; window.skyApp.setState(state); });
if(await page.locator('[aria-label="收起控制面板"]').isVisible()) await page.locator('[aria-label="收起控制面板"]').click();
await page.waitForTimeout(300);
await page.screenshot({path:'qa/render/mobile.png'});
await writeFile('qa/render/diagnostic.json', JSON.stringify({ diagnostics, errors, scenes, cameraAfterDrag }, null, 2));
console.log(JSON.stringify({ diagnostics, errors }));
const video=page.video();
await context.close();
if(video) await video.saveAs('qa/render/four-views-and-drag.webm');
await browser.close();
