/** Uses the probe's one actual WebGL context and its uploaded production LUT. No second context. */
export async function measureRefractionGpu(page){return page.evaluate(async()=>{
  const {getRefractionShaderChunk,refractEnuDirection,unrefractEnuDirection}=await import('/src/core/refraction.ts');
  const {angularSeparationDeg}=await import('/src/core/math.ts');
  const p=window.probe,owner=p.renderer,renderer=owner.renderer,bridge=owner.refractionBridge,profile=owner.refractionProfile,gl=renderer.getContext();
  const texture=renderer.properties.get(bridge.texture).__webglTexture;if(!texture)throw new Error('Actual RG32F LUT not uploaded');
  const inputs=[];for(const h of [-90,-89.99,-45,-1.01,-1,-.99999,-.9,-.5,0,.1,1,4.99,5,5.01,30,60,89,89.99,89.9999,90])for(const az of [0,31,90,177,270,359]){
    const r=h*Math.PI/180,a=az*Math.PI/180;inputs.push(Math.cos(r)*Math.sin(a),Math.cos(r)*Math.cos(a),Math.sin(r));
  }for(let i=0;i<=1000;i++){const h=-1+91*i/1000,r=h*Math.PI/180,a=i*.371;inputs.push(Math.cos(r)*Math.sin(a),Math.cos(r)*Math.cos(a),Math.sin(r));}
  const data=new Float32Array(inputs),shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  const vs=shader(gl.VERTEX_SHADER,`#version 300 es\nprecision highp float;precision highp int;in vec3 inputDirection;out vec3 mappedForward;out vec3 mappedInverse;${getRefractionShaderChunk()}\nvoid main(){mappedForward=skyRefractEnu(inputDirection);mappedInverse=skyUnrefractEnu(inputDirection);gl_Position=vec4(0,0,0,1);}`);
  const fs=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0);}');
  const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.transformFeedbackVaryings(program,['mappedForward','mappedInverse'],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  const vao=gl.createVertexArray(),input=gl.createBuffer(),output=gl.createBuffer(),feedback=gl.createTransformFeedback();
  try{
    renderer.resetState();gl.useProgram(program);gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,input);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    const location=gl.getAttribLocation(program,'inputDirection');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,output);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,data.length*2*4,gl.STREAM_READ);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,feedback);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,output);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(program,'uRefractionLut'),0);gl.uniform1i(gl.getUniformLocation(program,'uRefractionEnabled'),bridge.uniforms.uRefractionEnabled.value?1:0);
    for(const name of ['uRefractionForward','uRefractionInverseLow','uRefractionInverseHigh'])gl.uniform4fv(gl.getUniformLocation(program,name),bridge.uniforms[name].value.toArray());
    gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArrays(gl.POINTS,0,data.length/3);gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);
    const result=new Float32Array(data.length*2);gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER,0,result);
    let maxForwardArcsec=0,maxInverseArcsec=0,worstForward=null,worstInverse=null;
    for(let i=0;i<data.length/3;i++){
      const direction=Array.from(data.subarray(i*3,i*3+3));
      for(const [channel,fn] of [[0,refractEnuDirection],[1,unrefractEnuDirection]]){
        const actual=Array.from(result.subarray(i*6+channel*3,i*6+channel*3+3)),expected=fn(direction,profile),error=angularSeparationDeg(actual,expected)*3600;
        if(channel===0&&error>maxForwardArcsec){maxForwardArcsec=error;worstForward={direction,actual,expected,error};}
        if(channel===1&&error>maxInverseArcsec){maxInverseArcsec=error;worstInverse={direction,actual,expected,error};}
      }
    }
    const glError=gl.getError();if(glError!==gl.NO_ERROR)throw new Error(`TF GL error ${glError}`);
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {sampleCount:data.length/3,profileKey:profile.key,identity:profile.identity,enabled:bridge.uniforms.uRefractionEnabled.value,actualTextureId:bridge.texture.uuid,maxForwardArcsec,maxInverseArcsec,worstForward,worstInverse,
      webglVendor:gl.getParameter(gl.VENDOR),webglRenderer:gl.getParameter(gl.RENDERER),unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
      scope:'Actual WebGL2 transform feedback using the renderer uploaded RG32F slot; compares core CPU mapping of the same Float32 input. Separate from CPU profile-vs-policy interpolation error.'};
  }finally{
    gl.disable(gl.RASTERIZER_DISCARD);gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,null);gl.bindVertexArray(null);
    gl.deleteTransformFeedback(feedback);gl.deleteBuffer(input);gl.deleteBuffer(output);gl.deleteVertexArray(vao);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);renderer.resetState();
    owner.render(p.state,p.snapshot);
  }
});}
