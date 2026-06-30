/** Per-frame budget in milliseconds for common refresh targets. */
export declare const FrameBudget: {
  readonly FPS_30: number;
  readonly FPS_60: number;
  readonly FPS_120: number;
};
export declare function budgetMs(targetFps: number): number;
export declare function isOverBudget(frameMs: number, targetFps: number): boolean;
