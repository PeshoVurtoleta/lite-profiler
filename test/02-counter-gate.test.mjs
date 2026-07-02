import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, summarize, checkRegression, assertNoRegression } from '../index.js';

function capUploads(perFrame, frames = 12, tags = ['drawCalls', 'floatsUploaded']) {
    const p = new Profiler(64, ['render'], tags);
    for (let f = 0; f < frames; f++) {
        p.beginFrame();
        if (p.counterHandle('drawCalls') >= 0) p.count('drawCalls');
        p.count('floatsUploaded', perFrame);
        p.begin('render'); p.end('render');
        p.endFrame();
    }
    const s = summarize(p, { label: 'u' + perFrame });
    p.destroy();
    return s;
}

test('exact counter gate (tolerance 0): an increase is a regression', () => {
    const base = capUploads(4096), cand = capUploads(8192);
    const r = checkRegression(base, cand, { 'counter.floatsUploaded.max': 0 });
    assert.equal(r.ok, false);
    assert.equal(r.regressions[0].metric, 'counter.floatsUploaded.max');
});

test('exact counter gate: equal passes, a decrease passes (improvement)', () => {
    const base = capUploads(4096);
    assert.equal(checkRegression(base, capUploads(4096), { 'counter.floatsUploaded.max': 0 }).ok, true);
    assert.equal(checkRegression(base, capUploads(2048), { 'counter.floatsUploaded.max': 0 }).ok, true);
});

test('a vanished counter is a regression, not a silent pass (integrity)', () => {
    const base = capUploads(4096), cand = capUploads(4096);
    delete cand.counters.floatsUploaded;                       // a refactor stopped tracking it
    const r = checkRegression(base, cand, { 'counter.floatsUploaded.max': 0 });
    assert.equal(r.ok, false);
    assert.match(r.regressions[0].reason, /missing/);
    assert.equal(r.regressions[0].candidate, null);
});

test('vanished counter: baseline also lacks it -> no basis -> skip (not a false regression)', () => {
    const base = capUploads(4096), cand = capUploads(4096);
    delete base.counters.floatsUploaded;
    delete cand.counters.floatsUploaded;
    const r = checkRegression(base, cand, { 'counter.floatsUploaded.max': 0, 'counter.drawCalls.max': 0 });
    assert.equal(r.ok, true);
});

test('backward-compat: a VANISHED phase still SKIPS (frame/phase behavior unchanged)', () => {
    const base = capUploads(4096), cand = capUploads(4096);
    delete cand.phases.render;                                 // phase gone
    const r = checkRegression(base, cand, { 'phase.render.avg': 0.1 });
    assert.equal(r.ok, true, 'phase gating stays lenient; only counters are strict');
    assert.equal(r.regressions.length, 0);
});

test('deterministic quantization above 2^24 still gates equal', () => {
    const base = capUploads(16_777_217), cand = capUploads(16_777_217);   // 2^24+1: quantizes to 2^24 on both sides
    assert.equal(checkRegression(base, cand, { 'counter.floatsUploaded.max': 0 }).ok, true);
});

test('assertNoRegression names the vanished metric in its message', () => {
    const base = capUploads(4096), cand = capUploads(4096);
    delete cand.counters.floatsUploaded;
    assert.throws(
        () => assertNoRegression(base, cand, { 'counter.floatsUploaded.max': 0 }),
        (e) => e.name === 'RegressionError' && /missing/.test(e.message) && /floatsUploaded/.test(e.message)
    );
});

test('the sum gate also works (total bus traffic guard)', () => {
    const base = capUploads(4096), cand = capUploads(4096 * 100);
    const r = checkRegression(base, cand, { 'counter.floatsUploaded.sum': 0 });
    assert.equal(r.ok, false);
    assert.equal(r.regressions[0].metric, 'counter.floatsUploaded.sum');
});
