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

## Checked-indexing code-generation audit

```sh
bun run bootstrap
bun benchmarks/checked-indexing.ts
Z_INDEX_ISOLATE=1 bun benchmarks/checked-indexing.ts
```

This focused suite compares Stage 0, the bootstrapped native driver, and
handwritten checked C at both `-O2 -DNDEBUG` and `-O3 -DNDEBUG`. It covers
sequential reads, indirect table lookups, and a register loop with either direct
field access or a sibling-field `view`. The normal run permits ordinary
inlining. The isolated run makes only the selected kernel externally visible
and `noinline` in generated C and the reference, so caller-specific buffer-size
knowledge cannot specialize it. This is an experimental code-generation
boundary, not a proposed Z attribute.

Every variant has a paired **benchmark-only** bounds-removal control. The
transformation recognizes exact array helper definitions and fails closed when
their shapes change. It leaves overflow, conversion, shift, allocation, String,
and Slice checks alone. These controls run only constructed valid inputs; they
are not an unchecked Z API or a change to release-mode safety.

Setup and allocation happen before the native clock interval; cleanup, process
startup, compilation, and UBSan validation are outside it. Three small input
sizes are checked against an independent BigInt oracle, with and without UBSan.
Measured workloads must match the handwritten checked C checksum. Variant order
rotates and alternates, and raw samples include medians and min–max ranges.
The default is 4,096 elements × 32,768 rounds, two warmups and nine samples.

Options: `Z_INDEX_WIDTH`, `Z_INDEX_ROUNDS`, `Z_INDEX_SAMPLES`,
`Z_INDEX_WARMUPS`, `Z_INDEX_PROFILES=O2,O3`, `Z_INDEX_REPORT`, and
`Z_BENCH_TIMEOUT_MS`. `Z_BENCH_NATIVE` selects a bootstrapped driver with its
adjacent `.c`; the harness verifies that C against current compiler self-emission
and records both source and binary hashes. A stale compiler is rejected.
The compiler source must be committed; benchmark edits may be dirty and are
recorded by hashes. Neither compiler nor benchmark source may change mid-run.

Generated C, optimized LLVM IR, and assembly stay under a unique ignored
`benchmarks/.build/checked-indexing/run-*` directory. Reports default to dated
JSON/Markdown files, with a separate name for isolated runs. Every subprocess
group has a watchdog and is terminated on interruption. Run without concurrent
tests or other CPU-heavy work. Do not equate an `abort` anywhere in a binary
with a hot bounds check: inspect the measured loop and its control flow.

These are synthetic kernels, not an engine benchmark. An optimizer-eliminated
check costs nothing even if it appears in generated C; a surviving predictable
check can still be inexpensive. Conversely, opaque buffer sizes, aliasing,
method calls, and interpreter dispatch may change the result. Engine-specific
invariants and measurements remain necessary before choosing an unchecked API.

## Compiler build-latency matrix

For a real generated application graph, compare native compiler binaries without
deleting build caches or modifying application source:

```sh
bun benchmarks/native-emission.ts /path/to/native-z /path/to/project \
  /path/to/generated/services.zbuild.json .z-cache/benchmarks/emission.json
```

Use `-` instead of the overlay path when none is needed. This runs `z emit`, so
it always loads, checks, lowers, and emits the graph instead of taking the final
executable-cache shortcut. Existing SDK evidence is still validated/reused.
It excludes Clang compilation, linking, signing, frontend tooling, and launch.
The report records compiler/output hashes, wall time, and (on macOS) peak memory,
instructions, and other `/usr/bin/time -l` resource counters. Emitted native
source stays beside the report. Compare output hashes as well as timing. Alternate
before/after binaries, run without concurrent tests, and distinguish warm SDK
evidence from a clean-machine build. Every process group has a 180-second watchdog.

The [immutable SDK signature checkpoint](results/sdk-signatures-2026-09-16.json)
records a matched prior compiler and two optimized emission runs on Z Notes,
including the narrowly audited generated-code difference from a borrowed-class
pointer-qualification correction. Do not silently ignore differing output hashes.

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

The [lifecycle/nested-match checkpoint](results/build-latency-lifecycle-2026-09-11.md)
records before/after raw samples, compiler identities, and an unresolved
fresh-cache timing increase without treating desktop timing variance as proof
of no regression.

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
worker bundling, application launch, and WebView load.

## Repeated SDK imports

```sh
bun benchmarks/foreign-cache.ts sample ../zapp
```

Runs the real Z Notes AppKit/WebKit imports in separate declaration-adapter
processes with a fresh private artifact directory. Three modules import each
SDK header, followed by unchanged repetitions. Outputs must have identical
declaration hashes for each header. It does not clear application caches,
compile the app, or launch a GUI. Each child process group is bounded at 120
seconds; the private cache is removed on normal completion/failure. JSONL samples
are written to `.z-cache/benchmarks/foreign-cache.jsonl`.

The first module pays full producer cost. Later modules may reuse shared
evidence only with matching import alias, include order, target, header bytes,
and contracts/API notes. Existing-artifact hits still validate these inputs.
Fresh project evidence is not a cold OS/SDK filesystem cache. The
[initial before/after samples](results/foreign-cache-2026-09-16.json) are local
single observations, not medians or complete app-startup measurements.
