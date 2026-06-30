import type { RingBuffer } from '@zakkster/lite-ring-buffer';

/** Zero-GC frame and per-phase timing capture. */
export declare class Profiler {
  /** Total-frame-time ring buffer. */
  frameBuffer: RingBuffer;
  /** Actual (power-of-two) capacity of every buffer. */
  capacity: number;
  /** Registered phase tags, in handle order. */
  phaseTags: string[];
  /** Per-phase ring buffers, in handle order. */
  phaseBuffers: RingBuffer[];

  constructor(capacity?: number, phases?: string[]);

  get phaseCount(): number;
  /** Resolve a tag to a stable integer handle, or -1 if unknown. */
  handle(tag: string): number;
  tagOf(handle: number): string | null;

  beginFrame(): void;
  endFrame(): void;
  begin(tag: string): void;
  end(tag: string): void;
  beginAt(handle: number): void;
  endAt(handle: number): void;

  get frame(): RingBuffer;
  phase(tag: string): RingBuffer | null;
  phaseAt(handle: number): RingBuffer | null;

  reset(): void;
  destroy(): void;
}
