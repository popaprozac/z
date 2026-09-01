# Z channel performance checkpoint

Generated 2026-09-01T21:31:28.512Z on arm64, macOS 26.4.

- Compiler: Apple clang version 17.0.0 (clang-1700.4.4.1)
- Rust: rustc 1.97.1 (8bab26f4f 2026-07-14)
- Zig: 0.16.0 (ReleaseSafe)
- Nim: Nim Compiler Version 2.2.10 [MacOSX: arm64] (ARC release mode)
- Go: go version go1.24.5 darwin/arm64
- Hyperfine: hyperfine 1.20.0
- Z release profile under test: `clang -O3 -DNDEBUG`
- Samples: 7 measured runs after 2 warmups; table reports the median
- Workloads receive iteration counts at runtime from a separately compiled C helper
- Allocation counts instrument `malloc`, `calloc`, `realloc`, and `free` in the benchmark translation unit

## Runtime

Each workload's C, C++, or Z direct-await reference is the `1.000×` baseline.

| Workload | Variant | Median | Relative to baseline | Allocation calls/frees (requested bytes) |
| --- | --- | ---: | ---: | ---: |
| channel-local | z | 18.674 ms | 1.070× | 2/2 (0.3 KiB) |
| channel-local | c | 17.449 ms | 1.000× | 0/0 (0.0 KiB) |
| channel-local | rust | 14.727 ms | 0.844× | — |
| channel-local | go | 32.594 ms | 1.868× | — |
| channel-thread | z | 1.343 s | 1.218× | 250004/250004 (44922.6 KiB) |
| channel-thread | c | 1.102 s | 1.000× | 0/0 (0.0 KiB) |
| channel-thread | rust | 919.797 ms | 0.835× | — |
| channel-thread | go | 697.602 ms | 0.633× | — |
| channel-thread-sync | z | 1.087 s | 0.978× | 4/4 (0.7 KiB) |
| channel-thread-sync | c | 1.111 s | 1.000× | 0/0 (0.0 KiB) |
| channel-thread-sync | rust | 925.699 ms | 0.833× | — |
| channel-thread-sync | go | 701.108 ms | 0.631× | — |


## Compilation and stripped binary size

| Workload | Variant | Z emit (Bun stage 0) | Native build | Stripped binary |
| --- | --- | ---: | ---: | ---: |
| channel-local | z | 147.3 ms | 91.0 ms | 34.2 KiB |
| channel-local | c | — | 67.1 ms | 34.3 KiB |
| channel-local | rust | — | 695.5 ms | 365.9 KiB |
| channel-local | go | — | 1672.0 ms | 1535.8 KiB |
| channel-thread | z | 157.7 ms | 109.3 ms | 34.5 KiB |
| channel-thread | c | — | 68.2 ms | 34.4 KiB |
| channel-thread | rust | — | 689.9 ms | 401.1 KiB |
| channel-thread | go | — | 295.0 ms | 1552.0 KiB |
| channel-thread-sync | z | 157.5 ms | 115.1 ms | 34.5 KiB |
| channel-thread-sync | c | — | 84.5 ms | 34.4 KiB |
| channel-thread-sync | rust | — | 691.7 ms | 401.1 KiB |
| channel-thread-sync | go | — | 324.1 ms | 1552.0 KiB |

## Semantic equivalence

| Workload | Compared contract |
| --- | --- |
| channel-local | one capacity-1 channel send followed by one receive on the same thread |
| channel-thread | one async producer and one dedicated synchronous consumer; the blocking native references isolate Z's additional task-frame cost rather than matching scheduling semantics |
| channel-thread-sync | one synchronous producer and one dedicated synchronous consumer thread transferring u64 values through a capacity-1 channel |

## Generated-code classification

| Area | Finding | Classification |
| --- | --- | --- |
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

The `channel-thread` row deliberately compares Z's suspending producer with
the same blocking native handoff used by the synchronous control. It isolates
the current async task-frame cost; `channel-thread-sync` is the semantics-matched
native ceiling comparison.

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
