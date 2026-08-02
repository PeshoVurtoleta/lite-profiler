import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize,
    createCounterProbe, COUNTER_TELEMETRY_DESCRIPTOR,
    OP_COUNTER_AVG, OP_COUNTER_MAX, OP_COUNTER_LAST
} from '../index.js';

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

/** A mock SPP sink capturing [packed, t, a, b] tuples (mirrors the sibling probe tests). */
function collector() {
    const records = [];
    return { records, write(packed, t, a, b) { records.push([packed, t, a, b]); } };
}
const opOf = (packed) => packed & 0xFFFF;
const streamOf = (packed) => (packed >>> 16) & 0xFFFF;

/**
 * Build a Profiler with the given counter tags whose rings hold, per tag, the
 * given per-frame counts (all tag arrays must be equal length). One count()/frame.
 */
function profilerWithCounters(tags, countsByTag) {
    const p = new Profiler(1024, [], tags);
    const len = countsByTag[tags[0]].length;
    for (let f = 0; f < len; f++) {
        p.beginFrame();
        for (const tag of tags) p.count(tag, countsByTag[tag][f]);
        p.endFrame();
    }
    return p;
}

const arr = (n, v) => Array.from({ length: n }, () => v);

describe('COUNTER_TELEMETRY_DESCRIPTOR', () => {
    it('is frozen, 3 ops, all in the frozen 0x0A0x block, hz 10, unit count', () => {
        assert.ok(Object.isFrozen(COUNTER_TELEMETRY_DESCRIPTOR));
        assert.equal(COUNTER_TELEMETRY_DESCRIPTOR.ops.length, 3);
        for (const op of COUNTER_TELEMETRY_DESCRIPTOR.ops) {
            assert.equal((op.code >>> 8) & 0xFF, 0x0A, 'block 0x0A');
            assert.equal(op.kind, 0, 'LEVEL');
        }
        assert.equal(COUNTER_TELEMETRY_DESCRIPTOR.name, 'counter-telemetry');
        assert.equal(COUNTER_TELEMETRY_DESCRIPTOR.unit, 'count');
        assert.equal(COUNTER_TELEMETRY_DESCRIPTOR.hz, 10);
    });

    it('opcode constants match the frozen protocol values', () => {
        assert.equal(OP_COUNTER_AVG, 0x0A00);
        assert.equal(OP_COUNTER_MAX, 0x0A01);
        assert.equal(OP_COUNTER_LAST, 0x0A02);
    });
});

describe('createCounterProbe', () => {
    it('sample() emits 3 records per counter, grouped counter-major in canonical op order', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: arr(30, 10), floatsUploaded: arr(30, 100)
        });
        const c = collector();
        const probe = createCounterProbe({ profiler: p, sink: c, streamId: 5, clock: () => 100 });
        probe.sample();
        assert.equal(c.records.length, 6, '3 ops x 2 counters');
        assert.deepEqual(c.records.map((r) => opOf(r[0])), [
            OP_COUNTER_AVG, OP_COUNTER_MAX, OP_COUNTER_LAST,   // drawCalls
            OP_COUNTER_AVG, OP_COUNTER_MAX, OP_COUNTER_LAST    // floatsUploaded
        ]);
        p.destroy(); probe.dispose();
    });

    it('routes every record to the given streamId and shares one timestamp', () => {
        const p = profilerWithCounters(['drawCalls'], { drawCalls: arr(20, 6) });
        const c = collector();
        let calls = 0;
        const probe = createCounterProbe({ profiler: p, sink: c, streamId: 7, clock: () => { calls++; return 555; } });
        probe.sample();
        assert.equal(calls, 1, 'clock() called once per sample');
        for (const r of c.records) {
            assert.equal(streamOf(r[0]), 7);
            assert.equal(r[1], 555);
        }
        p.destroy(); probe.dispose();
    });

    it('carries the profiler dense counter index in b by default', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: arr(10, 10), floatsUploaded: arr(10, 100)
        });
        const c = collector();
        createCounterProbe({ profiler: p, sink: c, clock: () => 0 }).sample();
        // drawCalls=index 0, floatsUploaded=index 1; every record's b is its counter index.
        assert.deepEqual(c.records.map((r) => r[3]), [0, 0, 0, 1, 1, 1]);
        assert.equal(p.counterHandle('drawCalls'), 0);
        assert.equal(p.counterHandle('floatsUploaded'), 1);
        p.destroy();
    });

    it('carries interned ids in b when an intern bridge is supplied', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: arr(10, 10), floatsUploaded: arr(10, 100)
        });
        // A fake intern bridge with its own id namespace (offset to prove it is used).
        const table = [];
        const intern = (s) => { let i = table.indexOf(s); if (i < 0) { i = table.length; table.push(s); } return i + 100; };
        const c = collector();
        createCounterProbe({ profiler: p, sink: c, clock: () => 0, intern }).sample();
        assert.deepEqual(c.records.map((r) => r[3]), [100, 100, 100, 101, 101, 101]);
        p.destroy();
    });

    it('interns once at construction, not on the hot path', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: arr(4, 10), floatsUploaded: arr(4, 100)
        });
        let internCalls = 0;
        const intern = (s) => { internCalls++; return s === 'drawCalls' ? 0 : 1; };
        const probe = createCounterProbe({ profiler: p, sink: collector(), clock: () => 0, intern });
        assert.equal(internCalls, 2, 'one intern per counter at construction');
        probe.sample(); probe.sample(); probe.sample();
        assert.equal(internCalls, 2, 'no interning during sample()');
        p.destroy(); probe.dispose();
    });

    it('emitted values EXACTLY match summarize().counters[tag] (single source of truth)', () => {
        // Last frame is NOT the max, so last != max -- proves `last` is the newest sample.
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: [...arr(10, 40), ...arr(90, 10)],       // max 40, last 10
            floatsUploaded: [...arr(20, 500), ...arr(80, 100)] // max 500, last 100
        });
        const s = summarize(p);
        const c = collector();
        createCounterProbe({ profiler: p, sink: c, clock: () => 1 }).sample();
        const val = (idx, op) => c.records.find((r) => r[3] === idx && opOf(r[0]) === op)[2];
        for (const [idx, tag] of [[0, 'drawCalls'], [1, 'floatsUploaded']]) {
            assert.equal(val(idx, OP_COUNTER_AVG), s.counters[tag].avg, tag + ' avg');
            assert.equal(val(idx, OP_COUNTER_MAX), s.counters[tag].max, tag + ' max');
            assert.equal(val(idx, OP_COUNTER_LAST), s.counters[tag].last, tag + ' last');
        }
        // Sanity: last is genuinely distinct from max for both counters.
        assert.notEqual(s.counters.drawCalls.last, s.counters.drawCalls.max);
        assert.notEqual(s.counters.floatsUploaded.last, s.counters.floatsUploaded.max);
        p.destroy();
    });

    it('a counter with no samples emits zeros (parity with summarize)', () => {
        const p = new Profiler(64, [], ['drawCalls', 'floatsUploaded']);   // registered but never counted
        const s = summarize(p);
        const c = collector();
        createCounterProbe({ profiler: p, sink: c, clock: () => 0 }).sample();
        assert.equal(c.records.length, 6);
        for (const r of c.records) assert.equal(r[2], 0);
        assert.equal(s.counters.drawCalls.avg, 0);
        assert.equal(s.counters.floatsUploaded.max, 0);
        assert.equal(s.counters.drawCalls.last, 0);
        p.destroy();
    });

    it('a profiler with no registered counters emits nothing', () => {
        const p = new Profiler(64, ['physics']);   // phases but zero counters
        const c = collector();
        const probe = createCounterProbe({ profiler: p, sink: c, clock: () => 0 });
        probe.sample();
        assert.equal(c.records.length, 0);
        p.destroy(); probe.dispose();
    });

    it('dispose() is idempotent and halts emission', () => {
        const p = profilerWithCounters(['drawCalls'], { drawCalls: arr(10, 5) });
        const c = collector();
        const probe = createCounterProbe({ profiler: p, sink: c, clock: () => 0 });
        probe.sample();
        assert.equal(c.records.length, 3);
        probe.dispose();
        assert.equal(probe.disposed, true);
        probe.sample();                       // no-op after dispose
        probe.dispose();                      // idempotent
        assert.equal(c.records.length, 3);
        p.destroy();
    });

    it('fails closed on a bad profiler or sink', () => {
        const p = profilerWithCounters(['drawCalls'], { drawCalls: arr(4, 5) });
        assert.throws(() => createCounterProbe(), TypeError);
        assert.throws(() => createCounterProbe({ sink: collector() }), TypeError);
        assert.throws(() => createCounterProbe({ profiler: {}, sink: collector() }), TypeError);
        assert.throws(() => createCounterProbe({ profiler: p, sink: {} }), TypeError);
        assert.throws(() => createCounterProbe({ profiler: p }), TypeError);
        p.destroy();
    });

    it('is allocation-free across many samples (requires --expose-gc)', () => {
        if (typeof global.gc !== 'function') return;   // meaningful only under --expose-gc
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded', 'textureBinds'], {
            drawCalls: arr(400, 10), floatsUploaded: arr(400, 100), textureBinds: arr(400, 5)
        });
        const c = { write() {} };                        // non-allocating sink
        const probe = createCounterProbe({ profiler: p, sink: c, clock: () => 0 });
        for (let i = 0; i < 2000; i++) probe.sample();   // warm up JIT + settle
        global.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 50000; i++) probe.sample();
        global.gc();
        const delta = process.memoryUsage().heapUsed - before;
        assert.ok(delta < 64 * 1024, `50k samples allocated ${delta} B (expected ~0)`);
        p.destroy(); probe.dispose();
    });
});
