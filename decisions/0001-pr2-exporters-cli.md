# PR2 — lite-profiler v1.4.0: exporters + CLI

Roadmap brief PR2 (ROADMAP.md 1215-1253). Turns a `.litecap` capture into a CI
artifact (`exportChromeTrace`) and a terminal-inspectable/gateable file
(`npx litecap`). Fully additive; no format change; hot encode/decode untouched.

## DP2a — CLI packaging & verbs

`bin: { "litecap": "./bin/Litecap.mjs" }`, ESM, `#!/usr/bin/env node`, no new
runtime deps (reads files + delegates to existing modules). Operates on
`.litecap` *files* (read bytes -> `decodeCapture`), unlike lite-gc-gate which
spawns a target script. Verbs:

- `inspect <cap>`   — structural header dump (version, count, phases, counters, meta, timeline lanes)
- `summarize <cap>` — `summarizeCapture` -> CaptureSummary
- `diff <base> <cand>` — `diffCaptures`
- `gate <base> <cand>` — `checkRegression` -> exit 0/1/2
- `trace <cap> [-o out]` — `exportChromeTrace` -> Chrome trace JSON

## DP2b — mirror lite-gc-gate's surface, not its shape

lite-gc-gate is a *script runner* (`run <script> --reps --baseline --ratchet`);
those verbs do not map to file analysis. What is mirrored deliberately is the
CLI *grammar* a family user already knows:

- verb-first args; unknown arg / bad usage -> stderr message + exit 3.
- `--format console|json|markdown|github` (console + json fully; markdown/github
  are thin console/json wrappers so the flag never lies about accepting them).
- `--json <path>` — also write the JSON envelope to a file.
- `--config <path>` — gate tolerances `{ "tolerances": { "frame.p99": 0.1 } }`.
- `--allow-inconclusive` — accepted for parity; inconclusive still exits 2 (as
  lite-gc-gate does) so CI can always distinguish it.
- **Exit codes identical:** 0 pass, 1 fail, 2 inconclusive, 3 infrastructure
  error (file missing, bad magic, unsupported version, unreadable). A second CLI
  in the family with different codes is a tax paid forever — so they match.

## DP2c — Chrome Trace Event mapping (verify in real Perfetto)

Output: `{ traceEvents:[...], displayTimeUnit:"ms", metadata:{...} }`.
Chrome/Perfetto timestamps are **microseconds**; timeline times are
`performance.now()` **ms** -> `ts = ms * 1000` (rounded to 1e-3 us = ns).
`pid = 1`. Lanes become threads:

- frame boundaries -> thread tid 0 "frames", each boundary `ph:'i', s:'t'` name `frame`.
- span lane l    -> thread tid (1+l) named `spanTags[l]`; each (t0,t1) pair -> `ph:'X'` complete event `{ts:t0, dur:t1-t0}`.
- instant lane l -> thread tid (1+nSpan+l) named `instantTags[l]`; each mark -> `ph:'i', s:'t'`.
- thread/process names via `ph:'M'` metadata events.

Timestamps kept ABSOLUTE by default (provenance); `{ normalize:true }` zero-bases
to the earliest event. Non-finite samples skipped; negative dur clamped to 0.

## DP2d — the CLI delegates; it is not a second implementation

`summarize`/`diff`/`gate` call `decodeCapture` + `summarizeCapture` /
`diffCaptures` / `checkRegression` from compare.js verbatim. The gate verdict IS
`checkRegression(base, cand, tol).ok`. A test asserts the CLI's gate verdict and
regression list equal the in-process API on the same capture pair — if they ever
diverge, the CLI grew a second implementation and the test fails.

## DP2e — three-state gate verdict ("could not measure" is not "passed")

Same discipline as lite-gc-profiler's inconclusive verdict. In the CLI wrapper
(NOT in compare.js — the API stays pure):

- **inconclusive (exit 2)** when either capture has `frameCount === 0`, or the two
  summaries carry different `schema`, or every configured tolerance metric is
  unreadable in one side (nothing actually compared).
- else **fail (exit 1)** if `!checkRegression.ok`, else **pass (exit 0)**.

A gate that cannot tell "passed" from "did not measure" is the exact failure the
profiler family exists to prevent.

## DP2f — exportChromeTrace REQUIRES timeline data

A v2/v3 capture stores durations with no absolute start clock — a flame chart
cannot be honestly reconstructed from it (this is literally PR1's premise: "a
flame chart also needs to know WHEN each span started"). If `decoded` carries no
frame boundaries, spans, or instants, `exportChromeTrace` throws a clear error
pointing at TimelineRecorder rather than fabricating a synthetic end-to-end
layout. No invented timestamps.

## Gates

- A produced trace validated against the Chrome Trace Event schema (required
  fields, ph in {X,i,M}, dur>=0, per-thread ts monotonic for X) and committed as
  `test/fixtures/trace-sample.json`. NOTE: live import into the Perfetto UI is a
  MANUAL step (no browser in the build env) — recorded honestly, not asserted.
- Every CLI subcommand round-trips a real capture built in-test.
- Exit codes asserted per outcome incl. the inconclusive case.
- CLI gate verdict == in-process `checkRegression` on the same pair.
- SHA256 hash parity on `begin`/`end`/`beginAt`/`endAt` — the measuring stick
  (profiler hot path) is not touched by this release.

Blocks G2 (lite-gl v1.5.0 counters seam).
