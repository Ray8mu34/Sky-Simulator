import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDraft, createTeachingStorage, TeachingStorageError } from '../src/platform/teaching-storage';
import type { LocalRecord, TeachingStorage, LocalSaveStatus } from '../src/platform/teaching-storage';
import { COURSE_MAX_BYTES, parseCourse, parseCourseDraft, parseCoursePackage } from '../src/core/course';
import { parseLandscape } from '../src/platform/landscape-data';
import { createDefaultState } from '../src/state';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const course = () => ({ version: 1, title: '课程', steps: [{ title: '地面', text: '说明', durationSeconds: 2, scene: createDefaultState() }] });
const landscape = () => ({ version: 1, name: '地景', dataUrl: 'data:image/png;base64,AQID', northOffsetDeg: 45, enabled: true });
const stringValue = (value: unknown) => { assert.equal(typeof value, 'string'); return value as string; };
function memoryStorage() {
  let record: LocalRecord<unknown> | null = null;
  const storage: TeachingStorage = {
    async read<T>() { return structuredClone(record) as LocalRecord<T> | null; },
    async write<T>(_key: string, value: T, expected: number) {
      if ((record?.revision ?? 0) !== expected) throw new TeachingStorageError('conflict', 'conflict');
      record = { value: structuredClone(value), revision: expected + 1 }; return record.revision;
    },
  };
  return { storage, read: () => record };
}

test('local draft only reports saved after committed write; later edit wins an in-flight write', async () => {
  const firstWrite = deferred<number>(), started = deferred<void>(), statuses: LocalSaveStatus[] = [], writes: unknown[] = [];
  const storage: TeachingStorage = {
    async read() { return null; },
    async write(_key, value, revision) { writes.push(value); if (writes.length === 1) { started.resolve(); return firstWrite.promise; } assert.equal(revision, 1); return 2; },
  };
  const draft = createLocalDraft(storage, 'draft', stringValue, status => statuses.push(status));
  await draft.load();
  void draft.save('first'); await started.promise;
  const latest = draft.save('latest'); firstWrite.resolve(1); await latest;
  assert.deepEqual(writes, ['first', 'latest']);
  assert.equal(statuses.filter(s => s.phase === 'saved').length, 1);
  assert.deepEqual(draft.status(), { phase: 'saved', dirty: false });
});

test('superseded queued draft writes are skipped, and stale load never replaces edits', async () => {
  const reading = deferred<LocalRecord<string> | null>(), writes: unknown[] = [];
  const storage: TeachingStorage = { read: () => reading.promise as Promise<LocalRecord<never> | null>, async write(_key, value, revision) { writes.push(value); assert.equal(revision, 0); return 1; } };
  const draft = createLocalDraft(storage, 'draft', stringValue, () => {});
  const load = draft.load(); void draft.save('old'); const save = draft.save('new');
  reading.resolve(null);
  assert.equal(await load, null); await save;
  assert.deepEqual(writes, ['new']);
});

test('editing before initial read cannot overwrite an unseen saved draft', async () => {
  const reading = deferred<LocalRecord<string> | null>(); let writes = 0;
  const storage: TeachingStorage = { read: () => reading.promise as Promise<LocalRecord<never> | null>, async write() { writes++; return 2; } };
  const draft = createLocalDraft(storage, 'draft', stringValue, () => {});
  const load = draft.load(); const save = draft.save('new local edit'); reading.resolve({ revision: 1, value: 'unseen saved lesson' });
  assert.equal(await load, null); await save;
  assert.equal(writes, 0); assert.equal(draft.status().error?.code, 'conflict'); assert.equal(draft.status().dirty, true);
});

test('retry after unavailable initial read returns the recovered value to restore UI', async () => {
  let available = false;
  const memory = memoryStorage(); await memory.storage.write('draft', 'saved lesson', 0);
  const storage: TeachingStorage = { read: key => available ? memory.storage.read(key) : Promise.reject(new TeachingStorageError('unavailable', 'blocked')), write: (...args) => memory.storage.write(...args) };
  const draft = createLocalDraft(storage, 'draft', stringValue, () => {});
  assert.equal(await draft.load(), null); available = true;
  assert.equal(await draft.retry(), 'saved lesson'); assert.equal(draft.status().dirty, false);
});

test('quota failure leaves draft dirty and explicitly retries without false saved status', async () => {
  let fail = true;
  const storage: TeachingStorage = { async read() { return null; }, async write() { if (fail) throw { name: 'QuotaExceededError' }; return 1; } };
  const draft = createLocalDraft(storage, 'draft', stringValue, () => {});
  await draft.load(); await draft.save('recover me');
  assert.equal(draft.status().phase, 'error'); assert.equal(draft.status().dirty, true); assert.equal(draft.status().error?.code, 'quota');
  fail = false; await draft.retry(); assert.equal(draft.status().phase, 'saved');
});

test('two loaded tabs conflict and retry cannot overwrite newer persistent value', async () => {
  const memory = memoryStorage();
  const first = createLocalDraft(memory.storage, 'draft', stringValue, () => {});
  const second = createLocalDraft(memory.storage, 'draft', stringValue, () => {});
  await Promise.all([first.load(), second.load()]);
  await first.save('saved by first'); await second.save('second unsaved draft'); await second.retry();
  second.allowReplacement(); await second.save('explicit import must also respect conflict');
  assert.equal(memory.read()?.value, 'saved by first');
  assert.equal(second.status().error?.code, 'conflict'); assert.equal(second.status().dirty, true);
});

test('unavailable browser storage access fails cleanly and can be retried', async () => {
  const unavailable = createTeachingStorage(() => { throw new Error('blocked getter'); });
  await assert.rejects(unavailable.read('x'), (error: unknown) => error instanceof TeachingStorageError && error.code === 'unavailable');
  const memory = memoryStorage(); let available = false;
  const storage: TeachingStorage = { read: key => available ? memory.storage.read(key) : Promise.reject(new TeachingStorageError('unavailable', 'blocked')), write: (...args) => memory.storage.write(...args) };
  const draft = createLocalDraft(storage, 'draft', stringValue, () => {});
  await draft.load(); await draft.save('kept locally');
  available = true; await draft.retry();
  assert.equal(memory.read()?.value, 'kept locally'); assert.equal(draft.status().phase, 'saved');
});

test('corrupt records are retained; ordinary edits and retry never replace them', async () => {
  const memory = memoryStorage(); await memory.storage.write('draft', { invalid: true }, 0);
  const draft = createLocalDraft(memory.storage, 'draft', stringValue, () => {});
  await draft.load(); await draft.save('new'); await draft.retry();
  assert.deepEqual(memory.read()?.value, { invalid: true }); assert.equal(draft.status().error?.code, 'corrupt');
});

test('a decoded corrupt saved attachment blocks autosave but allows explicit validated replacement', async () => {
  const memory = memoryStorage(); await memory.storage.write('draft', 'broken attachment', 0);
  const draft = createLocalDraft(memory.storage, 'draft', stringValue, () => {});
  await draft.load(); draft.rejectLoadedValue('cannot decode'); await draft.save('accidental blank edit');
  assert.equal(memory.read()?.value, 'broken attachment');
  draft.allowReplacement(); await draft.save('validated replacement');
  assert.equal(memory.read()?.value, 'validated replacement');
});

test('course packages are backward compatible, isolated, paused and store landscape once', () => {
  const original = course(); original.steps[0]!.scene.time.running = true;
  const legacy = parseCoursePackage(JSON.stringify(original)); assert.equal(legacy.landscape, null);
  const input = { format: 'sky-course-package', version: 1, course: original, landscape: landscape() };
  const parsed = parseCoursePackage(JSON.stringify(input));
  assert.equal(parsed.course.steps[0]!.scene.time.running, false); assert.equal(original.steps[0]!.scene.time.running, true);
  assert.equal(parsed.landscape?.northOffsetDeg, 45); assert.equal('landscape' in parsed.course.steps[0]!, false);
  assert.throws(() => parseCoursePackage({ ...input, landscape: { ...landscape(), northOffsetDeg: 361 } }));
  assert.throws(() => parseCoursePackage({ ...input, version: 2 }));
  assert.throws(() => parseCoursePackage({ ...input, course: { ...original, steps: [null] } }));
  assert.equal(original.title, '课程');
});

test('course byte limit includes multibyte text and rejects giant legacy documents', () => {
  assert.throws(() => parseCourse(' '.repeat(COURSE_MAX_BYTES + 1)));
  assert.throws(() => parseCourse('中'.repeat(COURSE_MAX_BYTES / 3 + 1)), /最大/);
  assert.throws(() => parseCoursePackage(JSON.stringify({ ...course(), extra: 'x'.repeat(COURSE_MAX_BYTES) })), /最大/);
});

test('drafts retain unrecorded text and incomplete duration, accept empty course, reject corrupt state', () => {
  const value = { version: 1, course: { version: 1, title: '', steps: [] }, landscape: null, includeLandscape: false, stepTitle: '下一步', stepText: '未录入的说明', stepDuration: '' };
  assert.deepEqual(parseCourseDraft(value), value);
  assert.throws(() => parseCourse(value.course));
  assert.throws(() => parseCourseDraft({ ...value, stepText: 'x'.repeat(4001) }));
  assert.throws(() => parseCourseDraft({ ...value, landscape: {} }));
  assert.throws(() => parseLandscape({ ...landscape(), dataUrl: 'https://remote.test/image.png' }));
});
