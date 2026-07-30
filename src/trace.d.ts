import type { LiteCapData } from './litecap.js';

/** A single Chrome Trace Event (subset emitted by exportChromeTrace). */
export interface ChromeTraceEvent {
    ph: 'X' | 'i' | 'M';
    name: string;
    pid: number;
    tid?: number;
    ts?: number;
    dur?: number;
    s?: 't' | 'p' | 'g';
    args?: Record<string, unknown>;
}

/** Chrome Trace Event Format object, loadable in Perfetto / chrome://tracing. */
export interface ChromeTrace {
    traceEvents: ChromeTraceEvent[];
    displayTimeUnit: 'ms';
    metadata: {
        source: string;
        litecapVersion: number;
        normalized: boolean;
        captureMeta: object | null;
    };
}

export interface ExportChromeTraceOptions {
    /** Zero-base every timestamp to the earliest event (default: false). */
    normalize?: boolean;
    /** Override the process label (default: capture meta.label or a generic name). */
    processName?: string;
}

/**
 * Convert a decoded LiteCap v4 capture into a Chrome Trace Event object.
 * Throws if the capture carries no timeline data (v2/v3) — durations alone
 * cannot place spans on an absolute clock.
 */
export declare function exportChromeTrace(
    decoded: LiteCapData,
    opts?: ExportChromeTraceOptions
): ChromeTrace;
