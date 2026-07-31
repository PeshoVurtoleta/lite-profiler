/**
 * @zakkster/lite-profiler
 *
 * SPP frame-telemetry probe for the standalone Profiler.
 *
 * The Scope Probe Protocol (SPP, frozen in @zakkster/lite-scope) lets the
 * profiler suite share one wire format: every probe emits fixed-width records
 * into an INJECTED sink, and no probe imports another package. The suite's
 * frame-telemetry channel (opcode block 0x041x) was previously reachable only
 * through the REACTIVE bridge (`lite-profiler-signal` + a `lite-signal` peer +
 * `lite-throttle` + `lite-watch-ex`). `createFrameProbe` is the direct path: a
 * plain `Profiler` becomes an oscilloscope channel with nothing but this package
 * and a DI'd sink -- for headless / CI / non-reactive apps.
 *
 * It reuses the FROZEN 0x0410-0x0415 opcodes so a core-profiler stream drops
 * straight onto the existing CHANNELS scene and the suite gate. This is a second
 * PRODUCER of a shared channel, not a new block: an app runs the reactive probe
 * OR this one, never both for the same profiler.
 *
 * Zero-GC: the percentile + classifier scratch (`StatsMath`, `FrameHistogram`)
 * is allocated once at construction and reused on every `sample()`; a sample
 * emits six records and allocates nothing.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { StatsMath } from '@zakkster/lite-stats-math';
import { FrameHistogram, FrameClass } from './histogram.js';

// SPP v1 frame-telemetry opcode block (0x041x). These are PROTOCOL FACTS,
// inlined to match PROTOCOL.md and the lite-profiler-signal producer exactly --
// not imported, because probes couple by protocol, never by dependency.
export const OP_FPS = 0x0410;         // a=fps,        b=0
export const OP_FRAME_AVG = 0x0411;   // a=avgMs,      b=0
export const OP_FRAME_P99 = 0x0412;   // a=p99Ms,      b=0
export const OP_FRAME_MAX = 0x0413;   // a=maxMs,      b=0
export const OP_JANK = 0x0414;        // a=jankRatio,  b=spikeRatio
export const OP_FRAME_CLASS = 0x0415; // a=classEnum,  b=regressed(0|1)

const KIND_LEVEL = 0;

/**
 * Numeric class enum for OP_FRAME_CLASS's `a` slot, in severity order. SPP
 * records are four f64 slots, so the classifier's string label is mapped to a
 * number here (steady=0, spiking=1, throttled=2).
 */
const CLASS_ENUM = Object.freeze({
    [FrameClass.STEADY]: 0,
    [FrameClass.SPIKING]: 1,
    [FrameClass.THROTTLED]: 2
});

/** Registry descriptor for `scope.register()`. Mirrors the shared 0x041x channel. */
export const FRAME_TELEMETRY_DESCRIPTOR = Object.freeze({
    name: 'frame-telemetry',
    unit: 'ms',
    hz: 10,
    ops: Object.freeze([
        Object.freeze({ code: OP_FPS, name: 'fps', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_FRAME_AVG, name: 'frame.avg', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_FRAME_P99, name: 'frame.p99', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_FRAME_MAX, name: 'frame.max', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_JANK, name: 'jank', kind: KIND_LEVEL }),
        Object.freeze({ code: OP_FRAME_CLASS, name: 'frame.class', kind: KIND_LEVEL })
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
 * Create a frame-telemetry probe over a live Profiler. Call `sample()` on your
 * own cadence (the descriptor advertises 10 Hz); each call reduces the frame
 * ring to fps / avg / p99 / max / jank / class and emits six SPP records into
 * the sink. Additive: the profiler keeps working unchanged.
 *
 * @param {object} options
 * @param {import('./profiler.js').Profiler} options.profiler required.
 * @param {{ write:(packed:number, t:number, a:number, b:number)=>void }} options.sink required.
 * @param {number} [options.streamId=0] u16 stream id assigned by the registry.
 * @param {() => number} [options.clock] ms clock (default performance.now).
 * @param {() => boolean} [options.regressed] optional predicate for the
 *   OP_FRAME_CLASS `b` slot; a bare Profiler has no baseline, so it defaults to 0.
 * @returns {{ sample:()=>void, dispose:()=>void, disposed:boolean }}
 */
export function createFrameProbe(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createFrameProbe: expects an options object');
    }
    const profiler = options.profiler;
    if (!profiler || !profiler.frame || typeof profiler.frame.count !== 'number' ||
        typeof profiler.capacity !== 'number') {
        throw new TypeError('createFrameProbe: options.profiler must be a lite-profiler Profiler');
    }
    const sink = options.sink;
    if (!sink || typeof sink.write !== 'function') {
        throw new TypeError('createFrameProbe: options.sink must have a write() method');
    }
    const sid = typeof options.streamId === 'number' ? options.streamId : 0;
    const clock = typeof options.clock === 'function' ? options.clock : defaultClock;
    const regressedFn = typeof options.regressed === 'function' ? options.regressed : null;

    // Retained scratch -- allocated ONCE, reused on every sample() so the hot
    // path allocates nothing.
    const stats = new StatsMath(profiler.capacity);
    const hist = new FrameHistogram();
    const out = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };

    const pFps = sppPack(sid, OP_FPS);
    const pAvg = sppPack(sid, OP_FRAME_AVG);
    const pP99 = sppPack(sid, OP_FRAME_P99);
    const pMax = sppPack(sid, OP_FRAME_MAX);
    const pJank = sppPack(sid, OP_JANK);
    const pClass = sppPack(sid, OP_FRAME_CLASS);

    let disposed = false;

    return {
        /** Reduce the current frame window and emit six SPP records. Zero allocation. */
        sample() {
            if (disposed) return;
            const ring = profiler.frame;
            const t = clock();
            // Both are zero-alloc and safe on an empty ring (StatsMath zeroes `out`
            // at count 0; the histogram classifies an empty window as STEADY).
            stats.compute(ring, out);
            hist.update(ring);
            const fps = out.avg > 0 ? 1000 / out.avg : 0;
            sink.write(pFps, t, fps, 0);
            sink.write(pAvg, t, out.avg, 0);
            sink.write(pP99, t, out.p99, 0);
            sink.write(pMax, t, out.max, 0);
            sink.write(pJank, t, hist.jankRatio, hist.spikeRatio);
            sink.write(pClass, t, CLASS_ENUM[hist.classify()], (regressedFn && regressedFn()) ? 1 : 0);
        },
        /** Release the retained scratch. Idempotent; sample() is a no-op afterward. */
        dispose() {
            if (disposed) return;
            disposed = true;
            hist.destroy();
            if (typeof stats.destroy === 'function') stats.destroy();
        },
        get disposed() { return disposed; }
    };
}
