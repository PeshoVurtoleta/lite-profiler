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
}

export declare function encodeCapture(profiler: Profiler, scratch?: Float32Array | null): ArrayBuffer | null;
export declare function decodeCapture(input: ArrayBuffer | ArrayBufferView): LiteCapData;
export declare function downloadCapture(buffer: ArrayBuffer, filename?: string): void;
