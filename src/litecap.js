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
 *   off 4  : version  1 x uint8  = 1 or 2
 *   off 5  : count    1 x uint32 = samples per buffer
 *   off 9  : phases   1 x uint8  = number of phase buffers
 *   off 10 : frames   count x float32          (oldest-first)
 *   ...    : phase p  count x float32 each      (oldest-first), p = 0..phases-1
 *   v2 trailer (when version >= 2):
 *     tags   : per phase, uint8 len + len UTF-8 bytes  (registration order)
 *     meta   : uint32 len + len UTF-8 bytes (JSON; len 0 = none)
 *   v3 counter trailer (only when version = 3):
 *     numCounters : 1 x uint8
 *     counter c   : count x float32 each (oldest-first), c = 0..numCounters-1
 *     ctags       : per counter, uint8 len + len UTF-8 bytes (registration order)
 *   v4 timeline trailer (only when version = 4, TimelineRecorder data):
 *     frameCount   : uint32, then frameCount x float64  (absolute frame starts)
 *     numSpanLanes : uint8
 *       per lane: uint8 tag-len + tag bytes,
 *                 uint32 pairCount, then pairCount x float64 t0, pairCount x float64 t1
 *     numInstLanes : uint8
 *       per lane: uint8 tag-len + tag bytes,
 *                 uint32 markCount, then markCount x float64
 *     Absolute timestamps are float64 by necessity — a session open for hours
 *     pushes performance.now() past the point where a float32 ULP exceeds 1ms.
 *
 *   VERSION DISCIPLINE. Emit is the LOWEST version that fits the data: v2 with no
 *   counters and no timeline, v3 when counters exist, v4 only when a
 *   TimelineRecorder with data is serialized. A reader rejects versions above the
 *   one it knows (hard error, not silent truncation) — so a v4 capture is
 *   correctly refused by a v3 reader rather than round-tripping to a blank
 *   timeline. Captures WITHOUT timeline data stay byte-identical to v2/v3.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

const MAGIC0 = 0x4C, MAGIC1 = 0x43, MAGIC2 = 0x41, MAGIC3 = 0x50; // 'LCAP'
const VERSION = 4;            // max emit version (v2 base, v3 +counters, v4 +timeline)
const MIN_VERSION = 1;        // v1 still decodes
const OFF_VERSION = 4;
const OFF_COUNT = 5;
const OFF_NUM_PHASES = 9;
const HEADER_SIZE = 10;
const MAX_FRAMES = 1 << 20;   // ~1,048,576
const MAX_PHASES = 64;
const MAX_COUNTERS = 64;
const MAX_SPAN_LANES = 64;
const MAX_INSTANT_LANES = 64;
const MAX_TIMELINE_SAMPLES = 1 << 20;

// Module-level codecs: one allocation for the life of the module, not per call.
const _lcEnc = new TextEncoder();

/** Public constants for advanced consumers. */
export const LITECAP = Object.freeze({
    MAGIC: 'LCAP',
    VERSION,
    HEADER_SIZE,
    MAX_FRAMES,
    MAX_PHASES,
    MAX_COUNTERS,
    MAX_SPAN_LANES,
    MAX_INSTANT_LANES,
    MAX_TIMELINE_SAMPLES
});

/**
 * Size of the v4 timeline trailer for a recorder, in bytes. Also validates the
 * lane/sample limits up front so encodeCapture can fail before allocating.
 */
function measureTimeline(tr, enc) {
    const frames = tr.frameBoundaries.count;
    if (frames > MAX_TIMELINE_SAMPLES) {
        throw new RangeError(`encodeCapture: frame boundaries exceed limit (${frames} > ${MAX_TIMELINE_SAMPLES})`);
    }
    const nSpan = tr.spanLaneCount;
    const nInst = tr.instantLaneCount;
    if (nSpan > MAX_SPAN_LANES) throw new RangeError(`encodeCapture: span lanes exceed limit (${nSpan} > ${MAX_SPAN_LANES})`);
    if (nInst > MAX_INSTANT_LANES) throw new RangeError(`encodeCapture: instant lanes exceed limit (${nInst} > ${MAX_INSTANT_LANES})`);

    let bytes = 4 + frames * 8;        // frameCount + frames
    bytes += 1;                        // numSpanLanes
    const spanTagBytes = new Array(nSpan);
    for (let i = 0; i < nSpan; i++) {
        const b = enc.encode(tr.spanTags[i]);
        if (b.length > 255) throw new RangeError(`encodeCapture: span tag too long (${b.length} > 255)`);
        // t0 and t1 counts are paired and identical by construction; store once.
        const pairs = tr.spanT0At(i).count;
        if (pairs > MAX_TIMELINE_SAMPLES) throw new RangeError(`encodeCapture: span samples exceed limit (${pairs})`);
        spanTagBytes[i] = b;
        bytes += 1 + b.length + 4 + pairs * 8 * 2;
    }
    bytes += 1;                        // numInstLanes
    const instTagBytes = new Array(nInst);
    for (let i = 0; i < nInst; i++) {
        const b = enc.encode(tr.instantTags[i]);
        if (b.length > 255) throw new RangeError(`encodeCapture: instant tag too long (${b.length} > 255)`);
        const marks = tr.instantTimeAt(i).count;
        if (marks > MAX_TIMELINE_SAMPLES) throw new RangeError(`encodeCapture: instant samples exceed limit (${marks})`);
        instTagBytes[i] = b;
        bytes += 1 + b.length + 4 + marks * 8;
    }
    return { bytes, spanTagBytes, instTagBytes };
}

/** Write the v4 timeline trailer. Assumes measureTimeline already validated limits. */
function writeTimeline(view, u8, offset, tr, m, scratch64) {
    // Frame boundaries.
    const frames = tr.frameBoundaries.count;
    view.setUint32(offset, frames, true); offset += 4;
    if (frames > 0) {
        const buf = (scratch64 && scratch64.length >= frames) ? scratch64 : new Float64Array(frames);
        tr.frameBoundaries.copyTo(buf, 0);
        for (let i = 0; i < frames; i++) { view.setFloat64(offset, buf[i], true); offset += 8; }
    }
    // Span lanes.
    const nSpan = tr.spanLaneCount;
    view.setUint8(offset, nSpan); offset += 1;
    for (let l = 0; l < nSpan; l++) {
        const b = m.spanTagBytes[l];
        view.setUint8(offset, b.length); offset += 1;
        u8.set(b, offset); offset += b.length;
        const pairs = tr.spanT0At(l).count;
        view.setUint32(offset, pairs, true); offset += 4;
        if (pairs > 0) {
            const buf = (scratch64 && scratch64.length >= pairs) ? scratch64 : new Float64Array(pairs);
            tr.spanT0At(l).copyTo(buf, 0);
            for (let i = 0; i < pairs; i++) { view.setFloat64(offset, buf[i], true); offset += 8; }
            tr.spanT1At(l).copyTo(buf, 0);
            for (let i = 0; i < pairs; i++) { view.setFloat64(offset, buf[i], true); offset += 8; }
        }
    }
    // Instant lanes.
    const nInst = tr.instantLaneCount;
    view.setUint8(offset, nInst); offset += 1;
    for (let l = 0; l < nInst; l++) {
        const b = m.instTagBytes[l];
        view.setUint8(offset, b.length); offset += 1;
        u8.set(b, offset); offset += b.length;
        const marks = tr.instantTimeAt(l).count;
        view.setUint32(offset, marks, true); offset += 4;
        if (marks > 0) {
            const buf = (scratch64 && scratch64.length >= marks) ? scratch64 : new Float64Array(marks);
            tr.instantTimeAt(l).copyTo(buf, 0);
            for (let i = 0; i < marks; i++) { view.setFloat64(offset, buf[i], true); offset += 8; }
        }
    }
    return offset;
}

/**
 * Serialize a profiler's buffers into a binary capture (v2: includes phase tags
 * and optional metadata, making the capture self-describing).
 * @param {import('./profiler.js').Profiler} profiler
 * @param {Float32Array} [scratch] optional reusable scratchpad (length >= count) to avoid allocation
 * @param {object|null} [meta] optional JSON-serializable metadata (e.g. { engine, label, budgetMs })
 * @param {import('./timeline.js').TimelineRecorder|null} [timeline] optional absolute-time
 *        capture. When it carries any data the capture is emitted as v4 with a timeline
 *        trailer; otherwise the version is unchanged and the bytes are identical to before.
 * @returns {ArrayBuffer|null} null when no frames have been captured
 */
export function encodeCapture(profiler, scratch = null, meta = null, timeline = null) {
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

    // v2 trailer sizing: phase tags then a uint32-prefixed meta JSON blob.
    const enc = _lcEnc;
    const tagBytes = new Array(numPhases);
    let tagsTotal = 0;
    for (let p = 0; p < numPhases; p++) {
        const b = enc.encode(profiler.phaseTags[p]);
        if (b.length > 255) {
            throw new RangeError(`encodeCapture: phase tag too long (${b.length} bytes > 255)`);
        }
        tagBytes[p] = b;
        tagsTotal += 1 + b.length;
    }
    const metaBytes = meta != null ? enc.encode(JSON.stringify(meta)) : new Uint8Array(0);
    const metaTotal = 4 + metaBytes.length;

    // v3 counter section (emitted only when counters exist; otherwise the capture stays
    // v2 and decodes in older readers).
    const numCounters = profiler.counterCount || 0;
    if (numCounters > MAX_COUNTERS) {
        throw new RangeError(`encodeCapture: counter count exceeds limit (${numCounters} > ${MAX_COUNTERS})`);
    }
    // Timeline (v4) is opt-in and only bumps the version when it actually carries data.
    const hasTimeline = !!timeline && (
        timeline.frameCount > 0 ||
        _anySpanSamples(timeline) ||
        _anyInstantSamples(timeline)
    );
    const timelineMeasure = hasTimeline ? measureTimeline(timeline, _lcEnc) : null;

    const version = hasTimeline ? 4 : (numCounters > 0 ? 3 : 2);
    // The counter section exists iff version >= 3. Under v3 that always meant
    // numCounters > 0; v4 breaks that equivalence (a timeline capture can carry
    // zero counters), so the section — at minimum its 1-byte count header — must
    // still be written to keep the decoder's version>=3 read aligned.
    const emitCounters = version >= 3;
    let counterTagBytes = null;
    let counterSection = 0;
    if (emitCounters) {
        counterSection = 1;   // the numCounters byte is always present in v3+
    }
    if (numCounters > 0) {
        for (let cc = 0; cc < numCounters; cc++) {
            if (profiler.counterAt(cc).count !== count) {
                throw new Error(
                    `encodeCapture: counter buffer desync at index ${cc}. ` +
                    `Every registered counter is flushed on every endFrame().`
                );
            }
        }
        counterTagBytes = new Array(numCounters);
        let ctagsTotal = 0;
        for (let cc = 0; cc < numCounters; cc++) {
            const b = enc.encode(profiler.counterTags[cc]);
            if (b.length > 255) {
                throw new RangeError(`encodeCapture: counter tag too long (${b.length} bytes > 255)`);
            }
            counterTagBytes[cc] = b;
            ctagsTotal += 1 + b.length;
        }
        counterSection = 1 + (numCounters * count * 4) + ctagsTotal;
    }

    const timelineSection = hasTimeline ? timelineMeasure.bytes : 0;
    const byteLength = HEADER_SIZE + (count * 4) + (numPhases * count * 4)
        + tagsTotal + metaTotal + counterSection + timelineSection;
    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    view.setUint8(0, MAGIC0);
    view.setUint8(1, MAGIC1);
    view.setUint8(2, MAGIC2);
    view.setUint8(3, MAGIC3);
    view.setUint8(OFF_VERSION, version);
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

    for (let p = 0; p < numPhases; p++) {
        const b = tagBytes[p];
        view.setUint8(offset, b.length); offset += 1;
        u8.set(b, offset); offset += b.length;
    }
    view.setUint32(offset, metaBytes.length, true); offset += 4;
    u8.set(metaBytes, offset); offset += metaBytes.length;

    if (emitCounters) {
        view.setUint8(offset, numCounters); offset += 1;   // may be 0 in a v4 timeline-only capture
        for (let cc = 0; cc < numCounters; cc++) {
            profiler.counterAt(cc).copyTo(pad, 0);   // reuse the frame/phase scratch (Float32, len >= count)
            for (let i = 0; i < count; i++) { view.setFloat32(offset, pad[i], true); offset += 4; }
        }
        for (let cc = 0; cc < numCounters; cc++) {
            const b = counterTagBytes[cc];
            view.setUint8(offset, b.length); offset += 1;
            u8.set(b, offset); offset += b.length;
        }
    }

    if (hasTimeline) {
        // Reuse the Float32 scratch's backing where possible? No — timeline needs f64.
        offset = writeTimeline(view, u8, offset, timeline, timelineMeasure, null);
    }

    return buffer;
}

function _anySpanSamples(tr) {
    for (let i = 0; i < tr.spanLaneCount; i++) if (tr.spanT0At(i).count > 0) return true;
    return false;
}
function _anyInstantSamples(tr) {
    for (let i = 0; i < tr.instantLaneCount; i++) if (tr.instantTimeAt(i).count > 0) return true;
    return false;
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
    if (version < MIN_VERSION || version > VERSION) {
        throw new Error(`decodeCapture: unsupported version ${version} (supported ${MIN_VERSION}..${VERSION})`);
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

    let tags = [];
    let meta = null;
    if (version >= 2) {
        const dec = new TextDecoder();
        tags = new Array(numPhases);
        for (let p = 0; p < numPhases; p++) {
            if (offset + 1 > byteLength) throw new RangeError('decodeCapture: truncated tag table');
            const len = view.getUint8(offset); offset += 1;
            if (offset + len > byteLength) throw new RangeError('decodeCapture: truncated tag bytes');
            tags[p] = dec.decode(new Uint8Array(buffer, byteOffset + offset, len));
            offset += len;
        }
        if (offset + 4 > byteLength) throw new RangeError('decodeCapture: truncated meta length');
        const metaLen = view.getUint32(offset, true); offset += 4;
        if (offset + metaLen > byteLength) throw new RangeError('decodeCapture: truncated meta bytes');
        if (metaLen > 0) {
            const json = dec.decode(new Uint8Array(buffer, byteOffset + offset, metaLen));
            offset += metaLen;
            try { meta = JSON.parse(json); } catch { meta = null; }
        }
    }

    let counters = [];
    let counterTags = [];
    if (version >= 3) {
        if (offset + 1 > byteLength) throw new RangeError('decodeCapture: truncated counter header');
        const numCounters = view.getUint8(offset); offset += 1;
        if (numCounters > MAX_COUNTERS) throw new RangeError(`decodeCapture: counters exceed limit (${numCounters})`);
        const need = numCounters * count * 4;
        if (offset + need > byteLength) throw new RangeError('decodeCapture: truncated counter data');
        counters = new Array(numCounters);
        for (let cc = 0; cc < numCounters; cc++) {
            const arr = new Float32Array(count);
            for (let i = 0; i < count; i++) { arr[i] = view.getFloat32(offset, true); offset += 4; }
            counters[cc] = arr;
        }
        const cdec = new TextDecoder();
        counterTags = new Array(numCounters);
        for (let cc = 0; cc < numCounters; cc++) {
            if (offset + 1 > byteLength) throw new RangeError('decodeCapture: truncated counter tag table');
            const len = view.getUint8(offset); offset += 1;
            if (offset + len > byteLength) throw new RangeError('decodeCapture: truncated counter tag bytes');
            counterTags[cc] = cdec.decode(new Uint8Array(buffer, byteOffset + offset, len));
            offset += len;
        }
    }

    // v4 timeline trailer.
    let frameBoundaries = null;
    let spanTags = [], spanT0 = [], spanT1 = [];
    let instantTags = [], instantTimes = [];
    if (version >= 4) {
        const tdec = new TextDecoder();
        const readF64Array = (n, label) => {
            const need = n * 8;
            if (offset + need > byteLength) throw new RangeError(`decodeCapture: truncated ${label}`);
            const arr = new Float64Array(n);
            for (let i = 0; i < n; i++) { arr[i] = view.getFloat64(offset, true); offset += 8; }
            return arr;
        };
        const readTag = (label) => {
            if (offset + 1 > byteLength) throw new RangeError(`decodeCapture: truncated ${label} length`);
            const len = view.getUint8(offset); offset += 1;
            if (offset + len > byteLength) throw new RangeError(`decodeCapture: truncated ${label} bytes`);
            const tag = tdec.decode(new Uint8Array(buffer, byteOffset + offset, len));
            offset += len;
            return tag;
        };
        const readU32 = (label) => {
            if (offset + 4 > byteLength) throw new RangeError(`decodeCapture: truncated ${label}`);
            const v = view.getUint32(offset, true); offset += 4;
            return v;
        };

        const frameN = readU32('frame boundary count');
        if (frameN > MAX_TIMELINE_SAMPLES) throw new RangeError(`decodeCapture: frame boundaries exceed limit (${frameN})`);
        frameBoundaries = readF64Array(frameN, 'frame boundaries');

        if (offset + 1 > byteLength) throw new RangeError('decodeCapture: truncated span lane count');
        const nSpan = view.getUint8(offset); offset += 1;
        if (nSpan > MAX_SPAN_LANES) throw new RangeError(`decodeCapture: span lanes exceed limit (${nSpan})`);
        spanTags = new Array(nSpan); spanT0 = new Array(nSpan); spanT1 = new Array(nSpan);
        for (let l = 0; l < nSpan; l++) {
            spanTags[l] = readTag('span tag');
            const pairs = readU32('span pair count');
            if (pairs > MAX_TIMELINE_SAMPLES) throw new RangeError(`decodeCapture: span samples exceed limit (${pairs})`);
            spanT0[l] = readF64Array(pairs, 'span t0');
            spanT1[l] = readF64Array(pairs, 'span t1');
        }

        if (offset + 1 > byteLength) throw new RangeError('decodeCapture: truncated instant lane count');
        const nInst = view.getUint8(offset); offset += 1;
        if (nInst > MAX_INSTANT_LANES) throw new RangeError(`decodeCapture: instant lanes exceed limit (${nInst})`);
        instantTags = new Array(nInst); instantTimes = new Array(nInst);
        for (let l = 0; l < nInst; l++) {
            instantTags[l] = readTag('instant tag');
            const marks = readU32('instant mark count');
            if (marks > MAX_TIMELINE_SAMPLES) throw new RangeError(`decodeCapture: instant samples exceed limit (${marks})`);
            instantTimes[l] = readF64Array(marks, 'instant times');
        }
    }

    return {
        version, count, numPhases, frames, phases, tags, meta, counters, counterTags,
        frameBoundaries, spanTags, spanT0, spanT1, instantTags, instantTimes
    };
}

/**
 * Serialize ONLY a TimelineRecorder — a v4 capture with a one-frame stub in the
 * core section (count/phases carry no timing data). Convenience for tools that
 * capture a timeline without an active Profiler.
 *
 * Implemented on top of a tiny stub rather than teaching encodeCapture to accept
 * a null profiler, which would push null-checks through the entire hot encoder.
 *
 * @param {import('./timeline.js').TimelineRecorder} timeline
 * @param {object|null} [meta]
 * @returns {ArrayBuffer|null} null when the recorder holds no data
 */
export function encodeTimelineCapture(timeline, meta = null) {
    const hasData = timeline && (timeline.frameCount > 0 ||
        _anySpanSamples(timeline) || _anyInstantSamples(timeline));
    if (!hasData) return null;
    return encodeCapture(_TIMELINE_STUB, null, meta, timeline);
}

// A zero-phase, single-frame profiler-shaped stub so the v4 core section is minimal
// and valid. One 0ms frame keeps encodeCapture's "no frames -> null" guard happy.
const _TIMELINE_STUB = Object.freeze({
    frame: { count: 1, copyTo(dst, o = 0) { dst[o] = 0; } },
    phaseCount: 0,
    counterCount: 0,
    phaseTags: [],
    counterTags: [],
    phaseAt() { return { count: 1 }; },
    counterAt() { return { count: 1 }; },
});

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
