import test from 'node:test';
import assert from 'node:assert/strict';
import { earthFragment } from '../src/render/shaders';

// Read the actual shader's transition rather than maintaining another lighting policy.
const transition = earthFragment.match(/float night=1\.0-smoothstep\(([^,]+),([^,]+),mu\);/);
assert.ok(transition, 'Earth shader exposes its normal·Sun night-light transition');
const low = Number(transition[1]), high = Number(transition[2]);
assert.ok(Number.isFinite(low) && Number.isFinite(high) && high > low);
const nightWeight = (mu: number) => {
  const t = Math.min(1, Math.max(0, (mu - low) / (high - low)));
  return 1 - t * t * (3 - 2 * t);
};

test('Earth city-light contribution is strictly zero on the terminator and every sunlit normal', () => {
  assert.equal(low, -.16, 'retain the approved negative-side fade');
  assert.equal(high, 0, 'fade ends exactly at the geometric terminator');
  for (const mu of [-0, 0, Number.MIN_VALUE, 1e-7, .001, .01, .045, .5, 1]) {
    assert.equal(nightWeight(mu), 0, `sunlit mu=${mu} must have no night texture contribution`);
  }
  assert.match(earthFragment, /color\+=texture2D\(uNight,vUv\)\.rgb\*uHasNight\*uNightEnabled\*night\*\.7;/,
    'the tested weight actually controls the unchanged night sampler and gain');
});

test('Earth city lights retain a monotone twilight fade and full dark-side contribution', () => {
  assert.equal(nightWeight(-1), 1);
  assert.equal(nightWeight(-.16), 1);
  assert.equal(nightWeight(-.08), .5);
  let previous = 1;
  for (let i = 0; i <= 160; i++) {
    const weight = nightWeight(-.16 + i * .001);
    assert.ok(weight >= 0 && weight <= 1 && weight <= previous, `bounded monotone fade at sample ${i}`);
    previous = weight;
  }
  assert.equal(previous, 0);
});

test('Earth twilight transition is continuous with flat negative and zero endpoints', () => {
  const epsilon = 1e-4;
  for (const mu of [-.16, 0]) {
    assert.ok(Math.abs(nightWeight(mu - epsilon) - nightWeight(mu)) < 2e-6);
    assert.ok(Math.abs(nightWeight(mu + epsilon) - nightWeight(mu)) < 2e-6);
  }
});
