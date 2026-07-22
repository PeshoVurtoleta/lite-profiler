import type { Profiler } from './profiler.js';

export declare const LITECAP: {
  readonly MAGIC: 'LCAP';
  readonly VERSION: number;
  readonly HEADER_SIZE: number;
  readonly MAX_FRAMES: number;
  readonly MAX_PHASES: number;
  readonly MAX_COUNTERS: number;
  readonly MAX_SPAN_LANES: number;
  readonly MAX_INSTANT_LANES: number;
  readonly MAX_TIMELINE_SAMPLES: number;
};

export interface LiteCapData {
  version: number;
  count: number;
  numPhases: number;
  frames: Float32Array;
  phases: Float32Array[];
  /** Phase tags in registration order (v2; empty array for v1). */
  tags: string[];
  /** Embedded metadata (v2; null for v1 or when none was written). */
  meta: object | null;
  /** Per-counter sample arrays (v3; empty for v1/v2). */
  counters: Float32Array[];
  /** Counter tags in registration order (v3; empty for v1/v2). */
  counterTags: string[];
    // v4 timeline (null / [] when the capture is < v4)
    frameBoundaries: Float64Array | null;
    spanTags: string[];
    spanT0: Float64Array[];
    spanT1: Float64Array[];
    instantTags: string[];
    instantTimes: Float64Array[];
}

export declare function decodeCapture(input: ArrayBuffer | ArrayBufferView): LiteCapData;
export declare function downloadCapture(buffer: ArrayBuffer, filename?: string): void;

import type { TimelineRecorder } from './timeline.js';

/**
 * Serialize a profiler, optionally with a TimelineRecorder. When the recorder
 * carries data the capture is emitted as v4 (timeline trailer); otherwise the
 * version and bytes are unchanged. A timeline-free capture stays byte-identical
 * to v2/v3, so older readers are unaffected.
 */
export declare function encodeCapture(
    profiler: import('./profiler.js').Profiler,
    scratch?: Float32Array | null,
    meta?: object | null,
    timeline?: TimelineRecorder | null,
): ArrayBuffer | null;

/** Serialize only a TimelineRecorder (standalone v4). Null when it holds no data. */
export declare function encodeTimelineCapture(
    timeline: TimelineRecorder,
    meta?: object | null,
): ArrayBuffer | null;
