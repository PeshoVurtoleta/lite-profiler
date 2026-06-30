/**
 * @zakkster/lite-profiler
 *
 * LiteCap - zero-dependency binary capture format for profiler telemetry.
 * A capture round-trips through encodeCapture()/decodeCapture() for offline
 * analysis and sharing. decodeCapture() validates magic, version and exact
 * byte length before reading, so untrusted input cannot over-read.
 *
 * Byte layout (little-endian):
 *   off 0  : magic    4 x uint8  = 'L','C','A','P'
 *   off 4  : version  1 x uint8  = 1
 *   off 5  : count    1 x uint32 = samples per buffer
 *   off 9  : phases   1 x uint8  = number of phase buffers
 *   off 10 : frames   count x float32          (oldest-first)
 *   ...    : phase p  count x float32 each      (oldest-first), p = 0..phases-1
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

const MAGIC0 = 0x4C, MAGIC1 = 0x43, MAGIC2 = 0x41, MAGIC3 = 0x50; // 'LCAP'
const VERSION = 1;
const OFF_VERSION = 4;
const OFF_COUNT = 5;
const OFF_NUM_PHASES = 9;
const HEADER_SIZE = 10;
const MAX_FRAMES = 1 << 20;   // ~1,048,576
const MAX_PHASES = 64;

/** Public constants for advanced consumers. */
export const LITECAP = Object.freeze({
    MAGIC: 'LCAP',
    VERSION,
    HEADER_SIZE,
    MAX_FRAMES,
    MAX_PHASES
});

/**
 * Serialize a profiler's buffers into a binary capture.
 * @param {import('./profiler.js').Profiler} profiler
 * @param {Float32Array} [scratch] optional reusable scratchpad (length >= count) to avoid allocation
 * @returns {ArrayBuffer|null} null when no frames have been captured
 */
export function encodeCapture(profiler, scratch = null) {
    const frame = profiler.frame;
    const count = frame.count;
    if (count === 0) return null;
    if (count > MAX_FRAMES) {
        throw new RangeError(`encodeCapture: frame count exceeds limit (${count} > ${MAX_FRAMES})`);
    }

    const numPhases = profiler.phaseCount;
    if (numPhases > MAX_PHASES) {
        throw new RangeError(`encodeCapture: phase count exceeds limit (${numPhases} > ${MAX_PHASES})`);
    }

    for (let p = 0; p < numPhases; p++) {
        if (profiler.phaseAt(p).count !== count) {
            throw new Error(
                `encodeCapture: phase buffer desync at index ${p}. ` +
                `Every registered phase must be reported on every frame.`
            );
        }
    }

    const byteLength = HEADER_SIZE + (count * 4) + (numPhases * count * 4);
    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);

    view.setUint8(0, MAGIC0);
    view.setUint8(1, MAGIC1);
    view.setUint8(2, MAGIC2);
    view.setUint8(3, MAGIC3);
    view.setUint8(OFF_VERSION, VERSION);
    view.setUint32(OFF_COUNT, count, true);
    view.setUint8(OFF_NUM_PHASES, numPhases);

    const pad = (scratch && scratch.length >= count) ? scratch : new Float32Array(count);
    let offset = HEADER_SIZE;

    frame.copyTo(pad, 0);
    for (let i = 0; i < count; i++) { view.setFloat32(offset, pad[i], true); offset += 4; }

    for (let p = 0; p < numPhases; p++) {
        profiler.phaseAt(p).copyTo(pad, 0);
        for (let i = 0; i < count; i++) { view.setFloat32(offset, pad[i], true); offset += 4; }
    }

    return buffer;
}

/**
 * Decode a binary capture produced by encodeCapture().
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {{version:number, count:number, numPhases:number, frames:Float32Array, phases:Float32Array[]}}
 */
export function decodeCapture(input) {
    let buffer, byteOffset, byteLength;
    if (input instanceof ArrayBuffer) {
        buffer = input; byteOffset = 0; byteLength = input.byteLength;
    } else if (ArrayBuffer.isView(input)) {
        buffer = input.buffer; byteOffset = input.byteOffset; byteLength = input.byteLength;
    } else {
        throw new TypeError('decodeCapture: expected ArrayBuffer or ArrayBufferView');
    }

    if (byteLength < HEADER_SIZE) {
        throw new RangeError('decodeCapture: buffer too small for header');
    }

    const view = new DataView(buffer, byteOffset, byteLength);
    if (view.getUint8(0) !== MAGIC0 || view.getUint8(1) !== MAGIC1 ||
        view.getUint8(2) !== MAGIC2 || view.getUint8(3) !== MAGIC3) {
        throw new Error('decodeCapture: bad magic (not a LiteCap buffer)');
    }

    const version = view.getUint8(OFF_VERSION);
    if (version !== VERSION) {
        throw new Error(`decodeCapture: unsupported version ${version} (expected ${VERSION})`);
    }

    const count = view.getUint32(OFF_COUNT, true);
    const numPhases = view.getUint8(OFF_NUM_PHASES);
    if (count > MAX_FRAMES) throw new RangeError(`decodeCapture: count exceeds limit (${count})`);
    if (numPhases > MAX_PHASES) throw new RangeError(`decodeCapture: phases exceed limit (${numPhases})`);

    const expected = HEADER_SIZE + (count * 4) + (numPhases * count * 4);
    if (byteLength < expected) {
        throw new RangeError(`decodeCapture: truncated buffer (have ${byteLength}, need ${expected})`);
    }

    let offset = HEADER_SIZE;
    const frames = new Float32Array(count);
    for (let i = 0; i < count; i++) { frames[i] = view.getFloat32(offset, true); offset += 4; }

    const phases = new Array(numPhases);
    for (let p = 0; p < numPhases; p++) {
        const arr = new Float32Array(count);
        for (let i = 0; i < count; i++) { arr[i] = view.getFloat32(offset, true); offset += 4; }
        phases[p] = arr;
    }

    return { version, count, numPhases, frames, phases };
}

/**
 * Trigger a browser download of a capture buffer. Browser-only.
 * @param {ArrayBuffer} buffer
 * @param {string} [filename='telemetry.litecap']
 */
export function downloadCapture(buffer, filename = 'telemetry.litecap') {
    if (!buffer) return;
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error('downloadCapture: requires a browser environment');
    }
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 1000);
}
