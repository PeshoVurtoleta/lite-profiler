/**
 * @zakkster/lite-profiler
 *
 * SPP counter-telemetry probe for the standalone Profiler.
 *
 * The Scope Probe Protocol (SPP, frozen in @zakkster/lite-scope) lets the
 * profiler suite share one wire format: every probe emits fixed-width records
 * into an INJECTED sink, and no probe imports another package. `createFrameProbe`
 * streams the whole-frame channel (block 0x041x), `createPhaseProbe` the per-phase
 * channel (block 0x090x); `createCounterProbe` is the per-counter sibling. It
 * reduces every registered counter ring to avg / max / last and emits them on the
 * frozen 0x0A0x block, one "counter-telemetry" stream, with the counter's tag id
 * riding the record's `b` slot.
 *
 * Why avg / max / last (not the phase probe's avg / p99 / max): counters are
 * deterministic, lower-is-better integers, so `last` (the exact current-frame
 * value that is displayed and gated) and `max` (the ceiling gated at zero
 * tolerance) matter more than a percentile of small integers. Every value equals
 * summarize().counters[tag].{avg,max,last} exactly -- avg/max via StatsMath, last
 * via the ring's newest sample, the same path summarize() takes.
 *
 * Block 0x0A is owned by lite-scope (protocol home, v1.2.0) and produced only
 * here. The opcodes below are inlined PROTOCOL FACTS -- lite-scope is a test-only
 * devDependency; `src/` imports nothing from it, because probes couple by
 * protocol, never by dependency.
 *
 * Zero-GC: the percentile scratch (`StatsMath`), the reusable `out` object, and
 * the per-counter tag-id table are all allocated once at construction and reused
 * on every `sample()`; a sample emits 3 * counterCount records and allocates
 * nothing.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { StatsMath } from '@zakkster/lite-stats-math';

// SPP v1 counter-telemetry opcode block (0x0A0x). These are PROTOCOL FACTS,
// inlined to match @zakkster/lite-scope block 0x0A (PROTOCOL.md) exactly --
// not imported, because probes couple by protocol, never by dependency.
export const OP_COUNTER_AVG = 0x0A00; // a=avgCount, b=counterTagId
export const OP_COUNTER_MAX = 0x0A01; // a=maxCount, b=counterTagId
export const OP_COUNTER_LAST = 0x0A02; // a=lastCount, b=counterTagId

const KIND_LEVEL = 0;

/** Registry descriptor for `scope.register()`. Mirrors the frozen 0x0A0x channel. */
export const COUNTER_TELEMETRY_DESCRIPTOR = Object.freeze({
    name: 'counter-telemetry',
    unit: 'count',
    hz: 10,
    ops: Object.freeze([
        Object.freeze({ code: OP_COUNTER_AVG, name: 'counter.avg', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_COUNTER_MAX, name: 'counter.max', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_COUNTER_LAST, name: 'counter.last', kind: KIND_LEVEL })
    ])
});

/** packed = streamId<<16 | opcode, both u16 -> exact in f64 (and in u32). */
function sppPack(sid, op) { return ((sid << 16) | op) >>> 0; }

function defaultClock() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
}

/**
 * Create a counter-telemetry probe over a live Profiler. Call `sample()` on your
 * own cadence (the descriptor advertises 10 Hz); each call reduces every counter
 * ring to avg / max / last and emits three SPP records per counter into the sink.
 * Additive: the profiler keeps working unchanged. A profiler with no registered
 * counters emits nothing.
 *
 * The `b` slot of each record is the counter's dense tag id. By default it is the
 * profiler's own dense counter index (`profiler.counterHandle(tag)` order),
 * meaningful against `profiler.counterTags`. Pass `options.intern` (e.g. a
 * `scope.intern` bridge) to instead carry scope-interned ids, resolvable via the
 * scope's string table -- interning happens ONCE at construction, off the hot
 * path, per the block 0x01 tagId convention.
 *
 * @param {object} options
 * @param {import('./profiler.js').Profiler} options.profiler required.
 * @param {{ write:(packed:number, t:number, a:number, b:number)=>void }} options.sink required.
 * @param {number} [options.streamId=0] u16 stream id assigned by the registry.
 * @param {() => number} [options.clock] ms clock (default performance.now).
 * @param {(tag:string) => number} [options.intern] optional tag->id bridge; when
 *   absent, `b` carries the profiler's dense counter index.
 * @returns {{ sample:()=>void, dispose:()=>void, disposed:boolean }}
 */
export function createCounterProbe(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createCounterProbe: expects an options object');
    }
    const profiler = options.profiler;
    if (!profiler || typeof profiler.counterAt !== 'function' ||
        typeof profiler.counterCount !== 'number' || typeof profiler.capacity !== 'number' ||
        !Array.isArray(profiler.counterTags)) {
        throw new TypeError('createCounterProbe: options.profiler must be a lite-profiler Profiler');
    }
    const sink = options.sink;
    if (!sink || typeof sink.write !== 'function') {
        throw new TypeError('createCounterProbe: options.sink must have a write() method');
    }
    const sid = typeof options.streamId === 'number' ? options.streamId : 0;
    const clock = typeof options.clock === 'function' ? options.clock : defaultClock;
    const internFn = typeof options.intern === 'function' ? options.intern : null;

    const counterCount = profiler.counterCount;

    // Retained scratch -- allocated ONCE, reused on every sample() so the hot
    // path allocates nothing.
    const stats = new StatsMath(profiler.capacity);
    const out = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };

    // Per-counter tag id carried in the record's `b` slot. Interning (if any) is
    // done here, at construction, never on the write path. u32 ids are exact in
    // the Float64-backed slot.
    const tagIds = new Float64Array(counterCount);
    for (let i = 0; i < counterCount; i++) {
        tagIds[i] = internFn ? internFn(profiler.counterTags[i]) : i;
    }

    const pAvg = sppPack(sid, OP_COUNTER_AVG);
    const pMax = sppPack(sid, OP_COUNTER_MAX);
    const pLast = sppPack(sid, OP_COUNTER_LAST);

    let disposed = false;

    return {
        /**
         * Reduce every counter window and emit three SPP records per counter
         * (avg / max / last), grouped counter-major. Zero allocation.
         */
        sample() {
            if (disposed) return;
            const t = clock();
            for (let i = 0; i < counterCount; i++) {
                const ring = profiler.counterAt(i);
                // Zero-alloc and safe on an empty ring: StatsMath zeroes `out` at
                // count 0 and peekNewest() returns 0, matching summarize()'s zeros
                // for an unsampled counter.
                stats.compute(ring, out);
                const b = tagIds[i];
                sink.write(pAvg, t, out.avg, b);
                sink.write(pMax, t, out.max, b);
                sink.write(pLast, t, ring.peekNewest(), b);
            }
        },
        /** Release the retained scratch. Idempotent; sample() is a no-op afterward. */
        dispose() {
            if (disposed) return;
            disposed = true;
            if (typeof stats.destroy === 'function') stats.destroy();
        },
        get disposed() { return disposed; }
    };
}
