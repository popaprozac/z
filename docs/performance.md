# Performance

Z's performance target is the ceiling of C, C++, Rust, and Zig when equivalent
ownership and safety semantics are requested. Familiar syntax is not a reason to
accept a JavaScript-like runtime tax.

The repeatable suite lives in [`benchmarks/`](../benchmarks). It emits Z through
the current Bun-hosted compiler and then builds the generated source with
`clang -O3 -DNDEBUG`. C/C++, Rust, Zig ReleaseSafe, and Nim ARC variants are
included only where they preserve the workload's stated contract.

Run it with:

```sh
bun run bench
```

The latest machine-specific report is
[`checkpoint-1-macos-arm64.md`](../benchmarks/results/checkpoint-1-macos-arm64.md).
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
- Compilation measurements currently include Bun stage-0 emission separately
  from native compilation. They are not yet measurements of a self-hosted Z
  frontend.

The first checkpoint covers portable kernels, direct C calls, dynamic arrays,
deterministic ownership, structured task overhead, and native threads. ARC
identity, Map/Set, generators, Objective-C/C++ boundary calls, and richer async
fan-out remain explicit follow-up cases.
