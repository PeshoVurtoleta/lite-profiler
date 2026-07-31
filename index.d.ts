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
export { TimelineRecorder } from './src/timeline.js';
export type { F64Ring } from './src/timeline.js';
export { encodeTimelineCapture } from './src/litecap.js';
export { exportChromeTrace } from './src/trace.js';
export type { ChromeTrace, ChromeTraceEvent, ExportChromeTraceOptions } from './src/trace.js';
export {
    createFrameProbe, FRAME_TELEMETRY_DESCRIPTOR,
    OP_FPS, OP_FRAME_AVG, OP_FRAME_P99, OP_FRAME_MAX, OP_JANK, OP_FRAME_CLASS
} from './src/probe.js';
export type {
    SppSink, FrameTelemetryDescriptor, FrameTelemetryOp,
    CreateFrameProbeOptions, FrameProbe
} from './src/probe.js';
