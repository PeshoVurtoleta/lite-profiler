export { Profiler } from './src/profiler.js';
export { FrameHistogram, FrameClass } from './src/histogram.js';
export type { FrameClassLabel, FrameSampleSource } from './src/histogram.js';
export { encodeCapture, decodeCapture, downloadCapture, LITECAP } from './src/litecap.js';
export type { LiteCapData } from './src/litecap.js';
export { FrameBudget, budgetMs, isOverBudget } from './src/presets.js';
export { MeterHud } from './src/hud.js';
export type { MeterHudOptions } from './src/hud.js';
export {
    summarize, summarizeCapture, diffCaptures, checkRegression, assertNoRegression,
    DEFAULT_TOLERANCES, SUMMARY_SCHEMA
} from './src/compare.js';
export type {
    CaptureSummary, FrameSummary, PhaseSummary, CounterSummary, MetricDelta, CaptureDiff,
    Regression, RegressionReport
} from './src/compare.js';
