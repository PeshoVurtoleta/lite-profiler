# lite-profiler v1.6.0 — createPhaseProbe (SPP phase-telemetry probe)

Gives the standalone `Profiler` a second Scope Probe Protocol (SPP) channel: the
per-phase breakdown (avg / p99 / max per registered phase), alongside the
whole-frame numbers `createFrameProbe` already streams. Additive; `profiler.js`,
the hot path, and `createFrameProbe` are untouched.

This is the producer half of a deliberately two-package change. The protocol home
is `@zakkster/lite-scope` 1.1.0, which froze a dedicated block **0x09
"lite-profiler phase telemetry"** FIRST (its own release); this package then
produces into it.

## Why a new block 0x09, not an extension of 0x04

Frame telemetry (block 0x04) is whole-frame: fixed six ops, one value each. Phase
telemetry is *keyed* — an unbounded set of app-named phases, each needing the same
three stats. The pragmatic option was to squat more sub-ops inside 0x04 (`0x042x`);
the chosen option was a clean, dedicated frozen block so the phase family has its
own protocol identity and room to grow, and so the frame block stays exactly what
it says it is. The user chose the purist two-package path over the single-package
shortcut. `@zakkster/lite-scope` owns the block; lite-profiler is its sole producer.

## Decisions

- **DP1 — home & name.** `createPhaseProbe`, a named export in lite-profiler core
  (`src/phase-probe.js`), a sibling file to `src/probe.js`. Mirrors `createFrameProbe`
  one-for-one (options shape, retained scratch, `sample()/dispose()/disposed`,
  fail-closed validation) and reuses the package's own `StatsMath`. One source of
  truth for the reduction math; lite-profiler is the one package that ships its
  probe inline (see 0002-frame-probe DF1).
- **DP2 — encoding: 1 stream, 3 LEVEL ops, tag id in `b`.** One `phase-telemetry`
  stream carries every phase; `0x0900 phase.avg / 0x0901 phase.p99 / 0x0902 phase.max`,
  all width-1 LEVEL, `a` = stat ms, `b` = dense phase tag id. Phases are STATIC
  (registered once at `Profiler` construction), so their ids are stable and dense —
  a single stream demuxes into N lanes by `b`, with no per-phase stream registration
  and no dynamic allocation. This mirrors the block 0x01 tagId convention (the
  producer's dense ids ride the payload; consumers resolve id→name out of band).
- **DP3 — `b` source: profiler index by default, intern bridge optional.** With no
  `intern`, `b` is the profiler's own dense phase index (`profiler.handle(tag)`
  order), meaningful against `profiler.phaseTags` for a sink-only decoupled probe.
  Pass `options.intern` (a `scope.intern` bridge) to carry scope-interned ids
  resolvable via the scope string table — the live-scope path. Either way the ids
  are computed ONCE at construction, off the hot path.
- **DP4 — zero-GC.** `StatsMath`, the `out` object, and a `Float64Array` tag-id
  table are allocated ONCE at construction and reused; `sample()` emits
  `3 × phaseCount` records and allocates nothing. Proven by a `--expose-gc` test:
  50k samples < 64 KB. `StatsMath.compute` is safe + zeroing on an empty ring, so
  an unsampled phase emits clean zeros (parity with `summarize()`), with no
  empty-guard branch in the loop.
- **DP5 — inline the FROZEN 0x090x opcodes as protocol facts.** `OP_PHASE_AVG/P99/MAX`
  and `PHASE_TELEMETRY_DESCRIPTOR` are inlined to match lite-scope's `PROTOCOL.md`
  block 0x09 and its `phaseTelemetry` golden vector — NOT imported. Probes couple by
  protocol, never by dependency. A test pins the constants (0x0900-0x0902) and the
  descriptor block so drift fails CI.
- **DP6 — DI sink / cadence / fail-closed.** `createPhaseProbe({ profiler, sink,
  streamId?, clock?, intern? })`; sink duck-typed `write(packed,t,a,b)`,
  `packed = (streamId<<16 | opcode)>>>0`. `sample()` on the caller's cadence
  (descriptor advertises 10 Hz), one `clock()` call per sample shared by every
  record. `dispose()`/`disposed` mirror the sibling probes. A bad profiler or sink
  throws `TypeError` (fail closed). A profiler with zero phases is valid and emits
  nothing.

## Conformance

Two layers, mirroring the frame probe:

- **`test/15-phase-probe.test.js`** — mock collector: canonical phase-major record
  order, stream routing + shared timestamp, `b` = phase index (default) and interned
  id (bridge), intern-once-at-construction, exact
  `summarize().phases[tag].{avg,p99,max}` parity, empty-phase zeros, no-phase no-op,
  dispose idempotence, fail-closed, and the `--expose-gc` alloc gate.
- **`test/16-phase-scope-conformance.test.js`** — live `@zakkster/lite-scope` 1.1.0
  (test-only devDependency): registers `PHASE_TELEMETRY_DESCRIPTOR` through a real
  `createScope`, writes into a real `createMemorySink`, decodes back through
  lite-scope's `readSlab` reference decoder. Proves block-0x09 stream routing, width-1
  records, that each `b` resolves to its tag via `scope.stringTable()`, and that the
  decoded avg/p99/max still exactly equal `summarize()`. `src/phase-probe.js` imports
  nothing from lite-scope — it is absent from `dependencies` and the tarball.

## Gates

- 155 node:test pass (138 → +17); zero-alloc gate green under `--expose-gc`.
- `profiler.js` / `timeline.js` / `compare.js` / `probe.js` untouched — the
  measuring stick does not move.
- `npm run bundle-check` clean (esbuild, `@zakkster/*` external); pack ships
  `src/phase-probe.*` at 1.6.0.
