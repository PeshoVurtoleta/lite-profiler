import type { Profiler } from './profiler.js';

/** CaptureSummary schema version. */
export const SUMMARY_SCHEMA: number;

/** Default regression tolerances (fractional worsening allowed per metric). */
export const DEFAULT_TOLERANCES: Readonly<Record<string, number>>;

/** Per-phase statistics inside a CaptureSummary. */
export interface PhaseSummary {
    avg: number;
    min: number;
    max: number;
    p01: number;
    p99: number;
    /** Most recent sample. */
    last: number;
    /** Number of samples in the window. */
    count: number;
}

/** Per-counter statistics inside a CaptureSummary. */
export interface CounterSummary {
    /** Exact integer total over the window (Float64 accumulation). */
    sum: number;
    avg: number;
    min: number;
    max: number;
    p01: number;
    p99: number;
    /** Most recent per-frame value. */
    last: number;
    /** Number of frames in the window. */
    count: number;
}

/** Frame statistics inside a CaptureSummary. */
export interface FrameSummary {
    avg: number;
    min: number;
    max: number;
    p01: number;
    p99: number;
    /** Derived from avg: 1000 / avg, or 0 when avg is 0. */
    fps: number;
    /** Fraction of frames >= 16ms. */
    jankRatio: number;
    /** Fraction of frames >= 33ms. */
    spikeRatio: number;
    /** FrameClass label: 'steady' | 'spiking' | 'throttled'. */
    frameClass: string;
    /** The 7 FrameHistogram buckets. */
    bins: number[];
}

/** A small, JSON-serializable, self-describing snapshot of a Profiler window. */
export interface CaptureSummary {
    schema: number;
    /** Workload label, e.g. 'fan-out-1k'. */
    label: string | null;
    /** Engine/build label, e.g. 'lite-signal@1.4.0-beta.1'. */
    engine: string | null;
    timestamp: number;
    /** Informational frame budget in ms (not used by the fixed histogram bins). */
    budgetMs: number;
    frameCount: number;
    capacity: number;
    frame: FrameSummary;
    phases: Record<string, PhaseSummary>;
    /** Deterministic per-frame command counters (empty when none are registered). */
    counters: Record<string, CounterSummary>;
}

/** One metric's baseline/candidate values and their delta. */
export interface MetricDelta {
    base: number;
    cand: number;
    /** cand - base. */
    delta: number;
    /** (cand - base) / base, or null when base is 0. */
    pct: number | null;
}

/** Result of {@link diffCaptures}. */
export interface CaptureDiff {
    baseline: { label: string | null; engine: string | null; frameCount: number; timestamp: number };
    candidate: { label: string | null; engine: string | null; frameCount: number; timestamp: number };
    frame: Record<string, MetricDelta> & {
        frameClass: { base: string; cand: string; changed: boolean };
    };
    phases: Record<string, Record<string, MetricDelta> | { missing: 'baseline' | 'candidate' }>;
    counters: Record<string, Record<string, MetricDelta> | { missing: 'baseline' | 'candidate' }>;
}

/** One metric that worsened beyond tolerance. */
export interface Regression {
    metric: string;
    baseline: number;
    /** Candidate value, or null when the metric vanished from the candidate. */
    candidate: number | null;
    /** Fractional worsening (Infinity when the baseline was 0 or the metric vanished). */
    change: number;
    tolerance: number;
    /** Present when the regression is structural rather than a threshold breach. */
    reason?: string;
}

/** Result of {@link checkRegression}. */
export interface RegressionReport {
    ok: boolean;
    regressions: Regression[];
    diff: CaptureDiff;
}

/** Reduce a live Profiler to a CaptureSummary. */
export function summarize(
    profiler: Profiler,
    meta?: { label?: string; engine?: string; budgetMs?: number; timestamp?: number }
): CaptureSummary;

/** Reduce a decoded LiteCap to a CaptureSummary (v2 carries tags; v1 needs meta.tags). */
export function summarizeCapture(
    decoded: { count?: number; frames: Float32Array; phases: Float32Array[]; tags?: string[]; meta?: object; counters?: Float32Array[]; counterTags?: string[] },
    meta?: { label?: string; engine?: string; budgetMs?: number; timestamp?: number; tags?: string[] }
): CaptureSummary;

/** Per-metric delta between two summaries. */
export function diffCaptures(baseline: CaptureSummary, candidate: CaptureSummary): CaptureDiff;

/** Non-throwing regression check against per-metric tolerances. */
export function checkRegression(
    baseline: CaptureSummary,
    candidate: CaptureSummary,
    tolerances?: Record<string, number>
): RegressionReport;

/** CI gate: throws a RegressionError when a gated metric worsens beyond tolerance. */
export function assertNoRegression(
    baseline: CaptureSummary,
    candidate: CaptureSummary,
    tolerances?: Record<string, number>
): RegressionReport;
