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
Without an explicit report name, new reports use the UTC date, platform, and
architecture so reruns do not overwrite the original historical checkpoint.

Each run now also writes adjacent JSON with individual samples, workload sizes,
allocation counts, compilation timings, and the Z revision/dirty-state marker.
Native/compiler subprocesses have a 180-second deadline (override with
`Z_BENCH_TIMEOUT_MS`). These are watchdogs, not measured time limits or successful
results. Do not run benchmarks alongside compiler tests or other CPU-heavy work.

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

## Compiler build-latency matrix

```sh
bun run bootstrap
Z_BUILD_BENCH_REPORT=benchmarks/results/build-latency-2026-09-08.json \
  bun benchmarks/build-latency.ts
```

This self-contained probe generates 24 Z modules with 16 helpers each, plus a
tiny imported C header with a transitive dependency. It compares Stage 0 and
the bootstrapped native driver against identical source and validates every
produced executable's checksum. Three trials alternate driver order. Results
include fresh project caches, unchanged builds, one-module changes, transitive
header changes, debug/release switches, and repetitions after each change.
Every native unchanged row must hit its input cache; changed inputs and profile
switches must invalidate. Timing excludes executable validation and bootstrap.

`Z_BUILD_BENCH_TRIALS`, `Z_BUILD_BENCH_MODULES`, and
`Z_BUILD_BENCH_FUNCTIONS` control workload size; `Z_BENCH_NATIVE` selects an
already-built native driver. Every child process group has a bounded watchdog.
The probe removes only its own temporary fixture directory and saves raw JSON
and a Markdown summary. A fresh project cache is **not** a cold machine: host
filesystem, compiler, and SDK caches remain warm. This is a synthetic compiler
workload, not a prediction for a header-heavy application such as Z Notes.

The runtime suite uses Stage-0-generated C at `-O3`; this build matrix uses the
actual CLI profiles (`-O0` debug and `-O2 -DNDEBUG` release). Keep those results
separate. Foreign-adapter/SDK scale, .zd changes, generated overlays, compiler
replacement, memory, and module-level incremental compilation need additional
measurements.

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
