import type { Profiler } from './profiler.js';

export interface MeterHudOptions {
  width?: number;
  height?: number;
  maxMs?: number;
  decimate?: boolean;
  readout?: boolean;
  stroke?: string;
  background?: string;
  dpr?: number;
}

/** Minimal CPU overlay rendering a Profiler's frame-time envelope. */
export declare class MeterHud {
  profiler: Profiler;
  maxMs: number;
  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    profiler: Profiler,
    options?: MeterHudOptions
  );
  setMaxMs(ms: number): void;
  render(): void;
  resize(width: number, height: number): void;
  destroy(): void;
}
