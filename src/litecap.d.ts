import type { Profiler } from './profiler.js';

export declare const LITECAP: {
  readonly MAGIC: 'LCAP';
  readonly VERSION: number;
  readonly HEADER_SIZE: number;
  readonly MAX_FRAMES: number;
  readonly MAX_PHASES: number;
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
}

export declare function encodeCapture(profiler: Profiler, scratch?: Float32Array | null, meta?: object | null): ArrayBuffer | null;
export declare function decodeCapture(input: ArrayBuffer | ArrayBufferView): LiteCapData;
export declare function downloadCapture(buffer: ArrayBuffer, filename?: string): void;
