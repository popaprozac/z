# Z performance checkpoint 1

Generated 2026-07-24T14:47:35.488Z on arm64, macOS 26.4.

- Compiler: Apple clang version 17.0.0 (clang-1700.4.4.1)
- Rust: rustc 1.97.1 (8bab26f4f 2026-07-14)
- Zig: 0.16.0 (ReleaseSafe)
- Nim: Nim Compiler Version 2.2.10 [MacOSX: arm64] (ARC release mode)
- Hyperfine: hyperfine 1.20.0
- Z release profile under test: `clang -O3 -DNDEBUG`
- Samples: 9 measured runs after 2 warmups; table reports the median
- Workloads receive iteration counts at runtime from a separately compiled C helper
- Allocation counts instrument `malloc`, `calloc`, `realloc`, and `free` in the benchmark translation unit

## Runtime

Each workload's C, C++, or Z direct-await reference is the `1.000×` baseline.

| Workload | Variant | Median | Relative to baseline | Allocation calls/frees (requested bytes) |
| --- | --- | ---: | ---: | ---: |
| arithmetic | z | 46.285 ms | 1.004× | 0/0 (0.0 KiB) |
| arithmetic | c | 46.091 ms | 1.000× | 0/0 (0.0 KiB) |
| arithmetic | rust | 46.223 ms | 1.003× | — |
| arithmetic | zig | 46.352 ms | 1.006× | — |
| arithmetic | nim | 46.351 ms | 1.006× | — |
| direct-c-call | z | 21.253 ms | 0.986× | 0/0 (0.0 KiB) |
| direct-c-call | c | 21.562 ms | 1.000× | 0/0 (0.0 KiB) |
| direct-c-call | rust | 21.787 ms | 1.010× | — |
| direct-c-call | zig | 21.313 ms | 0.988× | — |
| direct-c-call | nim | 21.993 ms | 1.020× | — |
| dynamic-array | z | 3.793 ms | 1.035× | 22/1 (131072.0 KiB) |
| dynamic-array | c | 3.664 ms | 1.000× | 22/1 (131072.0 KiB) |
| dynamic-array | rust | 4.999 ms | 1.364× | — |
| dynamic-array | zig | 6.039 ms | 1.648× | — |
| dynamic-array | nim | 19.405 ms | 5.296× | — |
| struct-ownership | z | 13.769 ms | 0.974× | 0/0 (0.0 KiB) |
| struct-ownership | c++ | 14.133 ms | 1.000× | 0/0 (0.0 KiB) |
| struct-ownership | rust | 14.206 ms | 1.005× | — |
| struct-ownership | zig | 14.006 ms | 0.991× | — |
| struct-ownership | nim | 27.740 ms | 1.963× | — |
| async-task-pair | z | 2.342 ms | 0.927× | 100001/100001 (8593.9 KiB) |
| async-task-pair | z-direct-await | 2.525 ms | 1.000× | 100001/100001 (8593.9 KiB) |
| native-thread | z | 13.085 ms | 0.949× | 1001/1001 (117.4 KiB) |
| native-thread | c | 13.788 ms | 1.000× | 1000/1000 (15.6 KiB) |
| native-thread | rust | 17.043 ms | 1.236× | — |
| native-thread | zig | 16.252 ms | 1.179× | — |

## Whole-process sanity check

Hyperfine includes process startup and reports the mean of 10 runs after 2
warmups for the 50-million-iteration arithmetic workload.

| Variant | Mean wall time | Standard deviation |
| --- | ---: | ---: |
| z | 50.23 ms | ± 1.18 ms |
| c | 50.17 ms | ± 0.53 ms |
| rust | 50.97 ms | ± 0.45 ms |
| zig | 50.58 ms | ± 1.04 ms |
| nim | 53.15 ms | ± 1.79 ms |

## Compilation and stripped binary size

| Workload | Variant | Z emit (Bun stage 0) | Native build | Stripped binary |
| --- | --- | ---: | ---: | ---: |
| arithmetic | z | 107.0 ms | 62.8 ms | 33.6 KiB |
| arithmetic | c | — | 50.0 ms | 33.6 KiB |
| arithmetic | rust | — | 450.0 ms | 363.2 KiB |
| arithmetic | zig | — | 5501.0 ms | 377.0 KiB |
| arithmetic | nim | — | 342.3 ms | 66.8 KiB |
| direct-c-call | z | 105.8 ms | 56.8 ms | 33.6 KiB |
| direct-c-call | c | — | 50.0 ms | 33.6 KiB |
| direct-c-call | rust | — | 71.3 ms | 363.2 KiB |
| direct-c-call | zig | — | 4059.2 ms | 377.0 KiB |
| direct-c-call | nim | — | 313.2 ms | 66.8 KiB |
| dynamic-array | z | 107.3 ms | 61.4 ms | 33.6 KiB |
| dynamic-array | c | — | 56.0 ms | 33.6 KiB |
| dynamic-array | rust | — | 136.0 ms | 363.2 KiB |
| dynamic-array | zig | — | 4104.0 ms | 377.0 KiB |
| dynamic-array | nim | — | 313.1 ms | 66.8 KiB |
| struct-ownership | z | 111.6 ms | 58.4 ms | 33.6 KiB |
| struct-ownership | c++ | — | 95.3 ms | 33.6 KiB |
| struct-ownership | rust | — | 77.1 ms | 363.2 KiB |
| struct-ownership | zig | — | 4120.6 ms | 377.0 KiB |
| struct-ownership | nim | — | 317.1 ms | 66.8 KiB |
| async-task-pair | z | 109.2 ms | 68.0 ms | 33.6 KiB |
| async-task-pair | z-direct-await | — | 69.5 ms | 33.6 KiB |
| native-thread | z | 110.3 ms | 83.3 ms | 34.4 KiB |
| native-thread | c | — | 58.1 ms | 33.7 KiB |
| native-thread | rust | — | 170.5 ms | 366.2 KiB |
| native-thread | zig | — | 5855.5 ms | 377.0 KiB |

## Semantic equivalence

| Workload | Compared contract |
| --- | --- |
| arithmetic | u64 wrapping arithmetic in a runtime-sized loop |
| direct-c-call | one non-inlined imported C call per iteration |
| dynamic-array | native dynamic sequence growth, checked indexing, scan, and cleanup |
| struct-ownership | unique value transfer and exactly-once deterministic destruction |
| async-task-pair | two hot structured child tasks versus two direct awaits in the same Z async runtime |
| native-thread | one OS thread creation, one owned result transfer, and one join per iteration |

## Generated-code classification

| Area | Finding | Classification |
| --- | --- | --- |
| Arithmetic | Z and C emit the same hot loop; Z adds a checked subtraction for elapsed-time calculation outside that loop | Zero-wrapper confirmed |
| Direct C call | Z emits one direct `z_bench_mix` call per iteration with no adapter | Zero-wrapper confirmed |
| Dynamic array | Z and C use the same 2× growth path and vectorized scan; Z retains explicit overflow guards | Optimizer removes abstraction; intentional safety checks remain |
| Struct ownership | Z, C++, Rust, and Zig reduce to one drop call and checksum update per iteration | Move/deinit abstraction removed |
| Async task pair | Child tasks and direct awaits both allocate one async frame per call; structured scheduling adds no allocation in this case | Current runtime cost, not task-syntax cost |
| Native thread | Z lowers directly to pthread create/join but carries a larger task frame and one fixed root frame | Native call confirmed; current memory overhead |

## Scope and interpretation

Rust, Zig, and Nim are included only where their standard operations preserve
the contract in the table above. Missing cells are deliberate, not zero-cost
claims. Allocation instrumentation currently covers the generated Z and C/C++
translation units; other languages report `—` until they have equivalent
allocator-level counters. Swift is not part of this first portable-kernel
checkpoint.

This tests Z's current ceiling through generated C/C++ and Clang, not the
debug-oriented `z run` profile. Cross-language compilation times include
different amounts of runtime and standard-library work and should not be read
as a frontend-only comparison.

The generated C and optimized assembly used for inspection are reproducible in
`benchmarks/.build/<case>/z-generated.c` and `*.s`; the build directory is
not committed. Ratios near 1.0 confirm equivalent lowering for that workload.
Larger ratios must be classified as an intentional safety/ownership cost,
current compiler overhead, or a benchmark mismatch before becoming a language
performance claim.
