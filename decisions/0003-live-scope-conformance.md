# lite-profiler v1.5.1 — live lite-scope conformance test

v1.5.0 shipped `createFrameProbe` with conformance proven against a MOCK collector
sink plus exact `summarize()` parity (decisions/0002-frame-probe.md). That decision
recorded the honest gap: a live round-trip through the real `@zakkster/lite-scope`
registry was *deferred*, because lite-scope was not wired in. This patch closes it.
Test-only; no runtime behaviour changes, so it is a patch (1.5.1), not a minor.

## What the live test proves that the mock could not

`test/14-scope-conformance.test.js` builds a REAL `createScope`, registers
`FRAME_TELEMETRY_DESCRIPTOR` through the actual registry (which assigns the stream
id), lets the probe write into a real `createMemorySink`, and decodes the bytes
back through lite-scope's own reference decoder `readSlab(slab, scope.widthOf, cb)`.

- The registry-assigned `channel.id` is exactly the stream id the decoder reads
  back, and the probe's independent packing (`streamId<<16 | opcode`) equals
  lite-scope's own `pack(channel.id, op)` — two independent packers agree on the
  wire, not just the probe agreeing with itself.
- `scope.widthOf` sees all six ops as width 1, so `readSlab` surfaces each as a
  clean `[a, b]` record (`count === 2`) with no CONT chaining — the descriptor
  registers without drift.
- Every decoded value still EXACTLY equals `summarize()` on the same profiler,
  now through the reference decoder rather than a collector array.
- The live sink holds exactly `1` EPOCH meta record (emitted by `createScope`)
  plus the `6` telemetry records — nothing spurious, nothing missing.
- The classifier enum (steady=0 / spiking=1 / throttled=2) survives the
  round-trip for all three frame states.

## The convention tension (recorded, not hidden)

lite-scope's README (line 14) states its conformance model for probes: **copy-vendor
`vectors.json`, no dev-dep** — "Probes never import this package." Two honest reads:

- **`vectors.json` alone cannot exercise this probe.** Those golden vectors test the
  PROTOCOL PRIMITIVES (packing, layout checksum), not a specific probe's records.
  Proving `createFrameProbe` end to end needs the live decoder, which is runtime
  code, not a static fixture.
- **The SPP invariant is about the SOURCE, not the test.** The rule "probes couple
  by protocol, never by dependency" is preserved verbatim: `src/probe.js` imports
  nothing from lite-scope; the opcodes remain inlined protocol facts. lite-scope is
  a **devDependency** (`file:../LiteScope`) imported ONLY by the test — invisible to
  consumers (not in `dependencies`, not in the `files` tarball, `sideEffects:false`
  unchanged).

The trade: this is the one suite probe whose test takes a lite-scope dev-dep instead
of vendoring `vectors.json`. Chosen because a live registry round-trip is a strictly
stronger proof than a mock, and the runtime purity that actually matters — the probe
shipping zero coupling to lite-scope — is untouched. User-directed (they picked the
live round-trip over the vendored-vectors path).

## Gates

- 138 node:test pass (+4 live-conformance tests); the v1.5.0 zero-GC gate stays
  green under `--expose-gc` (probe source unchanged).
- `src/probe.js` and the profiler hot path are untouched — this patch adds only a
  test and a devDependency.
