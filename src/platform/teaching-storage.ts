export const TEACHING_DATABASE = 'panoramic-night-sky-teaching';
export interface LocalRecord<T> { revision: number; value: T }
export interface TeachingStorage {
  read<T>(key: string): Promise<LocalRecord<T> | null>;
  write<T>(key: string, value: T, expectedRevision: number): Promise<number>;
}
export class TeachingStorageError extends Error {
  constructor(readonly code: 'unavailable' | 'quota' | 'conflict' | 'corrupt', message: string) {
    super(message); this.name = 'TeachingStorageError';
  }
}
function storageError(error: unknown): TeachingStorageError {
  if (error instanceof TeachingStorageError) return error;
  return error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError'
    ? new TeachingStorageError('quota', '设备存储空间不足；请导出备份后重试。')
    : new TeachingStorageError('unavailable', '无法使用本地保存；请导出备份后重试。');
}
function checkedRecord<T>(value: unknown): LocalRecord<T> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || !('revision' in value) || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1 || !('value' in value)) {
    throw new TeachingStorageError('corrupt', '本地记录无法读取，原记录已保留；请先导出当前内容。');
  }
  return value as LocalRecord<T>;
}

/** A transaction compares and writes a revision together, including across browser tabs. */
export function createTeachingStorage(factory: () => IDBFactory = () => globalThis.indexedDB): TeachingStorage {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timeout); reject(storageError(error)); } };
      const timeout = setTimeout(() => fail(new Error('Storage timeout')), 5000);
      try { request = factory().open(TEACHING_DATABASE, 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records'); };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Storage upgrade blocked'));
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timeout);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  async function transact<T>(key: string, mode: IDBTransactionMode, value?: T, expectedRevision?: number): Promise<LocalRecord<T> | null> {
    const database = await open();
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      let failure: unknown;
      let record: LocalRecord<T> | null = null;
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); database.close();
        if (error) reject(storageError(error)); else resolve(record);
      };
      const timeout = setTimeout(() => { try { tx.abort(); } catch { /* Transaction may already be closed. */ } finish(new Error('Storage timeout')); }, 5000);
      try {
        tx = database.transaction('records', mode);
        tx.oncomplete = () => finish();
        tx.onabort = () => finish(failure ?? tx.error ?? new Error('Storage transaction aborted'));
        tx.onerror = () => { failure ??= tx.error; };
        const store = tx.objectStore('records'), request = store.get(key);
        request.onsuccess = () => {
          try {
            record = checkedRecord<T>(request.result);
            if (mode === 'readonly') return;
            if ((record?.revision ?? 0) !== expectedRevision) throw new TeachingStorageError('conflict', '另一页面已保存新版本。当前编辑仍在；请先导出，再重新读取。');
            record = { revision: (record?.revision ?? 0) + 1, value: value! };
            store.put(record, key);
          } catch (error) { failure = error; tx.abort(); }
        };
      } catch (error) { finish(error); }
    });
  }
  return {
    read: key => transact(key, 'readonly'),
    async write(key, value, expectedRevision) { return (await transact(key, 'readwrite', value, expectedRevision))!.revision; },
  };
}
export const teachingStorage = createTeachingStorage();

export interface LocalSaveStatus {
  phase: 'loading' | 'empty' | 'saving' | 'saved' | 'error';
  dirty: boolean;
  error?: TeachingStorageError;
}

/** Serial commits preserve latest edit order; stale completions cannot claim a newer edit is saved. */
export function createLocalDraft<T>(storage: TeachingStorage, key: string, validate: (value: unknown) => T,
  changed: (status: LocalSaveStatus) => void) {
  let revision = 0, intent = 0, committed = 0;
  let latest: T | undefined, loaded = false, blocked: TeachingStorageError | undefined;
  let status: LocalSaveStatus = { phase: 'loading', dirty: false };
  const publish = (phase: LocalSaveStatus['phase'], error?: TeachingStorageError) => {
    status = { phase, dirty: intent > committed, ...(error ? { error } : {}) }; changed(status);
  };
  let initial: Promise<T | null> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const load = () => initial ??= (async () => {
    const atStart = intent;
    try {
      const record = await storage.read<unknown>(key);
      revision = record?.revision ?? 0; loaded = true;
      const value = record ? validate(record.value) : null;
      // Editing before hydration cannot silently replace a saved draft the user has not seen.
      if (record && intent > 0) {
        blocked = new TeachingStorageError('conflict', '设备上已有保存内容。当前编辑仍在；请先导出，再重新读取。');
        publish('error', blocked); return null;
      }
      if (!intent) publish(record ? 'saved' : 'empty');
      return atStart === intent ? value : null;
    } catch (error) {
      blocked = error instanceof TeachingStorageError ? error : new TeachingStorageError('corrupt', '本地记录无法读取，原记录已保留；请先导出当前内容。');
      publish('error', blocked); return null;
    }
  })();
  const enqueue = (value: T) => {
    latest = structuredClone(value); const token = ++intent;
    publish('saving');
    queue = queue.then(async () => {
      await load();
      if (token !== intent) return;
      if (blocked) { publish('error', blocked); return; }
      try {
        revision = await storage.write(key, latest!, revision);
        committed = token;
        if (token === intent) publish('saved');
      } catch (error) {
        const failure = storageError(error);
        if (failure.code === 'conflict' || failure.code === 'corrupt') blocked = failure;
        if (token === intent) publish('error', failure);
      }
    });
    return queue;
  };
  return {
    load,
    save(value: T) { return enqueue(value); },
    async retry() {
      let restored: T | null = null;
      if (!loaded && blocked?.code === 'unavailable') { initial = undefined; blocked = undefined; restored = await load(); }
      if (latest !== undefined) { await enqueue(latest); return null; }
      if (!loaded && !blocked) { initial = undefined; restored = await load(); }
      return restored;
    },
    status: () => status,
    flush: () => queue,
    rejectLoadedValue(message: string) {
      blocked = new TeachingStorageError('corrupt', message); publish('error', blocked);
    },
    /** Explicit import/replacement may repair an invalid value, but never bypass a tab conflict. */
    allowReplacement() { if (loaded && blocked?.code === 'corrupt') blocked = undefined; },
  };
}
