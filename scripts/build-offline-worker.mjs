/** Scope-owned, version-qualified cache. No forced activation or client claiming. */
export function createOfflineWorker(buildId, core) {
  return `const BUILD_ID=${JSON.stringify(buildId)}, CORE=${JSON.stringify(core)};
const SCOPE=self.registration.scope, PREFIX='sky-v3:'+SCOPE+':', CACHE=PREFIX+BUILD_ID;
const COMMIT=new URL('./__sky_offline_commit__',SCOPE).href;
async function committed(){const cache=await caches.open(CACHE),marker=await cache.match(COMMIT);if(!marker)return false;
try{const value=await marker.json();if(value.buildId!==BUILD_ID||value.files!==CORE.length)return false;
for(const file of CORE)if(!await cache.match(new URL(file.url,SCOPE).href,{ignoreVary:true}))return false;return true;}catch{return false;}}
self.addEventListener('install',event=>event.waitUntil((async()=>{
try{const cache=await caches.open(CACHE);await cache.delete(COMMIT);
for(const file of CORE){const url=new URL(file.url,SCOPE).href,response=await fetch(new Request(url,{cache:'no-store'}));
if(!response.ok)throw new Error('Offline resource unavailable: '+file.url);
const bytes=await response.clone().arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
if(hash!==file.sha256)throw new Error('Offline resource version mismatch: '+file.url);await cache.put(url,response);}
await cache.put(COMMIT,new Response(JSON.stringify({buildId:BUILD_ID,files:CORE.length}),{headers:{'Content-Type':'application/json'}}));
}catch(error){await caches.delete(CACHE);throw error;}})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{if(!await committed())throw new Error('Offline cache not committed');
await Promise.all((await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==CACHE).map(key=>caches.delete(key)));})()));
self.addEventListener('message',event=>{const request=event.data;if(request!=='OFFLINE_STATUS'&&request?.type!=='OFFLINE_STATUS')return;
event.waitUntil((async()=>{const complete=await committed(),result={type:'OFFLINE_STATUS_RESULT',buildId:BUILD_ID,scope:SCOPE,cache:CACHE,complete};
if(event.ports?.[0])event.ports[0].postMessage(result);else if(complete)event.source?.postMessage({type:'OFFLINE_READY',buildId:BUILD_ID,cache:CACHE});})());});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==location.origin||!url.href.startsWith(SCOPE))return;
event.respondWith((async()=>{const cache=await caches.open(CACHE),shellUrl=new URL('./index.html',SCOPE);
if(event.request.mode==='navigate'&&(url.pathname===new URL(SCOPE).pathname||url.pathname===shellUrl.pathname)){const shell=await cache.match(shellUrl.href,{ignoreVary:true});if(shell)return shell;}
const hit=await cache.match(event.request,{ignoreVary:true});if(hit)return hit;
try{return await fetch(event.request);}catch(error){if(event.request.mode==='navigate'){const shell=await cache.match(new URL('./index.html',SCOPE).href,{ignoreVary:true});if(shell)return shell;}throw error;}})());});
`;
}
