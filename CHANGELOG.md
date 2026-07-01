# Changelog

All notable changes to `@zakkster/lite-profiler` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic Versioning.

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
