/**
 * @zakkster/lite-profiler
 *
 * MeterHud - a minimal CPU overlay that renders a Profiler's frame-time
 * envelope via @zakkster/lite-canvas-graph and prints a small numeric
 * readout. Rendering is allocation-free apart from the canvas text
 * concession inherited from the graph renderer.
 *
 * For a GPU-accelerated, bitmap-font HUD use the separate renderer package;
 * this one keeps the core dependency-light.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { CanvasGraph } from '@zakkster/lite-canvas-graph';

export class MeterHud {
    /**
     * @param {HTMLCanvasElement|OffscreenCanvas} canvas
     * @param {import('./profiler.js').Profiler} profiler
     * @param {object} [options]
     * @param {number} [options.width=400]
     * @param {number} [options.height=100]
     * @param {number} [options.maxMs=33]    value mapped to the top of the graph
     * @param {boolean} [options.decimate=true]
     * @param {boolean} [options.readout=true] draw the numeric ms/fps readout
     * @param {string} [options.stroke='#00ffcc']
     * @param {string} [options.background='#111']
     * @param {number} [options.dpr] override devicePixelRatio (Workers)
     */
    constructor(canvas, profiler, options = {}) {
        if (!canvas) throw new TypeError('MeterHud: canvas is required');
        if (!profiler) throw new TypeError('MeterHud: profiler is required');

        this.profiler = profiler;
        this.maxMs = options.maxMs ?? 33;
        this.decimate = options.decimate !== false;
        this.readout = options.readout !== false;
        this._textColor = options.stroke ?? '#00ffcc';
        // Hoisted so render() allocates nothing on the per-frame path.
        this._renderOpts = { decimate: this.decimate };

        const width = options.width ?? 400;
        const height = options.height ?? 100;

        this.graph = new CanvasGraph(canvas, width, height, {
            dpr: options.dpr,
            stroke: options.stroke ?? '#00ffcc',
            background: options.background ?? '#111',
            lineWidth: 1
        });

        if (this.readout) {
            const color = this._textColor;
            this.graph.labelBitmapHook = (ctx, maxValue, w) => {
                const last = profiler.frame.peekNewest();
                const fps = last > 0 ? Math.round(1000 / last) : 0;
                ctx.fillStyle = color;
                ctx.font = '12px monospace';
                ctx.fillText(`${last.toFixed(1)}ms`, 6, 14);
                ctx.fillText(`${fps}fps`, 6, 28);
                ctx.fillText(`${maxValue.toFixed(0)}ms`, w - 38, 14);
            };
        }
    }

    /** Set the value mapped to the top of the graph. */
    setMaxMs(ms) { this.maxMs = ms; }

    /** Render the current frame buffer. Call once per frame. */
    render() {
        this.graph.render(this.profiler.frame, this.maxMs, this._renderOpts);
    }

    /** Resize the overlay. */
    resize(width, height) { this.graph.resize(width, height); }

    destroy() {
        if (this.graph) this.graph.destroy();
        this.graph = null;
        this.profiler = null;
    }
}
