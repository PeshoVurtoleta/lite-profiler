import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameBudget, budgetMs, isOverBudget } from '../index.js';

const near = (a, b, eps = 1e-2) => assert.ok(Math.abs(a - b) <= eps, `${a} ~= ${b}`);

describe('presets', () => {
  it('exposes common budgets', () => {
    near(FrameBudget.FPS_60, 16.667);
    near(FrameBudget.FPS_30, 33.333);
    near(FrameBudget.FPS_120, 8.333);
  });

  it('computes budget and over-budget', () => {
    near(budgetMs(60), 16.667);
    assert.equal(isOverBudget(20, 60), true);
    assert.equal(isOverBudget(10, 60), false);
    assert.throws(() => budgetMs(0), RangeError);
  });
});
