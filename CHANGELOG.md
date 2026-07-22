# Changelog

All notable changes to `@zakkster/lite-profiler` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic Versioning.

## [1.3.0] - 2026-07-14

Timeline capture layer. The core rings store DURATIONS; a flame chart also needs to
know WHEN each span started on a shared clock. `TimelineRecorder` captures that missing
axis — absolute `performance.now()` t0/t1 span pairs, frame boundaries, and instant
marks — which is the prerequisite for any Perfetto / Chrome-trace / flame-chart exporter.
Fully additive: a capture with no timeline is byte-identical to a 1.2.0 capture.

### Added
- **`TimelineRecorder(capacity?, spanTags?, instantTags?)`** — opt-in, independent of
  `Profiler` (use standalone or alongside). Zero-GC hot path, static tag registration,
  power-of-two capacity, `reset()` / `destroy()` — every convention mirrors `Profiler`.
  - `recordFrameBoundary(t?)`, `beginSpan(tag,t0?)` / `endSpan(tag,t1?)` (+ `…At(handle)`
    fast forms), `mark(tag,t?)` for instants. Handles via `spanHandle` / `instantHandle`.
  - Accessors return the live ring: `frameBoundaries`, `spanT0(tag)` / `spanT1(tag)`,
    `instantTime(tag)`, plus `…At(handle)` forms. `copyTo` unwinds oldest-first.
  - **Its own raw `Float64Array` rings**, not the shared `RingBuffer`. The shared ring is
    Float32, which is right for small deltas but fatal for absolute time: an hour into a
    session `performance.now()` is large enough that a Float32 ULP exceeds a millisecond
    and a sub-ms span start is quantized away (measured ~44 s of error at a realistic
    `timeOrigin`). `profiler.js` documents exactly this tension for its own `_starts`.
- **LiteCap v4** — a timeline trailer after the v3 counter section: frame boundaries,
  then per span lane `{ tag, pairCount, t0[], t1[] }`, then per instant lane
  `{ tag, markCount, times[] }`, all `float64`. `encodeCapture(profiler, scratch, meta,
  timeline)` gains an optional fourth argument; `encodeTimelineCapture(timeline, meta?)`
  serializes a timeline with no active profiler. `decodeCapture` returns
  `frameBoundaries`, `spanTags`, `spanT0[]`, `spanT1[]`, `instantTags`, `instantTimes[]`.
- `LITECAP` advertises `MAX_SPAN_LANES`, `MAX_INSTANT_LANES`, `MAX_TIMELINE_SAMPLES`.

### Changed
- `LITECAP.VERSION` → **4** (the max emit version). **Version discipline is unchanged
  and strict:** emit the LOWEST version that fits the data. No timeline and no counters →
  v2. Counters → v3. A `TimelineRecorder` *with samples* → v4. An empty recorder does
  **not** bump the version, and a timeline-free capture is byte-for-byte identical to a
  1.2.0 capture — so older readers are unaffected. A v4 capture is correctly *rejected*
  by a v3-capped reader (hard "unsupported version" error), never silently truncated to
  a blank timeline.

### Fixed
- The counter section is now written whenever `version >= 3`, even when zero counters are
  registered (a v4 timeline-only capture). Under v3 the section's presence was equivalent
  to "counters exist"; v4 breaks that equivalence, and the 1-byte counter-count header
  must still be present to keep the decoder's `version >= 3` read aligned.

### Tested
- 18 new checks (82 → 100): Float64 round-trip at a realistic `now()` magnitude,
  oldest-first ring wrap, begin/end pairing edge cases, full v4 encode/decode of frames +
  spans + instants + coexisting counters, empty-lane round-trip, byte-identical
  no-timeline capture, empty-recorder-does-not-bump, standalone `encodeTimelineCapture`,
  and truncated-trailer rejection.

## [1.2.0] - 2026-07-02

Counter channel. Deterministic per-frame command counters (draw calls, floats
uploaded, instances, ...) recorded alongside timings, so counts gate EXACTLY and
headlessly in the same version matrix as timings. Fully additive: a Profiler with
no counters behaves exactly as 1.1.0.

### Added
- `Profiler(capacity?, phases?, counters?)` - an optional third argument registers
  static counter tags. `count(tag, n?)` / `countAt(handle, n?)` accumulate within a
  frame (zero-alloc hot path, mirroring `begin`/`beginAt`); accumulators flush one
  value per counter to a ring on `endFrame()`. Accessors: `counterHandle(tag)`,
  `counterTagOf(handle)`, `counter(tag)`, `counterAt(handle)`, `counterCount`.
- CaptureSummary gains a `counters` block: `{ [tag]: { sum, avg, min, max, p01,
  p99, last, count } }`. `sum` is an exact integer total (Float64 accumulation),
  exact well past 2^24 as long as each per-frame value is < 2^24. Counter rings are
  Float32-backed, so per-frame values above 2^24 quantize deterministically.
- Regression gating on `counter.<tag>.<metric>` paths. Counters are lower-is-better
  and deterministic: gate at zero tolerance for an exact ceiling, e.g.
  `checkRegression(base, cand, { 'counter.floatsUploaded.max': 0 })`. `diffCaptures`
  gains a matching `counters` block.

### Changed
- `SUMMARY_SCHEMA` -> **2**: the summary now carries `counters`; `frame` and
  `phases` are unchanged, so existing readers keep working.
- LiteCap format -> **v3** when counters are present: a counter trailer (data +
  tags) is appended after the v2 meta blob. A capture with no counters still emits
  **v2**, so older readers decode it unchanged. `decodeCapture()` now returns
  `counters` (`Float32Array[]`) and `counterTags`. `LITECAP.MAX_COUNTERS` added.

### Fixed
- Regression integrity for counter paths: a counter the baseline tracked that the
  candidate no longer reports is now a regression (`reason: 'metric missing in
  candidate'`) instead of a silent skip. Frame and phase paths keep their lenient
  skip (a phase may legitimately not fire), so existing gates are unaffected.

## [1.1.0] - 2026-07-01

Capture comparison and regression gating. Reduce a profiling window to a small,
self-describing summary, diff two summaries, and gate CI on regressions. Engine-
agnostic: the instrument for tracking one workload across builds (e.g. a reactive
graph profiled under lite-signal 1.3.0 vs 1.4.0 vs 1.7.0).

### Added
- `summarize(profiler, meta?)` -> a JSON-serializable CaptureSummary: frame
  `avg/min/max/p01/p99/fps`, `jankRatio`, `spikeRatio`, `frameClass`, histogram
  `bins`, and per-phase stats, tagged with optional `{ label, engine, budgetMs }`.
- `summarizeCapture(decoded, meta?)` -> summarize a decoded LiteCap.
- `diffCaptures(baseline, candidate)` -> per-metric `{ base, cand, delta, pct }`.
- `checkRegression(baseline, candidate, tolerances?)` -> non-throwing report.
- `assertNoRegression(baseline, candidate, tolerances?)` -> throws a
  `RegressionError` (carrying `err.report`) when a gated metric worsens beyond
  tolerance; drops straight into `node:test`.
- `DEFAULT_TOLERANCES` (`frame.avg` and `frame.p99` at `+10%`) and `SUMMARY_SCHEMA`.

### Changed
- LiteCap capture format bumped to **v2**: a capture now embeds its phase tags
  and an optional metadata blob (engine/label/...), making a saved `.litecap`
  self-describing. `encodeCapture(profiler, scratch?, meta?)` gained the `meta`
  argument; `decodeCapture()` now returns `tags` and `meta`. v1 buffers still
  decode (`tags: []`, `meta: null`) — no consumer action required.

## [1.0.0] - 2026-06-30

Initial release. Engine-agnostic, zero-GC frame and per-phase profiler.

### Added
- **`Profiler`** - frame and per-phase timing capture into power-of-two ring
  buffers. String tags for ergonomics and integer handles for the hot path;
  zero allocation and zero signal writes per frame.
- **`FrameHistogram`** - log-bucketed frame-time distribution (`<2` .. `>=66` ms)
  with a bimodal classifier that separates sparse spikes (GC-pause signature)
  from sustained elevation (throttle / CPU-bound signature). Exposes raw `bins`,
  `jankRatio`, and `spikeRatio` so callers can apply their own rule.
- **`encodeCapture` / `decodeCapture`** - binary `.litecap` capture format with
  a validating reader (magic, version, and exact byte-length bounds check, so
  untrusted input cannot over-read).
- **`downloadCapture`** - browser download helper.
- **`FrameBudget` / `budgetMs` / `isOverBudget`** - frame budget presets for
  30 / 60 / 120 fps targets.
- **`MeterHud`** - minimal CPU overlay rendering the frame-time envelope via
  `@zakkster/lite-canvas-graph`.
- Full TypeScript declarations beside every module.

### Notes
- The reactive surface (a `lite-signal` bridge), engine adapters
  (`lite-scheduler`, `lite-ecs`), and a GPU renderer ship as separate packages
  on top of this core, keeping the core dependency-light and signal-free.
