/**
 * @zakkster/lite-profiler
 *
 * Frame budget presets. A budget is the per-frame millisecond allowance for
 * a target refresh rate; helpers classify a measured frame time against it.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

/** Per-frame budget in milliseconds for common refresh targets. */
export const FrameBudget = Object.freeze({
    FPS_30: 1000 / 30,    // 33.33ms
    FPS_60: 1000 / 60,    // 16.67ms
    FPS_120: 1000 / 120   // 8.33ms
});

/**
 * @param {number} targetFps positive frames-per-second target
 * @returns {number} per-frame budget in milliseconds
 */
export function budgetMs(targetFps) {
    if (!Number.isFinite(targetFps) || targetFps <= 0) {
        throw new RangeError(`budgetMs: targetFps must be a positive number (got ${targetFps})`);
    }
    return 1000 / targetFps;
}

/**
 * @param {number} frameMs measured frame time in milliseconds
 * @param {number} targetFps target refresh rate
 * @returns {boolean} true when the frame exceeded its budget
 */
export function isOverBudget(frameMs, targetFps) {
    return frameMs > budgetMs(targetFps);
}
