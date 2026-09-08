# Z performance checkpoint

Generated 2026-09-08T15:37:03.375Z on arm64, macOS 26.4.

- Compiler: Apple clang version 17.0.0 (clang-1700.4.4.1)
- Rust: rustc 1.97.1 (8bab26f4f 2026-07-14)
- Zig: 0.16.0 (ReleaseSafe)
- Nim: Nim Compiler Version 2.2.10 [MacOSX: arm64] (ARC release mode)
- Go: go version go1.24.5 darwin/arm64
- Hyperfine: hyperfine 1.20.0
- Z release profile under test: `clang -O3 -DNDEBUG`
- Samples: 9 measured runs after 2 warmups; table reports the median
- Workloads receive iteration counts at runtime from a separately compiled C helper
- Allocation counts instrument `malloc`, `calloc`, `realloc`, and `free` in the benchmark translation unit

## Runtime

Each workload's C, C++, or Z direct-await reference is the `1.000×` baseline.

| Workload | Variant | Median | Relative to baseline | Allocation calls/frees (requested bytes) |
| --- | --- | ---: | ---: | ---: |
| arithmetic | z | 49.746 ms | 1.008× | 0/0 (0.0 KiB) |
| arithmetic | c | 49.359 ms | 1.000× | 0/0 (0.0 KiB) |
| arithmetic | rust | 49.395 ms | 1.001× | — |
| arithmetic | zig | 50.769 ms | 1.029× | — |
| arithmetic | nim | 51.069 ms | 1.035× | — |
| direct-c-call | z | 22.760 ms | 1.007× | 0/0 (0.0 KiB) |
| direct-c-call | c | 22.613 ms | 1.000× | 0/0 (0.0 KiB) |
| direct-c-call | rust | 22.874 ms | 1.012× | — |
| direct-c-call | zig | 23.202 ms | 1.026× | — |
| direct-c-call | nim | 22.747 ms | 1.006× | — |
| dynamic-array | z | 5.283 ms | 1.028× | 22/1 (131072.0 KiB) |
| dynamic-array | c | 5.140 ms | 1.000× | 22/1 (131072.0 KiB) |
| dynamic-array | rust | 6.254 ms | 1.217× | — |
| dynamic-array | zig | 7.013 ms | 1.364× | — |
| dynamic-array | nim | 22.004 ms | 4.281× | — |
| struct-ownership | z | 15.354 ms | 0.995× | 0/0 (0.0 KiB) |
| struct-ownership | c++ | 15.429 ms | 1.000× | 0/0 (0.0 KiB) |
| struct-ownership | rust | 15.297 ms | 0.991× | — |
| struct-ownership | zig | 15.388 ms | 0.997× | — |
| struct-ownership | nim | 30.750 ms | 1.993× | — |
| async-task-pair | z | 3.326 ms | 1.013× | 100001/100001 (10156.4 KiB) |
| async-task-pair | z-direct-await | 3.284 ms | 1.000× | 100001/100001 (10156.4 KiB) |
| native-thread | z | 13.902 ms | 0.931× | 1001/1001 (133.0 KiB) |
| native-thread | c | 14.929 ms | 1.000× | 1000/1000 (15.6 KiB) |
| native-thread | rust | 25.419 ms | 1.703× | — |
| native-thread | zig | 21.339 ms | 1.429× | — |
| channel-local | z | 18.843 ms | 1.078× | 2/2 (0.3 KiB) |
| channel-local | c | 17.480 ms | 1.000× | 0/0 (0.0 KiB) |
| channel-local | rust | 14.743 ms | 0.843× | — |
| channel-local | go | 31.762 ms | 1.817× | — |
| channel-thread | z | 1.326 s | 1.188× | 250004/250004 (44922.6 KiB) |
| channel-thread | c | 1.116 s | 1.000× | 0/0 (0.0 KiB) |
| channel-thread | rust | 957.532 ms | 0.858× | — |
| channel-thread | go | 649.434 ms | 0.582× | — |
| channel-thread-sync | z | 1.164 s | 1.007× | 4/4 (0.7 KiB) |
| channel-thread-sync | c | 1.156 s | 1.000× | 0/0 (0.0 KiB) |
| channel-thread-sync | rust | 968.769 ms | 0.838× | — |
| channel-thread-sync | go | 670.937 ms | 0.580× | — |

## Whole-process sanity check

Hyperfine includes process startup and reports the mean of 10 runs after 2
warmups for the 50-million-iteration arithmetic workload.

| Variant | Mean wall time | Standard deviation |
| --- | ---: | ---: |
| z | 53.22 ms | ± 0.89 ms |
| c | 53.54 ms | ± 0.47 ms |
| rust | 53.26 ms | ± 0.25 ms |
| zig | 53.39 ms | ± 0.31 ms |
| nim | 54.00 ms | ± 1.71 ms |


## Compilation and stripped binary size

| Workload | Variant | Z emit (Bun stage 0) | Native build | Stripped binary |
| --- | --- | ---: | ---: | ---: |
| arithmetic | z | 145.8 ms | 161.5 ms | 33.6 KiB |
| arithmetic | c | — | 58.0 ms | 33.6 KiB |
| arithmetic | rust | — | 1808.8 ms | 363.2 KiB |
| arithmetic | zig | — | 7856.6 ms | 377.0 KiB |
| arithmetic | nim | — | 995.8 ms | 66.8 KiB |
| direct-c-call | z | 141.3 ms | 66.9 ms | 33.6 KiB |
| direct-c-call | c | — | 58.0 ms | 33.6 KiB |
| direct-c-call | rust | — | 563.9 ms | 363.2 KiB |
| direct-c-call | zig | — | 4572.8 ms | 377.0 KiB |
| direct-c-call | nim | — | 396.1 ms | 66.8 KiB |
| dynamic-array | z | 140.5 ms | 75.1 ms | 33.6 KiB |
| dynamic-array | c | — | 62.8 ms | 33.6 KiB |
| dynamic-array | rust | — | 159.2 ms | 363.2 KiB |
| dynamic-array | zig | — | 4584.7 ms | 377.0 KiB |
| dynamic-array | nim | — | 349.6 ms | 66.8 KiB |
| struct-ownership | z | 142.6 ms | 64.4 ms | 33.6 KiB |
| struct-ownership | c++ | — | 143.1 ms | 33.6 KiB |
| struct-ownership | rust | — | 86.4 ms | 363.2 KiB |
| struct-ownership | zig | — | 4539.9 ms | 377.0 KiB |
| struct-ownership | nim | — | 378.5 ms | 66.8 KiB |
| async-task-pair | z | 143.6 ms | 77.8 ms | 33.6 KiB |
| async-task-pair | z-direct-await | — | 77.1 ms | 33.6 KiB |
| native-thread | z | 151.9 ms | 90.6 ms | 34.4 KiB |
| native-thread | c | — | 75.6 ms | 33.7 KiB |
| native-thread | rust | — | 738.4 ms | 366.2 KiB |
| native-thread | zig | — | 4523.3 ms | 377.0 KiB |
| channel-local | z | 152.1 ms | 88.9 ms | 34.2 KiB |
| channel-local | c | — | 68.0 ms | 34.3 KiB |
| channel-local | rust | — | 900.4 ms | 365.9 KiB |
| channel-local | go | — | 1860.6 ms | 1535.8 KiB |
| channel-thread | z | 162.5 ms | 253.1 ms | 34.5 KiB |
| channel-thread | c | — | 344.7 ms | 34.4 KiB |
| channel-thread | rust | — | 673.8 ms | 401.1 KiB |
| channel-thread | go | — | 362.6 ms | 1552.0 KiB |
| channel-thread-sync | z | 158.5 ms | 239.9 ms | 34.5 KiB |
| channel-thread-sync | c | — | 85.8 ms | 34.4 KiB |
| channel-thread-sync | rust | — | 949.9 ms | 401.1 KiB |
| channel-thread-sync | go | — | 303.0 ms | 1552.0 KiB |

## Semantic equivalence

| Workload | Compared contract |
| --- | --- |
| arithmetic | u64 wrapping arithmetic in a runtime-sized loop |
| direct-c-call | one non-inlined imported C call per iteration |
| dynamic-array | native dynamic sequence growth, checked indexing, scan, and cleanup |
| struct-ownership | unique value transfer and exactly-once deterministic destruction |
| async-task-pair | two hot structured child tasks versus two direct awaits in the same Z async runtime |
| native-thread | one OS thread creation, one owned result transfer, and one join per iteration |
| channel-local | one capacity-1 channel send followed by one receive on the same thread |
| channel-thread | one async producer and one dedicated synchronous consumer; the blocking native references isolate Z's additional task-frame cost rather than matching scheduling semantics |
| channel-thread-sync | one synchronous producer and one dedicated synchronous consumer thread transferring u64 values through a capacity-1 channel |

## Generated-code classification from prior inspection

These are the established code-shape observations for these fixtures, not a
new assembly audit performed automatically by this timing harness.

| Area | Finding | Classification |
| --- | --- | --- |
| Arithmetic | Z and C emit the same hot loop; Z adds a checked subtraction for elapsed-time calculation outside that loop | Zero-wrapper confirmed |
| Direct C call | Z emits one direct `z_bench_mix` call per iteration with no adapter | Zero-wrapper confirmed |
| Dynamic array | Z and C use the same 2× growth path and vectorized scan; Z retains explicit overflow guards | Optimizer removes abstraction; intentional safety checks remain |
| Struct ownership | Z, C++, Rust, and Zig reduce to one drop call and checksum update per iteration | Move/deinit abstraction removed |
| Async task pair | Child tasks and direct awaits both allocate one async frame per call; structured scheduling adds no allocation in this case | Current runtime cost, not task-syntax cost |
| Native thread | Z lowers directly to pthread create/join but carries a larger task frame and one fixed root frame | Native call confirmed; current memory overhead |
| Local channel | Z uses one preallocated bounded ring, one mutex acquisition per operation, and no per-message channel allocation | Intentional synchronization cost |
| Async cross-thread channel | Z transfers through the bounded ring while suspending the producer through one heap-owned task frame per send | Native synchronization confirmed; async frame cost remains |
| Synchronous cross-thread channel | Z transfers through the same bounded ring and parks producer or consumer directly on native condition variables | Native synchronization confirmed |

## Scope and interpretation

Rust, Zig, Nim, and Go are included only where their standard operations
preserve the contract in the table above. Missing cells are deliberate, not
zero-cost claims. Allocation instrumentation currently covers the generated Z
and C/C++ translation units; other languages report `—` until they have
equivalent allocator-level counters. Swift is not part of this portable-kernel
checkpoint.

The channel-thread row deliberately compares Z's suspending producer with
the same blocking native handoff used by the synchronous control. It isolates
the current async task-frame cost; channel-thread-sync is the semantics-matched
native ceiling comparison.

This tests Z's current ceiling through generated C/C++ and Clang, not the
debug-oriented `z run` profile. Cross-language compilation times include
different amounts of runtime and standard-library work and should not be read
as a frontend-only comparison.

The generated C and optimized assembly used for inspection are reproducible in
`benchmarks/.build/<case>/z-generated.c` and `*.s`; the build directory is
not committed. Ratios near 1.0 are consistent with equivalent performance for
that workload; confirming equivalent lowering requires inspecting the code.
Larger ratios must be classified as an intentional safety/ownership cost,
current compiler overhead, or a benchmark mismatch before becoming a language
performance claim.
