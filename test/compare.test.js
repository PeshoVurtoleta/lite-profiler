import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Profiler } from '../index.js';
import {
    summarize, summarizeCapture, diffCaptures, checkRegression, assertNoRegression
} from '../index.js';
import { encodeCapture, decodeCapture } from '../index.js';

// Deterministic fixtures: push exactly-f32-representable durations straight into
// the rings so every stat is exact and round-trips through float32 losslessly.
function makeProfiler(frames, phaseMap) {
    const tags = Object.keys(phaseMap);
    const p = new Profiler(Math.max(8, frames.length), tags);
    for (let i = 0; i < frames.length; i++) p.frame.push(frames[i]);
    for (const t of tags) {
        const ring = p.phase(t);
        const arr = phaseMap[t];
        for (let i = 0; i < arr.length; i++) ring.push(arr[i]);
    }
    return p;
}

test('summarize: frame + phase stats and metadata', () => {
    const p = makeProfiler([8, 8, 8, 40], { update: [4, 4, 4, 20], render: [2, 2, 2, 8] });
    const s = summarize(p, { label: 'unit', engine: 'test-engine', budgetMs: 16 });

    assert.equal(s.frameCount, 4);
    assert.equal(s.label, 'unit');
    assert.equal(s.engine, 'test-engine');
    assert.equal(s.budgetMs, 16);

    assert.equal(s.frame.min, 8);
    assert.equal(s.frame.max, 40);
    assert.equal(s.frame.avg, 16);            // (8+8+8+40)/4
    assert.equal(s.frame.fps, 1000 / 16);     // 62.5
    assert.equal(s.frame.jankRatio, 0.25);    // one frame >= 16ms of four
    assert.equal(s.frame.spikeRatio, 0.25);   // one frame >= 33ms of four
    assert.equal(s.frame.frameClass, 'throttled'); // jank >= 0.25
    assert.ok(s.frame.p99 >= s.frame.avg && s.frame.p99 <= s.frame.max);

    assert.equal(s.phases.update.max, 20);
    assert.equal(s.phases.update.last, 20);
    assert.equal(s.phases.render.avg, 3.5);   // (2+2+2+8)/4
});

test('summarize: empty profiler yields a zeroed steady summary', () => {
    const p = new Profiler(16, ['a']);
    const s = summarize(p);
    assert.equal(s.frameCount, 0);
    assert.equal(s.frame.fps, 0);
    assert.equal(s.frame.frameClass, 'steady');
    assert.equal(s.phases.a.count, 0);
});

test('diffCaptures: per-metric deltas and direction', () => {
    const base = summarize(makeProfiler([8, 8, 8, 8], { work: [4, 4, 4, 4] }), { label: 'base' });
    const cand = summarize(makeProfiler([8, 8, 8, 32], { work: [4, 4, 4, 16] }), { label: 'cand' });
    const d = diffCaptures(base, cand);

    assert.equal(d.baseline.label, 'base');
    assert.equal(d.candidate.label, 'cand');
    assert.ok(d.frame.avg.delta > 0, 'avg rose');
    assert.ok(d.frame.max.delta > 0, 'max rose (8 -> 32)');
    assert.ok(d.frame.fps.delta < 0, 'fps dropped');
    assert.ok(d.phases.work.max.delta > 0, 'phase max rose');
    assert.equal(d.frame.avg.base, 8);
});

test('checkRegression: catches worsening, passes identical', () => {
    const base = summarize(makeProfiler([8, 8, 8, 8], { work: [4, 4, 4, 4] }));
    const cand = summarize(makeProfiler([8, 8, 8, 32], { work: [4, 4, 4, 16] }));

    const bad = checkRegression(base, cand);          // default gates frame.avg/p99 at +10%
    assert.equal(bad.ok, false);
    assert.ok(bad.regressions.some((r) => r.metric === 'frame.avg'));

    const clean = checkRegression(base, base);
    assert.equal(clean.ok, true);
    assert.equal(clean.regressions.length, 0);

    // fps is higher-is-better: a slower candidate must trip an fps gate too
    const fps = checkRegression(base, cand, { 'frame.fps': 0.10 });
    assert.equal(fps.ok, false);
    assert.ok(fps.regressions.some((r) => r.metric === 'frame.fps'));

    // per-phase gate
    const phase = checkRegression(base, cand, { 'phase.work.max': 0.10 });
    assert.equal(phase.ok, false);
    assert.ok(phase.regressions.some((r) => r.metric === 'phase.work.max'));
});

test('assertNoRegression: throws on regression, returns on clean', () => {
    const base = summarize(makeProfiler([8, 8, 8, 8], { work: [4, 4, 4, 4] }));
    const cand = summarize(makeProfiler([8, 8, 8, 32], { work: [4, 4, 4, 16] }));

    assert.throws(() => assertNoRegression(base, cand), /regression/i);
    try {
        assertNoRegression(base, cand);
    } catch (e) {
        assert.equal(e.name, 'RegressionError');
        assert.ok(e.report && e.report.ok === false);
    }
    const ok = assertNoRegression(base, base);
    assert.equal(ok.ok, true);
});

test('litecap v2: round-trips tags + meta, and summarizeCapture matches summarize', () => {
    const p = makeProfiler([8, 8, 8, 16], { update: [4, 4, 4, 8], render: [2, 2, 2, 4] });
    const buf = encodeCapture(p, null, { engine: 'lite-signal@1.4.0-beta.1', label: 'roundtrip' });
    const dec = decodeCapture(buf);

    assert.equal(dec.version, 2);
    assert.deepEqual(dec.tags, ['update', 'render']);
    assert.equal(dec.meta.engine, 'lite-signal@1.4.0-beta.1');
    assert.equal(dec.meta.label, 'roundtrip');
    assert.equal(dec.count, 4);
    assert.equal(dec.frames[3], 16);

    const fromProfiler = summarize(p);
    const fromCapture = summarizeCapture(dec);
    assert.equal(fromCapture.frame.avg, fromProfiler.frame.avg);
    assert.equal(fromCapture.frame.max, fromProfiler.frame.max);
    assert.deepEqual(Object.keys(fromCapture.phases), ['update', 'render']);
    assert.equal(fromCapture.phases.update.max, fromProfiler.phases.update.max);
    // capture carried its own engine/label through summarizeCapture's meta merge
    assert.equal(fromCapture.engine, 'lite-signal@1.4.0-beta.1');
});

test('litecap: v1 buffers still decode (tags empty, meta null)', () => {
    const count = 3;
    const buf = new ArrayBuffer(10 + count * 4);
    const v = new DataView(buf);
    v.setUint8(0, 0x4C); v.setUint8(1, 0x43); v.setUint8(2, 0x41); v.setUint8(3, 0x50); // 'LCAP'
    v.setUint8(4, 1);                 // version 1
    v.setUint32(5, count, true);      // count
    v.setUint8(9, 0);                 // numPhases = 0
    const vals = [8, 16, 40];
    let off = 10;
    for (let i = 0; i < vals.length; i++) { v.setFloat32(off, vals[i], true); off += 4; }

    const dec = decodeCapture(buf);
    assert.equal(dec.version, 1);
    assert.deepEqual(dec.tags, []);
    assert.equal(dec.meta, null);
    assert.equal(dec.count, 3);
    assert.equal(dec.frames[2], 40);
});
