import type { Profiler } from './profiler.js';

export declare const LITECAP: {
  readonly MAGIC: 'LCAP';
  readonly VERSION: number;
  readonly HEADER_SIZE: number;
  readonly MAX_FRAMES: number;
  readonly MAX_PHASES: number;
  readonly MAX_COUNTERS: number;
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
}

export declare function encodeCapture(profiler: Profiler, scratch?: Float32Array | null, meta?: object | null): ArrayBuffer | null;
export declare function decodeCapture(input: ArrayBuffer | ArrayBufferView): LiteCapData;
export declare function downloadCapture(buffer: ArrayBuffer, filename?: string): void;
