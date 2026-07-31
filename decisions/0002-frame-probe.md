# lite-profiler v1.5.0 — createFrameProbe (SPP frame-telemetry probe)

Gives the standalone `Profiler` a Scope Probe Protocol (SPP) channel so a plain,
non-reactive profiler feeds `lite-scope` like every other probe in the suite.
Additive; `profiler.js` and the hot path are untouched.

## Why it is not redundant with lite-profiler-signal

The frame-telemetry opcode block `0x0410-0x0415` was reachable only through the
REACTIVE bridge: `lite-profiler-signal`'s probe samples a `createProfilerView`
result, dragging in a `lite-signal` peer + `lite-throttle` + `lite-watch-ex`.
`createFrameProbe` is the direct path — a bare `Profiler` + a DI'd sink, nothing
else. Headless / CI / non-reactive apps could not put frame telemetry on the
Scope before this. It is a second PRODUCER of a shared channel, not a new block;
an app runs one probe or the other, never both for the same profiler.

## Decisions

- **DF1 — home & name (user-confirmed).** `createFrameProbe`, a named export in
  lite-profiler core (`src/probe.js`), reusing the package's own `StatsMath` +
  `FrameHistogram`. Considered a standalone zero-import adapter in
  `LiteScopeAdapters/` (the convention for all 9 sibling probes), but a bare
  `Profiler` needs percentile + classifier math a zero-import file can't reach
  without re-implementing it. Keeping one source of truth for the telemetry math
  won; lite-profiler is the one package that ships its probe inline.
- **DF2 — zero-GC.** `StatsMath` + `FrameHistogram` + the `out` object are
  allocated ONCE at construction and reused; `sample()` emits six records and
  allocates nothing. Proven by a `--expose-gc` test: 50k samples < 64 KB.
  `StatsMath.compute` copies into a retained scratchpad and is safe + zeroing on
  an empty ring, so no empty-guard branch is needed in the hot path.
- **DF3 — reuse the FROZEN 0x041x block.** Opcode constants are inlined as
  PROTOCOL FACTS (not imported — probes couple by protocol, never dependency),
  matching PROTOCOL.md and the lite-profiler-signal producer so a core stream
  drops onto the existing CHANNELS scene and gate unchanged. A test pins the
  constants (0x0410-0x0415) and the descriptor block so drift fails CI.
- **DF4 — DI sink / cadence / fail-closed.** `createFrameProbe({ profiler, sink,
  streamId?, clock?, regressed? })`; sink duck-typed `write(packed,t,a,b)`,
  `packed = (streamId<<16 | opcode)>>>0`. `sample()` on the caller's cadence
  (descriptor advertises 10 Hz), one `clock()` call per sample shared by all six
  records. `dispose()`/`disposed` mirror the sibling probes. A bad profiler or
  sink throws `TypeError` (fail closed).
- **DF5 — numeric classEnum.** SPP slots are f64, so `OP_FRAME_CLASS.a` is a
  NUMBER: steady=0, spiking=1, throttled=2 (severity order), matching the
  sibling probe test's `frameClass: 1|2` contract. NOTE: the shipped
  lite-profiler-signal probe writes the raw string label from `view.frameClass()`
  into that slot — a latent f64-slot bug; the core probe emits the proper enum.
  `b` = `regressed()` predicate (default 0 — a bare Profiler has no baseline).

## Conformance test note (honest scope)

`lite-scope` is NOT a dependency of lite-profiler and is not installed here, and
none of the 9 shipped sibling probe tests import it — they assert against a MOCK
sink. `test/13-probe.test.js` follows that convention: a collector sink plus
exact equality of every emitted value against `summarize()` on the same profiler
(the package's own source of truth), the frozen opcodes, and the `streamId`
packing. A live `lite-scope` memory-sink round-trip would need lite-scope wired
into node_modules (a workspace step) and is deferred; the mock-sink + summarize
parity proves record correctness without it.

## Gates

- 135 node:test pass (124 -> +11); zero-alloc gate green under `--expose-gc`.
- `profiler.js` / `timeline.js` / `compare.js` untouched — the measuring stick
  does not move.
- TS declarations `tsc --strict` clean; pack ships `src/probe.*` at 1.5.0.
