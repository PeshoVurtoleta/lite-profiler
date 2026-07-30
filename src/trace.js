/**
 * @zakkster/lite-profiler
 *
 * Chrome Trace Event exporter. Turns a decoded LiteCap v4 timeline into the
 * JSON object format that Perfetto (ui.perfetto.dev) and chrome://tracing load
 * directly, so a `.litecap` becomes a shareable flame chart with no bespoke
 * viewer.
 *
 * WHY v4 ONLY. The core Profiler stores DURATIONS on a Float32 ring; a flame
 * chart needs to know WHEN each span started on a shared clock. That absolute
 * axis lives only in a TimelineRecorder (LiteCap v4). A v2/v3 capture cannot be
 * turned into an honest flame chart, so this exporter refuses one rather than
 * inventing an end-to-end layout. (See decisions/0001-pr2-exporters-cli.md DP2f.)
 *
 * Chrome Trace Event Format reference: timestamps and durations are in
 * MICROSECONDS. TimelineRecorder times are performance.now() milliseconds, so
 * every value is scaled x1000. pid is a single synthetic process; each span,
 * instant, and the frame-boundary marker gets its own thread (tid) so lanes
 * stack independently in the UI.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

const US_PER_MS = 1000;

/** Round microseconds to nanosecond precision so the JSON stays compact. */
function us(ms) { return Math.round(ms * US_PER_MS * 1000) / 1000; }

function hasTimeline(d) {
    if (d.frameBoundaries && d.frameBoundaries.length > 0) return true;
    if (d.spanT0) for (let i = 0; i < d.spanT0.length; i++) if (d.spanT0[i] && d.spanT0[i].length) return true;
    if (d.instantTimes) for (let i = 0; i < d.instantTimes.length; i++) if (d.instantTimes[i] && d.instantTimes[i].length) return true;
    return false;
}

/**
 * The smallest absolute timestamp across the whole timeline, in ms. Used when
 * `normalize` zero-bases the trace to its first event.
 */
function minTime(d) {
    let m = Infinity;
    const fb = d.frameBoundaries;
    if (fb) for (let i = 0; i < fb.length; i++) if (Number.isFinite(fb[i]) && fb[i] < m) m = fb[i];
    if (d.spanT0) for (let l = 0; l < d.spanT0.length; l++) {
        const a = d.spanT0[l];
        if (a) for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && a[i] < m) m = a[i];
    }
    if (d.instantTimes) for (let l = 0; l < d.instantTimes.length; l++) {
        const a = d.instantTimes[l];
        if (a) for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && a[i] < m) m = a[i];
    }
    return m === Infinity ? 0 : m;
}

/**
 * Convert a decoded LiteCap v4 capture into a Chrome Trace Event object.
 *
 * @param {object} decoded a `decodeCapture()` result carrying timeline data
 *   (`frameBoundaries`, `spanTags`, `spanT0[]`, `spanT1[]`, `instantTags`,
 *   `instantTimes[]`).
 * @param {object} [opts]
 * @param {boolean} [opts.normalize=false] zero-base every timestamp to the
 *   earliest event instead of keeping absolute performance.now() values.
 * @param {string}  [opts.processName] overrides the process label (defaults to
 *   the capture's meta.label, else 'lite-profiler capture').
 * @returns {{traceEvents:object[], displayTimeUnit:string, metadata:object}}
 * @throws {TypeError} if `decoded` is not a decoded capture.
 * @throws {Error} if the capture carries no timeline data (v2/v3) — see DP2f.
 */
export function exportChromeTrace(decoded, opts = null) {
    if (!decoded || !decoded.frames || !Array.isArray(decoded.phases)) {
        throw new TypeError('exportChromeTrace: expected a decoded LiteCap');
    }
    if (!hasTimeline(decoded)) {
        throw new Error(
            'exportChromeTrace: capture has no timeline data (v' + decoded.version + '). ' +
            'A flame chart needs absolute span start times — re-capture with a ' +
            'TimelineRecorder (LiteCap v4). Durations alone cannot place spans on a clock.'
        );
    }

    const normalize = !!(opts && opts.normalize);
    const base = normalize ? minTime(decoded) : 0;
    const pid = 1;
    const events = [];

    const label = (opts && opts.processName != null) ? String(opts.processName)
        : (decoded.meta && decoded.meta.label != null) ? String(decoded.meta.label)
            : 'lite-profiler capture';
    events.push({ ph: 'M', name: 'process_name', pid, args: { name: label } });

    let tid = 0;

    // Frame boundaries -> a dedicated lane of instant markers.
    const fb = decoded.frameBoundaries;
    if (fb && fb.length) {
        events.push({ ph: 'M', name: 'thread_name', pid, tid, args: { name: 'frames' } });
        for (let i = 0; i < fb.length; i++) {
            const t = fb[i];
            if (!Number.isFinite(t)) continue;
            events.push({ ph: 'i', name: 'frame', pid, tid, ts: us(t - base), s: 't' });
        }
        tid++;
    }

    // Span lanes -> complete ('X') events, one thread per lane.
    const spanTags = decoded.spanTags || [];
    for (let l = 0; l < spanTags.length; l++) {
        const t0 = decoded.spanT0[l], t1 = decoded.spanT1[l];
        events.push({ ph: 'M', name: 'thread_name', pid, tid, args: { name: spanTags[l] } });
        const n = t0 ? t0.length : 0;
        for (let i = 0; i < n; i++) {
            const a = t0[i], b = t1[i];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const dur = b > a ? b - a : 0;   // pairs are ordered by construction; clamp defensively
            events.push({ ph: 'X', name: spanTags[l], pid, tid, ts: us(a - base), dur: us(dur) });
        }
        tid++;
    }

    // Instant lanes -> instant ('i') events, one thread per lane.
    const instTags = decoded.instantTags || [];
    for (let l = 0; l < instTags.length; l++) {
        const times = decoded.instantTimes[l];
        events.push({ ph: 'M', name: 'thread_name', pid, tid, args: { name: instTags[l] } });
        const n = times ? times.length : 0;
        for (let i = 0; i < n; i++) {
            const t = times[i];
            if (!Number.isFinite(t)) continue;
            events.push({ ph: 'i', name: instTags[l], pid, tid, ts: us(t - base), s: 't' });
        }
        tid++;
    }

    return {
        traceEvents: events,
        displayTimeUnit: 'ms',
        metadata: {
            source: '@zakkster/lite-profiler',
            litecapVersion: decoded.version,
            normalized: normalize,
            captureMeta: decoded.meta || null
        }
    };
}
