import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, MeterHud } from '../index.js';

let clock = 0, realNow;
beforeEach(() => { clock = 0; realNow = performance.now; performance.now = () => clock; });
afterEach(() => { performance.now = realNow; });

function fakeCanvas() {
  const calls = { fillText: [], stroke: 0 };
  const ctx = {
    setTransform() {}, clearRect() {}, fillRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { calls.stroke++; },
    fillText(s) { calls.fillText.push(String(s)); },
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(_v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(_v) {}, get lineWidth() { return 1; },
    set lineCap(_v) {}, get lineCap() { return 'butt'; },
    set font(_v) {}, get font() { return '12px monospace'; }
  };
  const canvas = { width: 0, height: 0, style: {}, getContext() { return ctx; } };
  return { canvas, calls };
}

describe('MeterHud', () => {
  it('requires canvas and profiler', () => {
    const p = new Profiler(16);
    assert.throws(() => new MeterHud(null, p), TypeError);
    const { canvas } = fakeCanvas();
    assert.throws(() => new MeterHud(canvas, null), TypeError);
    p.destroy();
  });

  it('renders the frame envelope and a readout without throwing', () => {
    const p = new Profiler(64);
    for (let i = 0; i < 30; i++) { p.beginFrame(); clock += 16; p.endFrame(); clock += 1; }
    const { canvas, calls } = fakeCanvas();
    const hud = new MeterHud(canvas, p, { width: 200, height: 60, maxMs: 33 });
    assert.doesNotThrow(() => hud.render());
    assert.ok(calls.stroke > 0);
    assert.ok(calls.fillText.some(s => s.includes('ms')));
    hud.resize(220, 70);
    assert.doesNotThrow(() => hud.render());
    hud.destroy();
    assert.equal(hud.graph, null);
    p.destroy();
  });
});
