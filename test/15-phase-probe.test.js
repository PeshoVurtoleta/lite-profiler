import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize,
    createPhaseProbe, PHASE_TELEMETRY_DESCRIPTOR,
    OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX
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
 * Build a Profiler with the given phase tags whose rings hold, per tag, the
 * given per-frame ms values (all tag arrays must be equal length).
 */
function profilerWithPhases(tags, msByTag) {
    const p = new Profiler(1024, tags);
    const len = msByTag[tags[0]].length;
    for (let f = 0; f < len; f++) {
        for (const tag of tags) {
            clock += 1; p.begin(tag); clock += msByTag[tag][f]; p.end(tag);
        }
    }
    return p;
}

const arr = (n, ms) => Array.from({ length: n }, () => ms);

describe('PHASE_TELEMETRY_DESCRIPTOR', () => {
    it('is frozen, 3 ops, all in the frozen 0x090x block, hz 10', () => {
        assert.ok(Object.isFrozen(PHASE_TELEMETRY_DESCRIPTOR));
        assert.equal(PHASE_TELEMETRY_DESCRIPTOR.ops.length, 3);
        for (const op of PHASE_TELEMETRY_DESCRIPTOR.ops) {
            assert.equal((op.code >>> 8) & 0xFF, 0x09, 'block 0x09');
            assert.equal(op.kind, 0, 'LEVEL');
        }
        assert.equal(PHASE_TELEMETRY_DESCRIPTOR.name, 'phase-telemetry');
        assert.equal(PHASE_TELEMETRY_DESCRIPTOR.unit, 'ms');
        assert.equal(PHASE_TELEMETRY_DESCRIPTOR.hz, 10);
    });

    it('opcode constants match the frozen protocol values', () => {
        assert.equal(OP_PHASE_AVG, 0x0900);
        assert.equal(OP_PHASE_P99, 0x0901);
        assert.equal(OP_PHASE_MAX, 0x0902);
    });
});

describe('createPhaseProbe', () => {
    it('sample() emits 3 records per phase, grouped phase-major in canonical op order', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: arr(30, 4), render: arr(30, 9)
        });
        const c = collector();
        const probe = createPhaseProbe({ profiler: p, sink: c, streamId: 5, clock: () => 100 });
        probe.sample();
        assert.equal(c.records.length, 6, '3 ops x 2 phases');
        assert.deepEqual(c.records.map((r) => opOf(r[0])), [
            OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX,   // physics
            OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX    // render
        ]);
        p.destroy(); probe.dispose();
    });

    it('routes every record to the given streamId and shares one timestamp', () => {
        const p = profilerWithPhases(['physics'], { physics: arr(20, 6) });
        const c = collector();
        let calls = 0;
        const probe = createPhaseProbe({ profiler: p, sink: c, streamId: 7, clock: () => { calls++; return 555; } });
        probe.sample();
        assert.equal(calls, 1, 'clock() called once per sample');
        for (const r of c.records) {
            assert.equal(streamOf(r[0]), 7);
            assert.equal(r[1], 555);
        }
        p.destroy(); probe.dispose();
    });

    it('carries the profiler dense phase index in b by default', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: arr(10, 4), render: arr(10, 9)
        });
        const c = collector();
        createPhaseProbe({ profiler: p, sink: c, clock: () => 0 }).sample();
        // physics=index 0, render=index 1; every record's b is its phase index.
        assert.deepEqual(c.records.map((r) => r[3]), [0, 0, 0, 1, 1, 1]);
        assert.equal(p.handle('physics'), 0);
        assert.equal(p.handle('render'), 1);
        p.destroy();
    });

    it('carries interned ids in b when an intern bridge is supplied', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: arr(10, 4), render: arr(10, 9)
        });
        // A fake intern bridge with its own id namespace (offset to prove it is used).
        const table = [];
        const intern = (s) => { let i = table.indexOf(s); if (i < 0) { i = table.length; table.push(s); } return i + 100; };
        const c = collector();
        createPhaseProbe({ profiler: p, sink: c, clock: () => 0, intern }).sample();
        assert.deepEqual(c.records.map((r) => r[3]), [100, 100, 100, 101, 101, 101]);
        p.destroy();
    });

    it('interns once at construction, not on the hot path', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: arr(4, 4), render: arr(4, 9)
        });
        let internCalls = 0;
        const intern = (s) => { internCalls++; return s === 'physics' ? 0 : 1; };
        const probe = createPhaseProbe({ profiler: p, sink: collector(), clock: () => 0, intern });
        assert.equal(internCalls, 2, 'one intern per phase at construction');
        probe.sample(); probe.sample(); probe.sample();
        assert.equal(internCalls, 2, 'no interning during sample()');
        p.destroy(); probe.dispose();
    });

    it('emitted values EXACTLY match summarize().phases[tag] (single source of truth)', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: [...arr(90, 3), ...arr(10, 30)],   // skewed -> distinct p99/max
            render: [...arr(80, 8), ...arr(20, 25)]
        });
        const s = summarize(p);
        const c = collector();
        createPhaseProbe({ profiler: p, sink: c, clock: () => 1 }).sample();
        // Group records by phase index (b) then opcode.
        const val = (idx, op) => c.records.find((r) => r[3] === idx && opOf(r[0]) === op)[2];
        for (const [idx, tag] of [[0, 'physics'], [1, 'render']]) {
            assert.equal(val(idx, OP_PHASE_AVG), s.phases[tag].avg, tag + ' avg');
            assert.equal(val(idx, OP_PHASE_P99), s.phases[tag].p99, tag + ' p99');
            assert.equal(val(idx, OP_PHASE_MAX), s.phases[tag].max, tag + ' max');
        }
        p.destroy();
    });

    it('a phase with no samples emits zeros (parity with summarize)', () => {
        const p = new Profiler(64, ['physics', 'render']);   // registered but never sampled
        const s = summarize(p);
        const c = collector();
        createPhaseProbe({ profiler: p, sink: c, clock: () => 0 }).sample();
        assert.equal(c.records.length, 6);
        for (const r of c.records) assert.equal(r[2], 0);
        assert.equal(s.phases.physics.avg, 0);
        assert.equal(s.phases.render.max, 0);
        p.destroy();
    });

    it('a profiler with no registered phases emits nothing', () => {
        const p = new Profiler(64);   // zero phases
        const c = collector();
        const probe = createPhaseProbe({ profiler: p, sink: c, clock: () => 0 });
        probe.sample();
        assert.equal(c.records.length, 0);
        p.destroy(); probe.dispose();
    });

    it('dispose() is idempotent and halts emission', () => {
        const p = profilerWithPhases(['physics'], { physics: arr(10, 5) });
        const c = collector();
        const probe = createPhaseProbe({ profiler: p, sink: c, clock: () => 0 });
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
        const p = profilerWithPhases(['physics'], { physics: arr(4, 5) });
        assert.throws(() => createPhaseProbe(), TypeError);
        assert.throws(() => createPhaseProbe({ sink: collector() }), TypeError);
        assert.throws(() => createPhaseProbe({ profiler: {}, sink: collector() }), TypeError);
        assert.throws(() => createPhaseProbe({ profiler: p, sink: {} }), TypeError);
        assert.throws(() => createPhaseProbe({ profiler: p }), TypeError);
        p.destroy();
    });

    it('is allocation-free across many samples (requires --expose-gc)', () => {
        if (typeof global.gc !== 'function') return;   // meaningful only under --expose-gc
        const p = profilerWithPhases(['physics', 'render', 'ui'], {
            physics: arr(400, 4), render: arr(400, 9), ui: arr(400, 2)
        });
        const c = { write() {} };                       // non-allocating sink
        const probe = createPhaseProbe({ profiler: p, sink: c, clock: () => 0 });
        for (let i = 0; i < 2000; i++) probe.sample();  // warm up JIT + settle
        global.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 50000; i++) probe.sample();
        global.gc();
        const delta = process.memoryUsage().heapUsed - before;
        assert.ok(delta < 64 * 1024, `50k samples allocated ${delta} B (expected ~0)`);
        p.destroy(); probe.dispose();
    });
});
