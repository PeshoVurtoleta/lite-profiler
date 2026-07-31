export { Profiler } from './src/profiler.js';
export { TimelineRecorder } from './src/timeline.js';
export { FrameHistogram, FrameClass } from './src/histogram.js';
export { encodeCapture, decodeCapture, encodeTimelineCapture, downloadCapture, LITECAP } from './src/litecap.js';
export { exportChromeTrace } from './src/trace.js';
export {
    createFrameProbe, FRAME_TELEMETRY_DESCRIPTOR,
    OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS
} from './src/probe.js';
export {
    createPhaseProbe, PHASE_TELEMETRY_DESCRIPTOR,
    OP_PHASE_AVG, OP_PHASE_P99, OP_PHASE_MAX
} from './src/phase-probe.js';
export { FrameBudget, budgetMs, isOverBudget } from './src/presets.js';
export { MeterHud } from './src/hud.js';
export {
    summarize, summarizeCapture, diffCaptures, checkRegression, assertNoRegression,
    DEFAULT_TOLERANCES, SUMMARY_SCHEMA
} from './src/compare.js';
