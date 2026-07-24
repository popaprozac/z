# Z performance checkpoint 1

Generated 2026-07-24T08:18:23.226Z on arm64, macOS 26.4.

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
| arithmetic | z | 50.267 ms | 1.016× | 0/0 (0.0 KiB) |
| arithmetic | c | 49.497 ms | 1.000× | 0/0 (0.0 KiB) |
| arithmetic | rust | 49.812 ms | 1.006× | — |
| arithmetic | zig | 48.019 ms | 0.970× | — |
| arithmetic | nim | 49.363 ms | 0.997× | — |
| direct-c-call | z | 22.441 ms | 0.997× | 0/0 (0.0 KiB) |
| direct-c-call | c | 22.520 ms | 1.000× | 0/0 (0.0 KiB) |
| direct-c-call | rust | 22.675 ms | 1.007× | — |
| direct-c-call | zig | 22.673 ms | 1.007× | — |
| direct-c-call | nim | 22.647 ms | 1.006× | — |
| dynamic-array | z | 3.885 ms | 0.985× | 22/1 (131072.0 KiB) |
| dynamic-array | c | 3.946 ms | 1.000× | 22/1 (131072.0 KiB) |
| dynamic-array | rust | 5.510 ms | 1.396× | — |
| dynamic-array | zig | 5.966 ms | 1.512× | — |
| dynamic-array | nim | 20.744 ms | 5.258× | — |
| struct-ownership | z | 14.643 ms | 0.977× | 0/0 (0.0 KiB) |
| struct-ownership | c++ | 14.989 ms | 1.000× | 0/0 (0.0 KiB) |
| struct-ownership | rust | 15.072 ms | 1.006× | — |
| struct-ownership | zig | 14.886 ms | 0.993× | — |
| struct-ownership | nim | 29.087 ms | 1.941× | — |
| async-task-pair | z | 2.362 ms | 0.902× | 100001/100001 (8593.9 KiB) |
| async-task-pair | z-direct-await | 2.618 ms | 1.000× | 100001/100001 (8593.9 KiB) |
| native-thread | z | 13.151 ms | 0.930× | 1001/1001 (117.4 KiB) |
| native-thread | c | 14.138 ms | 1.000× | 1000/1000 (15.6 KiB) |
| native-thread | rust | 17.258 ms | 1.221× | — |
| native-thread | zig | 21.053 ms | 1.489× | — |

## Whole-process sanity check

Hyperfine includes process startup and reports the mean of 10 runs after 2
warmups for the 50-million-iteration arithmetic workload.

| Variant | Mean wall time | Standard deviation |
| --- | ---: | ---: |
| z | 49.25 ms | ± 0.67 ms |
| c | 49.61 ms | ± 0.57 ms |
| rust | 49.52 ms | ± 0.96 ms |
| zig | 49.43 ms | ± 0.35 ms |
| nim | 49.34 ms | ± 0.41 ms |

## Compilation and stripped binary size

| Workload | Variant | Z emit (Bun stage 0) | Native build | Stripped binary |
| --- | --- | ---: | ---: | ---: |
| arithmetic | z | 116.7 ms | 66.2 ms | 33.7 KiB |
| arithmetic | c | — | 55.8 ms | 33.7 KiB |
| arithmetic | rust | — | 338.0 ms | 363.2 KiB |
| arithmetic | zig | — | 5747.0 ms | 377.0 KiB |
| arithmetic | nim | — | 362.8 ms | 66.9 KiB |
| direct-c-call | z | 109.4 ms | 57.8 ms | 33.7 KiB |
| direct-c-call | c | — | 50.1 ms | 33.7 KiB |
| direct-c-call | rust | — | 72.7 ms | 363.2 KiB |
| direct-c-call | zig | — | 4265.6 ms | 377.0 KiB |
| direct-c-call | nim | — | 314.7 ms | 66.9 KiB |
| dynamic-array | z | 109.6 ms | 64.9 ms | 33.7 KiB |
| dynamic-array | c | — | 57.6 ms | 33.7 KiB |
| dynamic-array | rust | — | 130.6 ms | 363.2 KiB |
| dynamic-array | zig | — | 4282.0 ms | 377.0 KiB |
| dynamic-array | nim | — | 359.6 ms | 66.9 KiB |
| struct-ownership | z | 110.7 ms | 58.9 ms | 33.7 KiB |
| struct-ownership | c++ | — | 115.8 ms | 33.8 KiB |
| struct-ownership | rust | — | 344.6 ms | 363.2 KiB |
| struct-ownership | zig | — | 4255.4 ms | 377.0 KiB |
| struct-ownership | nim | — | 312.5 ms | 66.9 KiB |
| async-task-pair | z | 111.6 ms | 67.7 ms | 33.7 KiB |
| async-task-pair | z-direct-await | — | 67.6 ms | 33.8 KiB |
| native-thread | z | 110.8 ms | 80.4 ms | 34.5 KiB |
| native-thread | c | — | 56.8 ms | 33.9 KiB |
| native-thread | rust | — | 159.3 ms | 366.2 KiB |
| native-thread | zig | — | 4277.9 ms | 377.0 KiB |

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
