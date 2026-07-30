import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    Profiler, TimelineRecorder, encodeCapture, decodeCapture, encodeTimelineCapture,
    exportChromeTrace
} from '../index.js';

// A realistic session-uptime magnitude: one hour in. This is exactly where a
// Float32 timeline would quantize sub-ms starts away, so it doubles as a guard
// that the exporter reads the Float64 timeline faithfully.
const BIG = 3_600_000;

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

/** Build a v4 capture: 4 frames, one span lane 'physics', one instant lane 'gc'. */
function buildV4() {
    const p = new Profiler(64, ['physics'], ['draws']);
    const tr = new TimelineRecorder(64, ['physics', 'render'], ['gc']);
    for (let f = 0; f < 4; f++) {
        clock = BIG + f * 16; p.beginFrame(); p.begin('physics'); p.count('draws', 10 + f); p.end('physics'); clock = BIG + f * 16 + 16; p.endFrame();
        tr.recordFrameBoundary(BIG + f * 16);
        tr.beginSpan('physics', BIG + f * 16 + 1);
        tr.endSpan('physics', BIG + f * 16 + 5.5);   // 4.5 ms span
        tr.mark('gc', BIG + f * 16 + 8);
    }
    const d = decodeCapture(encodeCapture(p, null, { label: 'run-a' }, tr));
    p.destroy(); tr.destroy();
    return d;
}

/** Assert an object is a schema-valid Chrome Trace Event trace. */
function assertValidTrace(t) {
    assert.equal(typeof t, 'object');
    assert.equal(t.displayTimeUnit, 'ms');
    assert.ok(Array.isArray(t.traceEvents));
    const lastTsByTid = new Map();
    for (const e of t.traceEvents) {
        assert.ok(e.ph === 'X' || e.ph === 'i' || e.ph === 'M', 'ph in {X,i,M}: ' + e.ph);
        assert.equal(e.pid, 1);
        assert.equal(typeof e.name, 'string');
        if (e.ph === 'M') {
            assert.ok(e.name === 'process_name' || e.name === 'thread_name');
            assert.equal(typeof e.args.name, 'string');
            continue;
        }
        assert.equal(typeof e.ts, 'number');
        assert.ok(Number.isFinite(e.ts));
        if (e.ph === 'X') {
            assert.equal(typeof e.dur, 'number');
            assert.ok(e.dur >= 0, 'dur >= 0');
            // per-thread complete events must be time-ordered
            const prev = lastTsByTid.get(e.tid);
            if (prev !== undefined) assert.ok(e.ts >= prev, 'X ts monotonic within tid ' + e.tid);
            lastTsByTid.set(e.tid, e.ts);
        }
        if (e.ph === 'i') assert.ok(e.s === 't' || e.s === 'p' || e.s === 'g');
    }
}

describe('exportChromeTrace', () => {
    it('produces a schema-valid Chrome trace from a v4 capture', () => {
        const t = exportChromeTrace(buildV4());
        assertValidTrace(t);
        assert.equal(t.metadata.source, '@zakkster/lite-profiler');
        assert.equal(t.metadata.litecapVersion, 4);
    });

    it('maps span pairs to X events with microsecond ts/dur', () => {
        const t = exportChromeTrace(buildV4());
        const spans = t.traceEvents.filter((e) => e.ph === 'X' && e.name === 'physics');
        assert.equal(spans.length, 4);
        // first span: t0 = BIG+1 ms -> ts in us; dur = 4.5 ms -> 4500 us
        assert.equal(spans[0].ts, (BIG + 1) * 1000);
        assert.equal(spans[0].dur, 4500);
    });

    it('maps instant marks to i events', () => {
        const t = exportChromeTrace(buildV4());
        const marks = t.traceEvents.filter((e) => e.ph === 'i' && e.name === 'gc');
        assert.equal(marks.length, 4);
        assert.equal(marks[0].ts, (BIG + 8) * 1000);
        assert.equal(marks[0].s, 't');
    });

    it('emits a frame-boundary lane of instant markers', () => {
        const t = exportChromeTrace(buildV4());
        const frames = t.traceEvents.filter((e) => e.ph === 'i' && e.name === 'frame');
        assert.equal(frames.length, 4);
        assert.equal(frames[0].ts, BIG * 1000);
    });

    it('names every lane with a thread_name metadata event', () => {
        const t = exportChromeTrace(buildV4());
        const names = t.traceEvents.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => e.args.name);
        assert.ok(names.includes('frames'));
        assert.ok(names.includes('physics'));
        assert.ok(names.includes('gc'));
        // Empty lane 'render' was registered but has no samples -> still named, no events.
        assert.ok(names.includes('render'));
        assert.equal(t.traceEvents.filter((e) => e.ph === 'X' && e.name === 'render').length, 0);
    });

    it('keeps absolute timestamps by default and zero-bases under normalize', () => {
        const abs = exportChromeTrace(buildV4());
        const firstAbs = abs.traceEvents.find((e) => e.ph === 'i' && e.name === 'frame');
        assert.equal(firstAbs.ts, BIG * 1000);

        const norm = exportChromeTrace(buildV4(), { normalize: true });
        assert.equal(norm.metadata.normalized, true);
        const tsValues = norm.traceEvents.filter((e) => e.ts !== undefined).map((e) => e.ts);
        assert.equal(Math.min(...tsValues), 0, 'earliest event zero-based');
    });

    it('honors a processName override, else falls back to meta.label', () => {
        const named = exportChromeTrace(buildV4(), { processName: 'custom' });
        const pn = named.traceEvents.find((e) => e.ph === 'M' && e.name === 'process_name');
        assert.equal(pn.args.name, 'custom');
        const dflt = exportChromeTrace(buildV4());
        assert.equal(dflt.traceEvents.find((e) => e.ph === 'M' && e.name === 'process_name').args.name, 'run-a');
    });

    it('REFUSES a v2/v3 capture (no absolute clock — DP2f)', () => {
        // v3: counters, no timeline.
        const p = new Profiler(64, ['a'], ['c']);
        clock = 0; p.beginFrame(); p.begin('a'); p.count('c', 1); p.end('a'); clock = 5; p.endFrame();
        const v3 = decodeCapture(encodeCapture(p, null, { label: 'x' }));
        p.destroy();
        assert.equal(v3.version, 3);
        assert.throws(() => exportChromeTrace(v3), /no timeline data/);
    });

    it('rejects a non-capture argument', () => {
        assert.throws(() => exportChromeTrace(null), TypeError);
        assert.throws(() => exportChromeTrace({}), TypeError);
    });

    it('handles a timeline-only capture (encodeTimelineCapture)', () => {
        const tr = new TimelineRecorder(16, ['work'], ['tick']);
        tr.recordFrameBoundary(BIG);
        tr.beginSpan('work', BIG + 1); tr.endSpan('work', BIG + 2);
        tr.mark('tick', BIG + 3);
        const d = decodeCapture(encodeTimelineCapture(tr, { label: 'tl' }));
        tr.destroy();
        const t = exportChromeTrace(d);
        assertValidTrace(t);
        assert.equal(t.traceEvents.filter((e) => e.ph === 'X').length, 1);
    });

    it('matches the committed fixture, if present', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const fx = join(here, 'fixtures', 'trace-sample.json');
        if (!existsSync(fx)) return;   // fixture is a documentation artifact; skip if absent
        const committed = JSON.parse(readFileSync(fx, 'utf8'));
        assertValidTrace(committed);
        const fresh = exportChromeTrace(buildV4());
        assert.deepEqual(committed.traceEvents, fresh.traceEvents, 'fixture in sync with exporter');
    });
});
