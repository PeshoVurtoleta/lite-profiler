import type { Profiler } from './profiler.js';
import type { SppSink } from './probe.js';

export declare const OP_PHASE_AVG: 0x0900;
export declare const OP_PHASE_P99: 0x0901;
export declare const OP_PHASE_MAX: 0x0902;

export interface PhaseTelemetryOp {
    code: number;
    name: string;
    kind: number;
}

export interface PhaseTelemetryDescriptor {
    name: 'phase-telemetry';
    unit: 'ms';
    hz: number;
    ops: ReadonlyArray<PhaseTelemetryOp>;
}

/** Registry descriptor for `scope.register()`. */
export declare const PHASE_TELEMETRY_DESCRIPTOR: PhaseTelemetryDescriptor;

export interface CreatePhaseProbeOptions {
    profiler: Profiler;
    sink: SppSink;
    streamId?: number;
    clock?: () => number;
    /** Optional tag->id bridge; when absent, `b` carries the profiler's dense phase index. */
    intern?: (tag: string) => number;
}

export interface PhaseProbe {
    /** Reduce every phase window and emit 3 * phaseCount SPP records. Zero allocation. */
    sample(): void;
    /** Release retained scratch. Idempotent; sample() is a no-op afterward. */
    dispose(): void;
    readonly disposed: boolean;
}

/**
 * Create a phase-telemetry probe over a live Profiler, emitting the frozen SPP
 * 0x090x block (one "phase-telemetry" stream, avg/p99/max per phase, tag id in
 * `b`) into a DI'd sink with no reactive dependency.
 */
export declare function createPhaseProbe(options: CreatePhaseProbeOptions): PhaseProbe;
