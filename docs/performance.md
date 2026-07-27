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

The subsequent semantic decomposition checkpoints produced this comparison:

| Operation | Path/model | Signatures/symbols | Graph | Names | Type shapes | Identity/validation | Flow state | Type ownership | Member lookups | Pattern validation | Generic/aggregate | Calls/ownership | Expression types | Closures | Function contexts | Intrinsics | Evidence | Operators | Structural summary | Structural topology | Structural symbols | Structural function signatures | Structural all signatures | Structural evidence | Phase API v1 | Generic identities | Async effects | Task effects | Executor placement | Corpus compatibility | Throwing callables | Weak references | Recursive ownership | Dependent generics | Foreign deferral | Raw grammar |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stage-1 self-analysis | 270.8 ms | 270.4 ms | 258.0 ms | 263.7 ms | 268.1 ms | 261.5 ms | 243.5 ms | 263.5 ms | 267.5 ms | 258.9 ms | 254.1 ms | 256.4 ms | 258.4 ms | 261.0 ms | 257.5 ms | 260.1 ms | 253.9 ms | 247.6 ms | 249.0 ms | 242.0 ms | 254.4 ms | 236.6 ms | 239.9 ms | 262.2 ms | 261.0 ms | 261.1 ms | 260.7 ms | 263.4 ms | 244.3 ms | 240.1 ms | 245.5 ms | 246.3 ms | 245.4 ms | 245.2 ms | 250.3 ms | 251.3 ms |
| Ordinary Stage-0 check | 267.5 ms | 278.8 ms | 259.3 ms | 262.8 ms | 274.8 ms | 270.1 ms | 240.4 ms | 266.4 ms | 273.6 ms | 268.8 ms | 265.3 ms | 267.2 ms | 260.9 ms | 269.9 ms | 265.5 ms | 266.9 ms | 268.2 ms | 262.9 ms | 265.5 ms | 257.0 ms | 270.2 ms | 248.8 ms | 250.2 ms | 278.1 ms | 278.9 ms | 273.2 ms | 286.1 ms | 282.0 ms | 249.7 ms | 253.8 ms | 255.2 ms | 245.7 ms | 248.7 ms | 250.0 ms | 247.2 ms | 250.4 ms |
| Hybrid Stage-0/native authority check | 2.468 s | 2.198 s | 2.124 s | 2.053 s | 1.986 s | 1.669 s | 1.524 s | 1.582 s | 1.470 s | 1.396 s | 1.312 s | 1.281 s | 1.276 s | 1.249 s | 1.185 s | 1.181 s | 1.147 s | 1.124 s | 1.128 s | 1.081 s | 1.143 s | 1.045 s | 1.045 s | 1.159 s | 1.143 s | 1.147 s | 1.181 s | 1.193 s | 1.116 s | 1.105 s | 1.105 s | 1.119 s | 1.116 s | 1.119 s | 1.130 s | 1.137 s |

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

After the structural-symbol slice, a warm timed resolver invocation spent
approximately 159 ms in native lexing, parsing, graph/name/type/expression
analysis, encoding, and response-handle creation, plus 7 ms decoding the
remaining compatibility stream. The graph handle supplied all 832 symbols
through one bulk fixed-width record fill rather than one FFI call per field.
The first cold bridge rebuild spent approximately 805 ms in boundary
preparation.

The raw whole-process samples above appeared slower than the immediately
preceding structural-topology checkpoint, so both commits were also measured
side by side from the same temporary filesystem after warming their native
libraries. Structural symbols measured 272.9 ms versus 275.1 ms for Stage 1,
285.9 ms versus 286.5 ms for Stage 0, and 1.179 s versus 1.179 s for the hybrid
path. The symbol handoff is therefore performance-neutral within measurement
noise; the apparent raw regression was host/filesystem variance. This slice
removes symbol serialization and establishes the retained graph handle's
borrowed-string lifetime without claiming a runtime speedup.

After top-level function signatures moved to two additional structural batches,
a warm invocation spent approximately 167 ms in native work and 6 ms decoding
the compatibility stream. Whole-process samples measured 236.6 ms for Stage 1,
248.8 ms for Stage 0, and 1.045 s for the hybrid path. Those raw checkpoints are
better than the preceding samples, but they are not a controlled causal claim:
the structural change removes `signature` and `functionConstraint` serialization,
while machine and filesystem-cache variance can still move the totals.

Completing aggregate, constructor, and method signature handoff measured 149 ms
of warm native work and 5 ms of remaining compatibility-stream decoding.
Whole-process samples were 239.9 ms for Stage 1, 250.2 ms for Stage 0, and
1.045 s for the hybrid path. Those are equivalent to the preceding checkpoint
within normal variance. The compatibility stream now carries semantic evidence
only; signature shape no longer affects its size.

Completing structural call, binding, expression, and nominal-identity evidence
handoff measured 168.22 ms of warm native work and 1.39 ms validating the empty
successful compatibility stream. Whole-process samples were 262.2 ms for Stage
1, 278.1 ms for Stage 0, and 1.159 s for the hybrid path. Stage 1 was 1.06 times
faster than the ordinary Stage-0 check in this run. The successful resolver
payload no longer serializes graph data; only failure diagnostics retain the
temporary framed text path.

Phase API version 1 removes the successful payload and the production
compatibility decoder entirely. The host version-checks the library, validates
structural cardinalities and references, and adopts the canonical graph
directly from the owned result. Warm native phase work including structural
handoff measured 165.82 ms. Whole-process samples were 261.0 ms for Stage 1,
278.9 ms for Stage 0, and 1.143 s for the hybrid path; these remain within the
same performance band as the structural-evidence checkpoint.

Retaining source templates and ordered arguments for user-defined generic
aggregate materializations measured 164.65 ms in the warm native phase.
Whole-process samples were 261.1 ms for Stage 1, 273.2 ms for Stage 0, and
1.147 s for the hybrid path. The stronger nominal-identity proof remains in the
same performance band: Stage 1 was 1.05 times faster than Stage 0 in this run.

Preserving direct and intrinsic async effects measured 175.61 ms for the warm
native phase across the now twenty-eight-module frontend graph. Whole-process
samples were 260.7 ms for Stage 1, 286.1 ms for Stage 0, and 1.181 s for the
hybrid path. Stage 1 remained effectively unchanged from the preceding sample
and was 1.10 times faster than Stage 0. The Stage-0 and hybrid changes are within
the noisy range seen across earlier checkpoints, while the native graph now
proves 957 inferred bindings and 3,628 root expressions.

Preserving structured task effects measured 173.71 ms in the warm native phase.
Whole-process samples were 263.4 ms for Stage 1, 282.0 ms for Stage 0, and
1.193 s for the hybrid path. Stage 1 remained within 1.0 percent of the direct
async-effect checkpoint and was 1.07 times faster than Stage 0. Native
self-analysis now proves 960 inferred bindings and 3,638 root expressions.

Native-source-resolved executor placement, including the extracted capture
module, measured 166.19 ms in the warm native phase. Whole-process samples were
244.3 ms for Stage 1, 249.7 ms for Stage 0, and 1.116 s for the hybrid path.
These are faster raw samples than the preceding checkpoint rather than a causal
optimization claim. The twenty-nine-module graph now proves 974 inferred
bindings and 3,683 root expressions.

Classifying unavailable foreign types and deferring only ABI-dependent
judgments measured 174.67 ms in the warm native phase across the same
twenty-nine-module graph. Whole-process samples were 250.3 ms for Stage 1,
247.2 ms for Stage 0, and 1.130 s for the hybrid path. These remain in the
established band. The native graph now exports 991 inferred bindings and 3,750
root expressions; the wider executable corpus has no partial
binding/expression-authority gaps among the 154 roots its parser accepts.

Adding opaque raw-native body lexing and raw-function structural parsing
measured 177.52 ms in the warm native phase. Whole-process samples were
251.3 ms for Stage 1, 250.4 ms for Stage 0, and 1.137 s for the hybrid path,
again within the established band. The frontend graph exports 1,001 inferred
bindings and 3,803 root expressions, and all 155 executable roots now pass
without a partial native binding/expression-authority gap.

Adding the first native C-emission module produced a thirty-module frontend
graph and measured 181.69 ms for the warm native resolve/semantic phase.
Whole-process resolver samples were 252.7 ms for Stage 1, 247.2 ms for Stage 0,
and 1.147 s for the hybrid path, still inside the established band. On the tiny
scalar/function emission fixture, the deliberately narrow `self-host-emit`
command measured 36.0 ms versus 44.4 ms for production Stage-0 `emit`. That
comparison is useful as an edit-loop baseline, not a speedup claim: the native
proof does not yet perform Stage 0's complete semantic analysis, runtime
lowering, or module/interop work.

The earlier small ordinary Stage-0 increase demonstrated that loading more
modules is not free, so the direction is not guaranteed for every split.
Native module fingerprints and incremental parse/semantic caches should
eventually make a one-file edit proportional to the changed module and its
dependents rather than the whole frontend.
