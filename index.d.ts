export { Profiler } from './src/profiler.js';
export { FrameHistogram, FrameClass } from './src/histogram.js';
export type { FrameClassLabel, FrameSampleSource } from './src/histogram.js';
export { encodeCapture, decodeCapture, downloadCapture, LITECAP } from './src/litecap.js';
export type { LiteCapData } from './src/litecap.js';
export { FrameBudget, budgetMs, isOverBudget } from './src/presets.js';
export { MeterHud } from './src/hud.js';
export type { MeterHudOptions } from './src/hud.js';
