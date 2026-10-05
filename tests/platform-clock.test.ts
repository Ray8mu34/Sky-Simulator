import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationClock } from '../src/platform/clock';

test('one anchored clock progresses forward and backward without integrating frames', () => {
  const clock = new SimulationClock();
  clock.rebase(100, 600, true, 1000);
  assert.equal(clock.sample(2000), 100 + 600 / 86400);
  clock.rebase(100, -86400, true, 1000);
  assert.equal(clock.sample(2000), 99);
});
test('pause and visibility resume preserve the exact last instant', () => {
  const clock = new SimulationClock();
  clock.rebase(100, 60, true, 0);
  const paused = clock.sample(5000);
  clock.rebase(paused, 60, false, 5000);
  assert.equal(clock.sample(605000), paused);
  clock.rebase(paused, 60, true, 605000);
  assert.equal(clock.sample(606000), paused + 60 / 86400);
});
test('clock rejects non-finite parameters', () => {
  const clock = new SimulationClock();
  assert.throws(() => clock.rebase(NaN, 1, true, 0), RangeError);
});
