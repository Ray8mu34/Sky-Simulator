import type { OfflineController, OfflineStatus } from './offline-status';
interface WorkerStatus { buildId: string; scope: string; cache: string; complete: boolean }

/** file:// never registers a SW. One owner qualifies versions and never forces a classroom reload. */
export async function registerOffline(onStatus: (status: OfflineStatus) => void): Promise<OfflineController> {
  const expected = document.querySelector<HTMLMetaElement>('meta[name="sky-build-id"]')?.content ?? null;
  let current: OfflineStatus = { phase: 'installing', message: '正在缓存离线资源…', expectedBuildId: expected, activeBuildId: null, waitingBuildId: null,
    updateCheck: 'idle', lastCheckedAt: null, canCheckForUpdate: false };
  let registration: ServiceWorkerRegistration | null = null;
  let active: WorkerStatus | null = null, waiting: WorkerStatus | null = null;
  let failure: 'download' | 'probe' | 'check' | null = null, disposed = false;
  let refreshTask: Promise<void> | null = null, refreshQueued = false;
  let updateTask: Promise<void> | null = null, checking = false, canCheck = false;
  let lastCheckedAt: number | null = null;
  let activeOwner: ServiceWorker | null = null, waitingOwner: ServiceWorker | null = null;
  const cancelProbes = new Set<() => void>();
  const watched = new Map<ServiceWorker, () => void>();
  const publish = (phase: OfflineStatus['phase'], message: string) => {
    if (disposed) return;
    current = { phase, message, expectedBuildId: expected, activeBuildId: active?.buildId ?? null, waitingBuildId: waiting?.buildId ?? null,
      updateCheck: checking ? 'checking' : failure ? 'failed' : lastCheckedAt && phase === 'ready' ? 'current' : 'idle',
      lastCheckedAt, canCheckForUpdate: canCheck };
    onStatus({ ...current });
  };
  const emit = () => {
    if (waiting?.complete) publish('update-ready', '新版已就绪。保存场景后，关闭本应用所有页面（含独立窗口），再重新打开即可更新。');
    else if (waiting && !waiting.complete) publish('update-failed', '新版下载未完成，请联网后检查更新。');
    else if (failure) {
      const explanation = failure === 'check' ? '检查更新失败，请联网后重试。' : failure === 'probe' ? '暂时无法确认离线资源，请重试检查。' : '离线资源下载未完成，请联网后检查更新。';
      publish(active?.complete ? 'update-failed' : 'error', `${explanation}${active?.complete ? '当前版本可继续离线使用。' : ''}`);
    }
    else if (registration?.installing) publish('installing', active?.complete ? '正在下载新版…' : '正在缓存离线资源…');
    else if (registration?.waiting) publish('installing', '正在检查更新…');
    else if (checking) publish(active?.complete ? 'ready' : 'installing', '正在检查更新…');
    else if (active?.complete && active.buildId === expected) publish('ready', lastCheckedAt ? '已检查，未发现更新。离线资源已就绪。' : '离线资源已就绪');
    else if (active && !active.complete) publish('error', '离线资源不完整，请联网后重试。');
    else if (active?.complete) publish('update-ready', '离线版本已变化。保存场景后，关闭本应用所有页面（含独立窗口），再重新打开。');
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
  const refresh = (): Promise<void> => {
    if (!registration || disposed) return Promise.resolve();
    if (refreshTask) {
      if (activeOwner !== registration.active) active = null;
      if (waitingOwner !== registration.waiting) waiting = null;
      refreshQueued = true; emit(); return refreshTask;
    }
    refreshTask = (async () => {
      do {
        refreshQueued = false;
        const reg: ServiceWorkerRegistration = registration!, activeWorker = reg.active, waitingWorker = reg.waiting;
        if (activeOwner !== activeWorker) { activeOwner = activeWorker; active = null; }
        if (waitingOwner !== waitingWorker) { waitingOwner = waitingWorker; waiting = null; }
        const results = await Promise.allSettled([
          activeWorker ? probe(activeWorker, reg.scope) : Promise.resolve(null),
          waitingWorker ? probe(waitingWorker, reg.scope) : Promise.resolve(null),
        ]);
        if (!disposed && registration === reg) {
          if (reg.active === activeWorker && results[0].status === 'fulfilled') active = results[0].value;
          if (reg.waiting === waitingWorker && results[1].status === 'fulfilled') waiting = results[1].value;
          const probeFailed = (reg.active === activeWorker && results[0].status === 'rejected')
            || (reg.waiting === waitingWorker && results[1].status === 'rejected');
          if (probeFailed && !failure) failure = 'probe';
          else if (!probeFailed && failure === 'probe') failure = null;
          emit();
        }
      } while (refreshQueued && !disposed);
    })().finally(() => { refreshTask = null; });
    return refreshTask;
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
  const connect = async () => {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (disposed) return;
    registration.addEventListener('updatefound', updateFound);
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    watch(registration.installing); watch(registration.waiting);
    void navigator.serviceWorker.ready.then(() => { if (!disposed) void refresh(); });
  };
  const controller: OfflineController = {
    getStatus: () => ({ ...current }),
    checkForUpdate() {
      if (!canCheck || disposed) return Promise.resolve();
      if (updateTask) return updateTask;
      checking = true; failure = null; lastCheckedAt = null; emit();
      updateTask = (async () => {
        try {
          if (!registration) await connect();
          if (disposed) return;
          await registration!.update();
          if (disposed) return;
          lastCheckedAt = Date.now();
          await refresh();
        } catch { failure = 'check'; }
        finally { checking = false; updateTask = null; emit(); }
      })();
      return updateTask;
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
  if (__SKY_PORTABLE__ || location.protocol === 'file:') { publish('portable', '离线版'); return controller; }
  if (import.meta.env.DEV) { publish('development', '本地开发'); return controller; }
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { publish('unsupported', '当前环境不支持离线缓存'); return controller; }
  if (!expected || !/^[a-f0-9]{16}$/.test(expected)) { publish('error', '离线模式暂不可用，请联网使用或打开离线版。'); return controller; }
  canCheck = true;
  publish('installing', '正在缓存离线资源…');
  try {
    await connect();
    if (disposed) return controller;
    void refresh();
  } catch { failure = 'download'; emit(); }
  return controller;
}
