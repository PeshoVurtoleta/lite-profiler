/**
 * Live @zakkster/lite-scope conformance for createPhaseProbe.
 *
 * The sibling mock test (15-phase-probe.test.js) asserts against a collector sink.
 * This file closes the remaining gap: it wires a REAL Scope (lite-scope 1.1.0, a
 * test-only devDependency), registers PHASE_TELEMETRY_DESCRIPTOR through the actual
 * registry, lets the probe write into a real memory sink with a scope.intern
 * bridge, and decodes the bytes back through lite-scope's own reference decoder
 * (`readSlab`). That proves the block 0x09 records are protocol-correct end to end
 * -- opcodes, stream routing, width, and the interned tag id in b -- not merely
 * equal to what the probe believes it wrote.
 *
 * lite-scope is a devDependency ONLY: `src/phase-probe.js` still imports nothing
 * from it (probes couple by protocol, never by dependency). See
 * decisions/0004-phase-channel.md.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize,
    createPhaseProbe, PHASE_TELEMETRY_DESCRIPTOR,
    OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX
} from '../index.js';
import {
    createScope, createMemorySink, readSlab,
    pack, streamOf, opOf, blockOf, BLOCK_PHASE
} from '@zakkster/lite-scope';

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

const PHASE_OPS = [OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX];
const arr = (n, ms) => Array.from({ length: n }, () => ms);

/** Build a Profiler with phase rings holding the given per-frame ms values per tag. */
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

/**
 * Decode a memory sink through lite-scope's reference decoder, keeping only the
 * phase-telemetry (block 0x09) records. Returns an array of {op, stream, t, a, b}.
 * The EPOCH meta record that createScope emits is filtered out by block.
 */
function decodePhaseRecords(sink, scope) {
    const rows = [];
    readSlab(sink.toSlab(), scope.widthOf, (packed, t, payload, count) => {
        if (blockOf(opOf(packed)) !== BLOCK_PHASE) return;   // skip EPOCH meta record
        rows.push({ op: opOf(packed), stream: streamOf(packed), t, a: payload[0], b: payload[1], count });
    });
    return rows;
}

describe('live lite-scope conformance (real registry + reference decoder)', () => {
    it('round-trips avg/p99/max per phase, exactly matching summarize()', () => {
        const tags = ['physics', 'render'];
        const p = profilerWithPhases(tags, {
            physics: [...arr(90, 3), ...arr(10, 30)],
            render: [...arr(80, 8), ...arr(20, 25)]
        });
        const s = summarize(p);

        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });          // emits the EPOCH meta record
        const channel = scope.register(PHASE_TELEMETRY_DESCRIPTOR);   // registry assigns the stream id

        const probe = createPhaseProbe({
            profiler: p, sink: scope.sink, streamId: channel.id,
            clock: () => 42, intern: (str) => scope.intern(str)
        });
        probe.sample();

        const rows = decodePhaseRecords(sink, scope);
        assert.equal(rows.length, 6, '3 ops x 2 phases');

        for (const tag of tags) {
            const id = scope.intern(tag);                             // idempotent: same id the probe used
            assert.equal(scope.stringTable()[id], tag, 'b resolves back to the tag via the scope table');
            const forPhase = rows.filter((r) => r.b === id);
            assert.equal(forPhase.length, 3, 'avg/p99/max for ' + tag);
            const a = (op) => forPhase.find((r) => r.op === op).a;
            assert.equal(a(OP_PHASE_AVG), s.phases[tag].avg, tag + ' avg');
            assert.equal(a(OP_PHASE_P99), s.phases[tag].p99, tag + ' p99');
            assert.equal(a(OP_PHASE_MAX), s.phases[tag].max, tag + ' max');
        }

        // Stream routing + width + shared timestamp, verified through the decoder.
        for (const r of rows) {
            assert.equal(r.stream, channel.id);
            assert.equal(pack(channel.id, r.op) >>> 0, pack(r.stream, r.op) >>> 0);
            assert.equal(r.count, 2, 'width-1 record: payload is [a,b]');
            assert.equal(r.t, 42);
        }

        p.destroy(); probe.dispose();
    });

    it('registers cleanly and lands in scope.streams() with all three ops at width 1', () => {
        const sink = createMemorySink(64);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(PHASE_TELEMETRY_DESCRIPTOR);

        const mine = scope.streams().find((st) => st.id === channel.id);
        assert.ok(mine, 'registered stream is listed');
        assert.equal(mine.name, 'phase-telemetry');
        assert.equal(mine.unit, 'ms');
        assert.equal(mine.hz, 10);
        assert.deepEqual(mine.ops.map((o) => o.code), PHASE_OPS);
        for (const o of mine.ops) {
            assert.equal(scope.widthOf(pack(channel.id, o.code)), 1, 'LEVEL ops are width 1');
            assert.equal(blockOf(o.code), BLOCK_PHASE, 'op is in block 0x09');
        }
    });

    it('the live sink holds exactly the EPOCH meta record plus 3*phaseCount phase records', () => {
        const p = profilerWithPhases(['physics', 'render', 'ui'], {
            physics: arr(30, 4), render: arr(30, 9), ui: arr(30, 2)
        });
        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(PHASE_TELEMETRY_DESCRIPTOR);
        createPhaseProbe({
            profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 7,
            intern: (str) => scope.intern(str)
        }).sample();

        assert.equal(sink.size(), 10, '1 epoch + 9 phase records (3 ops x 3 phases)');
        let meta = 0, phase = 0;
        sink.forEach((packed) => { blockOf(opOf(packed)) === BLOCK_PHASE ? phase++ : meta++; });
        assert.equal(phase, 9);
        assert.equal(meta, 1, 'the single EPOCH meta record from createScope');
        p.destroy();
    });

    it('default (no intern bridge) carries the profiler dense phase index, still decodable', () => {
        const p = profilerWithPhases(['physics', 'render'], {
            physics: arr(20, 4), render: arr(20, 9)
        });
        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(PHASE_TELEMETRY_DESCRIPTOR);
        createPhaseProbe({ profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 0 }).sample();

        const rows = decodePhaseRecords(sink, scope);
        // b is the profiler's own dense phase index: physics=0, render=1.
        assert.deepEqual([...new Set(rows.map((r) => r.b))].sort(), [0, 1]);
        assert.equal(p.handle('physics'), 0);
        assert.equal(p.handle('render'), 1);
        p.destroy();
    });
});
