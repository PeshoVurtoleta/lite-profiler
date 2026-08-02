/**
 * Live @zakkster/lite-scope conformance for createCounterProbe.
 *
 * The sibling mock test (17-counter-probe.test.js) asserts against a collector
 * sink. This file closes the remaining gap: it wires a REAL Scope (lite-scope
 * 1.2.0, a test-only devDependency), registers COUNTER_TELEMETRY_DESCRIPTOR through
 * the actual registry, lets the probe write into a real memory sink with a
 * scope.intern bridge, and decodes the bytes back through lite-scope's own
 * reference decoder (`readSlab`). That proves the block 0x0A records are
 * protocol-correct end to end -- opcodes, stream routing, width, and the interned
 * tag id in b -- not merely equal to what the probe believes it wrote.
 *
 * lite-scope is a devDependency ONLY: `src/counter-probe.js` still imports nothing
 * from it (probes couple by protocol, never by dependency). See
 * decisions/0005-counter-channel.md.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiler, summarize,
    createCounterProbe, COUNTER_TELEMETRY_DESCRIPTOR,
    OP_COUNTER_AVG, OP_COUNTER_MAX, OP_COUNTER_LAST
} from '../index.js';
import {
    createScope, createMemorySink, readSlab,
    pack, streamOf, opOf, blockOf, BLOCK_COUNTER
} from '@zakkster/lite-scope';

let clock = 0;
let realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

const COUNTER_OPS = [OP_COUNTER_AVG, OP_COUNTER_MAX, OP_COUNTER_LAST];
const arr = (n, v) => Array.from({ length: n }, () => v);

/** Build a Profiler with counter rings holding the given per-frame counts per tag. */
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

/**
 * Decode a memory sink through lite-scope's reference decoder, keeping only the
 * counter-telemetry (block 0x0A) records. Returns an array of {op, stream, t, a, b}.
 * The EPOCH meta record that createScope emits is filtered out by block.
 */
function decodeCounterRecords(sink, scope) {
    const rows = [];
    readSlab(sink.toSlab(), scope.widthOf, (packed, t, payload, count) => {
        if (blockOf(opOf(packed)) !== BLOCK_COUNTER) return;   // skip EPOCH meta record
        rows.push({ op: opOf(packed), stream: streamOf(packed), t, a: payload[0], b: payload[1], count });
    });
    return rows;
}

describe('live lite-scope conformance (real registry + reference decoder)', () => {
    it('round-trips avg/max/last per counter, exactly matching summarize()', () => {
        const tags = ['drawCalls', 'floatsUploaded'];
        const p = profilerWithCounters(tags, {
            drawCalls: [...arr(10, 40), ...arr(90, 10)],        // max 40, last 10
            floatsUploaded: [...arr(20, 500), ...arr(80, 100)]  // max 500, last 100
        });
        const s = summarize(p);

        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });            // emits the EPOCH meta record
        const channel = scope.register(COUNTER_TELEMETRY_DESCRIPTOR);   // registry assigns the stream id

        const probe = createCounterProbe({
            profiler: p, sink: scope.sink, streamId: channel.id,
            clock: () => 42, intern: (str) => scope.intern(str)
        });
        probe.sample();

        const rows = decodeCounterRecords(sink, scope);
        assert.equal(rows.length, 6, '3 ops x 2 counters');

        for (const tag of tags) {
            const id = scope.intern(tag);                              // idempotent: same id the probe used
            assert.equal(scope.stringTable()[id], tag, 'b resolves back to the tag via the scope table');
            const forCounter = rows.filter((r) => r.b === id);
            assert.equal(forCounter.length, 3, 'avg/max/last for ' + tag);
            const a = (op) => forCounter.find((r) => r.op === op).a;
            assert.equal(a(OP_COUNTER_AVG), s.counters[tag].avg, tag + ' avg');
            assert.equal(a(OP_COUNTER_MAX), s.counters[tag].max, tag + ' max');
            assert.equal(a(OP_COUNTER_LAST), s.counters[tag].last, tag + ' last');
            // last is genuinely the newest sample, distinct from max.
            assert.notEqual(a(OP_COUNTER_LAST), a(OP_COUNTER_MAX), tag + ' last != max');
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
        const channel = scope.register(COUNTER_TELEMETRY_DESCRIPTOR);

        const mine = scope.streams().find((st) => st.id === channel.id);
        assert.ok(mine, 'registered stream is listed');
        assert.equal(mine.name, 'counter-telemetry');
        assert.equal(mine.unit, 'count');
        assert.equal(mine.hz, 10);
        assert.deepEqual(mine.ops.map((o) => o.code), COUNTER_OPS);
        for (const o of mine.ops) {
            assert.equal(scope.widthOf(pack(channel.id, o.code)), 1, 'LEVEL ops are width 1');
            assert.equal(blockOf(o.code), BLOCK_COUNTER, 'op is in block 0x0A');
        }
    });

    it('the live sink holds exactly the EPOCH meta record plus 3*counterCount counter records', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded', 'textureBinds'], {
            drawCalls: arr(30, 10), floatsUploaded: arr(30, 100), textureBinds: arr(30, 5)
        });
        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(COUNTER_TELEMETRY_DESCRIPTOR);
        createCounterProbe({
            profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 7,
            intern: (str) => scope.intern(str)
        }).sample();

        assert.equal(sink.size(), 10, '1 epoch + 9 counter records (3 ops x 3 counters)');
        let meta = 0, counter = 0;
        sink.forEach((packed) => { blockOf(opOf(packed)) === BLOCK_COUNTER ? counter++ : meta++; });
        assert.equal(counter, 9);
        assert.equal(meta, 1, 'the single EPOCH meta record from createScope');
        p.destroy();
    });

    it('default (no intern bridge) carries the profiler dense counter index, still decodable', () => {
        const p = profilerWithCounters(['drawCalls', 'floatsUploaded'], {
            drawCalls: arr(20, 10), floatsUploaded: arr(20, 100)
        });
        const sink = createMemorySink(4096);
        const scope = createScope({ sink, epochWallMs: 0 });
        const channel = scope.register(COUNTER_TELEMETRY_DESCRIPTOR);
        createCounterProbe({ profiler: p, sink: scope.sink, streamId: channel.id, clock: () => 0 }).sample();

        const rows = decodeCounterRecords(sink, scope);
        // b is the profiler's own dense counter index: drawCalls=0, floatsUploaded=1.
        assert.deepEqual([...new Set(rows.map((r) => r.b))].sort(), [0, 1]);
        assert.equal(p.counterHandle('drawCalls'), 0);
        assert.equal(p.counterHandle('floatsUploaded'), 1);
        p.destroy();
    });
});
