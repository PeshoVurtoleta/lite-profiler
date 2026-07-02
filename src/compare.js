/**
 * @zakkster/lite-profiler
 *
 * Capture comparison + regression gating. `summarize()` reduces a Profiler's
 * rolling buffers to a small, self-describing, JSON-friendly CaptureSummary;
 * `diffCaptures()` reports per-metric deltas between two summaries; and
 * `assertNoRegression()` turns a summary pair into a CI gate.
 *
 * Engine-agnostic on purpose: nothing here knows about reactivity. It verifies
 * any frame loop, which is what makes it the instrument for comparing one
 * workload across builds -- e.g. the same reactive graph profiled under
 * lite-signal 1.3.0 vs 1.4.0 vs 1.7.0. Correctness suites say "still correct";
 * this says "still fast."
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { RingBuffer } from '@zakkster/lite-ring-buffer';
import { StatsMath } from '@zakkster/lite-stats-math';
import { FrameHistogram, FrameClass } from './histogram.js';

/** CaptureSummary schema version. */
export const SUMMARY_SCHEMA = 2;   // v2 adds the optional `counters` block

/** 60fps frame budget in ms; the default recorded in a summary's metadata. */
const BUDGET_60 = 1000 / 60;

/**
 * Default regression tolerances: the fractional worsening allowed per metric
 * before assertNoRegression() fails. Frame average and p99 gated at +10%.
 */
export const DEFAULT_TOLERANCES = Object.freeze({
    'frame.avg': 0.10,
    'frame.p99': 0.10
});

const FRAME_METRICS = ['avg', 'min', 'max', 'p01', 'p99', 'fps', 'jankRatio', 'spikeRatio'];
const PHASE_METRICS = ['avg', 'min', 'max', 'p01', 'p99', 'last'];
const COUNTER_METRICS = ['sum', 'avg', 'min', 'max', 'p01', 'p99', 'last'];

function emptyFrame() {
    return {
        avg: 0, min: 0, max: 0, p01: 0, p99: 0, fps: 0,
        jankRatio: 0, spikeRatio: 0, frameClass: FrameClass.STEADY,
        bins: [0, 0, 0, 0, 0, 0, 0]
    };
}

function summarizeRings(frameRing, phaseRings, tags, counterRings, counterTags, capacity, meta) {
    const stats = new StatsMath(capacity);
    const hist = new FrameHistogram();
    const fOut = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };
    const pOut = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };
    const frameCount = frameRing.count;

    let frame;
    if (frameCount > 0) {
        stats.compute(frameRing, fOut);
        hist.update(frameRing);
        frame = {
            avg: fOut.avg, min: fOut.min, max: fOut.max, p01: fOut.p01, p99: fOut.p99,
            fps: fOut.avg > 0 ? 1000 / fOut.avg : 0,
            jankRatio: hist.jankRatio,
            spikeRatio: hist.spikeRatio,
            frameClass: hist.classify(),
            bins: Array.prototype.slice.call(hist.bins)
        };
    } else {
        frame = emptyFrame();
    }

    const phases = {};
    for (let i = 0; i < tags.length; i++) {
        const ring = phaseRings[i];
        const c = ring ? ring.count : 0;
        if (c > 0) {
            stats.compute(ring, pOut);
            phases[tags[i]] = {
                avg: pOut.avg, min: pOut.min, max: pOut.max, p01: pOut.p01, p99: pOut.p99,
                last: ring.peekNewest(), count: c
            };
        } else {
            phases[tags[i]] = { avg: 0, min: 0, max: 0, p01: 0, p99: 0, last: 0, count: 0 };
        }
    }

    // Counters: same reduction plus an exact integer sum (Float64 accumulation over the
    // ring; exact well past 2^24 as long as each per-frame value is < 2^24). Off the hot
    // path, so a lazy scratch alloc here is fine.
    const counters = {};
    const cOut = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };
    let sumScratch = null;
    for (let i = 0; i < counterTags.length; i++) {
        const ring = counterRings[i];
        const c = ring ? ring.count : 0;
        if (c > 0) {
            stats.compute(ring, cOut);
            if (sumScratch === null) sumScratch = new Float64Array(capacity);
            const nn = ring.copyTo(sumScratch, 0);
            let sum = 0;
            for (let j = 0; j < nn; j++) sum += sumScratch[j];
            counters[counterTags[i]] = {
                sum, avg: cOut.avg, min: cOut.min, max: cOut.max, p01: cOut.p01, p99: cOut.p99,
                last: ring.peekNewest(), count: c
            };
        } else {
            counters[counterTags[i]] = { sum: 0, avg: 0, min: 0, max: 0, p01: 0, p99: 0, last: 0, count: 0 };
        }
    }

    hist.destroy();
    if (typeof stats.destroy === 'function') stats.destroy();

    return {
        schema: SUMMARY_SCHEMA,
        label: (meta && meta.label != null) ? String(meta.label) : null,
        engine: (meta && meta.engine != null) ? String(meta.engine) : null,
        timestamp: (meta && meta.timestamp != null) ? meta.timestamp : Date.now(),
        budgetMs: (meta && meta.budgetMs != null) ? meta.budgetMs : BUDGET_60,
        frameCount,
        capacity,
        frame,
        phases,
        counters
    };
}

/**
 * Reduce a live Profiler to a CaptureSummary.
 * @param {import('./profiler.js').Profiler} profiler
 * @param {{label?:string, engine?:string, budgetMs?:number, timestamp?:number}} [meta]
 * @returns {object} a JSON-serializable CaptureSummary
 */
export function summarize(profiler, meta = null) {
    if (!profiler || typeof profiler.phase !== 'function' || !profiler.frame) {
        throw new TypeError('summarize: a lite-profiler Profiler instance is required');
    }
    const tags = profiler.phaseTags ? profiler.phaseTags.slice() : [];
    const phaseRings = new Array(tags.length);
    for (let i = 0; i < tags.length; i++) phaseRings[i] = profiler.phase(tags[i]);
    const cTags = profiler.counterTags ? profiler.counterTags.slice() : [];
    const counterRings = new Array(cTags.length);
    for (let i = 0; i < cTags.length; i++) counterRings[i] = profiler.counter(cTags[i]);
    return summarizeRings(profiler.frame, phaseRings, tags, counterRings, cTags, profiler.capacity, meta);
}

function arrToRing(arr, capacity) {
    const rb = new RingBuffer(capacity);
    for (let i = 0; i < arr.length; i++) rb.push(arr[i]); // oldest-first in -> newest last
    return rb;
}

/**
 * Reduce a decoded LiteCap to a CaptureSummary. A v2 capture carries its phase
 * tags; a v1 capture does not, so pass `{ tags }` in meta to name the phases.
 * @param {{count?:number, frames:Float32Array, phases:Float32Array[], tags?:string[], meta?:object}} decoded
 * @param {{label?:string, engine?:string, budgetMs?:number, timestamp?:number, tags?:string[]}} [meta]
 * @returns {object} a CaptureSummary
 */
export function summarizeCapture(decoded, meta = null) {
    if (!decoded || !decoded.frames || !Array.isArray(decoded.phases)) {
        throw new TypeError('summarizeCapture: expected a decoded LiteCap');
    }
    const count = decoded.count != null ? decoded.count : decoded.frames.length;
    const tags = (decoded.tags && decoded.tags.length) ? decoded.tags.slice()
        : (meta && meta.tags && meta.tags.length) ? meta.tags.slice()
            : decoded.phases.map((_unused, i) => 'phase' + i);
    const cap = Math.max(1, count);
    const frameRing = arrToRing(decoded.frames, cap);
    const phaseRings = decoded.phases.map((a) => arrToRing(a, cap));
    const counterArrs = decoded.counters || [];
    const cTags = (decoded.counterTags && decoded.counterTags.length) ? decoded.counterTags.slice()
        : counterArrs.map((_u, i) => 'counter' + i);
    const counterRings = counterArrs.map((a) => arrToRing(a, cap));
    // fold the capture's own embedded meta in as a fallback
    const merged = Object.assign({}, decoded.meta || null, meta || null);
    return summarizeRings(frameRing, phaseRings, tags, counterRings, cTags, cap, merged);
}

function delta(base, cand) {
    const d = cand - base;
    let pct;
    if (base === 0) pct = (cand === 0) ? 0 : null;   // null: percentage undefined from a zero baseline
    else pct = d / base;
    return { base, cand, delta: d, pct };
}

function metaOf(s) {
    return { label: s.label, engine: s.engine, frameCount: s.frameCount, timestamp: s.timestamp };
}

/**
 * Per-metric delta between two CaptureSummary objects. `delta > 0` means the
 * candidate's value rose; interpret direction per metric (lower is better for
 * frame times / jank / spike, higher is better for fps).
 * @param {object} baseline @param {object} candidate
 * @returns {object} a CaptureDiff
 */
export function diffCaptures(baseline, candidate) {
    if (!baseline || !candidate || !baseline.frame || !candidate.frame) {
        throw new TypeError('diffCaptures: expected two CaptureSummary objects');
    }
    const frame = {};
    for (let i = 0; i < FRAME_METRICS.length; i++) {
        const k = FRAME_METRICS[i];
        frame[k] = delta(baseline.frame[k] || 0, candidate.frame[k] || 0);
    }
    frame.frameClass = {
        base: baseline.frame.frameClass,
        cand: candidate.frame.frameClass,
        changed: baseline.frame.frameClass !== candidate.frame.frameClass
    };

    const phases = {};
    const tags = {};
    for (const t in baseline.phases) tags[t] = true;
    for (const t in candidate.phases) tags[t] = true;
    for (const t in tags) {
        const b = baseline.phases[t], c = candidate.phases[t];
        if (!b || !c) { phases[t] = { missing: b ? 'candidate' : 'baseline' }; continue; }
        const row = {};
        for (let i = 0; i < PHASE_METRICS.length; i++) {
            const k = PHASE_METRICS[i];
            row[k] = delta(b[k] || 0, c[k] || 0);
        }
        phases[t] = row;
    }

    const counters = {};
    const ctags = {};
    for (const t in (baseline.counters || {})) ctags[t] = true;
    for (const t in (candidate.counters || {})) ctags[t] = true;
    for (const t in ctags) {
        const b = baseline.counters ? baseline.counters[t] : null;
        const c = candidate.counters ? candidate.counters[t] : null;
        if (!b || !c) { counters[t] = { missing: b ? 'candidate' : 'baseline' }; continue; }
        const row = {};
        for (let i = 0; i < COUNTER_METRICS.length; i++) {
            const k = COUNTER_METRICS[i];
            row[k] = delta(b[k] || 0, c[k] || 0);
        }
        counters[t] = row;
    }
    return { baseline: metaOf(baseline), candidate: metaOf(candidate), frame, phases, counters };
}

function higherIsBetter(path) { return path === 'frame.fps' || path.endsWith('.fps'); }

function readMetric(summary, path) {
    const parts = path.split('.');
    if (parts[0] === 'frame') return summary.frame ? summary.frame[parts[1]] : undefined;
    if (parts[0] === 'phase') {
        const ph = summary.phases ? summary.phases[parts[1]] : null;
        return ph ? ph[parts[2]] : undefined;
    }
    if (parts[0] === 'counter') {
        const cm = summary.counters ? summary.counters[parts[1]] : null;
        return cm ? cm[parts[2]] : undefined;
    }
    return undefined;
}

/**
 * Non-throwing regression check.
 * @param {object} baseline @param {object} candidate
 * @param {Object<string,number>} [tolerances] metric path -> allowed fractional worsening
 * @returns {{ok:boolean, regressions:Array, diff:object}}
 */
export function checkRegression(baseline, candidate, tolerances = DEFAULT_TOLERANCES) {
    const regressions = [];
    for (const path in tolerances) {
        const tol = tolerances[path];
        const b = readMetric(baseline, path);
        const c = readMetric(candidate, path);
        // Counters are deterministic: a counter the baseline tracked that the candidate no
        // longer reports has VANISHED -- a structural regression, not a silent skip. (frame
        // and phase keep the lenient skip below: a phase may legitimately not fire.)
        if (path.startsWith('counter.') &&
            typeof b === 'number' && Number.isFinite(b) &&
            (typeof c !== 'number' || !Number.isFinite(c))) {
            regressions.push({
                metric: path, baseline: b, candidate: (typeof c === 'number' ? c : null),
                change: Infinity, tolerance: tol, reason: 'metric missing in candidate'
            });
            continue;
        }
        if (typeof b !== 'number' || typeof c !== 'number' || !Number.isFinite(b) || !Number.isFinite(c)) continue;
        let worse;
        if (b === 0) worse = (c <= 0) ? 0 : Infinity;
        else worse = higherIsBetter(path) ? (b - c) / b : (c - b) / b;
        if (worse > tol) regressions.push({ metric: path, baseline: b, candidate: c, change: worse, tolerance: tol });
    }
    return { ok: regressions.length === 0, regressions, diff: diffCaptures(baseline, candidate) };
}

function fmt(n) { return String(Math.round(n * 1000) / 1000); }

/**
 * CI gate. Throws a RegressionError listing every metric that worsened beyond
 * its tolerance; returns the check report when clean. Drops into node:test.
 * @param {object} baseline @param {object} candidate
 * @param {Object<string,number>} [tolerances]
 * @returns {{ok:boolean, regressions:Array, diff:object}}
 */
export function assertNoRegression(baseline, candidate, tolerances = DEFAULT_TOLERANCES) {
    const report = checkRegression(baseline, candidate, tolerances);
    if (!report.ok) {
        const lines = report.regressions.map((r) => {
            const cand = r.candidate == null ? 'missing' : fmt(r.candidate);
            const why = r.reason ? r.reason
                : (r.change === Infinity ? 'new from 0' : '+' + (r.change * 100).toFixed(1) + '%');
            return `  ${r.metric}: ${fmt(r.baseline)} -> ${cand} (${why} > ${(r.tolerance * 100).toFixed(0)}% budget)`;
        });
        const err = new Error(
            `lite-profiler: ${report.regressions.length} performance regression(s) exceeded tolerance:\n` +
            lines.join('\n')
        );
        err.name = 'RegressionError';
        err.report = report;
        throw err;
    }
    return report;
}
