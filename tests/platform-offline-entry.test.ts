import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createOfflineWorker } from '../scripts/build-offline-worker.mjs';

test('active SW serves its committed entry for online root/index navigation while a newer server package exists', async () => {
  const scope = 'http://127.0.0.1:4174/lesson-one/';
  const handlers = new Map<string, (event: unknown) => void>();
  let networkRequests = 0;
  const cached = new Map([
    [`${scope}index.html`, '<meta name="sky-build-id" content="bbbbbbbbbbbbbbbb">'],
    [`${scope}assets/b.js`, 'activeB()'],
  ]);
  vm.runInNewContext(createOfflineWorker('bbbbbbbbbbbbbbbb', []), {
    URL, Response,
    self: { registration: { scope }, addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler) },
    location: { origin: new URL(scope).origin },
    caches: { open: async () => ({ match: async (input: string | { url: string }) => {
      const value = cached.get(typeof input === 'string' ? input : input.url);
      return value === undefined ? undefined : new Response(value);
    } }) },
    fetch: async () => { networkRequests++; return new Response('serverC()'); },
  });
  async function request(url: string, mode: string) {
    const captured: { response?: Promise<Response> } = {};
    handlers.get('fetch')!({ request: { method: 'GET', url, mode }, respondWith: (value: Promise<Response>) => { captured.response = value; } });
    return captured.response ? (await captured.response).text() : null;
  }
  for (const url of [scope, `${scope}?lesson=continues`, `${scope}index.html`, `${scope}index.html?lesson=continues`]) {
    assert.match((await request(url, 'navigate'))!, /bbbbbbbbbbbbbbbb/);
  }
  assert.equal(await request(`${scope}assets/b.js`, 'cors'), 'activeB()');
  assert.equal(networkRequests, 0);
  assert.equal(await request('http://127.0.0.1:4174/lesson-two/', 'navigate'), null);
});
