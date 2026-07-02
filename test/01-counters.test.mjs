import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, summarize } from '../index.js';

test('counters accumulate within a frame and flush one value per endFrame', () => {
    const p = new Profiler(64, [], ['drawCalls']);
    p.beginFrame(); p.count('drawCalls'); p.count('drawCalls', 2); p.endFrame();   // frame total 3
    p.beginFrame(); p.count('drawCalls'); p.endFrame();                            // frame total 1
    const r = p.counter('drawCalls');
    assert.equal(r.count, 2);
    assert.equal(r.peekNewest(), 1);
    const s = summarize(p);
    assert.equal(s.counters.drawCalls.sum, 4);
    assert.equal(s.counters.drawCalls.max, 3);
    assert.equal(s.counters.drawCalls.last, 1);
    p.destroy();
});

test('count(tag) and countAt(handle) are equivalent', () => {
    const a = new Profiler(64, [], ['x']);
    const b = new Profiler(64, [], ['x']);
    const h = b.counterHandle('x');
    for (let f = 0; f < 6; f++) {
        a.beginFrame(); a.count('x', f); a.endFrame();
        b.beginFrame(); b.countAt(h, f); b.endFrame();
    }
    const sa = summarize(a).counters.x, sb = summarize(b).counters.x;
    assert.deepEqual([sa.sum, sa.max, sa.last], [sb.sum, sb.max, sb.last]);
    a.destroy(); b.destroy();
});

test('unknown tag / bad handle is a no-op, never throws, never corrupts', () => {
    const p = new Profiler(64, [], ['a', 'b']);
    p.beginFrame();
    p.count('nope', 999);         // unknown tag
    p.countAt(-1, 999);           // bad handle
    p.countAt(42, 999);           // out-of-range handle
    p.count('a', 5);
    p.endFrame();
    const s = summarize(p);
    assert.equal(s.counters.a.sum, 5);
    assert.equal(s.counters.b.sum, 0);
    p.destroy();
});

test('custom counter order is safe: by-tag routing is index-independent', () => {
    // drawCalls is NOT first
    const p = new Profiler(64, [], ['floatsUploaded', 'drawCalls', 'instances']);
    for (let f = 0; f < 3; f++) {
        p.beginFrame(); p.count('drawCalls'); p.count('floatsUploaded', 4096); p.count('instances', 512); p.endFrame();
    }
    const s = summarize(p);
    assert.equal(s.counters.drawCalls.sum, 3);
    assert.equal(s.counters.floatsUploaded.sum, 12288);
    assert.equal(s.counters.instances.sum, 1536);
    p.destroy();
});

test('sum is EXACT past 2^24 via Float64 accumulation (per-frame value stays < 2^24)', () => {
    const perFrame = 8_000_000;   // < 2^24 (16,777,216) -> Float32-exact
    const frames = 10;            // total 80,000,000 > 2^24
    const p = new Profiler(64, [], ['floatsUploaded']);
    for (let f = 0; f < frames; f++) { p.beginFrame(); p.count('floatsUploaded', perFrame); p.endFrame(); }
    const s = summarize(p);
    assert.equal(s.counters.floatsUploaded.sum, perFrame * frames);   // 80,000,000 exact
    assert.equal(s.counters.floatsUploaded.max, perFrame);
    p.destroy();
});

test('a per-frame value above 2^24 quantizes, but deterministically (same input -> same value)', () => {
    const big = 16_777_217;   // 2^24 + 1: the first integer Float32 cannot hold (rounds to 2^24)
    const mk = () => { const p = new Profiler(64, [], ['c']); p.beginFrame(); p.count('c', big); p.endFrame(); return summarize(p).counters.c.max; };
    const v1 = mk(), v2 = mk();
    assert.equal(v1, v2, 'quantization is deterministic');
    assert.notEqual(v1, big, 'value did quantize (documents the bound)');
});

test('a profiler with no counters yields an empty counters block and stays backward-compatible', () => {
    const p = new Profiler(64, ['render']);
    for (let f = 0; f < 4; f++) { p.beginFrame(); p.begin('render'); p.end('render'); p.endFrame(); }
    const s = summarize(p);
    assert.equal(Object.keys(s.counters).length, 0);
    assert.equal(s.counterCount, undefined);          // not a summary field
    assert.equal(p.counterCount, 0);
    assert.ok(s.phases.render, 'phases still present');
    p.destroy();
});

test('reset clears counter rings + accumulators; destroy releases them', () => {
    const p = new Profiler(64, [], ['c']);
    p.beginFrame(); p.count('c', 7); p.endFrame();
    assert.equal(p.counter('c').count, 1);
    p.reset();
    assert.equal(p.counter('c').count, 0);
    p.beginFrame(); p.count('c', 3); p.endFrame();
    assert.equal(summarize(p).counters.c.sum, 3, 'usable after reset');
    p.destroy();
    assert.equal(p.counterBuffers, null);
});
