import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, summarizeCapture, encodeCapture, decodeCapture, LITECAP } from '../index.js';

function withCounters(perFrame = 4096, frames = 12) {
    const p = new Profiler(64, ['render'], ['drawCalls', 'floatsUploaded']);
    for (let f = 0; f < frames; f++) {
        p.beginFrame(); p.count('drawCalls'); p.count('floatsUploaded', perFrame);
        p.begin('render'); p.end('render'); p.endFrame();
    }
    return p;
}

test('LITECAP advertises v3 and MAX_COUNTERS', () => {
    assert.equal(LITECAP.VERSION, 3);
    assert.equal(LITECAP.MAX_COUNTERS, 64);
});

test('v3 round-trip: counter arrays, tags, and exact sum survive encode/decode', () => {
    const p = withCounters(4096, 12);
    const d = decodeCapture(encodeCapture(p));
    assert.equal(d.version, 3);
    assert.deepEqual(d.counterTags, ['drawCalls', 'floatsUploaded']);
    assert.equal(d.counters.length, 2);
    assert.equal(d.counters[1].length, 12);
    const s = summarizeCapture(d);
    assert.equal(s.counters.floatsUploaded.sum, 4096 * 12);   // exact
    assert.equal(s.counters.drawCalls.sum, 12);
    p.destroy();
});

test('no counters -> emit stays v2 (older readers decode); decode yields empty counters', () => {
    const p = new Profiler(64, ['render']);
    for (let f = 0; f < 5; f++) { p.beginFrame(); p.begin('render'); p.end('render'); p.endFrame(); }
    const d = decodeCapture(encodeCapture(p));
    assert.equal(d.version, 2);
    assert.deepEqual(d.counters, []);
    assert.deepEqual(d.counterTags, []);
    p.destroy();
});

test('a decoded v2 capture summarizes with an empty counters block', () => {
    const p = new Profiler(64, ['render']);
    for (let f = 0; f < 5; f++) { p.beginFrame(); p.begin('render'); p.end('render'); p.endFrame(); }
    const s = summarizeCapture(decodeCapture(encodeCapture(p)));
    assert.equal(Object.keys(s.counters).length, 0);
    p.destroy();
});

test('truncated counter section is rejected (no over-read)', () => {
    const p = withCounters(4096, 8);
    const buf = encodeCapture(p);
    const chopped = buf.slice(0, buf.byteLength - 1);   // drop the last tag byte
    assert.throws(() => decodeCapture(chopped), /truncated/);
    p.destroy();
});

test('meta round-trips alongside counters (v3 trailer after meta)', () => {
    const p = withCounters(2048, 6);
    const d = decodeCapture(encodeCapture(p, null, { engine: 'lite-gl@1.0.0', label: 'nudge' }));
    assert.equal(d.version, 3);
    assert.equal(d.meta.engine, 'lite-gl@1.0.0');
    assert.equal(d.counterTags.length, 2);
    p.destroy();
});
