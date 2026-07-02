/**
 * @zakkster/lite-profiler
 *
 * Profiler - zero-GC frame and per-phase timing capture.
 *
 * Contract:
 *  - All phases are registered once at construction. Dynamic phase
 *    registration at runtime is not supported (it would allocate).
 *  - begin(tag)/end(tag) and beginAt(i)/endAt(i) must be paired per frame.
 *  - The hot path performs no allocation and writes no signals: samples
 *    land in pre-allocated Float32Array ring buffers only.
 *  - Methods are not safe to call after destroy().
 *
 * Timing source is performance.now() (milliseconds, sub-ms in most engines).
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { RingBuffer } from '@zakkster/lite-ring-buffer';

export class Profiler {
    /**
     * @param {number} capacity sample window per buffer; rounded up to a
     *        power of two by the underlying ring buffer (e.g. 600 -> 1024).
     * @param {string[]} phases static phase tags, e.g. ['physics','render'].
     * @param {string[]} counters static counter tags, e.g. ['drawCalls','floatsUploaded'].
     *        Optional; omit for pure timing (behaves exactly as before).
     */
    constructor(capacity = 1024, phases = [], counters = []) {
        if (!Number.isFinite(capacity) || capacity < 1) {
            throw new RangeError(
                `Profiler: capacity must be a finite positive number (got ${capacity})`
            );
        }

        this.frameBuffer = new RingBuffer(capacity);
        /** @type {number} actual (power-of-two) capacity of every buffer */
        this.capacity = this.frameBuffer.capacity;

        const n = phases.length;
        this.phaseTags = phases.slice();
        this.phaseBuffers = new Array(n);
        // Absolute performance.now() timestamps must be 64-bit: after a tab has
        // been open for hours, now() is large enough that a Float32 ULP exceeds
        // a millisecond and sub-ms phase starts would be quantized away. The
        // ring buffers stay Float32 because they store small deltas (now-start).
        this._starts = new Float64Array(n);
        this._index = Object.create(null);

        for (let i = 0; i < n; i++) {
            this._index[phases[i]] = i;
            this.phaseBuffers[i] = new RingBuffer(capacity);
        }

        // Counter channel: deterministic per-frame command counts (draw calls, floats
        // uploaded, ...). Accumulated within a frame via count()/countAt() and flushed
        // to rings at endFrame(). Values are integers, but rings are Float32-backed like
        // every other buffer, so per-frame counts are exact up to 2^24. With no counters
        // registered this is all zero-length and the hot path is untouched.
        const cn = counters.length;
        this.counterTags = counters.slice();
        this.counterBuffers = new Array(cn);
        this._counterAccum = new Float64Array(cn);   // per-frame accumulators (flushed + cleared at endFrame)
        this._counterIndex = Object.create(null);
        for (let i = 0; i < cn; i++) {
            this._counterIndex[counters[i]] = i;
            this.counterBuffers[i] = new RingBuffer(capacity);
        }

        this._frameStart = 0;
    }

    /** @returns {number} number of registered phases */
    get phaseCount() { return this.phaseBuffers.length; }

    /**
     * Resolve a phase tag to a stable integer handle for the hot path.
     * @param {string} tag
     * @returns {number} handle, or -1 if the tag was not registered.
     */
    handle(tag) {
        const i = this._index[tag];
        return i === undefined ? -1 : i;
    }

    /** @param {number} handle @returns {string|null} */
    tagOf(handle) {
        return (handle >= 0 && handle < this.phaseTags.length) ? this.phaseTags[handle] : null;
    }

    /** Mark the start of a frame. */
    beginFrame() {
        this._frameStart = performance.now();
    }

    /** Record total frame duration, then flush per-frame counter accumulators to their rings. */
    endFrame() {
        this.frameBuffer.push(performance.now() - this._frameStart);
        const cb = this.counterBuffers;
        for (let i = 0; i < cb.length; i++) {
            cb[i].push(this._counterAccum[i]);
            this._counterAccum[i] = 0;
        }
    }

    /** Begin timing a phase by tag. No-op for unknown tags. */
    begin(tag) {
        const i = this._index[tag];
        if (i !== undefined) this._starts[i] = performance.now();
    }

    /** End timing a phase by tag and record the elapsed time. No-op for unknown tags. */
    end(tag) {
        const i = this._index[tag];
        if (i !== undefined) this.phaseBuffers[i].push(performance.now() - this._starts[i]);
    }

    /** Begin timing a phase by integer handle (hot-path form). */
    beginAt(handle) {
        if (handle >= 0 && handle < this._starts.length) this._starts[handle] = performance.now();
    }

    /** End timing a phase by integer handle and record elapsed (hot-path form). */
    endAt(handle) {
        if (handle >= 0 && handle < this.phaseBuffers.length) {
            this.phaseBuffers[handle].push(performance.now() - this._starts[handle]);
        }
    }

    /** @returns {RingBuffer} the total-frame-time buffer */
    get frame() { return this.frameBuffer; }

    /** @param {string} tag @returns {RingBuffer|null} */
    phase(tag) {
        const i = this._index[tag];
        return i === undefined ? null : this.phaseBuffers[i];
    }

    /** @param {number} handle @returns {RingBuffer|null} */
    phaseAt(handle) {
        return (handle >= 0 && handle < this.phaseBuffers.length) ? this.phaseBuffers[handle] : null;
    }

    /** @returns {number} number of registered counters */
    get counterCount() { return this.counterBuffers.length; }

    /**
     * Resolve a counter tag to a stable integer handle for the hot path.
     * @param {string} tag @returns {number} handle, or -1 if not registered.
     */
    counterHandle(tag) {
        const i = this._counterIndex[tag];
        return i === undefined ? -1 : i;
    }

    /** @param {number} handle @returns {string|null} */
    counterTagOf(handle) {
        return (handle >= 0 && handle < this.counterTags.length) ? this.counterTags[handle] : null;
    }

    /** Add n to a counter by tag for the current frame. No-op for unknown tags. */
    count(tag, n = 1) {
        const i = this._counterIndex[tag];
        if (i !== undefined) this._counterAccum[i] += n;
    }

    /** Add n to a counter by integer handle (hot-path form). */
    countAt(handle, n = 1) {
        if (handle >= 0 && handle < this._counterAccum.length) this._counterAccum[handle] += n;
    }

    /** @param {string} tag @returns {RingBuffer|null} */
    counter(tag) {
        const i = this._counterIndex[tag];
        return i === undefined ? null : this.counterBuffers[i];
    }

    /** @param {number} handle @returns {RingBuffer|null} */
    counterAt(handle) {
        return (handle >= 0 && handle < this.counterBuffers.length) ? this.counterBuffers[handle] : null;
    }

    /** Clear all buffers without releasing memory. */
    reset() {
        this.frameBuffer.reset();
        for (let i = 0; i < this.phaseBuffers.length; i++) this.phaseBuffers[i].reset();
        for (let i = 0; i < this.counterBuffers.length; i++) this.counterBuffers[i].reset();
        this._counterAccum.fill(0);
        this._starts.fill(0);
        this._frameStart = 0;
    }

    /** Release all buffers. Not safe to use afterwards. */
    destroy() {
        this.frameBuffer.destroy();
        for (let i = 0; i < this.phaseBuffers.length; i++) this.phaseBuffers[i].destroy();
        for (let i = 0; i < this.counterBuffers.length; i++) this.counterBuffers[i].destroy();
        this.phaseBuffers = null;
        this.counterBuffers = null;
        this._counterAccum = null;
        this._counterIndex = null;
        this.counterTags = null;
        this._starts = null;
        this._index = null;
        this.phaseTags = null;
    }
}
