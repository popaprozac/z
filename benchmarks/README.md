# Z benchmarks

This directory holds repeatable, semantics-matched performance probes for Z's
generated native code. The first checkpoint uses Apple Clang, Rust, Zig, Nim,
and focused Go channel references with a harness-local release profile:

```sh
bun run bench
```

The harness:

- emits Z through the current Bun-hosted Stage-0 compiler;
- compiles generated C with `-O3 -DNDEBUG`;
- compiles C/C++ baselines with the same optimizer;
- includes Rust, Zig ReleaseSafe, Nim ARC release, and focused Go
  implementations where their operations preserve the stated contract;
- passes workload sizes at runtime so the optimizer cannot precompute results;
- validates matching checksums;
- reports medians after warmups;
- instruments allocation calls in generated Z and C/C++ benchmark translation
  units;
- records compilation time and stripped binary size; and
- retains generated C and assembly under ignored `benchmarks/.build/`.

Use `Z_BENCH_SCALE=0.1` for a short smoke run, or adjust
`Z_BENCH_SAMPLES` and `Z_BENCH_WARMUPS`. Results are machine-specific and must
not be compared across hosts without recording hardware and toolchain versions.
Use `Z_BENCH_CASES=channel-local,channel-thread` to run a focused subset and
`Z_BENCH_REPORT=checkpoint-channels.md` to keep that report separate from the
full checkpoint.

The native reference must preserve the relevant Z semantics. For example,
wrapping arithmetic is compared with unsigned modular C arithmetic, checked
array access is compared with an explicit bounds check, and a consuming Z value
with `deinit` is compared with unique C++ RAII ownership.

The primary times are measured inside each native kernel, excluding process
startup. For a secondary whole-process sanity check, build the suite once and
run a long-lived case with Hyperfine against executables in
`benchmarks/.build/<case>/`:

```sh
Z_BENCH_ITERATIONS=50000000 hyperfine --warmup 2 \
  'benchmarks/.build/arithmetic/z' \
  'benchmarks/.build/arithmetic/c' \
  'benchmarks/.build/arithmetic/rust' \
  'benchmarks/.build/arithmetic/zig' \
  'benchmarks/.build/arithmetic/nim'
```

Do not interpret cross-language allocation cells as zero when they display
`—`: equivalent allocator instrumentation has not yet been added for that
toolchain.

## Z Notes build latency

With the sibling Zapp checkout installed and Z's native compiler bootstrapped:

```sh
bun benchmarks/profile-zapp-build.ts ../zapp release first
bun benchmarks/profile-zapp-build.ts ../zapp release unchanged
bun benchmarks/profile-zapp-build.ts ../zapp dev development
```

This build-only probe runs the actual Z Notes service preflight, native staging,
compiler, bundle, and signing code. Release mode also runs Vite's production
build. It does not open the application or start a Vite dev server; dev mode
requires an existing Vite-produced worker bundle in the application's
`.zapp/workers`. It writes normal gitignored Zapp build artifacts and appends
phase/subprocess timings to `.z-cache/benchmarks/zapp-build.jsonl` in Z.
Every observed subprocess group has a 180-second watchdog.

Report first invocation, unchanged repetition, and source-change builds
separately. Existing caches are not cleared by this probe. A failed build is
not a completed build-time measurement, and dev results exclude server startup,
worker bundling, application launch, and WebView load. See
[the dated performance log](../docs/performance.md#z-notes-end-to-end-build-sweep--2026-09-08).
