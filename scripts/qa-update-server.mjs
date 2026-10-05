import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

/** Private localhost server: change actual package roots, never alter cached resources. */
export async function startUpdateServer(packages) {
  const scopes = new Map(), requests = [];
  let closing;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><title>Private offline QA control</title><p>Outside application scopes.</p>'); return;
    }
    const entry = [...scopes].find(([scope]) => url.pathname.startsWith(scope));
    if (!entry) { response.writeHead(404); response.end(); return; }
    const [scope, selected] = entry;
    let local;
    try { local = decodeURIComponent(url.pathname.slice(scope.length)) || 'index.html'; }
    catch { response.writeHead(400); response.end(); return; }
    const root = resolve(packages[selected.version]), target = resolve(root, local);
    const relativePath = relative(root, target);
    if (isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`) || relativePath === '..' || resolve(target) === root) { response.writeHead(403); response.end(); return; }
    const log = { at: new Date().toISOString(), scope, version: selected.version, path: url.pathname, local, method: request.method, fault: selected.fault === local };
    requests.push(log);
    if (log.fault) { log.status = 404; response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end('Deliberate failed download in controlled QA'); return; }
    try {
      const body = await readFile(target);
      log.status = 200;
      response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { log.status = 404; response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    select(scope, version, fault = null) {
      if (!/^\/[a-z0-9-]+\/$/.test(scope) || !Object.hasOwn(packages, version)) throw new Error('Unknown QA scope/package');
      scopes.set(scope, { version, fault });
    },
    close: () => closing ??= new Promise((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}
