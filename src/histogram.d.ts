/** Frame-time classification labels. */
export declare const FrameClass: {
  readonly STEADY: 'steady';
  readonly SPIKING: 'spiking';
  readonly THROTTLED: 'throttled';
};
export type FrameClassLabel = typeof FrameClass[keyof typeof FrameClass];

/** A minimal ring-buffer surface the histogram reads from. */
export interface FrameSampleSource {
  count: number;
  get(offset: number): number;
}

/** Zero-GC log-bucketed frame-time distribution with a bimodal classifier. */
export declare class FrameHistogram {
  /** Seven buckets: <2, 2-4, 4-8, 8-16, 16-33, 33-66, >=66 ms. Reused per update. */
  bins: Uint32Array;
  /** Sample count from the last update(). */
  total: number;
  /** Index of the most populated bucket. */
  modeIndex: number;

  constructor();
  update(ringBuffer: FrameSampleSource): this;
  get jankRatio(): number;
  get spikeRatio(): number;
  classify(): FrameClassLabel;
  destroy(): void;
}
