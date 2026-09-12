# Lifecycle and nested-match compiler checkpoint

2026-09-11, Apple M4 Pro, macOS Darwin 25.4.0 arm64.

This is a build-latency guardrail for the lifecycle-callable and nested enum
match fixes, not an optimization or runtime-performance claim. The native
compiler completed its fixed-point bootstrap before the after measurements.

## Method and provenance

The existing `benchmarks/build-latency.ts` workload uses 24 Z modules with 16
helpers each and a tiny C header with a transitive dependency. It measures
`z build`, excludes executable validation time, and verifies the checksum and
expected cache-hit/miss status after every build. Debug is `-O0`, release is
`-O2 -DNDEBUG`. Host filesystem/toolchain caches remain warm.

- [Before: three trials](build-latency-lifecycle-before-2026-09-11.json), using
  the previously bootstrapped native compiler.
- [Initial after: three trials](build-latency-lifecycle-initial-2026-09-11.json),
  immediately after replacing the bootstrap artifacts.
- [Confirmation after: five trials](build-latency-lifecycle-2026-09-11.json),
  using the same rebuilt compiler.

All reports identify base revision `50f6788c` with a dirty worktree. Stage 0
uses the working-tree source in all three runs, so its before/after movement
is not a comparison of two Stage-0 revisions. Compiler tests were not running
alongside the benchmarks; other desktop activity was not controlled.

Native executable SHA-256:

```text
before b4eb7cd30a1030a8077b3cc7e460cc430b7142e055927532f88e47408ab6313c
after  fe5c78fea1c0d08fc6606c15c533b61427437225afdc6f6426e8b0a39e8f531b
```

The bootstrap also replaces the adjacent foreign-metadata adapter. These are
whole-toolchain measurements, not an isolated lowering-pass A/B comparison.

## Native results

Medians in seconds; the after column uses the five-trial confirmation.

| Scenario | Before | After |
| --- | ---: | ---: |
| Fresh project cache | 0.233 | 0.371 |
| Unchanged | 0.044 | 0.047 |
| One module changed | 0.179 | 0.190 |
| Unchanged after source edit | 0.046 | 0.054 |
| Transitive header changed | 0.248 | 0.259 |
| Unchanged after header edit | 0.044 | 0.048 |
| Switch to release | 0.181 | 0.199 |
| Release unchanged | 0.044 | 0.049 |
| Return to debug | 0.166 | 0.173 |
| Debug unchanged | 0.044 | 0.051 |

Warm unchanged builds remain roughly 40–55 ms in most samples, and ordinary
source-change builds roughly 180–200 ms. Every cache correctness and executable
checksum assertion passed.

Fresh-cache measurements increased and are **not cleared as noise**: the
confirmation range was 0.240–0.384 s versus 0.229–0.341 s before. The initial
after run also included a 1.651 s first native build, retained in its raw data.
Stage 0, whose source did not change between these runs, also moved from 0.306
to 0.340 s median on fresh caches. Consequently these runs do not establish
how much of the increase belongs to the compiler changes, adapter/startup
caches, or host variation.

Follow-up if the increase persists: interleave preserved before/after native
binaries against the same adapter and profile cache-miss phases. Do not claim
a compiler speedup or complete absence of regression from this checkpoint.
This small synthetic workload does not predict Z Notes launch/build latency.
