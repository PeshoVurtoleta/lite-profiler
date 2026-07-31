/**
 * @zakkster/lite-profiler
 *
 * SPP phase-telemetry probe for the standalone Profiler.
 *
 * The Scope Probe Protocol (SPP, frozen in @zakkster/lite-scope) lets the
 * profiler suite share one wire format: every probe emits fixed-width records
 * into an INJECTED sink, and no probe imports another package. `createFrameProbe`
 * streams the whole-frame channel (block 0x041x); `createPhaseProbe` is its
 * per-phase sibling. It reduces every registered phase ring to avg / p99 / max
 * and emits them on the frozen 0x090x block, one "phase-telemetry" stream, with
 * the phase's tag id riding the record's `b` slot.
 *
 * Block 0x09 is owned by lite-scope (protocol home, v1.1.0) and produced only
 * here. The opcodes below are inlined PROTOCOL FACTS -- lite-scope is a test-only
 * devDependency; `src/` imports nothing from it, because probes couple by
 * protocol, never by dependency.
 *
 * Zero-GC: the percentile scratch (`StatsMath`), the reusable `out` object, and
 * the per-phase tag-id table are all allocated once at construction and reused on
 * every `sample()`; a sample emits 3 * phaseCount records and allocates nothing.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { StatsMath } from '@zakkster/lite-stats-math';

// SPP v1 phase-telemetry opcode block (0x090x). These are PROTOCOL FACTS,
// inlined to match @zakkster/lite-scope block 0x09 (PROTOCOL.md) exactly --
// not imported, because probes couple by protocol, never by dependency.
export const OP_PHASE_AVG = 0x0900; // a=avgMs, b=phaseTagId
export const OP_PHASE_P99 = 0x0901; // a=p99Ms, b=phaseTagId
export const OP_PHASE_MAX = 0x0902; // a=maxMs, b=phaseTagId

const KIND_LEVEL = 0;

/** Registry descriptor for `scope.register()`. Mirrors the frozen 0x090x channel. */
export const PHASE_TELEMETRY_DESCRIPTOR = Object.freeze({
    name: 'phase-telemetry',
    unit: 'ms',
    hz: 10,
    ops: Object.freeze([
        Object.freeze({ code: OP_PHASE_AVG, name: 'phase.avg', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_PHASE_P99, name: 'phase.p99', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_PHASE_MAX, name: 'phase.max', kind: KIND_LEVEL })
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
 * Create a phase-telemetry probe over a live Profiler. Call `sample()` on your
 * own cadence (the descriptor advertises 10 Hz); each call reduces every phase
 * ring to avg / p99 / max and emits three SPP records per phase into the sink.
 * Additive: the profiler keeps working unchanged. A profiler with no registered
 * phases emits nothing.
 *
 * The `b` slot of each record is the phase's dense tag id. By default it is the
 * profiler's own dense phase index (`profiler.handle(tag)` order), meaningful
 * against `profiler.phaseTags`. Pass `options.intern` (e.g. a `scope.intern`
 * bridge) to instead carry scope-interned ids, resolvable via the scope's string
 * table -- interning happens ONCE at construction, off the hot path, per the
 * block 0x01 tagId convention.
 *
 * @param {object} options
 * @param {import('./profiler.js').Profiler} options.profiler required.
 * @param {{ write:(packed:number, t:number, a:number, b:number)=>void }} options.sink required.
 * @param {number} [options.streamId=0] u16 stream id assigned by the registry.
 * @param {() => number} [options.clock] ms clock (default performance.now).
 * @param {(tag:string) => number} [options.intern] optional tag->id bridge; when
 *   absent, `b` carries the profiler's dense phase index.
 * @returns {{ sample:()=>void, dispose:()=>void, disposed:boolean }}
 */
export function createPhaseProbe(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createPhaseProbe: expects an options object');
    }
    const profiler = options.profiler;
    if (!profiler || typeof profiler.phaseAt !== 'function' ||
        typeof profiler.phaseCount !== 'number' || typeof profiler.capacity !== 'number' ||
        !Array.isArray(profiler.phaseTags)) {
        throw new TypeError('createPhaseProbe: options.profiler must be a lite-profiler Profiler');
    }
    const sink = options.sink;
    if (!sink || typeof sink.write !== 'function') {
        throw new TypeError('createPhaseProbe: options.sink must have a write() method');
    }
    const sid = typeof options.streamId === 'number' ? options.streamId : 0;
    const clock = typeof options.clock === 'function' ? options.clock : defaultClock;
    const internFn = typeof options.intern === 'function' ? options.intern : null;

    const phaseCount = profiler.phaseCount;

    // Retained scratch -- allocated ONCE, reused on every sample() so the hot
    // path allocates nothing.
    const stats = new StatsMath(profiler.capacity);
    const out = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };

    // Per-phase tag id carried in the record's `b` slot. Interning (if any) is
    // done here, at construction, never on the write path. u32 ids are exact in
    // the Float64-backed slot.
    const tagIds = new Float64Array(phaseCount);
    for (let i = 0; i < phaseCount; i++) {
        tagIds[i] = internFn ? internFn(profiler.phaseTags[i]) : i;
    }

    const pAvg = sppPack(sid, OP_PHASE_AVG);
    const pP99 = sppPack(sid, OP_PHASE_P99);
    const pMax = sppPack(sid, OP_PHASE_MAX);

    let disposed = false;

    return {
        /**
         * Reduce every phase window and emit three SPP records per phase
         * (avg / p99 / max), grouped phase-major. Zero allocation.
         */
        sample() {
            if (disposed) return;
            const t = clock();
            for (let i = 0; i < phaseCount; i++) {
                const ring = profiler.phaseAt(i);
                // Zero-alloc and safe on an empty ring: StatsMath zeroes `out` at
                // count 0, matching summarize()'s zeros for an unsampled phase.
                stats.compute(ring, out);
                const b = tagIds[i];
                sink.write(pAvg, t, out.avg, b);
                sink.write(pP99, t, out.p99, b);
                sink.write(pMax, t, out.max, b);
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
