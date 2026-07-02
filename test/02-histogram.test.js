import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameHistogram, FrameClass } from '../index.js';

function bufFrom(values) {
  return { count: values.length, get(o) { return values[values.length - 1 - o]; } };
}
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ~= ${b}`);

describe('FrameHistogram', () => {
  it('places samples in the correct buckets at boundaries', () => {
    const h = new FrameHistogram();
    h.update(bufFrom([1.9, 2, 3.9, 4, 7.9, 8, 15.9, 16, 32.9, 33, 65.9, 66, 200]));
    assert.deepEqual(Array.from(h.bins), [1, 2, 2, 2, 2, 2, 2]);
    assert.equal(h.total, 13);
  });

  it('reports zero ratios and STEADY on empty input', () => {
    const h = new FrameHistogram();
    h.update(bufFrom([]));
    assert.equal(h.jankRatio, 0);
    assert.equal(h.spikeRatio, 0);
    assert.equal(h.classify(), FrameClass.STEADY);
  });

  it('classifies a smooth window as STEADY', () => {
    const h = new FrameHistogram();
    h.update(bufFrom(new Array(100).fill(15)));
    assert.equal(h.classify(), FrameClass.STEADY);
    assert.equal(h.modeIndex, 3);
  });

  it('classifies sparse hitches as SPIKING', () => {
    const h = new FrameHistogram();
    const v = new Array(100).fill(15);
    for (let i = 0; i < 10; i++) v[i] = 80;
    h.update(bufFrom(v));
    near(h.jankRatio, 0.10);
    assert.equal(h.classify(), FrameClass.SPIKING);
  });

  it('classifies sustained elevation as THROTTLED', () => {
    const h = new FrameHistogram();
    h.update(bufFrom(new Array(100).fill(22)));
    near(h.jankRatio, 1);
    assert.equal(h.classify(), FrameClass.THROTTLED);
  });

  it('reuses the same bins array across updates', () => {
    const h = new FrameHistogram();
    const ref = h.bins;
    h.update(bufFrom([1, 2, 3]));
    h.update(bufFrom([40, 50, 60]));
    assert.equal(h.bins, ref);
  });
});
