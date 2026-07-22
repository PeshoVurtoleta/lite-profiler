/**
 * @zakkster/lite-profiler — TimelineRecorder (v1.3.0)
 * Opt-in absolute-timestamp capture: t0/t1 span pairs, frame boundaries, instant marks.
 * Its own Float64 rings — the shared RingBuffer is Float32 and cannot hold absolute time.
 */

/** A raw Float64 ring exposed by the recorder. copyTo unwinds oldest-first. */
export interface F64Ring {
    readonly capacity: number;
    readonly count: number;
    copyTo(dst: Float64Array | number[], dstOffset?: number): number;
    reset(): void;
    destroy(): void;
}

export declare class TimelineRecorder {
    /**
     * @param capacity    samples per ring; rounded up to a power of two.
     * @param spanTags    static span lane tags, e.g. ['physics','render'].
     * @param instantTags static instant lane tags, e.g. ['gc','input'].
     */
    constructor(capacity?: number, spanTags?: string[], instantTags?: string[]);

    readonly capacity: number;
    readonly spanTags: string[];
    readonly instantTags: string[];
    readonly spanLaneCount: number;
    readonly instantLaneCount: number;
    readonly frameCount: number;

    spanHandle(tag: string): number;
    instantHandle(tag: string): number;

    recordFrameBoundary(t?: number): void;

    beginSpan(tag: string, t0?: number): void;
    beginSpanAt(handle: number, t0?: number): void;
    endSpan(tag: string, t1?: number): void;
    endSpanAt(handle: number, t1?: number): void;

    mark(tag: string, t?: number): void;
    markAt(handle: number, t?: number): void;

    readonly frameBoundaries: F64Ring;
    spanT0(tag: string): F64Ring | null;
    spanT1(tag: string): F64Ring | null;
    spanT0At(handle: number): F64Ring | null;
    spanT1At(handle: number): F64Ring | null;
    instantTime(tag: string): F64Ring | null;
    instantTimeAt(handle: number): F64Ring | null;

    reset(): void;
    destroy(): void;
}
