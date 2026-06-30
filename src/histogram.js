/**
 * @zakkster/lite-profiler
 *
 * FrameHistogram - zero-GC log-bucketed frame-time distribution with a
 * bimodal classifier that separates sparse spikes (GC-pause signature)
 * from sustained elevation (throttle / CPU-bound signature).
 *
 * Buckets (milliseconds):
 *   [0] <2    [1] 2-4    [2] 4-8    [3] 8-16
 *   [4] 16-33 [5] 33-66  [6] >=66
 * The 16ms and 33ms edges are the 60fps and 30fps frame budgets.
 *
 * Classification is a documented heuristic over two ratios:
 *   jankRatio  = fraction of samples >= 16ms (a missed 60fps frame)
 *   spikeRatio = fraction of samples >= 33ms (a hard hitch)
 *     STEADY     jankRatio < 0.05
 *     THROTTLED  jankRatio >= 0.25            (many frames elevated)
 *     SPIKING    otherwise                    (intermittent hitches)
 * Raw bins and ratios are exposed so callers can apply their own rule.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

/** Frame-time classification labels (interned string constants). */
export const FrameClass = Object.freeze({
    STEADY: 'steady',
    SPIKING: 'spiking',
    THROTTLED: 'throttled'
});

const STEADY_MAX_JANK = 0.05;
const THROTTLE_MIN_JANK = 0.25;

export class FrameHistogram {
    constructor() {
        /** @type {Uint32Array} 7 buckets, reused on every update() */
        this.bins = new Uint32Array(7);
        /** @type {number} sample count of the last update() */
        this.total = 0;
        /** @type {number} index of the most populated bucket */
        this.modeIndex = 0;
    }

    /**
     * Recompute the distribution from a ring buffer. Zero allocation.
     * @param {{count:number, get:(o:number)=>number}} ringBuffer
     * @returns {this}
     */
    update(ringBuffer) {
        const bins = this.bins;
        bins.fill(0);
        const count = ringBuffer.count;
        this.total = count;

        for (let i = 0; i < count; i++) {
            const v = ringBuffer.get(i);
            if (v < 2)        bins[0]++;
            else if (v < 4)   bins[1]++;
            else if (v < 8)   bins[2]++;
            else if (v < 16)  bins[3]++;
            else if (v < 33)  bins[4]++;
            else if (v < 66)  bins[5]++;
            else              bins[6]++;
        }

        let mode = 0;
        for (let b = 1; b < 7; b++) if (bins[b] > bins[mode]) mode = b;
        this.modeIndex = mode;
        return this;
    }

    /** @returns {number} fraction of samples >= 16ms (missed 60fps frames) */
    get jankRatio() {
        if (this.total === 0) return 0;
        const b = this.bins;
        return (b[4] + b[5] + b[6]) / this.total;
    }

    /** @returns {number} fraction of samples >= 33ms (hard hitches) */
    get spikeRatio() {
        if (this.total === 0) return 0;
        const b = this.bins;
        return (b[5] + b[6]) / this.total;
    }

    /**
     * Classify the current distribution.
     * @returns {string} one of FrameClass.*
     */
    classify() {
        if (this.total === 0) return FrameClass.STEADY;
        const jank = this.jankRatio;
        if (jank < STEADY_MAX_JANK) return FrameClass.STEADY;
        if (jank >= THROTTLE_MIN_JANK) return FrameClass.THROTTLED;
        return FrameClass.SPIKING;
    }

    destroy() {
        this.bins = null;
    }
}
