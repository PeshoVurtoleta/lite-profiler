import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, encodeCapture, decodeCapture, LITECAP } from '../index.js';

let clock = 0, realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

function fill(p, frames) {
  for (let f = 0; f < frames; f++) {
    p.beginFrame();
    for (let i = 0; i < p.phaseCount; i++) { p.beginAt(i); clock += (i + 1); p.endAt(i); }
    clock += 1; p.endFrame(); clock += 1;
  }
}

describe('LiteCap', () => {
  it('returns null when nothing was captured', () => {
    const p = new Profiler(16, ['a']);
    assert.equal(encodeCapture(p), null);
    p.destroy();
  });

  it('round-trips frames and phases exactly', () => {
    const p = new Profiler(64, ['physics', 'render']);
    fill(p, 20);
    const buf = encodeCapture(p);
    assert.ok(buf instanceof ArrayBuffer);
    const data = decodeCapture(buf);
    assert.equal(data.version, LITECAP.VERSION);
    assert.equal(data.count, 20);
    assert.equal(data.numPhases, 2);
    const expFrames = new Float32Array(20); p.frame.copyTo(expFrames, 0);
    assert.deepEqual(Array.from(data.frames), Array.from(expFrames));
    for (let ph = 0; ph < 2; ph++) {
      const exp = new Float32Array(20); p.phaseAt(ph).copyTo(exp, 0);
      assert.deepEqual(Array.from(data.phases[ph]), Array.from(exp));
    }
    p.destroy();
  });

  it('accepts a Uint8Array view as decode input', () => {
    const p = new Profiler(32); fill(p, 5);
    const data = decodeCapture(new Uint8Array(encodeCapture(p)));
    assert.equal(data.count, 5);
    p.destroy();
  });

  it('throws on phase desync', () => {
    const p = new Profiler(64, ['a', 'b']);
    p.beginFrame(); p.beginAt(0); clock += 1; p.endAt(0); clock += 1; p.endFrame();
    assert.throws(() => encodeCapture(p), /desync/);
    p.destroy();
  });

  it('rejects a buffer with bad magic', () => {
    assert.throws(() => decodeCapture(new ArrayBuffer(LITECAP.HEADER_SIZE + 4)), /magic/);
  });

  it('rejects a truncated buffer', () => {
    const p = new Profiler(32); fill(p, 8);
    const buf = encodeCapture(p);
    assert.throws(() => decodeCapture(buf.slice(0, buf.byteLength - 4)), /truncated/);
    p.destroy();
  });

  it('rejects non-buffer input', () => {
    assert.throws(() => decodeCapture({}), TypeError);
  });
});
