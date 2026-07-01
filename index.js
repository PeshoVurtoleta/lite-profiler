export { Profiler } from './src/profiler.js';
export { FrameHistogram, FrameClass } from './src/histogram.js';
export { encodeCapture, decodeCapture, downloadCapture, LITECAP } from './src/litecap.js';
export { FrameBudget, budgetMs, isOverBudget } from './src/presets.js';
export { MeterHud } from './src/hud.js';
export {
    summarize, summarizeCapture, diffCaptures, checkRegression, assertNoRegression,
    DEFAULT_TOLERANCES, SUMMARY_SCHEMA
} from './src/compare.js';
