# Performance

This document describes how Z measures performance and how to read the results.
Each report describes the named compiler revision, machine, profile, and
semantic workload; it is evidence about Z's performance ceiling, not a timeless
headline number. Current feature coverage belongs in
[`bootstrap-status.md`](bootstrap-status.md).

Z's performance target is the ceiling of C, C++, Rust, and Zig when equivalent
ownership and safety semantics are requested. Familiar syntax is not a reason to
accept a JavaScript-like runtime tax.

The repeatable suite lives in [`benchmarks/`](../benchmarks). It emits Z through
the current Bun-hosted compiler and then builds the generated source with
`clang -O3 -DNDEBUG`. C/C++, Rust, Zig ReleaseSafe, Nim ARC, and focused Go
variants are included only where they preserve the workload's stated contract.

Run it with:

```sh
bun run bench
```

The latest machine-specific runtime report is
[`checkpoint-2026-09-08-macos-arm64.md`](../benchmarks/results/checkpoint-2026-09-08-macos-arm64.md).
It separates runtime, allocation counts where equivalent instrumentation
exists, compilation time, binary size, whole-process Hyperfine measurements,
and generated-code findings.

## Reading the results

- Ratios near C do not prove every Z program is zero-cost. They establish that a
  particular abstraction can compile away.
- Safety checks, reference counting, allocation, dynamic dispatch, and task
  frames have real costs when the program requests those semantics.
- Cross-language comparisons must match semantics. Z ARC belongs beside Rust
  `Rc`/`Arc`, Nim ARC, and Swift classes—not uniquely owned Rust values.
- `z run` is currently a debuggable bootstrap path. It is not the release
  profile used by the benchmark suite.
- The cross-language benchmark suite's compilation measurements include Bun
  Stage-0 emission separately from native compilation.
