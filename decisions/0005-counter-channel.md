# lite-profiler v1.7.0 — createCounterProbe (SPP counter-telemetry probe)

Gives the standalone `Profiler` a third Scope Probe Protocol (SPP) channel: the
per-counter breakdown (avg / max / last per registered counter), alongside the
whole-frame numbers `createFrameProbe` streams and the per-phase numbers
`createPhaseProbe` streams. This completes the SPP producer trilogy — frame
(block 0x041x), phase (block 0x090x), counter (block 0x0A0x). Additive;
`profiler.js`, the hot path, `createFrameProbe`, and `createPhaseProbe` are
untouched.

This is the producer half of a deliberately two-package change, mirroring the
phase channel (0004). The protocol home is `@zakkster/lite-scope` 1.2.0, which
froze a dedicated block **0x0A "lite-profiler counter telemetry"** FIRST (its own
release); this package then produces into it.

## Why a new block 0x0A, not an extension of 0x09

Block 0x09 is *phase* telemetry — a keyed set of timing phases in milliseconds.
Counters are a different keyed family: deterministic per-frame command counts
(draw calls, floats uploaded), dimensionless and lower-is-better. They deserve
their own protocol identity and stat semantics rather than squatting more sub-ops
inside the phase block. The user chose the same purist two-package path as the
phase channel. `@zakkster/lite-scope` owns the block; lite-profiler is its sole
producer.

## Decisions

- **DC1 — home & name.** `createCounterProbe`, a named export in lite-profiler
  core (`src/counter-probe.js`), a sibling file to `src/probe.js` and
  `src/phase-probe.js`. Mirrors `createPhaseProbe` one-for-one (options shape,
  retained scratch, `sample()/dispose()/disposed`, fail-closed validation) and
  reuses the package's own `StatsMath`. One source of truth for the reduction
  math; lite-profiler is the one package that ships its probe inline.
- **DC2 — encoding: 1 stream, 3 LEVEL ops, tag id in `b`.** One
  `counter-telemetry` stream carries every counter; `0x0A00 counter.avg /
  0x0A01 counter.max / 0x0A02 counter.last`, all width-1 LEVEL, `a` = stat count,
  `b` = dense counter tag id. Counters are STATIC (registered once at `Profiler`
  construction), so their ids are stable and dense — a single stream demuxes into
  N lanes by `b`, with no per-counter stream registration and no dynamic
  allocation. Unit is `count` (dimensionless), not `ms`.
- **DC3 — stat trio avg / max / last (NOT the phase probe's avg / p99 / max).**
  Counters are deterministic, lower-is-better integers. `last` is the exact
  current-frame value that is displayed and gated; `max` is the ceiling gated at
  zero tolerance; `avg` is typical load. A percentile of a small integer counter
  is a weak signal, so `p99` is dropped in its favour. `last` costs one extra
  cheap ring read (`ring.peekNewest()`) beyond `StatsMath.compute` — still
  zero-alloc, and exactly the path `summarize()` takes for `counters[tag].last`.
- **DC4 — `b` source: profiler index by default, intern bridge optional.** With
  no `intern`, `b` is the profiler's own dense counter index
  (`profiler.counterHandle(tag)` order), meaningful against
  `profiler.counterTags` for a sink-only decoupled probe. Pass `options.intern`
  (a `scope.intern` bridge) to carry scope-interned ids resolvable via the scope
  string table — the live-scope path. Either way the ids are computed ONCE at
  construction, off the hot path.
- **DC5 — zero-GC.** `StatsMath`, the `out` object, and a `Float64Array`
  tag-id table are allocated ONCE at construction and reused; `sample()` emits
  `3 × counterCount` records and allocates nothing. Proven by a `--expose-gc`
  test: 50k samples < 64 KB. `StatsMath.compute` is safe + zeroing on an empty
  ring and `ring.peekNewest()` returns 0 on empty, so an unsampled counter emits
  clean zeros (parity with `summarize()`), with no empty-guard branch in the loop.
- **DC6 — inline the FROZEN 0x0A0x opcodes as protocol facts.**
  `OP_COUNTER_AVG/MAX/LAST` and `COUNTER_TELEMETRY_DESCRIPTOR` are inlined to
  match lite-scope's `PROTOCOL.md` block 0x0A and its `counterTelemetry` golden
  vector — NOT imported. Probes couple by protocol, never by dependency. A test
  pins the constants (0x0A00-0x0A02) and the descriptor block so drift fails CI.
- **DC7 — DI sink / cadence / fail-closed.** `createCounterProbe({ profiler,
  sink, streamId?, clock?, intern? })`; sink duck-typed `write(packed,t,a,b)`,
  `packed = (streamId<<16 | opcode)>>>0`. `sample()` on the caller's cadence
  (descriptor advertises 10 Hz), one `clock()` call per sample shared by every
  record. `dispose()`/`disposed` mirror the sibling probes. A bad profiler or
  sink throws `TypeError` (fail closed). A profiler with zero counters is valid
  and emits nothing.

## Conformance

Two layers, mirroring the phase probe:

- **`test/17-counter-probe.test.js`** — mock collector: canonical counter-major
  record order, stream routing + shared timestamp, `b` = counter index (default)
  and interned id (bridge), intern-once-at-construction, exact
  `summarize().counters[tag].{avg,max,last}` parity (with a `last != max` case
  proving `last` is the newest sample), empty-counter zeros, no-counter no-op,
  dispose idempotence, fail-closed, and the `--expose-gc` alloc gate.
- **`test/18-counter-scope-conformance.test.js`** — live `@zakkster/lite-scope`
  1.2.0 (test-only devDependency): registers `COUNTER_TELEMETRY_DESCRIPTOR`
  through a real `createScope`, writes into a real `createMemorySink`, and decodes
  back through lite-scope's `readSlab` reference decoder. Proves block-0x0A stream
  routing, width-1 records, that each `b` resolves to its tag via
  `scope.stringTable()`, and that the decoded avg/max/last still exactly equal
  `summarize()`. `src/counter-probe.js` imports nothing from lite-scope — it is
  absent from `dependencies` and the tarball.

## Gates

- 173 node:test pass (+17); zero-alloc gate green under `--expose-gc`.
- `profiler.js` / `timeline.js` / `compare.js` / `probe.js` / `phase-probe.js`
  untouched — the measuring stick does not move.
- `npm run bundle-check` clean (esbuild, `@zakkster/*` external); `tsc --strict`
  clean; pack ships `src/counter-probe.*` at 1.7.0.
