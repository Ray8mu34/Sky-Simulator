export async function measureHeavyScene(page){return page.evaluate(async()=>{
  const p=window.probe,r=p.renderer.renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const rows=[],queries=[];p.state.illustration.bodySizeScale=8;p.state.environment.refraction='standard';
  for(const key of Object.keys(p.state.layers))p.state.layers[key]=true;p.state.selected='constellation:Ori';p.state.cameras.ground.verticalFovDeg=65;
  for(const mode of ['ground','globe']){
    p.state.viewMode=mode;
    for(let i=0;i<12;i++){p.state.time.utDaysJ2000+=10/86400;p.snapshot=p.computeSnapshot(p.state,100+i);p.renderer.render(p.state,p.snapshot);}gl.finish();
    for(let i=0;i<45;i++){
      const beforeUpdateCount=p.renderer.getInteractionDiagnostics().sphericalArcs.updateCount;
      p.state.time.utDaysJ2000+=10/86400;p.snapshot=p.computeSnapshot(p.state,200+i);
      const query=ext?gl.createQuery():null;if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
      const start=performance.now();p.renderer.render(p.state,p.snapshot);const cpuSubmitMs=performance.now()-start;
      if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);queries.push(query);}gl.finish();const submitAndFinishMs=performance.now()-start;
      const diagnostic=p.renderer.getInteractionDiagnostics(),metrics=p.renderer.getMetrics();
      rows.push({mode,cpuSubmitMs,submitAndFinishMs,arcUpdateMs:diagnostic.sphericalArcs.updateCount>beforeUpdateCount?diagnostic.sphericalArcs.lastUpdateMs:0,lastArcUpdateMs:diagnostic.sphericalArcs.lastUpdateMs,arcUpdateCount:diagnostic.sphericalArcs.updateCount,
        phases:diagnostic.renderPhases,arcPhases:diagnostic.sphericalArcs.updateCount>beforeUpdateCount?diagnostic.sphericalArcs.lastUpdatePhases:null,requestedUploadBytes:diagnostic.sphericalArcs.requestedUploadBytesLastRender,arcSegments:diagnostic.sphericalArcs.totalSegments,arcBudgetMisses:diagnostic.sphericalArcs.budgetExceededArcCount,
        drawCalls:metrics.drawCallsPerFrame,textures:metrics.textureCount,geometries:metrics.geometryCount,ownedGpuEstimate:metrics.appOwnedGpuBytesEstimate});
    }
  }
  const gpuNs=[];if(ext){for(const query of queries){for(let attempt=0;attempt<30&&!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE);attempt++)await new Promise(resolve=>setTimeout(resolve,10));gpuNs.push(gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)?gl.getQueryParameter(query,gl.QUERY_RESULT):null);gl.deleteQuery(query);}}
  const disjoint=ext?gl.getParameter(ext.GPU_DISJOINT_EXT):null;
  return {rows,gpuTimeMs:disjoint?null:gpuNs.map(value=>value===null?null:value/1e6),timerQuerySupported:!!ext,disjoint,
    scope:'Short headed single-context 600x-equivalent snapshot steps, all layers, warm renderer CPU submission/GL finish and optional actual GPU timer. This is not application RAF FPS or 30-minute qualification.'};
});}
