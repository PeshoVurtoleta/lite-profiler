# Changelog

All notable changes to `@zakkster/lite-profiler` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic Versioning.

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
