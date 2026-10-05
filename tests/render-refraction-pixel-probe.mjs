/** Independent CSS projection and physical-mask oracle; reads the one actual renderer framebuffer. */
export async function measureSunMask(page){return page.evaluate(async()=>{
  const {deriveRefractionProfile,unrefractEnuDirection}=await import('/src/core/refraction.ts');
  const {Quaternion,Vector3}=await import('/node_modules/three/build/three.module.js');
  const p=window.probe,owner=p.renderer,r=owner.renderer,gl=r.getContext(),diagnostic=owner.getInteractionDiagnostics().groundBodyDiscs.find(d=>d.id==='Sun');
  const width=owner.canvas.width,height=owner.canvas.height,on=new Uint8Array(width*height*4),off=new Uint8Array(on.length);
  gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,on);const saved=p.state.layers.sunMoon;
  p.state.layers.sunMoon=false;owner.render(p.state,p.snapshot);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,off);p.state.layers.sunMoon=saved;owner.render(p.state,p.snapshot);
  const profile=deriveRefractionProfile(p.snapshot.observerRefraction),axis=diagnostic.observedCentreEnu,b=diagnostic.physicalBasisDisplay,d=diagnostic.geometricCentreDisplay;
  const q=new Quaternion().fromArray(diagnostic.cameraOrientationQuaternion),tanFov=Math.tan(diagnostic.verticalFovDeg*Math.PI/360),aspect=width/height,scale=diagnostic.teachingScale,k=diagnostic.physicalTanRadius;
  let expectedPixels=0,actualPixels=0,mismatchPixels=0,interiorWrongPixels=0,deepInteriorSamples=0,backgroundHoles=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const index=(y*width+x)*4,actual=on[index]>250&&on[index+1]>230&&on[index+2]>178&&on[index+2]<210;
    const ray=new Vector3((2*(x+.5)/width-1)*aspect*tanFov,(2*(y+.5)/height-1)*tanFov,-1).normalize().applyQuaternion(q);
    const enu=[ray.x,-ray.z,ray.y],axial=enu.reduce((sum,v,i)=>sum+v*axis[i],0),unscaled=enu.map((v,i)=>v/scale+(1-1/scale)*axis[i]*axial);
    const g=unrefractEnuDirection(unscaled,profile),world=[g[0],g[2],-g[1]],denominator=world.reduce((sum,v,i)=>sum+v*d[i],0)*k;
    const px=world.reduce((sum,v,i)=>sum+v*b[i][0],0)/denominator,py=world.reduce((sum,v,i)=>sum+v*b[i][1],0)/denominator,rho=px*px+py*py;
    const az=Math.atan2(ray.x,-ray.z),hill=.010+.007*Math.sin(az*7+1.4)+.008*Math.sin(az*3-1)+.003*Math.sin(az*13);
    const visible=!p.state.layers.terrain||ray.y>=hill,expected=denominator>0&&rho<=1&&visible;
    expectedPixels+=expected?1:0;actualPixels+=actual?1:0;
    if(actual!==expected){mismatchPixels++;if(Math.abs(rho-1)>(scale>=8?.006:.3)&&(!p.state.layers.terrain||Math.abs(ray.y-hill)>.001))interiorWrongPixels++;}
    if(expected&&rho<.8&&(!p.state.layers.terrain||ray.y-hill>.001)){deepInteriorSamples++;if(!actual)backgroundHoles++;}
  }
  return {width,height,expectedPixels,actualPixels,mismatchPixels,interiorWrongPixels,deepInteriorSamples,backgroundHoles,
    scope:'Actual on/off framebuffer, independent ray/physical mask. Edge antialias/raster quantization excluded by |rho−1|≤.006; no ellipse proxy.'};
});}
