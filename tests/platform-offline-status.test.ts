import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { OfflineController, OfflineStatus } from '../src/platform/offline-status';

const source = (await build({ entryPoints: ['src/platform/offline.ts'], bundle: true, write: false, format: 'cjs',
  define: { __SKY_PORTABLE__: 'false', 'import.meta.env.DEV': 'false' } })).outputFiles[0].text;
const scope = 'https://sky.example/lesson/', oldBuild = 'aaaaaaaaaaaaaaaa', newBuild = 'bbbbbbbbbbbbbbbb';
class Worker extends EventTarget {
  state = 'activated';
  constructor(readonly buildId: string, readonly complete = true) { super(); }
  postMessage(_request: unknown, ports: Array<{ send(data: unknown): void }>) {
    queueMicrotask(() => ports[0].send({ type: 'OFFLINE_STATUS_RESULT', scope, buildId: this.buildId, cache: `sky-v3:${scope}:${this.buildId}`, complete: this.complete }));
  }
  transition(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
class Channel {
  port1 = { onmessage: null as null | ((event: { data: unknown }) => void), close() {} };
  port2 = { send: (data: unknown) => this.port1.onmessage?.({ data }) };
}
async function fixture(initialFailure = false) {
  const reg = Object.assign(new EventTarget(), { scope, active: new Worker(oldBuild), installing: null as Worker | null,
    waiting: null as Worker | null, update: async () => { updates++; await updateWork(); } });
  let updates = 0, registrations = 0, updateWork = async () => {};
  const sw = Object.assign(new EventTarget(), { ready: Promise.resolve(reg), register: async () => {
    registrations++;
    if (initialFailure && registrations === 1) throw new Error('offline');
    return reg;
  } });
  const module = { exports: {} as { registerOffline(cb: (value: OfflineStatus) => void): Promise<OfflineController> } };
  vm.runInNewContext(source, { module, exports: module.exports, setTimeout, clearTimeout, MessageChannel: Channel,
    document: { querySelector: () => ({ content: oldBuild }) }, navigator: { serviceWorker: sw },
    location: { protocol: 'https:' }, window: { isSecureContext: true } });
  const statuses: OfflineStatus[] = [];
  const controller = await module.exports.registerOffline(value => statuses.push(value));
  const settle = async () => { for (let count = 0; count < 15; count++) await Promise.resolve(); };
  await settle();
  return { reg, controller, statuses, settle, updates: () => updates, registrations: () => registrations,
    updateWith: (work: () => Promise<void>) => { updateWork = work; } };
}

test('only a successful explicit check reports no update; concurrent checks share one request', async () => {
  const f = await fixture();
  try {
    assert.equal(f.controller.getStatus().phase, 'ready');
    assert.equal(f.controller.getStatus().updateCheck, 'idle');
    let finish!: () => void;
    f.updateWith(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = f.controller.checkForUpdate(), second = f.controller.checkForUpdate();
    assert.equal(first, second); assert.equal(f.updates(), 1);
    assert.equal(f.controller.getStatus().updateCheck, 'checking');
    finish(); await first;
    assert.equal(f.controller.getStatus().updateCheck, 'current');
    assert.match(f.controller.getStatus().message, /未发现更新/);
    assert.ok(f.controller.getStatus().lastCheckedAt);
  } finally { f.controller.dispose(); }
});

test('installing update never reports current and committed waiting worker preserves page identity', async () => {
  const f = await fixture();
  try {
    const candidate = new Worker(newBuild); candidate.state = 'installing';
    f.updateWith(async () => { f.reg.installing = candidate; f.reg.dispatchEvent(new Event('updatefound')); });
    await f.controller.checkForUpdate();
    assert.equal(f.controller.getStatus().phase, 'installing');
    assert.notEqual(f.controller.getStatus().updateCheck, 'current');
    assert.doesNotMatch(f.controller.getStatus().message, /未发现更新|最新/);
    f.reg.installing = null; f.reg.waiting = candidate; candidate.transition('installed'); await f.settle();
    const status = f.controller.getStatus();
    assert.equal(status.phase, 'update-ready'); assert.equal(status.expectedBuildId, oldBuild);
    assert.equal(status.activeBuildId, oldBuild); assert.equal(status.waitingBuildId, newBuild);
    assert.match(status.message, /关闭本应用所有页面/); assert.doesNotMatch(status.message, /刷新即可/);
  } finally { f.controller.dispose(); }
});

test('failed check keeps complete old version available; retry clears the failed result', async () => {
  const f = await fixture();
  try {
    f.updateWith(async () => { throw new Error('offline'); }); await f.controller.checkForUpdate();
    assert.equal(f.controller.getStatus().phase, 'update-failed');
    assert.equal(f.controller.getStatus().updateCheck, 'failed');
    assert.match(f.controller.getStatus().message, /当前版本可继续离线使用/);
    f.updateWith(async () => {}); await f.controller.checkForUpdate();
    assert.equal(f.controller.getStatus().updateCheck, 'current');
  } finally { f.controller.dispose(); }
});

test('failed initial registration can retry without reopening or clearing cached data', async () => {
  const f = await fixture(true);
  try {
    assert.equal(f.controller.getStatus().phase, 'error');
    assert.equal(f.controller.getStatus().canCheckForUpdate, true);
    await f.controller.checkForUpdate();
    assert.equal(f.registrations(), 2); assert.equal(f.controller.getStatus().phase, 'ready');
  } finally { f.controller.dispose(); }
});

test('dispose ignores late check completion and detaches worker listeners', async () => {
  const f = await fixture();
  let finish!: () => void;
  f.updateWith(() => new Promise<void>(resolve => { finish = resolve; }));
  const check = f.controller.checkForUpdate();
  f.controller.dispose(); const count = f.statuses.length;
  finish(); await check; await f.controller.checkForUpdate();
  assert.equal(f.statuses.length, count); assert.equal(f.updates(), 1);
});
