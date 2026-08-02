# Changelog

All notable changes to `@zakkster/lite-profiler` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic Versioning.

## [1.7.0] - 2026-08-02

Per-counter telemetry on the Scope. This completes the SPP producer trilogy —
whole-frame (`createFrameProbe`, block 0x041x), per-phase (`createPhaseProbe`,
block 0x090x), and now per-counter. `createCounterProbe` reduces every registered
counter ring to avg / max / last and emits them on the **new frozen SPP block
0x0A**, one `counter-telemetry` stream, with the counter's tag id riding the
record's `b` slot. This lands the producer half of the two-package counter
channel; the protocol home is `@zakkster/lite-scope` 1.2.0 (block 0x0A). `src/`
still imports nothing from lite-scope. Decisions in
`decisions/0005-counter-channel.md`.

### Added

- **`createCounterProbe({ profiler, sink, streamId?, clock?, intern? })` →
  `{ sample(), dispose(), disposed }`** (`src/counter-probe.js`). Each `sample()`
  emits `3 × counterCount` records, grouped counter-major, into a DI'd sink.
  Zero-GC: the `StatsMath` scratch, the reused `out` object, and the per-counter
  tag-id table are allocated once at construction; a sample allocates nothing
  (proven under `--expose-gc`, 50k samples < 64 KB). A profiler with no counters
  emits nothing.
- **`COUNTER_TELEMETRY_DESCRIPTOR`** + **`OP_COUNTER_AVG` (0x0A00) /
  `OP_COUNTER_MAX` (0x0A01) / `OP_COUNTER_LAST` (0x0A02)** — the frozen block-0x0A
  opcodes, inlined as PROTOCOL FACTS (probes couple by protocol, never
  dependency), matching lite-scope's `PROTOCOL.md` and `counterTelemetry` golden
  vector.
- **Why avg / max / last (not the phase probe's avg / p99 / max).** Counters are
  deterministic, lower-is-better integers, so `last` (the exact current-frame
  value that is displayed and gated) and `max` (the ceiling gated at zero
  tolerance) matter more than a percentile of small integers. Every value equals
  `summarize().counters[tag].{avg,max,last}` exactly — avg/max via `StatsMath`,
  last via `ring.peekNewest()`, the same path `summarize()` takes.
- **`b` = counter tag id.** By default the profiler's own dense counter index;
  pass `options.intern` (a `scope.intern` bridge) to carry scope-interned ids
  instead. Interning happens once, at construction, off the hot path — per the
  block 0x01 tagId convention.
- **`test/17-counter-probe.test.js`** (mock collector) — canonical record order,
  stream routing, `b`-slot ids (index default + intern bridge), intern-once,
  exact `summarize().counters[tag].{avg,max,last}` parity (with a `last != max`
  case proving `last` is the newest sample), empty-counter zeros, no-counter
  no-op, dispose, fail-closed, and the `--expose-gc` alloc gate.
- **`test/18-counter-scope-conformance.test.js`** (live) — registers the
  descriptor through a real `createScope`, writes into a real `createMemorySink`,
  and decodes back through lite-scope's `readSlab`, proving block-0x0A
  routing/width and that each `b` resolves to its tag via the scope string table,
  with values still exactly matching `summarize()`.
- `@zakkster/lite-scope` devDependency bumped to `^1.2.0` (block 0x0A). Imported
  ONLY by the conformance test; absent from `dependencies` and the tarball.

### Unchanged

- No change to `createFrameProbe`, `createPhaseProbe`, the profiler hot path, or
  any existing record. Additive: a new stream on a new block. 173 tests (+17);
  zero-GC gate green.

## [1.6.0] - 2026-08-01

Per-phase telemetry on the Scope. `createFrameProbe` streams the whole-frame
channel; `createPhaseProbe` is its per-phase sibling — it reduces every registered
phase ring to avg / p99 / max and emits them on the **new frozen SPP block 0x09**,
one `phase-telemetry` stream, with the phase's tag id riding the record's `b` slot.
This lands the producer half of the two-package phase channel; the protocol home
is `@zakkster/lite-scope` 1.1.0 (block 0x09). `src/` still imports nothing from
lite-scope. Decisions in `decisions/0004-phase-channel.md`.

### Added

- **`createPhaseProbe({ profiler, sink, streamId?, clock?, intern? })` →
  `{ sample(), dispose(), disposed }`** (`src/phase-probe.js`). Each `sample()`
  emits `3 × phaseCount` records, grouped phase-major, into a DI'd sink. Zero-GC:
  the `StatsMath` scratch, the reused `out` object, and the per-phase tag-id table
  are allocated once at construction; a sample allocates nothing (proven under
  `--expose-gc`, 50k samples < 64 KB). A profiler with no phases emits nothing.
- **`PHASE_TELEMETRY_DESCRIPTOR`** + **`OP_PHASE_AVG` (0x0900) / `OP_PHASE_P99`
  (0x0901) / `OP_PHASE_MAX` (0x0902)** — the frozen block-0x09 opcodes, inlined as
  PROTOCOL FACTS (probes couple by protocol, never dependency), matching
  lite-scope's `PROTOCOL.md` and `phaseTelemetry` golden vector.
- **`b` = phase tag id.** By default the profiler's own dense phase index; pass
  `options.intern` (a `scope.intern` bridge) to carry scope-interned ids instead.
  Interning happens once, at construction, off the hot path — per the block 0x01
  tagId convention.
- **`test/15-phase-probe.test.js`** (mock collector) — canonical record order,
  stream routing, `b`-slot ids (index default + intern bridge), intern-once,
  exact `summarize().phases[tag].{avg,p99,max}` parity, empty-phase zeros,
  no-phase no-op, dispose, fail-closed, and the `--expose-gc` alloc gate.
- **`test/16-phase-scope-conformance.test.js`** (live) — registers the descriptor
  through a real `createScope`, writes into a real `createMemorySink`, and decodes
  back through lite-scope's `readSlab`, proving block-0x09 routing/width and that
  each `b` resolves to its tag via the scope string table, with values still
  exactly matching `summarize()`.
- `@zakkster/lite-scope` devDependency bumped to `^1.1.0` (block 0x09). Imported
  ONLY by the conformance test; absent from `dependencies` and the tarball.

### Unchanged

- No change to `createFrameProbe`, the profiler hot path, or any existing record.
  Additive: a new stream on a new block. 155 tests (+17); zero-GC gate green.

## [1.5.1] - 2026-07-31

Live conformance. v1.5.0 proved `createFrameProbe` against a mock sink plus exact
`summarize()` parity, and deferred a real `@zakkster/lite-scope` round-trip. This
patch adds it: a test-only run through the actual registry and reference decoder.
Behaviour is unchanged — `src/probe.js` and the profiler hot path are untouched.
Decisions in `decisions/0003-live-scope-conformance.md`.

### Added

- **`test/14-scope-conformance.test.js`** — registers `FRAME_TELEMETRY_DESCRIPTOR`
  through a real `createScope`, lets the probe write into a real `createMemorySink`,
  and decodes the bytes back through lite-scope's own `readSlab` reference decoder.
  Proves the registry-assigned stream id is the one on the wire, the probe's packing
  equals lite-scope's `pack()`, `widthOf` sees all six ops as width 1, and every
  decoded value still exactly equals `summarize()` — end to end, not against a mock.
- `@zakkster/lite-scope` as a **devDependency** (`file:../LiteScope`), imported ONLY
  by the conformance test. `src/probe.js` still imports nothing from it — probes
  couple by protocol, never by dependency — and it is absent from `dependencies` and
  the published tarball. The convention trade (dev-dep vs. vendored `vectors.json`)
  is recorded in the decision file.

### Unchanged

- No public API change; SPP records, opcodes, and the zero-GC hot path are identical
  to 1.5.0. 138 tests pass (+4 from the live conformance suite); the zero-GC gate
  stays green under `--expose-gc`.

## [1.5.0] - 2026-07-31

Scope probe. `createFrameProbe` gives the standalone `Profiler` a Scope Probe
Protocol (SPP) channel, so a plain non-reactive profiler streams frame telemetry
into `@zakkster/lite-scope` like every other probe in the suite. Additive; the
binary format and the profiler hot path are untouched. Decisions in
`decisions/0002-frame-probe.md`.

### Added

- **`createFrameProbe({ profiler, sink, streamId?, clock?, regressed? })`** — an
  SPP v1 probe over a live `Profiler`. `sample()` reduces the frame window to
  fps / avg / p99 / max / jank / class and emits six records into a DI'd sink
  (`write(packed, t, a, b)`, `packed = streamId<<16 | opcode`). Zero-GC: the
  `StatsMath` + `FrameHistogram` scratch is allocated once and reused, so a
  sample allocates nothing (proven under `--expose-gc`: 50k samples < 64 KB).
  `dispose()`/`disposed` mirror the suite's probes; a bad profiler or sink throws
  (fail closed).
- **`FRAME_TELEMETRY_DESCRIPTOR`** + the opcode constants **`OP_FPS` (0x0410)
  … `OP_FRAME_CLASS` (0x0415)** — the FROZEN SPP frame-telemetry block, inlined
  as protocol facts so a core-profiler stream drops onto the existing Scope
  CHANNELS scene and gate with no protocol change.

### Why it's not redundant with `lite-profiler-signal`

That block was previously reachable only through the reactive bridge
(`lite-profiler-signal` + a `lite-signal` peer + `lite-throttle` +
`lite-watch-ex`). `createFrameProbe` is the direct path — a bare `Profiler` plus
a sink, nothing else — for headless / CI / non-reactive apps. It is a second
*producer* of a shared channel, not a new block; run one probe or the other,
never both for the same profiler. (`OP_FRAME_CLASS.a` is emitted as a numeric
enum — steady=0, spiking=1, throttled=2 — the correct f64-slot value; the
reactive probe writes the raw string label there.)

### Tested

- 11 new checks (124 → 135): descriptor/opcode conformance to the frozen block;
  six-record emission in canonical order; `streamId` packing and a single shared
  timestamp; every emitted value asserted **exactly equal to `summarize()`** on
  the same profiler (one source of truth); the classifier→enum map; the empty
  profiler; `dispose()` idempotency; fail-closed argument validation; and the
  zero-allocation gate under `--expose-gc`.

### Note

- `lite-scope` is not a dependency and the sibling probe tests mock the sink, so
  the conformance test does too (asserting against `summarize()` parity + the
  frozen opcodes). A live `lite-scope` memory-sink round-trip is deferred to a
  workspace-wiring step, recorded rather than claimed.

## [1.4.0] - 2026-07-31

Exporters + CLI. A `.litecap` capture becomes two things it could not be before:
a **Chrome trace** loadable in Perfetto, and a file you can inspect, summarize,
diff and **gate from a terminal** with no browser. Fully additive; the binary
format, the profiler hot path, and every existing export are byte-for-byte
unchanged. Decisions in `decisions/0001-pr2-exporters-cli.md`.

### Added

- **`exportChromeTrace(decoded, opts?)`** — converts a decoded LiteCap **v4**
  timeline into the Chrome Trace Event object (`{ traceEvents, displayTimeUnit,
  metadata }`) that Perfetto and `chrome://tracing` load directly. Span pairs
  become `ph:'X'` complete events, instant marks `ph:'i'`, and frame boundaries
  a dedicated marker lane; each lane is its own thread. Timestamps scale
  `performance.now()` ms to Chrome's microseconds, kept absolute by default or
  zero-based with `{ normalize:true }`. It **refuses a v2/v3 capture** (throws):
  durations with no absolute clock cannot honestly reconstruct a flame chart —
  which is the whole reason the v1.3.0 timeline layer exists.
- **`npx litecap` CLI** (`bin/Litecap.mjs`) — `inspect`, `summarize`, `diff`,
  `gate`, `trace`. The grammar deliberately mirrors `lite-gc-gate`: verb-first,
  `--format console|json|markdown|github`, `--json <path>`, `--config <path>`,
  and the **same exit-code contract — 0 pass, 1 fail, 2 inconclusive, 3
  infrastructure error** — so a user who knows one CLI in the family knows this
  one. `gate` is a genuine three-state verdict: an empty capture, a schema
  mismatch, or a tolerance metric absent from both captures is **inconclusive
  (exit 2)**, never a silent pass. The CLI **delegates** every verdict to the
  in-process API (`decodeCapture` + `summarizeCapture` / `diffCaptures` /
  `checkRegression`) — a test pins the CLI's gate result equal to the API's on
  the same capture pair, so it can never drift into a second implementation.

### Tested

- 23 new checks (100 → 123): the Chrome trace validated against the trace-event
  schema (ph set, `dur >= 0`, per-thread ts monotonic) with a committed
  `test/fixtures/trace-sample.json`; span/instant/frame mapping and microsecond
  scaling; `normalize` zero-basing; v2/v3 refusal; the CLI driven as a
  subprocess across all five verbs asserting each exit code including the
  inconclusive case; and the CLI-gate == API-gate equality.
- **Live import into the Perfetto UI is a manual step** (there is no browser in
  the build environment) — the committed fixture and schema assertions stand in
  for it in CI; the manual load is recorded here rather than claimed as an
  automated gate.

### Unchanged

- `src/profiler.js`, `src/timeline.js`, `src/litecap.js` and `src/compare.js`
  are untouched — the measuring stick does not move in a release that only adds
  readers of what it already produces.

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
