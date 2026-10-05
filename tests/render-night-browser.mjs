import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel:'chrome',headless:true});
const context = await browser.newContext({viewport:{width:1152,height:720}});
const page = await context.newPage();
await mkdir('qa/render/night', {recursive:true});
await page.addInitScript(() => {
  const original=WebGL2RenderingContext.prototype.linkProgram;
  window.__renderPrograms=[];
  WebGL2RenderingContext.prototype.linkProgram=function(program){window.__renderPrograms.push(program);return original.call(this,program);};
});
const url=process.env.SKY_RENDER_URL ?? 'http://127.0.0.1:5173/';
await page.goto(url);
await page.waitForFunction(()=>window.skyApp?.ready);
await page.waitForTimeout(1500);
await page.evaluate(()=>{
  const state=window.skyApp.state;state.time.running=false;state.viewMode='space';state.density='reference';
  state.cameras.space.distanceDisplayUnits=5;state.layers.earthNightLights=true;state.layers.earthClouds=true;
  window.skyApp.setState(state);
});
await page.waitForTimeout(500);
const assets=await page.evaluate(async(probeSource)=>{
  if(!probeSource) return {dataset:{...document.querySelector('#sky-stage').dataset},status:window.skyApp.diagnostics.assetStatus};
  const {earthDayUrl,earthNightUrl,earthCloudsUrl}=await import('/src/data/textures.ts');
  const result=[];
  for(const [name,url] of [['day',earthDayUrl],['night',earthNightUrl],['cloud',earthCloudsUrl]]){
    const image=new Image();image.src=url;
    try{await image.decode();result.push({name,urlLength:url.length,prefix:url.slice(0,40),width:image.naturalWidth,height:image.naturalHeight});}
    catch(error){result.push({name,urlLength:url.length,prefix:url.slice(0,40),error:String(error)});}
  }
  return {result,dataset:{...document.querySelector('#sky-stage').dataset}};
},process.env.SKY_RENDER_PROBE_SOURCE!=='0');
const samples=[];
for(const [name,lights,clouds] of [['lights-on-clouds-on',true,true],['lights-off-clouds-on',false,true],['lights-on-clouds-off',true,false],['lights-off-clouds-off',false,false]]){
  await page.evaluate(({lights,clouds})=>{const state=window.skyApp.state;state.layers.earthNightLights=lights;state.layers.earthClouds=clouds;window.skyApp.setState(state);},{lights,clouds});
  await page.waitForTimeout(250);
  const sample=await page.evaluate(()=>{
    const gl=document.querySelector('#sky-stage canvas').getContext('webgl2');
    const program=window.__renderPrograms.find(program=>gl.getAttachedShaders(program).some(shader=>gl.getShaderSource(shader).includes('uniform sampler2D uNight;')));
    const uniforms=Object.fromEntries(['uDay','uNight','uClouds','uHasDay','uHasNight','uHasClouds','uNightEnabled','uCloudEnabled'].map(name=>[name,gl.getUniform(program,gl.getUniformLocation(program,name))]));
    const originalUnit=gl.getParameter(gl.ACTIVE_TEXTURE);
    const textures=[];
    for(const name of ['uDay','uNight','uClouds']){gl.activeTexture(gl.TEXTURE0+uniforms[name]);textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));}
    gl.activeTexture(originalUnit);
    return {uniforms,distinctTextures:new Set(textures).size,state:window.skyApp.state,snapshot:window.skyApp.snapshot};
  });
  samples.push({name,...sample});
  assert.equal(sample.uniforms.uHasDay,1);assert.equal(sample.uniforms.uHasNight,1);assert.equal(sample.uniforms.uHasClouds,1);
  assert.equal(sample.uniforms.uNightEnabled,lights?1:0);assert.equal(sample.uniforms.uCloudEnabled,clouds?1:0);assert.equal(sample.distinctTextures,3);
  await page.screenshot({path:`qa/render/night/${name}.png`});
}
await writeFile('qa/render/night/report.json',JSON.stringify({url,assets,samples},null,2));
console.log(assets);
console.log(samples.map(s=>({name:s.name,uniforms:s.uniforms,distinctTextures:s.distinctTextures})));
await context.close();await browser.close();
