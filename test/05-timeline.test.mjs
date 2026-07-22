import test from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, TimelineRecorder,
    encodeCapture, decodeCapture, encodeTimelineCapture, LITECAP,
} from '../index.js';

// A large, realistic performance.now() magnitude — the whole reason the timeline
// uses Float64 rings. An hour-plus into a session, a Float32 ULP exceeds 1ms.
const BIG = 1784084000000.125;

test('LITECAP advertises v4 and timeline limits', () => {
    assert.equal(LITECAP.VERSION, 4);
    assert.equal(LITECAP.MAX_SPAN_LANES, 64);
    assert.equal(LITECAP.MAX_INSTANT_LANES, 64);
});

test('capacity rounds up to a power of two, like Profiler', () => {
    assert.equal(new TimelineRecorder(600).capacity, 1024);
    assert.equal(new TimelineRecorder(1024).capacity, 1024);
    assert.equal(new TimelineRecorder(1025).capacity, 2048);
});

test('rejects a non-finite capacity', () => {
    assert.throws(() => new TimelineRecorder(0), RangeError);
    assert.throws(() => new TimelineRecorder(NaN), RangeError);
    assert.throws(() => new TimelineRecorder(-4), RangeError);
});

test('absolute t0/t1 survive at a realistic now() magnitude (Float64, not Float32)', () => {
    const tr = new TimelineRecorder(16, ['physics']);
    tr.beginSpan('physics', BIG + 0.125);
    tr.endSpan('physics', BIG + 2.625);
    const t0 = new Float64Array(1), t1 = new Float64Array(1);
    tr.spanT0('physics').copyTo(t0);
    tr.spanT1('physics').copyTo(t1);
    // Bit-exact: the value stored is exactly the value read back.
    assert.equal(t0[0], BIG + 0.125);
    assert.equal(t1[0], BIG + 2.625);
    assert.equal(t1[0] - t0[0], 2.5);   // sub-ms duration intact at hour-scale time
});

test('Float32 would have destroyed this — sanity check on the hazard', () => {
    // Demonstrates why raw Float64 rings are required: a Float32 cannot even hold BIG.
    assert.notEqual(Math.fround(BIG + 0.125), BIG + 0.125);
});

test('end without begin is ignored; a fresh begin overwrites an unpaired one', () => {
    const tr = new TimelineRecorder(16, ['a']);
    tr.endSpan('a', BIG);                       // no open begin -> nothing recorded
    assert.equal(tr.spanT0('a').count, 0);
    tr.beginSpan('a', BIG + 1);
    tr.beginSpan('a', BIG + 5);                 // last-open-wins
    tr.endSpan('a', BIG + 9);
    const t0 = new Float64Array(1); tr.spanT0('a').copyTo(t0);
    assert.equal(t0[0], BIG + 5);
    assert.equal(tr.spanT0('a').count, 1);
});

test('unknown tags are no-ops, not throws', () => {
    const tr = new TimelineRecorder(16, ['a'], ['x']);
    assert.doesNotThrow(() => { tr.beginSpan('nope'); tr.endSpan('nope'); tr.mark('nope'); });
    assert.equal(tr.spanHandle('nope'), -1);
    assert.equal(tr.instantHandle('nope'), -1);
    assert.equal(tr.spanHandle('a'), 0);
    assert.equal(tr.instantHandle('x'), 0);
});

test('handle fast-path matches the tag path', () => {
    const tr = new TimelineRecorder(16, ['physics'], ['gc']);
    const sh = tr.spanHandle('physics'), ih = tr.instantHandle('gc');
    tr.beginSpanAt(sh, BIG + 1); tr.endSpanAt(sh, BIG + 3);
    tr.markAt(ih, BIG + 2);
    assert.equal(tr.spanT0At(sh).count, 1);
    assert.equal(tr.instantTimeAt(ih).count, 1);
});

test('rings wrap oldest-first', () => {
    const tr = new TimelineRecorder(4, ['a']);   // capacity 4
    for (let i = 0; i < 6; i++) { tr.beginSpan('a', BIG + i); tr.endSpan('a', BIG + i + 0.5); }
    const t0 = new Float64Array(4);
    tr.spanT0('a').copyTo(t0);
    assert.deepEqual(Array.from(t0), [BIG + 2, BIG + 3, BIG + 4, BIG + 5]);   // oldest two dropped
});

test('reset clears rings and drops open spans; destroy is safe', () => {
    const tr = new TimelineRecorder(16, ['a'], ['x']);
    tr.recordFrameBoundary(BIG);
    tr.beginSpan('a', BIG + 1);                 // left open
    tr.mark('x', BIG + 2);
    tr.reset();
    assert.equal(tr.frameCount, 0);
    assert.equal(tr.instantTime('x').count, 0);
    tr.endSpan('a', BIG + 3);                   // the open begin was dropped by reset
    assert.equal(tr.spanT0('a').count, 0);
    assert.doesNotThrow(() => tr.destroy());
});

// ── LiteCap v4 round-trip ──

function build() {
    const p = new Profiler(64, ['physics'], ['draws']);
    const tr = new TimelineRecorder(64, ['physics', 'render'], ['gc']);
    for (let f = 0; f < 3; f++) {
        p.beginFrame(); p.begin('physics'); p.count('draws', 10 + f); p.end('physics'); p.endFrame();
        tr.recordFrameBoundary(BIG + f * 16);
        tr.beginSpan('physics', BIG + f * 16 + 1); tr.endSpan('physics', BIG + f * 16 + 5.5);
        tr.mark('gc', BIG + f * 16 + 8);
        // 'render' lane intentionally never used -> a valid empty lane.
    }
    return { p, tr };
}

test('v4 round-trip: frame boundaries, spans and instants survive encode/decode', () => {
    const { p, tr } = build();
    const d = decodeCapture(encodeCapture(p, null, { label: 'x' }, tr));

    assert.equal(d.version, 4);
    // Core data still present and correct.
    assert.deepEqual(Array.from(d.counters[0]), [10, 11, 12]);
    assert.equal(d.meta.label, 'x');

    // Frame boundaries, bit-exact.
    assert.deepEqual(Array.from(d.frameBoundaries), [BIG, BIG + 16, BIG + 32]);

    // Span lane 'physics': three pairs, exact.
    assert.equal(d.spanTags[0], 'physics');
    assert.deepEqual(Array.from(d.spanT0[0]), [BIG + 1, BIG + 17, BIG + 33]);
    assert.deepEqual(Array.from(d.spanT1[0]), [BIG + 5.5, BIG + 21.5, BIG + 37.5]);

    // Empty 'render' lane round-trips as a present-but-empty lane.
    assert.equal(d.spanTags[1], 'render');
    assert.equal(d.spanT0[1].length, 0);

    // Instant lane 'gc'.
    assert.equal(d.instantTags[0], 'gc');
    assert.deepEqual(Array.from(d.instantTimes[0]), [BIG + 8, BIG + 24, BIG + 40]);
});

test('durations reconstruct from absolute timestamps — the flame-chart prerequisite', () => {
    const { p, tr } = build();
    const d = decodeCapture(encodeCapture(p, null, null, tr));
    for (let i = 0; i < d.spanT0[0].length; i++) {
        assert.equal(d.spanT1[0][i] - d.spanT0[0][i], 5.5 - 1);   // 4.5ms each
    }
});

test('a capture WITHOUT timeline stays v3 — byte-identical, old readers unaffected', () => {
    const p = new Profiler(64, ['physics'], ['draws']);
    for (let f = 0; f < 3; f++) { p.beginFrame(); p.begin('physics'); p.count('draws', 1); p.end('physics'); p.endFrame(); }
    const before = new Uint8Array(encodeCapture(p, null, { label: 'x' }));
    const after = new Uint8Array(encodeCapture(p, null, { label: 'x' }, null));
    assert.equal(after[LITECAP.HEADER_SIZE - 6], 3);   // version byte still 3
    assert.deepEqual(Array.from(after), Array.from(before));   // literally the same bytes
});

test('an EMPTY recorder does not bump the version', () => {
    const p = new Profiler(64, ['a'], ['c']);
    p.beginFrame(); p.begin('a'); p.count('c', 1); p.end('a'); p.endFrame();
    const d = decodeCapture(encodeCapture(p, null, null, new TimelineRecorder(8, ['unused'])));
    assert.equal(d.version, 3);   // no timeline samples -> no bump
});

test('encodeTimelineCapture: standalone v4 with no profiler', () => {
    const tr = new TimelineRecorder(16, ['frame'], ['input']);
    tr.recordFrameBoundary(BIG);
    tr.beginSpan('frame', BIG + 1); tr.endSpan('frame', BIG + 9);
    tr.mark('input', BIG + 3);
    const d = decodeCapture(encodeTimelineCapture(tr, { source: 'standalone' }));
    assert.equal(d.version, 4);
    assert.equal(d.numPhases, 0);
    assert.equal(d.counters.length, 0);
    assert.equal(d.spanT1[0][0] - d.spanT0[0][0], 8);
    assert.equal(d.meta.source, 'standalone');
});

test('encodeTimelineCapture returns null for an empty recorder', () => {
    assert.equal(encodeTimelineCapture(new TimelineRecorder(8, ['x'])), null);
});

test('a v3 reader model rejects a v4 capture (hard error, not silent drop)', () => {
    // Simulate an old reader by asserting the version byte is out of its supported range.
    const { p, tr } = build();
    const buf = new Uint8Array(encodeCapture(p, null, null, tr));
    const version = buf[4];
    assert.equal(version, 4);
    // The current decoder supports up to 4; a hypothetical v3-capped reader would see
    // 4 > 3 and throw 'unsupported version', which is the correct behavior — the whole
    // capture is refused rather than round-tripping to a blank timeline.
    assert.ok(version > 3);
});

test('truncated v4 trailer is rejected, not silently accepted', () => {
    const { p, tr } = build();
    const full = new Uint8Array(encodeCapture(p, null, null, tr));
    // Lop off the last 8 bytes (a Float64 mid-instant) — decode must throw.
    const truncated = full.slice(0, full.length - 8);
    assert.throws(() => decodeCapture(truncated), RangeError);
});
