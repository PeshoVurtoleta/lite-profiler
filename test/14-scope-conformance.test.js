/**
 * Live @zakkster/lite-scope conformance for createFrameProbe.
 *
 * The other probe tests (13-probe.test.js) assert against a MOCK collector sink
 * -- fast, dependency-free, and enough to prove the six records carry the right
 * opcodes and values. This file closes the remaining gap: it wires a REAL Scope
 * (lite-scope, a test-only devDependency), registers the frame-telemetry
 * descriptor through the actual registry, lets the probe write into a real
 * memory sink, and decodes the bytes back through lite-scope's own reference
 * decoder (`readSlab`). That proves the records are protocol-correct end to end,
 * not merely equal to what the probe believes it wrote.
 *
 * lite-scope is a devDependency ONLY: `src/probe.js` still imports nothing from
 * it (probes couple by protocol, never by dependency). See
 * decisions/0003-live-scope-conformance.md for the convention note.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize, FrameClass,
    createFrameProbe, FRAME_TELEMETRY_DESCRIPTOR,
    OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS
} from '../index.js';
import {
    createScope, createMemorySink, readSlab,
    pack, streamOf, opOf, blockOf, BLOCK_GPU
} from '@zakkster/lite-scope';

// Deterministic frame clock (mirrors 13-probe.test.js).
let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

const CLASS_ENUM = { [FrameClass.STEADY]: 0, [FrameClass.SPIKING]: 1, [FrameClass.THROTTLED]: 2 };
const FRAME_OPS = [OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS];
const arr = (n, ms) => Array.from({ length: n }, () => ms);

/** Build a Profiler whose frame ring holds the given per-frame ms values. */
function profilerWith(frameMsList) {
    const p = new Profiler(1024);
    for (const ms of frameMsList) { clock += 1; p.beginFrame(); clock += ms; p.endFrame(); }
    return p;
}

/**
 * Decode a memory sink through lite-scope's reference decoder, keeping only the
 * frame-telemetry (block 0x04) records. Returns Map<opcode, {packed,t,a,b,count}>.
 * The EPOCH meta record that createScope emits is filtered out by block.
 */
function decodeFrameRecords(sink, scope) {
    const byOp = new Map();
    readSlab(sink.toSlab(), scope.widthOf, (packed, t, payload, count) => {
        if (blockOf(opOf(packed)) !== BLOCK_GPU) return;   // skip EPOCH meta record
        byOp.set(opOf(packed), { packed, t, a: payload[0], b: payload[1], count });
    });
    return byOp;
}

describe('live lite-scope conformance (real registry + reference decoder)', () => {
    it('round-trips the six records through readSlab, exactly matching summarize()', () => {
        const p = profilerWith([...arr(90, 8), ...arr(10, 40)]);   // mixed -> spiking-ish window
        const s = summarize(p);

        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });        // emits the EPOCH meta record
        const channel = scope.register(FRAME_TELEMETRY_DESCRIPTOR); // registry assigns the stream id

        const probe = createFrameProbe({
            profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 42
        });
        probe.sample();

        const rec = decodeFrameRecords(sink, scope);

        // Exactly the six frame-telemetry ops, each a clean width-1 record.
        assert.equal(rec.size, 6);
        for (const op of FRAME_OPS) {
            assert.ok(rec.has(op), 'op 0x' + op.toString(16) + ' decoded');
            assert.equal(rec.get(op).count, 2, 'width-1 record: payload is [a,b]');
        }

        // The registry-assigned stream id is what the decoder reads back, and it
        // equals lite-scope's own packing of that id (independent packers agree),
        // with one shared timestamp across the sample.
        for (const op of FRAME_OPS) {
            assert.equal(streamOf(rec.get(op).packed), channel.id);
            assert.equal(rec.get(op).packed, pack(channel.id, op) >>> 0);
            assert.equal(rec.get(op).t, 42);
        }

        // Every decoded value EXACTLY equals summarize() on the same profiler --
        // now proven through lite-scope's reference decoder, not a mock collector.
        assert.equal(rec.get(OP_FPS).a, s.frame.fps);
        assert.equal(rec.get(OP_FRAME_AVG).a, s.frame.avg);
        assert.equal(rec.get(OP_FRAME_P99).a, s.frame.p99);
        assert.equal(rec.get(OP_FRAME_MAX).a, s.frame.max);
        assert.equal(rec.get(OP_JANK).a, s.frame.jankRatio);
        assert.equal(rec.get(OP_JANK).b, s.frame.spikeRatio);
        assert.equal(rec.get(OP_FRAME_CLASS).a, CLASS_ENUM[s.frame.frameClass]);
        assert.equal(rec.get(OP_FRAME_CLASS).b, 0);   // a bare Profiler has no baseline

        p.destroy(); probe.dispose();
    });

    it('registers cleanly and lands in scope.streams() with all six ops at width 1', () => {
        const sink = createMemorySink(64);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(FRAME_TELEMETRY_DESCRIPTOR);

        const mine = scope.streams().find((st) => st.id === channel.id);
        assert.ok(mine, 'registered stream is listed');
        assert.equal(mine.name, 'frame-telemetry');
        assert.equal(mine.unit, 'ms');
        assert.equal(mine.hz, 10);
        assert.deepEqual(mine.ops.map((o) => o.code), FRAME_OPS);
        for (const o of mine.ops) {
            assert.equal(scope.widthOf(pack(channel.id, o.code)), 1, 'LEVEL ops are width 1');
        }
    });

    it('the live sink holds exactly the EPOCH meta record plus six frame records', () => {
        const p = profilerWith(arr(60, 10));
        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(FRAME_TELEMETRY_DESCRIPTOR);
        createFrameProbe({ profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 7 }).sample();

        assert.equal(sink.size(), 7, '1 epoch + 6 telemetry');
        let meta = 0, frame = 0;
        sink.forEach((packed) => { blockOf(opOf(packed)) === BLOCK_GPU ? frame++ : meta++; });
        assert.equal(frame, 6);
        assert.equal(meta, 1, 'the single EPOCH meta record from createScope');
        p.destroy();
    });

    it('classifier enum survives the round-trip for every frame state', () => {
        const cases = [
            { frames: arr(100, 8), cls: FrameClass.STEADY, enum: 0 },
            { frames: [...arr(90, 8), ...arr(10, 40)], cls: FrameClass.SPIKING, enum: 1 },
            { frames: arr(100, 20), cls: FrameClass.THROTTLED, enum: 2 }
        ];
        for (const { frames, cls, enum: e } of cases) {
            const p = profilerWith(frames);
            assert.equal(summarize(p).frame.frameClass, cls, 'fixture really is ' + cls);
            const sink = createMemorySink(64);
            const scope = createScope({ sink, epochWallMs: 0 });
            const channel = scope.register(FRAME_TELEMETRY_DESCRIPTOR);
            createFrameProbe({ profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 0 }).sample();
            assert.equal(decodeFrameRecords(sink, scope).get(OP_FRAME_CLASS).a, e);
            p.destroy();
        }
    });
});
