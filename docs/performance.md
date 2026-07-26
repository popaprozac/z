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

## Compiler developer-experience latency

Runtime performance and compiler throughput are separate gates. During
self-hosting, every frontend extraction should preserve the edit-check-run loop
as well as semantic parity. The 2026-07-25 macOS arm64 checkpoint, measured with
Hyperfine after splitting `semantic-model.zs` and `module-paths.zs`, established
this baseline:

| Operation | Warm whole-process time |
| --- | ---: |
| Check the 8.7K-line native semantic analyzer through Stage 0 | 267.5 ms ± 7.1 ms |
| Resolve and analyze the same five-module graph through Stage 1 | 270.8 ms ± 1.6 ms |
| Compile and run `examples/language/basics/first.zs` | 339.7 ms ± 10.4 ms |
| Hybrid Stage-0 check plus native authority/parity observation | 2.468 s ± 0.017 s |

The warm Stage-1 command spends approximately 174 ms in native lexing, parsing,
resolution, semantic analysis, and protocol encoding, then 9 ms decoding the
temporary protocol. A single cold bridge rebuild after editing the frontend
spent approximately 769 ms preparing the Stage-0-compiled native library.

The hybrid path is intentionally doing both frontends plus exhaustive
observation, but 2.5 seconds is too expensive to become the ordinary developer
loop. It is currently an opt-in migration gate. As native authority replaces
Stage 0, ordinary `z check` should approach the Stage-1 figure rather than
retaining both costs. Future reports should distinguish:

- cold compiler/frontend rebuild;
- warm whole-process command latency;
- in-process frontend work;
- protocol or structural-handoff overhead;
- native C-family compilation and linking;
- executed program startup.

Modularization is not automatically a win if it makes these numbers materially
worse. Any regression beyond ordinary measurement noise needs an explanation
or an optimization before the extraction is treated as complete.

The subsequent signature/symbol, graph, lexical-name, shared type-shape,
type-identity, declaration-validation, flow-state, type-ownership, and
member-lookup
extractions produced this comparison:

| Operation | Path/model | Signatures/symbols | Graph | Names | Type shapes | Identity/validation | Flow state | Type ownership | Member lookups |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stage-1 self-analysis | 270.8 ms | 270.4 ms | 258.0 ms | 263.7 ms | 268.1 ms | 261.5 ms | 243.5 ms | 263.5 ms | 267.5 ms |
| Ordinary Stage-0 check | 267.5 ms | 278.8 ms | 259.3 ms | 262.8 ms | 274.8 ms | 270.1 ms | 240.4 ms | 266.4 ms | 273.6 ms |
| Hybrid Stage-0/native authority check | 2.468 s | 2.198 s | 2.124 s | 2.053 s | 1.986 s | 1.669 s | 1.524 s | 1.582 s | 1.470 s |

The Stage-1 results show that additional semantic modules do not inherently
slow the native frontend. The small Stage-1 and Stage-0 changes after extracting
name validation are within ordinary whole-process measurement variance, while
the exhaustive native-authority observation path improved again. The graph
split's larger improvement suggests some parsing or semantic work scales
nonlinearly with declarations or state per file. Smaller Stage-0 semantic units
also reduce the exhaustive native-authority observation cost.

The standalone type-ownership checkpoint appeared slower than the immediately
preceding flow-state sample, so both commits were also archived and measured
side by side on the same temporary filesystem with the same toolchain and cache
conditions. In that controlled comparison, type ownership measured 289.8 ms
versus 292.9 ms for Stage 1, 294.4 ms versus 295.3 ms for Stage 0, and 1.648 s
versus 1.736 s for the hybrid path. The apparent regression was therefore host
and filesystem-cache variance rather than a cost introduced by the module.

After the member-lookup split, a warm timed resolver invocation spent
approximately 165 ms in native lexing, parsing,
graph/name/type/expression analysis, and
encoding, plus 9 ms decoding the temporary protocol. The first cold bridge
rebuild for the preceding type-ownership checkpoint spent approximately 864 ms
in boundary preparation. Cold rebuild cost
remains noisier than warm checks and is tracked separately.

The earlier small ordinary Stage-0 increase demonstrated that loading more
modules is not free, so the direction is not guaranteed for every split.
Native module fingerprints and incremental parse/semantic caches should
eventually make a one-file edit proportional to the changed module and its
dependents rather than the whole frontend.
