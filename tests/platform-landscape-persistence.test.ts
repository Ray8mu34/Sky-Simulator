import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreparedLandscape, captureLandscape, landscapeState, prepareLandscape, setLandscape, updateLandscape } from '../src/platform/landscape';

function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const value = (name: string) => ({ version: 1 as const, name, dataUrl: 'data:image/png;base64,AQID', northOffsetDeg: 0, enabled: true });

test('landscape prepares atomically, latest async intent wins and temporary lesson can restore original pixels', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let decoding = Promise.resolve();
  class ImageMock { src = ''; width = 4; height = 2; decode() { return decoding; } }
  const pixel = { width: 4, height: 2, data: new Uint8ClampedArray(32) };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: ImageMock });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => pixel }) }) } });
  try {
    const first = deferred(); decoding = first.promise; const oldImport = setLandscape(value('old'));
    decoding = Promise.resolve(); await setLandscape(value('latest')); first.resolve(); await oldImport;
    assert.equal(landscapeState().current?.name, 'latest');
    const removal = deferred(); decoding = removal.promise; const importBeforeRemove = setLandscape(value('resurrect'));
    await setLandscape(null); removal.resolve(); await importBeforeRemove;
    assert.equal(landscapeState().current, null);
    decoding = Promise.resolve(); await setLandscape(value('original'));
    const calibration = deferred(); decoding = calibration.promise; const importBeforeEdit = setLandscape(value('stale'));
    updateLandscape({ northOffsetDeg: 45 }); calibration.resolve(); await importBeforeEdit;
    assert.equal(landscapeState().current?.name, 'original'); assert.equal(landscapeState().current?.northOffsetDeg, 45);
    const before = captureLandscape();
    decoding = Promise.reject(new Error('bad image')); await assert.rejects(prepareLandscape(value('bad')));
    assert.deepEqual(captureLandscape(), before);
    decoding = Promise.resolve(); const lesson = await prepareLandscape(value('lesson'));
    applyPreparedLandscape(lesson, false); assert.equal(landscapeState().current?.name, 'lesson');
    applyPreparedLandscape(before, false); assert.deepEqual(captureLandscape(), before);
    assert.throws(() => updateLandscape({ northOffsetDeg: NaN })); assert.equal(landscapeState().current?.northOffsetDeg, 45);
  } finally {
    for (const [key, descriptor] of [['window', originalWindow], ['Image', originalImage], ['document', originalDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
