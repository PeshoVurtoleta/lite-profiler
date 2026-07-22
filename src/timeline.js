/**
 * @zakkster/lite-profiler
 *
 * TimelineRecorder — opt-in ABSOLUTE-timestamp capture (v1.3.0).
 *
 * The core Profiler stores DURATIONS (now - start) in Float32 rings. Durations
 * alone cannot reconstruct a flame chart: you also need to know WHEN each span
 * started on a shared clock. This recorder captures that missing axis — absolute
 * performance.now() t0/t1 pairs, frame boundaries, and instant marks.
 *
 * WHY ITS OWN RINGS (raw Float64Array, not the shared RingBuffer). RingBuffer is
 * Float32-backed, which is right for small deltas but fatal for absolute time:
 * an hour into a session, performance.now() is ~3.6e6 and a Float32 ULP already
 * exceeds a millisecond, so a sub-ms span start is quantized away (measured: ~44s
 * of error at a realistic timeOrigin). profiler.js documents exactly this tension.
 * So the timeline keeps its own Float64 rings and unwinds them oldest-first by hand.
 *
 * Contract (mirrors Profiler):
 *  - All span/instant tags are registered once at construction. No dynamic
 *    registration (it would allocate).
 *  - beginSpan/endSpan must be paired per lane; one sample lands per pair, on end.
 *  - The hot path allocates nothing: samples land in preallocated rings only.
 *  - Not safe to call after destroy().
 *
 * Independent of Profiler — use standalone or alongside it.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * A single Float64 ring. Deliberately tiny and local — the shared RingBuffer is
 * Float32 and cannot hold absolute timestamps without quantizing them.
 */
class F64Ring {
    constructor(capacity) {
        this.capacity = nextPow2(capacity);
        this._mask = this.capacity - 1;
        this._data = new Float64Array(this.capacity);
        this._head = 0;   // next write index
        this.count = 0;
    }
    push(v) {
        this._data[this._head] = v;
        this._head = (this._head + 1) & this._mask;
        if (this.count < this.capacity) this.count++;
    }
    /** Copy the live samples oldest-first into dst at dstOffset. Returns count written. */
    copyTo(dst, dstOffset = 0) {
        const n = this.count;
        const cap = this.capacity;
        // Oldest sample sits `count` slots behind head (mod capacity).
        const start = (this._head - n + cap) & this._mask;
        for (let i = 0; i < n; i++) dst[dstOffset + i] = this._data[(start + i) & this._mask];
        return n;
    }
    reset() { this._head = 0; this.count = 0; }
    destroy() { this._data = null; }
}

export class TimelineRecorder {
    /**
     * @param {number}   [capacity=1024] samples per ring; rounded up to a power of two.
     * @param {string[]} [spanTags=[]]   static span lane tags, e.g. ['physics','render'].
     * @param {string[]} [instantTags=[]] static instant lane tags, e.g. ['gc','input'].
     */
    constructor(capacity = 1024, spanTags = [], instantTags = []) {
        if (!Number.isFinite(capacity) || capacity < 1) {
            throw new RangeError(`TimelineRecorder: capacity must be a finite positive number (got ${capacity})`);
        }

        this.capacity = nextPow2(capacity);

        // Frame boundaries: absolute start time of each frame.
        this._frames = new F64Ring(this.capacity);

        // Span lanes: paired t0/t1. A begin stores t0 in _openT0; the matching end
        // pushes both t0 and t1. An unpaired begin is simply overwritten by the next
        // begin on that lane (last-open-wins), matching Profiler's begin/end leniency.
        const sn = spanTags.length;
        this.spanTags = spanTags.slice();
        this._spanT0 = new Array(sn);
        this._spanT1 = new Array(sn);
        this._openT0 = new Float64Array(sn);
        this._open = new Uint8Array(sn);         // 1 while a begin is outstanding
        this._spanIndex = Object.create(null);
        for (let i = 0; i < sn; i++) {
            this._spanIndex[spanTags[i]] = i;
            this._spanT0[i] = new F64Ring(this.capacity);
            this._spanT1[i] = new F64Ring(this.capacity);
        }

        // Instant lanes: point events.
        const inN = instantTags.length;
        this.instantTags = instantTags.slice();
        this._instant = new Array(inN);
        this._instantIndex = Object.create(null);
        for (let i = 0; i < inN; i++) {
            this._instantIndex[instantTags[i]] = i;
            this._instant[i] = new F64Ring(this.capacity);
        }
    }

    get spanLaneCount() { return this.spanTags.length; }
    get instantLaneCount() { return this.instantTags.length; }
    get frameCount() { return this._frames.count; }

    /** Resolve a span tag to a stable integer handle, or -1. */
    spanHandle(tag) {
        const i = this._spanIndex[tag];
        return i === undefined ? -1 : i;
    }
    /** Resolve an instant tag to a stable integer handle, or -1. */
    instantHandle(tag) {
        const i = this._instantIndex[tag];
        return i === undefined ? -1 : i;
    }

    /** Record an absolute frame-start timestamp (defaults to now). */
    recordFrameBoundary(t = performance.now()) {
        this._frames.push(t);
    }

    /** Begin a span by tag. No-op for unknown tags. */
    beginSpan(tag, t0 = performance.now()) {
        const i = this._spanIndex[tag];
        if (i !== undefined) { this._openT0[i] = t0; this._open[i] = 1; }
    }
    /** Begin a span by handle (hot-path form). */
    beginSpanAt(handle, t0 = performance.now()) {
        if (handle >= 0 && handle < this._open.length) { this._openT0[handle] = t0; this._open[handle] = 1; }
    }
    /** End a span by tag and record the t0/t1 pair. No-op for unknown or unopened tags. */
    endSpan(tag, t1 = performance.now()) {
        const i = this._spanIndex[tag];
        if (i !== undefined) this._closeSpan(i, t1);
    }
    /** End a span by handle (hot-path form). */
    endSpanAt(handle, t1 = performance.now()) {
        if (handle >= 0 && handle < this._open.length) this._closeSpan(handle, t1);
    }
    _closeSpan(i, t1) {
        if (this._open[i] === 0) return;   // end without a begin: ignore
        this._spanT0[i].push(this._openT0[i]);
        this._spanT1[i].push(t1);
        this._open[i] = 0;
    }

    /** Record an instant (point) event by tag. No-op for unknown tags. */
    mark(tag, t = performance.now()) {
        const i = this._instantIndex[tag];
        if (i !== undefined) this._instant[i].push(t);
    }
    /** Record an instant by handle (hot-path form). */
    markAt(handle, t = performance.now()) {
        if (handle >= 0 && handle < this._instant.length) this._instant[handle].push(t);
    }

    // ── Accessors (return the live F64Ring so callers can copyTo their own buffers) ──

    /** Frame-boundary ring. */
    get frameBoundaries() { return this._frames; }
    /** t0 ring for a span lane, by tag. */
    spanT0(tag) { const i = this._spanIndex[tag]; return i === undefined ? null : this._spanT0[i]; }
    /** t1 ring for a span lane, by tag. */
    spanT1(tag) { const i = this._spanIndex[tag]; return i === undefined ? null : this._spanT1[i]; }
    /** t0 ring by handle. */
    spanT0At(h) { return (h >= 0 && h < this._spanT0.length) ? this._spanT0[h] : null; }
    /** t1 ring by handle. */
    spanT1At(h) { return (h >= 0 && h < this._spanT1.length) ? this._spanT1[h] : null; }
    /** Instant ring by tag. */
    instantTime(tag) { const i = this._instantIndex[tag]; return i === undefined ? null : this._instant[i]; }
    /** Instant ring by handle. */
    instantTimeAt(h) { return (h >= 0 && h < this._instant.length) ? this._instant[h] : null; }

    /** Clear all rings without releasing memory. Open spans are dropped. */
    reset() {
        this._frames.reset();
        for (let i = 0; i < this._spanT0.length; i++) { this._spanT0[i].reset(); this._spanT1[i].reset(); }
        for (let i = 0; i < this._instant.length; i++) this._instant[i].reset();
        this._open.fill(0);
        this._openT0.fill(0);
    }

    /** Release all rings. Not safe to use afterwards. */
    destroy() {
        this._frames.destroy();
        for (let i = 0; i < this._spanT0.length; i++) { this._spanT0[i].destroy(); this._spanT1[i].destroy(); }
        for (let i = 0; i < this._instant.length; i++) this._instant[i].destroy();
        this._frames = null;
        this._spanT0 = null; this._spanT1 = null; this._instant = null;
        this._openT0 = null; this._open = null;
        this._spanIndex = null; this._instantIndex = null;
        this.spanTags = null; this.instantTags = null;
    }
}
