# Changelog

All notable changes to `@zakkster/lite-profiler` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic Versioning.

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
