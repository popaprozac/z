# Performance

This document is an append-only record of dated measurements. Results describe
the named compiler revision, machine, profile, and semantic workload; they are
evidence about Z's performance ceiling, not timeless headline numbers. Current
feature coverage belongs in [`bootstrap-status.md`](bootstrap-status.md).

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
- The cross-language benchmark suite's compilation measurements include Bun
  Stage-0 emission separately from native compilation. The standalone native
  compiler measurements below are a separate self-hosting checkpoint.

The first checkpoint covers portable kernels, direct C calls, dynamic arrays,
deterministic ownership, structured task overhead, and native threads. ARC
identity, Map/Set, generators, Objective-C/C++ boundary calls, and richer async
fan-out remain explicit follow-up cases.

## Native main-executor frame audit

On 2026-08-08, the fixed-point backend's first cross-suspension-local tier was
checked at the generated-C boundary. This is a code-shape audit, not a
cross-language runtime benchmark:

| Operation | Generated cost |
| --- | --- |
| Synchronous or suspension-free placed call | Stack context; zero frame allocations |
| Placed callee containing one or more timer suspensions | One `calloc`/`free` invocation frame |
| Each additional top-level `await delay(...)` | One condition-backed wait and main-executor request; no additional allocation |
| One top-level suspending `if`/`else` | One boolean selector field; only the chosen branch submits callbacks and waits |
| One top-level suspending `match` | One enum subject field plus one `size_t` arm selector; cleanup-bearing payloads add one live bit, and only the chosen arm submits callbacks and waits |
| One top-level suspending `while` | One boolean condition field plus one integer control field; each iteration submits only its synchronous main segments and worker-side waits |
| Cleanup-free local across suspension | One direct frame field |
| Cleanup-bearing local across suspension | One direct frame field plus one liveness bit |
| Local move between segments or into the result | Bitwise ownership transfer; no clone, retain, or second allocation |
| Cancellation | Main-executor destruction of each live owned field, then one frame free |

The separately created `thread.spawn` task still owns its existing task-storage
allocation and native thread. The extra frame allocation is therefore explicit
async machinery, not a tax on ordinary functions. A later lightweight executor
can pool frames or embed them in task storage; any such optimization must retain
the same liveness and executor-routed cleanup behavior.

The same checkpoint also compared equal one-module self-host emission commands
with warm filesystem caches over seven Hyperfine runs. Stage 0 through Bun
measured 47.4 ms ± 1.2 ms; the fixed-point native `z emit` measured 1.8 ms ±
0.3 ms. The native command is short enough that shell-startup noise is material,
so the reported 26.5-times ratio is directional rather than a precise speedup.
It nevertheless confirms that the new frame lowering has not compromised the
native compiler's low-startup-cost edit loop.

The structured-`if` follow-up retained that shape: optimized generated C has
one invocation-frame allocation, one selector bit, and waits only inside the
chosen branch. On the owned-branch fixture, seven warm Hyperfine runs measured
50.6 ms ± 0.8 ms through Bun and 1.9 ms ± 0.3 ms through fixed-point native
`z emit`. The same sub-5-ms shell-noise caveat applies to the 26.8-times
directional ratio.

The ownership-bearing structured-`match` follow-up keeps the same allocation
invariant. Generated C has one invocation frame, one enum subject field, one
`size_t` arm selector, and submits waits only for the selected arm. Scalar and
plain-struct payload bindings are direct reads from that subject. A
cleanup-bearing payload adds one live bit and transfers between the subject
slot and arm binding with direct assignments; cleanup-bearing arm locals add
their existing liveness bits without another allocation. On the owned-`String`
payload fixture, seven warm Hyperfine runs measured 50.1 ms ± 0.9 ms through
Bun and 2.9 ms ± 0.4 ms through the
fixed-point native `z emit`. The native command remains below Hyperfine's 5 ms
precision threshold, so the 17.1-times ratio is directional.

Computed cleanup-bearing match subjects retain that same frame shape. A call or
inline enum construction writes its result directly into the existing subject
field; no temporary frame or second allocation is introduced. Any named values
consumed while computing the subject retire through their ordinary live guards.
On the inline owned-`String` constructor fixture, seven warm Hyperfine runs
measured 69.6 ms ± 1.0 ms through Bun and 4.5 ms ± 1.1 ms through the
fixed-point native `z emit`. The native command remains near Hyperfine's 5 ms
precision threshold, so the 15.3-times ratio is directional.

The first suspending-`while` tier also retains the one-frame invariant. The
condition and synchronous body segments are submitted to main once per active
iteration; direct literal delays remain cancellable worker waits. `break` and
`continue` use one integer control field rather than allocating child frames.
`return` and `throw` reuse a third value of that same control field and write
the existing result slot; they add no allocation or completion object.
Cleanup-bearing iteration locals reuse their existing frame slot and liveness
bit, so normal iteration exit, loop control, and cancellation do not clone or
retain the value. On the owned-local fixture combining normal iteration,
`continue`, and `break`, seven warm Hyperfine runs measured 51.9 ms ± 0.5 ms
through Bun and 3.1 ms ± 0.3 ms through fixed-point native `z emit`. The native
command remains below Hyperfine's 5 ms precision threshold, so the 16.9-times
ratio is directional.

The function-exit follow-up preserves that shape. A fixture that returns both
before and after its suspension emits one invocation-frame allocation for each
placed call and no per-iteration allocation. Seven warm Hyperfine runs measured
47.5 ms ± 1.1 ms through Bun and 2.9 ms ± 0.5 ms through fixed-point native
`z emit`. The 16.5-times ratio is directional because the native command remains
below Hyperfine's 5 ms precision threshold.

Direct synchronous `try` inside that loop adds no frame or completion object.
The native result is checked on main; success writes its payload into the
ordinary local/frame slot, while failure reuses loop completion state `3` and
the existing invocation result. Cleanup-bearing success and error payloads
move directly, with their existing liveness bits carrying responsibility across
the next wait. The three-call success/pre-wait-failure/post-wait-failure fixture
emits exactly one invocation-frame allocation per placed call and no
per-iteration allocation. Seven warm Hyperfine runs measured 49.0 ms ± 0.9 ms
through Bun and 2.8 ms ± 0.2 ms through fixed-point native `z emit`. The
17.2-times ratio is directional because the native command remains below
Hyperfine's 5 ms precision threshold.

## Standalone native compiler checkpoint

On 2026-07-27, the recursively self-built 30-module native driver made a
like-for-like compiler measurement possible. Hyperfine used warm caches, 12
measured runs, and the same macOS arm64 development machine:

| Operation | Stage 0 / Bun | Native `-O0` | Native `-O2 -DNDEBUG` |
| --- | ---: | ---: | ---: |
| Check the 30-module driver graph | 372.3 ms ± 4.1 ms | 601.7 ms ± 3.5 ms | 185.7 ms ± 1.3 ms |
| Emit the 30-module driver graph to C | 1.095 s ± 0.006 s | 982.9 ms ± 4.7 ms | 257.7 ms ± 1.0 ms |
| Check a two-module application | 52.6 ms ± 0.6 ms | 2.0 ms ± 0.1 ms | not separately measured |

The results separate two conclusions. First, the ordinary `-O0` native compiler
is not automatically faster: on its own large semantic workload it is about
1.62 times slower than Bun, despite using less aggregate CPU. Second, the same
generated C compiled as release code checks that graph 2.0 times faster than
Bun and emits it about 4.25 times faster. The small-project native check removes
most runtime startup overhead and is about 26.6 times faster than the Bun
command.

These are compiler-throughput measurements, not generated-program runtime
benchmarks. They justify shipping the compiler itself as optimized native code
while retaining a debuggable `-O0` output profile for user programs. They do not
remove the need to profile String, collection, and semantic hot paths, and they
must be repeated as foreign/project-manifest work enters the native command.

The first repetition followed immediately after the native driver gained its
31st module: a typed `z.json` reader with path validation and Clang target/link
projection. The same machine, warm-cache policy, and 12-run sample measured:

| Operation | Stage 0 / Bun | Native `-O0` | Native `-O2 -DNDEBUG` |
| --- | ---: | ---: | ---: |
| Check the 31-module driver graph | 378.0 ms ± 6.7 ms | 609.7 ms ± 1.6 ms | 190.3 ms ± 1.4 ms |
| Emit the 31-module driver graph to C | 1.109 s ± 0.003 s | 1.018 s ± 0.005 s | 265.3 ms ± 1.4 ms |

Relative to the 30-module checkpoint, release check increased 2.5% and release
emit increased 2.9%. The new release compiler still checks 1.99 times faster
and emits 4.18 times faster than the corresponding Bun command. That is within
the expected cost of adding and semantically resolving a real parser module;
it does not indicate a throughput cliff.

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

Routing native emission through native module resolution and semantic analysis,
then adding checked scalar arithmetic and control flow, measured 36.9 ms on the
factorial fixture versus 44.8 ms for production Stage-0 `emit`. This remains a non-equivalent
subset comparison—the native path still omits runtime and ownership lowering—
but semantic validation is now inside the measured path rather than deferred to
Clang. The thirty-module compiler graph measured 178.84 ms for its warm native
phase; whole-process resolver samples were 249.6 ms for Stage 1, 249.5 ms for
Stage 0, and 1.140 s for the hybrid gate.

Adding cleanup-free value-struct layout, construction, passing, and field access
measured 36.6 ms for native emission versus 44.3 ms for production Stage-0
`emit` on the struct fixture. As above, this is an edit-loop baseline for a
strict subset, not an equal-work backend comparison. The stable result supports
introducing the ownership-lowering IR for semantic correctness rather than
trying to preserve a misleading microbenchmark advantage by keeping the native
emitter underspecified.

Routing all three fixtures through the new typed flat-arena lowering IR measured
37.8 ms for native struct emission versus 45.3 ms for Stage-0 `emit`. The
thirty-one-module compiler graph's warm native phase measured 179.30 ms. The IR
therefore adds an explicit semantic boundary without a meaningful edit-loop
regression at this scale; ownership cleanup correctness remains the reason for
the architecture, not this timing.

The earlier small ordinary Stage-0 increase demonstrated that loading more
modules is not free, so the direction is not guaranteed for every split.
Native module fingerprints and incremental parse/semantic caches should
eventually make a one-file edit proportional to the changed module and its
dependents rather than the whole frontend.

The standalone native driver's first incremental tier now removes the Clang
compile/link step from unchanged `run` commands. It still loads, checks, lowers,
and emits the complete graph, then compares exact C plus profile, target,
toolchain, and foreign evidence before reporting a cache hit. This improves the
edit loop without conflating backend reuse with the still-future module-level
parse and semantic caches. Configured native libraries found unambiguously in
explicit link directories now contribute their canonical path and exact
SHA-256 bytes to the identity. System-search-path or ambiguous libraries still
fail closed to relinking rather than risk a stale executable.

Concurrent native-driver runs now serialize the cache-critical section with an
OS-backed `fs.Lock`. The lock covers inspection, compilation, and metadata
publication but is explicitly released before launching the user program.
Warm single-process hits therefore pay one open/lock/unlock/close sequence,
while concurrent misses avoid duplicate Clang work and torn cache artifacts.
Misses compile into pending paths, then use same-filesystem `fs.replace` to
publish the generated C and executable before atomically publishing complete
metadata last. Failed compilation leaves the prior executable bytes untouched
and an invalid metadata marker prevents stale reuse. This adds no replacement
work to a hit; module-level caches can later reduce the critical section
without changing the public ownership model.

An exploratory `/usr/bin/time` smoke measurement on the one-module native
driver fixture took 0.65 seconds for its initial debug compile and 0.02 seconds
for the immediately repeated cache hit on the same machine. This is not a
cross-language benchmark or a stable performance promise; it confirms that the
hit path actually removes the dominant Clang compile/link work.

The supported local bootstrap path now makes the consecutive-generation gate
directly measurable. A warm-boundary run on 2026-07-28 took 12.0 seconds. That
includes seed emission, an optimized strict C compile, generation one's
optimized recursive build of generation two, a 3,087,259-byte exact-C
comparison, compilation of the adjacent metadata adapter, and publication.
The native `z` is about 820 KiB; the currently Bun-compiled adapter is about
61 MiB because it embeds its trusted JavaScript runtime and Clang-import
orchestration. That size belongs to the temporary toolchain adapter, not every
Z program. This is a bootstrap/release-path measurement rather than an
edit-loop cost; ordinary users should eventually receive trusted platform
artifacts instead of paying it.

A local-view composition checkpoint on 2026-07-29 replaced 64 repeated
`tree.nodes[index]` projections in the recursive expression resolver with one
checked `view`, and replaced defensive owned copies of its child-index Array and
String spelling with owner-tied views. Generated C consequently contains one
root bounds check and no per-call child-array or spelling allocation/cleanup.
This did not yet move whole-compiler latency: interleaved fixed-point native
`z check` measurements were 252.1 ms before and 256.0 ms after, statistically
neutral at `1.02 ± 0.02`. The hybrid check was likewise effectively flat at
3.870 seconds before and 3.900 seconds after (`1.01 ± 0.01`) while also
analyzing and lowering the expanded compiler implementation. This is recorded
as a confirmed generated-code improvement, not a claimed end-to-end speedup.
