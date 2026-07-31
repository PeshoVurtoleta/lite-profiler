import type { Profiler } from './profiler.js';

export declare const OP_FPS: 0x0410;
export declare const OP_FRAME_AVG: 0x0411;
export declare const OP_FRAME_P99: 0x0412;
export declare const OP_FRAME_MAX: 0x0413;
export declare const OP_JANK: 0x0414;
export declare const OP_FRAME_CLASS: 0x0415;

/** An SPP v1 sink: fixed-width record writer, duck-typed by protocol. */
export interface SppSink {
    write(packed: number, t: number, a: number, b: number): void;
}

export interface FrameTelemetryOp {
    code: number;
    name: string;
    kind: number;
}

export interface FrameTelemetryDescriptor {
    name: 'frame-telemetry';
    unit: 'ms';
    hz: number;
    ops: ReadonlyArray<FrameTelemetryOp>;
}

/** Registry descriptor for `scope.register()`. */
export declare const FRAME_TELEMETRY_DESCRIPTOR: FrameTelemetryDescriptor;

export interface CreateFrameProbeOptions {
    profiler: Profiler;
    sink: SppSink;
    streamId?: number;
    clock?: () => number;
    regressed?: () => boolean;
}

export interface FrameProbe {
    /** Reduce the current frame window and emit six SPP records. Zero allocation. */
    sample(): void;
    /** Release retained scratch. Idempotent; sample() is a no-op afterward. */
    dispose(): void;
    readonly disposed: boolean;
}

/**
 * Create a frame-telemetry probe over a live Profiler, emitting the frozen SPP
 * 0x041x block into a DI'd sink with no reactive dependency.
 */
export declare function createFrameProbe(options: CreateFrameProbeOptions): FrameProbe;
