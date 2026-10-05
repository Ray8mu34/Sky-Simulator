import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotNeedsImmediateUi, uiCadenceDue, UI_UPDATE_INTERVAL_MS } from '../src/platform/ui-cadence';
import { SimulationClock } from '../src/platform/clock';
import { createDefaultState } from '../src/state';
import { dateToUt } from '../src/core/time';
import { solarDayKey } from '../src/core/teaching';

test('240Hz accepted science remains immediate while ordinary playback has one existing UI publication per interval', () => {
  const state = createDefaultState(), clock = new SimulationClock();
  clock.rebase(state.time.utDaysJ2000, 600, true, 0);
  let ready = false, scienceDirty = true, lastUiMs = -Infinity, accepted = 0;
  const published: number[] = [];
  for (let frame = 0; frame <= 480; frame++) {
    const nowMs = frame * 1000 / 240;
    const immediate = snapshotNeedsImmediateUi(scienceDirty, ready, true);
    state.time.utDaysJ2000 = clock.sample(nowMs); accepted++; ready = true; scienceDirty = false;
    if (immediate) { published.push(nowMs); lastUiMs = nowMs; }
    if (uiCadenceDue(nowMs, lastUiMs)) { published.push(nowMs); lastUiMs = nowMs; }
  }
  assert.equal(accepted, 481); assert.equal(clock.rebaseCount, 1);
  assert.equal(published[0], 0); assert.ok(published.length >= 11 && published.length <= 12);
  assert.equal(new Set(published).size, published.length, 'Immediate refresh must not double-publish through the same-frame cadence.');
  for (let i = 1; i < published.length; i++) assert.ok(published[i]! - published[i - 1]! >= UI_UPDATE_INTERVAL_MS);
  assert.equal(state.time.utDaysJ2000, clock.sample(2000));
});

test('explicit dirty and paused snapshots publish immediately and restart only the existing UI cadence', () => {
  let lastUiMs = 180;
  const publication: number[] = [];
  for (const sample of [
    { nowMs: 225, scienceDirty: true, ready: true, running: true },
    { nowMs: 250, scienceDirty: false, ready: true, running: true },
    { nowMs: 300, scienceDirty: false, ready: true, running: false },
    { nowMs: 310, scienceDirty: false, ready: true, running: true },
    { nowMs: 480, scienceDirty: false, ready: true, running: true },
  ]) {
    if (snapshotNeedsImmediateUi(sample.scienceDirty, sample.ready, sample.running)) { publication.push(sample.nowMs); lastUiMs = sample.nowMs; }
    if (uiCadenceDue(sample.nowMs, lastUiMs)) { publication.push(sample.nowMs); lastUiMs = sample.nowMs; }
  }
  assert.deepEqual(publication, [225, 300, 480]);
});

test('the current civil-day key changes by the next existing UI interval and never labels an old event result as the new day', () => {
  const state = createDefaultState(), clock = new SimulationClock();
  state.observer.displayZone = { kind: 'fixed', offsetMinutes: 480 };
  state.time.utDaysJ2000 = dateToUt(new Date('2026-09-14T15:59:30Z'));
  const beforeKey = solarDayKey(state), beforeResult = { key: beforeKey, marker: 'old-day' };
  clock.rebase(state.time.utDaysJ2000, 600, true, 0);
  let lastUiMs = 0, changedAt: number | null = null, publishedNewAt: number | null = null;
  for (let frame = 1; frame <= 60; frame++) {
    const nowMs = frame * 1000 / 240; state.time.utDaysJ2000 = clock.sample(nowMs);
    const currentKey = solarDayKey(state); if (currentKey !== beforeKey && changedAt === null) changedAt = nowMs;
    if (uiCadenceDue(nowMs, lastUiMs)) {
      lastUiMs = nowMs;
      if (currentKey !== beforeKey) {
        publishedNewAt = nowMs;
        const publishableResult = beforeResult.key === currentKey ? beforeResult : null;
        assert.equal(publishableResult, null, 'A pending new date cannot consume the retained previous-date event array.');
        break;
      }
    }
  }
  assert.ok(changedAt !== null && publishedNewAt !== null);
  assert.ok(publishedNewAt - changedAt <= UI_UPDATE_INTERVAL_MS);
  assert.equal(clock.rebaseCount, 1);
});
