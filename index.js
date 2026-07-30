export { Profiler } from './src/profiler.js';
export { TimelineRecorder } from './src/timeline.js';
export { FrameHistogram, FrameClass } from './src/histogram.js';
export { encodeCapture, decodeCapture, encodeTimelineCapture, downloadCapture, LITECAP } from './src/litecap.js';
export { exportChromeTrace } from './src/trace.js';
export { FrameBudget, budgetMs, isOverBudget } from './src/presets.js';
export { MeterHud } from './src/hud.js';
export {
    summarize, summarizeCapture, diffCaptures, checkRegression, assertNoRegression,
    DEFAULT_TOLERANCES, SUMMARY_SCHEMA
} from './src/compare.js';
