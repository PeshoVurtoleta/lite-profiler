import type { Profiler } from './profiler.js';
import type { SppSink } from './probe.js';

export declare const OP_COUNTER_AVG: 0x0A00;
export declare const OP_COUNTER_MAX: 0x0A01;
export declare const OP_COUNTER_LAST: 0x0A02;

export interface CounterTelemetryOp {
    code: number;
    name: string;
    kind: number;
}

export interface CounterTelemetryDescriptor {
    name: 'counter-telemetry';
    unit: 'count';
    hz: number;
    ops: ReadonlyArray<CounterTelemetryOp>;
}

/** Registry descriptor for `scope.register()`. */
export declare const COUNTER_TELEMETRY_DESCRIPTOR: CounterTelemetryDescriptor;

export interface CreateCounterProbeOptions {
    profiler: Profiler;
    sink: SppSink;
    streamId?: number;
    clock?: () => number;
    /** Optional tag->id bridge; when absent, `b` carries the profiler's dense counter index. */
    intern?: (tag: string) => number;
}

export interface CounterProbe {
    /** Reduce every counter window and emit 3 * counterCount SPP records. Zero allocation. */
    sample(): void;
    /** Release retained scratch. Idempotent; sample() is a no-op afterward. */
    dispose(): void;
    readonly disposed: boolean;
}

/**
 * Create a counter-telemetry probe over a live Profiler, emitting the frozen SPP
 * 0x0A0x block (one "counter-telemetry" stream, avg/max/last per counter, tag id
 * in `b`) into a DI'd sink with no reactive dependency.
 */
export declare function createCounterProbe(options: CreateCounterProbeOptions): CounterProbe;
