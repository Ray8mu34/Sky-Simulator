import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';

const root=resolve('qa/final-m4b');
const read=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
const web=await read('build-report-web.json'),portable=await read('build-report-portable.json');
const names=['workflow-confirmed','chrome-offline','edge-offline','updates-passive','ui-extended','ui-drafts','recording','mobile-recording-confirmed','performance'];
const evidence=[];
for(const kind of names){const path=resolve(root,kind,'report.json'),value=JSON.parse(await readFile(path,'utf8'));evidence.push({kind,path,status:value.status});}
const perf=await read('performance/report.json'),updates=await read('updates-passive/report.json');
const videos=[];
for(const [kind,name] of [['recording','interaction.webm'],['mobile-recording-confirmed','bottom-drawer.webm']]){
  const path=resolve(root,kind,name),bytes=(await stat(path)).size;
  const ffmpeg=join(process.env.LOCALAPPDATA,'ms-playwright','ffmpeg-1011','ffmpeg-win64.exe');
  const result=spawnSync(ffmpeg,['-hide_banner','-i',path],{encoding:'utf8'});
  const duration=/Duration:\s*(\d+):(\d+):([\d.]+)/.exec(result.stderr??''),size=/\b(\d+)x(\d+),/.exec(result.stderr??''),fps=/([\d.]+) fps/.exec(result.stderr??'');
  const metadata={path,bytes,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),seconds:duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):null,
    width:size?Number(size[1]):null,height:size?Number(size[2]):null,encodedFps:fps?Number(fps[1]):null,encodedFpsScope:'Video container cadence, not GPU completed/display FPS',inspection:'Bundled Playwright FFmpeg input metadata; no synthetic frames'};
  await writeFile(resolve(root,kind,'video-metadata.json'),JSON.stringify(metadata,null,2));videos.push(metadata);
}
const latest=perf.samples.at(-1),heaps=perf.samples.map(sample=>sample.metrics.mainThreadJsHeapBytes).filter(Number.isFinite);
const summary={stage:'M4B',status:'targeted-functional-and-short-diagnostic-completed-principal-review-pending',generatedAt:new Date().toISOString(),
  artifact:{webBuildId:web.buildId,webEntry:web.files.find(file=>file.path.endsWith('.js')),webRawBytes:web.rawBytes,webGzipBytes:web.gzipBytes,
    portablePath:resolve('dist-portable/三维全景夜空.html'),portableSha256:portable.sha256,portableRawBytes:portable.bytes,portableGzipBytes:portable.gzipBytes,
    workerCountMax:portable.workerCountMax,workerBytes:portable.workerBytes,attributionComplete:portable.attributionComplete},
  performance:{...perf.deliveredFrames,terminology:'Actual renderer submissions; no GPU completion/display FPS claim',cpuSubmissionMs:latest.diagnostics.rendererCpuFrameMs,
    resourcesBefore:perf.preStress,resourcesAfter:perf.postStress,jsHeapBytes:{min:Math.min(...heaps),max:Math.max(...heaps),last:heaps.at(-1)},configuration:perf.resourceSampling,
    environment:perf.environment,thirtyMinuteTest:'deferred by user; not run'},
  updates:{controlledBuilds:updates.packages.map(value=>({version:value.version,buildId:value.report.buildId??null,testTag:value.report.testTag??null,htmlSha256:value.htmlSha256,swSha256:value.swSha256})),
    failedCandidateReloadStatus:updates.bAfterFailedOfflineReload.app.status,actualOriginUnavailable:updates.originStopped,finalScopes:{one:updates.originUnavailableReopen.first.status,two:updates.originUnavailableReopen.second.status}},
  videos,evidence,preservedInitialEvidence:[
    {path:'workflow/report.json',classification:'QA function omitted final status; assertions passed, corrected independent run is workflow-confirmed'},
    {path:'updates/report.json',classification:'Async Playwright wait predicate Promise was treated as truthy; checked cache before install completed'},
    {path:'updates-diagnostic/report.json',classification:'Additional captured installing/nullable waiting evidence for premature wait'},
    {path:'updates-confirmed/report.json',classification:'Strictly expected ready after rejected candidate reload; actual valid failed-update feedback retained'},
    {path:'updates-final/report.json',classification:'QA repeatedly pinged unsupported legacy worker protocol while waiting, keeping old worker alive'},
    {path:'updates-verified/report.json',classification:'Additional active/waiting/timeout/targets evidence; passive CDP probe and final run corrected polling'},
    {path:'update-client-probe/report.json',classification:'Passive native CDP lifecycle/target diagnostic, not a full acceptance pass'},
    {path:'mobile-recording/report.json',classification:'QA saved video after closing browser; original raw video retained, confirmed run fixes finalization order'},
  ],limitations:['Physical mobile, Firefox/Safari and OS PWA install remain untested.','No 100-switch/30-minute test this batch.','Waiting update notice overlaps the tail of the Canvas2D title in one desktop screenshot; chart and complete notice remain readable.','Known pagehide once:true/BFCache lifecycle issue is explicitly deferred to the following lifecycle stage.']};
await writeFile(resolve(root,'summary.json'),JSON.stringify(summary,null,2));
await writeFile(resolve(root,'evidence-index.json'),JSON.stringify({stage:'M4B',artifact:summary.artifact,reports:evidence,videos,preserved:summary.preservedInitialEvidence},null,2));
console.log(JSON.stringify({summary:resolve(root,'summary.json'),videos,submissions:summary.performance.frameCount,seconds:summary.performance.seconds,submissionsPerSecond:summary.performance.framesPerSecond},null,2));
