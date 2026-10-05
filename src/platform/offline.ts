import type { OfflineController, OfflineStatus } from './offline-status';
interface WorkerStatus { buildId: string; scope: string; cache: string; complete: boolean }

/** file:// never registers a SW. One owner qualifies versions and never forces a classroom reload. */
export async function registerOffline(onStatus: (status: OfflineStatus) => void): Promise<OfflineController> {
  const expected = document.querySelector<HTMLMetaElement>('meta[name="sky-build-id"]')?.content ?? null;
  let current: OfflineStatus = { phase: 'installing', message: '正在缓存离线资源…', expectedBuildId: expected, activeBuildId: null, waitingBuildId: null };
  let registration: ServiceWorkerRegistration | null = null;
  let active: WorkerStatus | null = null, waiting: WorkerStatus | null = null;
  let failure: 'download' | 'probe' | null = null, disposed = false;
  let probing = false, refreshQueued = false;
  let activeOwner: ServiceWorker | null = null, waitingOwner: ServiceWorker | null = null;
  const cancelProbes = new Set<() => void>();
  const watched = new Map<ServiceWorker, () => void>();
  const publish = (phase: OfflineStatus['phase'], message: string) => {
    if (disposed) return;
    current = { phase, message, expectedBuildId: expected, activeBuildId: active?.buildId ?? null, waitingBuildId: waiting?.buildId ?? null };
    onStatus({ ...current });
  };
  const emit = () => {
    if (waiting?.complete) publish('update-ready', '新版已缓存；下课后保存场景，关闭本应用所有页面后重新打开更新');
    else if (waiting && !waiting.complete) publish('update-failed', '新版离线缓存不完整；继续当前版本，可使用便携 HTML');
    else if (failure) publish(active?.complete ? 'update-failed' : 'error', active?.complete ? '新版离线缓存未完成；当前旧版仍可离线使用' : '离线缓存未完成；可使用便携 HTML');
    else if (registration?.installing) publish('installing', active?.complete ? '新版正在缓存；当前教学继续使用旧版' : '正在缓存离线资源…');
    else if (registration?.waiting) publish('installing', '正在确认新版离线资源；当前版本保持运行');
    else if (active?.complete && active.buildId === expected) publish('ready', '离线资源已就绪');
    else if (active && !active.complete) publish('error', '离线缓存不完整；可使用便携 HTML');
    else if (active?.complete) publish('installing', '当前页面与离线包版本不同；下课后关闭所有应用页面再重新打开');
    else publish('installing', '正在确认离线资源…');
  };
  const probe = (worker: ServiceWorker, scope: string): Promise<WorkerStatus> => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const clean = () => { clearTimeout(timer); channel.port1.close(); cancelProbes.delete(cancel); };
    const cancel = () => { clean(); reject(new Error('离线检查已停止')); };
    const timer = setTimeout(() => { clean(); reject(new Error('离线版本确认超时')); }, 5000);
    cancelProbes.add(cancel);
    channel.port1.onmessage = event => {
      const value = event.data as Partial<WorkerStatus> & { type?: string };
      if (value?.type !== 'OFFLINE_STATUS_RESULT' || value.scope !== scope || typeof value.buildId !== 'string'
        || !/^[a-f0-9]{16}$/.test(value.buildId) || value.cache !== `sky-v3:${scope}:${value.buildId}` || typeof value.complete !== 'boolean') return;
      clean(); resolve(value as WorkerStatus);
    };
    try { worker.postMessage({ type: 'OFFLINE_STATUS', expectedBuildId: expected }, [channel.port2]); }
    catch (error) { clean(); reject(error); }
  });
  const refresh = async () => {
    if (!registration || disposed) return;
    if (probing) {
      if (activeOwner !== registration.active) active = null;
      if (waitingOwner !== registration.waiting) waiting = null;
      refreshQueued = true; emit(); return;
    }
    probing = true;
    const reg = registration, activeWorker = reg.active, waitingWorker = reg.waiting;
    if (activeOwner !== activeWorker) { activeOwner = activeWorker; active = null; }
    if (waitingOwner !== waitingWorker) { waitingOwner = waitingWorker; waiting = null; }
    const results = await Promise.allSettled([
      activeWorker ? probe(activeWorker, reg.scope) : Promise.resolve(null),
      waitingWorker ? probe(waitingWorker, reg.scope) : Promise.resolve(null),
    ]);
    probing = false;
    if (!disposed && registration === reg) {
      if (reg.active === activeWorker && results[0].status === 'fulfilled') active = results[0].value;
      if (reg.waiting === waitingWorker && results[1].status === 'fulfilled') waiting = results[1].value;
      const probeFailed = (reg.active === activeWorker && results[0].status === 'rejected')
        || (reg.waiting === waitingWorker && results[1].status === 'rejected');
      if (probeFailed && failure !== 'download') failure = 'probe';
      else if (!probeFailed && failure === 'probe') failure = null;
      emit();
      if (refreshQueued) { refreshQueued = false; void refresh(); }
    }
  };
  const watch = (worker: ServiceWorker | null) => {
    if (!worker || watched.has(worker)) return;
    const changed = () => {
      if (disposed) return;
      if (worker.state === 'redundant') { failure = 'download'; emit(); }
      else if (worker.state === 'installed' || worker.state === 'activated') { failure = null; void refresh(); }
      if (worker.state === 'redundant' || worker.state === 'activated') {
        worker.removeEventListener('statechange', changed); watched.delete(worker);
      }
    };
    watched.set(worker, changed); worker.addEventListener('statechange', changed);
  };
  const updateFound = () => {
    // Hold the actual worker: registration.installing is cleared before the installed event.
    const worker = registration?.installing ?? null;
    if (worker) { failure = null; watch(worker); emit(); }
  };
  const controllerChanged = () => { active = null; waiting = null; failure = null; void refresh(); };
  const controller: OfflineController = {
    getStatus: () => ({ ...current }),
    async checkForUpdate() {
      if (!registration || disposed) return;
      try { await registration.update(); await refresh(); }
      catch { failure = 'download'; emit(); }
    },
    dispose() {
      disposed = true;
      registration?.removeEventListener('updatefound', updateFound);
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
      for (const [worker, listener] of watched) worker.removeEventListener('statechange', listener);
      watched.clear();
      for (const cancel of [...cancelProbes]) cancel();
    },
  };
  if (__SKY_PORTABLE__ || location.protocol === 'file:') { publish('portable', '便携离线版 · 资源已内联'); return controller; }
  if (import.meta.env.DEV) { publish('development', '本地开发'); return controller; }
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { publish('unsupported', '当前环境不支持离线缓存'); return controller; }
  if (!expected || !/^[a-f0-9]{16}$/.test(expected)) { publish('error', '离线版本标识缺失；可使用便携 HTML'); return controller; }
  publish('installing', '正在缓存离线资源…');
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (disposed) return controller;
    registration.addEventListener('updatefound', updateFound);
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    watch(registration.installing); watch(registration.waiting);
    void refresh();
    void navigator.serviceWorker.ready.then(() => { if (!disposed) void refresh(); });
  } catch { failure = 'download'; emit(); }
  return controller;
}
