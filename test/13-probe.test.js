import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize, FrameClass,
    createFrameProbe, FRAME_TELEMETRY_DESCRIPTOR,
    OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS
} from '../index.js';

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

const CLASS_ENUM = { [FrameClass.STEADY]: 0, [FrameClass.SPIKING]: 1, [FrameClass.THROTTLED]: 2 };

/** A mock SPP sink capturing [packed, t, a, b] tuples (mirrors the sibling probe tests). */
function collector() {
    const records = [];
    return { records, write(packed, t, a, b) { records.push([packed, t, a, b]); } };
}
const opOf = (packed) => packed & 0xFFFF;
const streamOf = (packed) => (packed >>> 16) & 0xFFFF;

/** Build a Profiler whose frame ring holds the given per-frame ms values. */
function profilerWith(frameMsList) {
    const p = new Profiler(1024);
    for (const ms of frameMsList) {
        clock += 1; p.beginFrame(); clock += ms; p.endFrame();
    }
    return p;
}

const arr = (n, ms) => Array.from({ length: n }, () => ms);

describe('FRAME_TELEMETRY_DESCRIPTOR', () => {
    it('is frozen, 6 ops, all in the frozen 0x041x block', () => {
        assert.ok(Object.isFrozen(FRAME_TELEMETRY_DESCRIPTOR));
        assert.equal(FRAME_TELEMETRY_DESCRIPTOR.ops.length, 6);
        for (const op of FRAME_TELEMETRY_DESCRIPTOR.ops) {
            assert.equal((op.code >>> 8) & 0xFF, 0x04, 'block 0x04');
            assert.equal((op.code >>> 4) & 0xF, 0x1, 'sub-block 0x041x');
        }
        assert.equal(FRAME_TELEMETRY_DESCRIPTOR.hz, 10);
    });

    it('opcode constants match the frozen protocol values', () => {
        assert.equal(OP_FPS, 0x0410);
        assert.equal(OP_FRAME_AVG, 0x0411);
        assert.equal(OP_FRAME_P99, 0x0412);
        assert.equal(OP_FRAME_MAX, 0x0413);
        assert.equal(OP_JANK, 0x0414);
        assert.equal(OP_FRAME_CLASS, 0x0415);
    });
});

describe('createFrameProbe', () => {
    it('sample() emits exactly 6 records in canonical opcode order', () => {
        const p = profilerWith(arr(60, 10));
        const c = collector();
        const probe = createFrameProbe({ profiler: p, sink: c, streamId: 4, clock: () => 100 });
        probe.sample();
        assert.equal(c.records.length, 6);
        assert.deepEqual(c.records.map((r) => opOf(r[0])),
            [OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS]);
        p.destroy(); probe.dispose();
    });

    it('routes every record to the given streamId and shares one timestamp', () => {
        const p = profilerWith(arr(30, 12));
        const c = collector();
        let calls = 0;
        const probe = createFrameProbe({ profiler: p, sink: c, streamId: 7, clock: () => { calls++; return 555; } });
        probe.sample();
        assert.equal(calls, 1, 'clock() called once per sample');
        for (const r of c.records) {
            assert.equal(streamOf(r[0]), 7);
            assert.equal(r[1], 555);
        }
        p.destroy(); probe.dispose();
    });

    it('emitted values EXACTLY match summarize() on the same profiler (single source of truth)', () => {
        const p = profilerWith([...arr(90, 8), ...arr(10, 40)]);   // mixed -> spiking-ish
        const s = summarize(p);
        const c = collector();
        const probe = createFrameProbe({ profiler: p, sink: c, streamId: 0, clock: () => 1 });
        probe.sample();
        const a = (op) => c.records.find((r) => opOf(r[0]) === op)[2];
        const b = (op) => c.records.find((r) => opOf(r[0]) === op)[3];
        assert.equal(a(OP_FPS), s.frame.fps);
        assert.equal(a(OP_FRAME_AVG), s.frame.avg);
        assert.equal(a(OP_FRAME_P99), s.frame.p99);
        assert.equal(a(OP_FRAME_MAX), s.frame.max);
        assert.equal(a(OP_JANK), s.frame.jankRatio);
        assert.equal(b(OP_JANK), s.frame.spikeRatio);
        assert.equal(a(OP_FRAME_CLASS), CLASS_ENUM[s.frame.frameClass]);
        p.destroy(); probe.dispose();
    });

    it('maps every classifier state to its numeric enum', () => {
        const cases = [
            { frames: arr(100, 8), cls: FrameClass.STEADY, enum: 0 },
            { frames: [...arr(90, 8), ...arr(10, 40)], cls: FrameClass.SPIKING, enum: 1 },
            { frames: arr(100, 20), cls: FrameClass.THROTTLED, enum: 2 }
        ];
        for (const { frames, cls, enum: e } of cases) {
            const p = profilerWith(frames);
            assert.equal(summarize(p).frame.frameClass, cls, 'fixture really is ' + cls);
            const c = collector();
            const probe = createFrameProbe({ profiler: p, sink: c, clock: () => 0 });
            probe.sample();
            assert.equal(c.records.find((r) => opOf(r[0]) === OP_FRAME_CLASS)[2], e);
            p.destroy(); probe.dispose();
        }
    });

    it('regressed predicate drives the OP_FRAME_CLASS b-slot (default 0)', () => {
        const p = profilerWith(arr(20, 10));
        const c1 = collector();
        createFrameProbe({ profiler: p, sink: c1, clock: () => 0 }).sample();
        assert.equal(c1.records.find((r) => opOf(r[0]) === OP_FRAME_CLASS)[3], 0);
        const c2 = collector();
        createFrameProbe({ profiler: p, sink: c2, clock: () => 0, regressed: () => true }).sample();
        assert.equal(c2.records.find((r) => opOf(r[0]) === OP_FRAME_CLASS)[3], 1);
        p.destroy();
    });

    it('an empty profiler samples cleanly (zeros, STEADY)', () => {
        const p = new Profiler(64);
        const c = collector();
        const probe = createFrameProbe({ profiler: p, sink: c, clock: () => 0 });
        probe.sample();
        assert.equal(c.records.length, 6);
        assert.equal(c.records.find((r) => opOf(r[0]) === OP_FPS)[2], 0);
        assert.equal(c.records.find((r) => opOf(r[0]) === OP_FRAME_CLASS)[2], 0);   // STEADY
        p.destroy(); probe.dispose();
    });

    it('dispose() is idempotent and halts emission', () => {
        const p = profilerWith(arr(10, 10));
        const c = collector();
        const probe = createFrameProbe({ profiler: p, sink: c, clock: () => 0 });
        probe.sample();
        assert.equal(c.records.length, 6);
        probe.dispose();
        assert.equal(probe.disposed, true);
        probe.sample();                       // no-op after dispose
        probe.dispose();                      // idempotent
        assert.equal(c.records.length, 6);
        p.destroy();
    });

    it('fails closed on a bad profiler or sink', () => {
        const p = profilerWith(arr(4, 10));
        assert.throws(() => createFrameProbe(), TypeError);
        assert.throws(() => createFrameProbe({ sink: collector() }), TypeError);
        assert.throws(() => createFrameProbe({ profiler: {}, sink: collector() }), TypeError);
        assert.throws(() => createFrameProbe({ profiler: p, sink: {} }), TypeError);
        assert.throws(() => createFrameProbe({ profiler: p }), TypeError);
        p.destroy();
    });

    it('is allocation-free across many samples (requires --expose-gc)', () => {
        if (typeof global.gc !== 'function') return;   // meaningful only under --expose-gc
        const p = profilerWith(arr(500, 12));
        const c = { write() {} };                       // non-allocating sink
        const probe = createFrameProbe({ profiler: p, sink: c, clock: () => 0 });
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
