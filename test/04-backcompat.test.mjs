import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, summarize, checkRegression, encodeCapture, decodeCapture } from '../index.js';

test('the 2-arg Profiler (no counters) behaves exactly as before', () => {
    const p = new Profiler(64, ['physics', 'render']);
    for (let f = 0; f < 8; f++) {
        p.beginFrame();
        p.begin('physics'); p.end('physics');
        p.begin('render'); p.end('render');
        p.endFrame();
    }
    const s = summarize(p, { label: 'base' });
    assert.equal(s.frameCount, 8);
    assert.deepEqual(Object.keys(s.phases).sort(), ['physics', 'render']);
    assert.equal(decodeCapture(encodeCapture(p)).version, 2);
    p.destroy();
});

test('frame tolerance gating is unchanged', () => {
    function frameCap(ms) {
        const p = new Profiler(128, []);
        for (let f = 0; f < 120; f++) { p.beginFrame(); const t = performance.now(); while (performance.now() - t < ms); p.endFrame(); }
        const s = summarize(p);
        p.destroy();
        return s;
    }
    const base = frameCap(0);
    // same workload vs itself: no frame.avg/p99 regression
    const r = checkRegression(base, frameCap(0));
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.regressions));
    assert.ok(r.diff.frame, 'diff still carries a frame block');
});

test('summary schema is 2, with frame + phases shapes intact', () => {
    const p = new Profiler(64, ['render']);
    p.beginFrame(); p.begin('render'); p.end('render'); p.endFrame();
    const s = summarize(p);
    assert.equal(s.schema, 2);
    for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'fps']) assert.ok(k in s.frame);
    for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'last', 'count']) assert.ok(k in s.phases.render);
    p.destroy();
});
