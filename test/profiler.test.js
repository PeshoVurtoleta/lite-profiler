import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Profiler } from '../index.js';

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ~= ${b}`);

describe('Profiler', () => {
  it('rounds capacity to a power of two and exposes it', () => {
    const p = new Profiler(600, ['a', 'b']);
    assert.equal(p.capacity, 1024);
    assert.equal(p.phaseCount, 2);
    p.destroy();
  });

  it('rejects invalid capacity', () => {
    assert.throws(() => new Profiler(0), RangeError);
    assert.throws(() => new Profiler(NaN), RangeError);
  });

  it('captures frame time deterministically', () => {
    const p = new Profiler(64);
    clock = 1000; p.beginFrame(); clock = 1016; p.endFrame();
    assert.equal(p.frame.count, 1);
    near(p.frame.peekNewest(), 16);
    p.destroy();
  });

  it('times phases by tag and by handle', () => {
    const p = new Profiler(64, ['physics', 'render']);
    clock = 100; p.begin('physics'); clock = 105; p.end('physics');
    const h = p.handle('render');
    assert.equal(h, 1);
    clock = 200; p.beginAt(h); clock = 212; p.endAt(h);
    near(p.phase('physics').peekNewest(), 5);
    near(p.phaseAt(h).peekNewest(), 12);
    assert.equal(p.tagOf(0), 'physics');
    p.destroy();
  });

  it('ignores unknown tags and out-of-range handles', () => {
    const p = new Profiler(64, ['a']);
    assert.doesNotThrow(() => { p.begin('nope'); p.end('nope'); p.beginAt(9); p.endAt(9); });
    assert.equal(p.handle('nope'), -1);
    assert.equal(p.phase('nope'), null);
    assert.equal(p.phaseAt(9), null);
    p.destroy();
  });

  it('overflows the window without growing past capacity', () => {
    const p = new Profiler(4);
    for (let i = 0; i < 100; i++) { p.beginFrame(); clock += 1; p.endFrame(); clock += 1; }
    assert.equal(p.frame.count, 4);
    assert.equal(p.capacity, 4);
    p.destroy();
  });

  it('reset clears all buffers', () => {
    const p = new Profiler(16, ['a']);
    p.beginFrame(); clock = 10; p.endFrame();
    clock = 20; p.begin('a'); clock = 25; p.end('a');
    p.reset();
    assert.equal(p.frame.count, 0);
    assert.equal(p.phase('a').count, 0);
    p.destroy();
  });

  it('keeps sub-ms phase precision at large timestamps (Float64 starts)', () => {
    const p = new Profiler(16, ['x']);
    const big = 9_000_000;      // ~2.5h uptime; a Float32 ULP here is ~1ms
    clock = big + 0.25; p.begin('x');
    clock = big + 0.75; p.end('x');
    near(p.phase('x').peekNewest(), 0.5, 1e-3);
    p.destroy();
  });
});
