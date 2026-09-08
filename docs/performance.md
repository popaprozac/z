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
  Stage-0 emission separately from native compilation. The standalone native
  compiler measurements below are a separate self-hosting checkpoint.

The first checkpoint covers portable kernels, direct C calls, dynamic arrays,
deterministic ownership, structured task overhead, and native threads. ARC
identity, Map/Set, generators, Objective-C/C++ boundary calls, and richer async
fan-out remain explicit follow-up cases.

## Bounded channel checkpoint

On 2026-09-01, the capacity-one bounded channel was measured over seven runs
after two warmups on the same macOS arm64 development machine. The focused
report is
[`checkpoint-2-channels-macos-arm64.md`](../benchmarks/results/checkpoint-2-channels-macos-arm64.md).

| Workload | Z | C | Rust | Go | Z allocations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Same-thread send + receive, 2M round trips | 18.674 ms | 17.449 ms | 14.727 ms | 32.594 ms | 2 fixed |
| Async producer → native consumer, 250K values | 1.343 s | 1.102 s | 919.797 ms | 697.602 ms | 250,004 |
| Synchronous producer → native consumer, 250K values | 1.087 s | 1.111 s | 925.699 ms | 701.108 ms | 4 fixed |

The synchronous cross-thread control is the channel's native ceiling: Z was
0.978 times the C duration in this sample and requested only 0.7 KiB of fixed
storage. The ring, ownership transfer, mutex, and condition-variable lowering
therefore do not show a material abstraction penalty.

The async producer is a deliberately different scheduling contract measured
against the same blocking native handoff. Each `await sender.send(...)`
currently creates one heap-owned task frame. The tracked run requested about
44 MiB across 250,004 balanced allocations—approximately 184 bytes per send—and
ran 1.218 times the C duration. Frame reuse or pooling is therefore the clear
optimization target; replacing the channel storage or weakening ownership is
not. This cost is recorded for optimization and does not block using channels
for Zapp Worker control traffic.

### Tracked optimization: reusable async invocation frames

This is an explicit performance backlog item, not only a historical benchmark
observation.

| Item | Requirement |
| --- | --- |
| Scope | Short-lived heap-owned frames created by repeated async calls, beginning with channel `send` and `receive` |
| Candidate implementation | Per-executor cache, size-class pool, or another reuse design that keeps ownership local to the responsible executor |
| Allocation goal | Allocation count grows with peak concurrently live frames, not the total number of completed operations |
| Semantic constraints | Preserve exact liveness, owned-result transfer, cancellation propagation, waiter removal, executor-affine destruction, and deterministic cleanup |
| Validation | Re-run the focused channel suite unchanged; add cancellation/close stress under ASan and verify balanced cleanup before accepting a speedup |
| Product priority | Important runtime optimization, but not a blocker for the first Zapp Worker vertical slice because control traffic is not a per-element bulk-data path |

The first implementation should remain narrow. General slab allocators,
work-stealing executors, wait sets, and channel selection are separate design
problems and should not be pulled into frame reuse without measured need.

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

## Compiler-scale flow and foreign-import checkpoint

On 2026-08-30, five native-frontend changes reduced repeated ownership-state
copies, indexed call evidence by source offset, used compact symbol identities
for stored-view recursion, and avoided full generic parsing or empty
substitution walks on common lookup paths. Hyperfine compared the same complete
native-driver emission with warm filesystem caches over five interleaved runs:

| Native `z emit compiler/driver/main.zs` | Mean | Range |
| --- | ---: | ---: |
| Before | 2.650 s ± 0.017 s | 2.626–2.666 s |
| After | 1.570 s ± 0.014 s | 1.552–1.586 s |

The optimized compiler was 1.69 ± 0.02 times faster for that workload. The
change passed the 127-test fixed-point self-hosting suite. This is compiler
throughput, not generated-program runtime.

The same checkpoint profiled a cold language-service diagnostic request for
Zapp's macOS `application.zs`. Of a 59.03-second instrumented run, 58.78
seconds were spent resolving foreign modules; entry parsing, project loading,
the Z module graph, generic materialization, and semantic analysis together
took under 260 milliseconds. The graph imported `zapp_desktop.h`, Foundation,
and WebKit seventeen times through module-local aliases, and the cache treated
every alias as a different Clang producer.

Foreign import caching now keys the expensive producer by header, include
configuration, contract/API-note freshness, language, deployment target, and
local header freshness—not by a module's private alias. One compiler-owned
canonical IR is retained and cheaply requalified for each local namespace, so
source-facing hover names and nominal types remain unchanged. A one-process
cold sample fell from the controlled 51.49-second pre-change baseline to 11.28
seconds, a 4.56-times improvement. The remaining latency is primarily the
three genuinely distinct Clang imports and remains an optimization target;
this checkpoint does not claim a persistent cross-process SDK cache.

Editor analysis dependencies now also include `z.json`, generated overlays,
source modules, local headers, and present or absent `.zd` candidates. Creating,
editing, or deleting one therefore invalidates both successful and briefly
cached failed analyses immediately instead of returning stale diagnostics.

The fixed-point driver had a second alias cost after Stage 0 stopped repeating
Clang work. Each Z module still owned a separate 12–28 MB ZFDCL artifact and
the native compiler decoded and normalized every artifact even when the
producer fingerprint and imported namespace were identical. The normalized
contract graph is now one immutable ARC identity shared within the compiler
invocation. Reuse requires both the adapter's dependency/contract fingerprint
and the source-visible namespace, so two aliases cannot accidentally exchange
qualified native identities.

On the same generated Z Notes benchmark project, a warm-filesystem
`z metadata` invocation fell from 38.47 seconds to 11.34 seconds, a 3.39-times
improvement. Both outputs were 149,930 bytes; the only observed JSON changes
were source offsets from an unrelated five-byte source correction. This cache
does not skip adapter freshness validation and does not yet deduplicate the
large on-disk artifacts. Persistent canonical ZFDCL storage and cheaper
cross-process dependency validation remain follow-up work.

## Z Notes native build latency checkpoint

A 2026-09-04 profile used the generated native core of the real Z Notes
application rather than a reduced compiler fixture. The original cold release
build took 179.00 seconds, peaked near 7.69 GB, and retired approximately 2.03
trillion instructions. Indexing imported-type identity, visible-type, alias,
and final hidden-identity lookups in native lowering reduced the same cold build
to 57.90 seconds and approximately 525 billion instructions: 3.09 times faster
and about 74 percent fewer instructions.

The next profile showed two remaining sources of repeated work: foreign names
were rediscovered with contract-wide scans, and every generic call-site rebuilt
the same broad imported-type evidence for its owning module. Contract-local
indices, direct decoding of compiler-hidden nominal names, owner-grouped generic
lowering, and demand-driven hidden identities reduced the final verified cold
build to 35.80 seconds, approximately 310 billion instructions, and a 3.27 GB
peak footprint. That is 5.0 times faster than the original application build,
roughly 85 percent fewer instructions, and comfortably below the first one-minute
DX target. Repeated measurements landed between 34.83 and 37.48 seconds.

Project `build` now has an early whole-project cache boundary before module
loading, foreign validation, semantic analysis, lowering, and Clang. Its input
record covers the compiler executable, reachable Z modules, manifests,
generated overlays, explicit native-library bytes, target/toolchain identity,
and the transitive native-header and adjacent `.zd` set emitted by Clang. On the
same machine, an unchanged Z Notes build fell from the final 35.80-second cold
path and 3.27 GB peak footprint to 0.22 seconds and roughly 12.5 MB. Tests
prove that editing either a reachable Z module or a transitively included C
header invalidates reuse and rebuilds the artifact.

Cache input schema v2 also binds an entry to the path and digest of the active Z
compiler. Merely retaining the older compiler binary on disk is insufficient:
a different compiler executable cannot reuse its generated native source or
artifact. A fixed-point regression exposed and now guards this distinction.

One more application profile made the remaining foreign-import cost precise.
Although the native adapter artifact was already fresh, normalization repeatedly
searched the complete Clang type and Objective-C interface collections for each
parameter, field, and result. Raw declaration decoding now constructs canonical
enum, scalar, record-value, record-pointer, and Objective-C interface indices
once. Contract normalization consumes those indices without changing which
source spellings, aliases, qualifiers, or ABI facts are accepted.

The same real Z Notes cold release build subsequently took 19.62 seconds,
retired approximately 89.1 billion instructions, and peaked near 1.78 GB: 1.82
times faster than the preceding 35.80-second checkpoint, about 71 percent fewer
instructions, and roughly 46 percent less peak memory. Compared with the original
179-second application build, this is a 9.1-times reduction. A post-change Time
Profiler trace attributed only 0.47 seconds of sampled compiler CPU to foreign
module loading, down from 11.15 seconds. Native lowering now dominates compiler
CPU at about 5.45 seconds, while Clang compilation/linking accounts for most of
the remaining wall time.

This is still not incremental compilation. A one-byte source edit pays the full
cold path, now about 20 seconds on this machine. The measured next boundaries
are sharing imported-type evidence directly through lowering and splitting the
monolithic generated translation unit into independently compilable artifacts.
A persistent AST cache alone would save little: parsing and project loading are
now about one second, while cross-module generic lowering and Clang remain the
dominant work. The existing `run` cache also remains a later emitted-C comparison
and can reuse the early input record in a future slice.

## Z Notes end-to-end build sweep — 2026-09-08

This checkpoint measures the real Zapp build pipeline, not only `z build`.
The host was an Apple M4 Pro with 24 GiB RAM, macOS 26.4 arm64, Apple Clang
17.0.0, and Bun 1.3.14. Source revisions: Z `53ec87f`, Zapp `d89bb92`.
The native driver was the current fixed-point `.z-cache/bootstrap/z`.

The build-only probe called the same config loader, service preflight, Vite
production build, and `compileNative` functions as `spikes/z-notes/run.ts`.
It did not launch the application, open a WebView, or touch application data.
It observed subprocess wall times with unchanged compiler arguments and bounded
each child process group to 180 seconds. The second invocation used identical
source, configuration, and release settings. Existing caches were not purged:
"first invocation" is not a clean-room cold build.

| Stage | First invocation | Unchanged repeat |
| --- | ---: | ---: |
| Load Zapp config | 0.004 s | 0.003 s |
| Checked service metadata, including worker protocol | 8.79 s | 0.21 s |
| `bunx vite build`, including launcher | 2.20 s | 1.51 s |
| Compile worker bridge and create archive | 0.50 s | 0.41 s |
| Separate generated-dispatcher `z check` | 16.23 s | 17.00 s |
| Main `z build --release`, **failed** | 19.34 s | 19.24 s |
| Total until failure, including other staging | **47.20 s** | **38.51 s** |

These are single-run observations, not medians. The build failed during Clang
validation of generated Objective-C. **They are not successful build or launch
times**, and do not include completed native optimization/linking, bundling,
signing, or application startup. These initial failed attempts cannot establish
a warm-build speedup; the successful follow-up measurements are below. No Go,
Bun-based framework, or Tauri comparison was run in this sweep.

### Initial correctness gate (resolved below)

The initial native compiler emitted references to undeclared
`_z_stage1_live__z_stage1_match_payload_*` flags in ordinary async match paths.
The application reproduces both a moved match payload passed to an awaited
child and an owned error payload returned inside another aggregate. The former
has an existing `_z_stage1_async_live_*` frame guard but references a different
name; the latter references a guard with no declaration. The same five Clang
diagnostics occurred in both builds. The generated dispatcher check passes
because it lowers the program without compiling the emitted native source.

The required gate was to fix these upstream and add reduced regression coverage
for existing async lowering paths before using the full application to certify
performance or resuming listener integration. Generated C and ownership checks
must not be patched around to make a timing run pass.

### Confirmed unchanged-build costs

1. **Worker archive instability defeats compiler reuse.** Comparing the current
   bytes of 1,647 recorded cache-input paths across the repeat found only
   `libzapp_worker_zjs.a` changed. `zapp_worker_zjs.o` was byte-identical. The
   archive member headers contain timestamps; `stageZApplicationWorkerRuntime`
   recompiles the object and invokes `ar rcs` on every build. Z correctly hashes
   explicit native-library bytes, so this unnecessary archive change is enough
   to invalidate a previously successful input record. The failed native build
   is independently unable to publish a new successful cache record. Preserve
   native dependency checking; cache the bridge by its real inputs and produce
   deterministic archives, rather than excluding the archive from the key.
2. **The dispatcher check repeats broad compiler work.** It checks 85 Z modules
   and includes full native lowering. The subsequent application build includes
   the generated dispatcher through the registration overlay, checking/lowering
   the graph again. Prefer one authoritative checked build, with negative tests
   proving malformed generated dispatch/overlays still fail. If the separate
   check remains useful for standalone tooling, cache its complete inputs.
   Removing this duplicate pass targets about 16–17 seconds in this workload;
   that is measured redundant work, not a verified end-to-end speedup yet.
3. **Dev and release share one native cache slot.** Both stage into
   `.zapp/z-native-core` and use the same target/cache metadata path. Z correctly
   distinguishes the build profile, and the generated WebView/assets differ,
   so switching modes invalidates the other mode's last entry. Separate
   profile/config artifact namespaces are a follow-up. This observation is from
   source inspection; the sweep did not time mode switching.
4. **Smaller work still happens on every invocation.** Worker-protocol metadata
   is recollected even after service metadata reuse. Vite itself reported only
   133–148 ms, while the `bunx` launcher also performed dependency resolution.
   Workspace staging removes and recopies source, and generated metadata is
   rewritten. Content-preserving staging and a resolved local Vite executable
   are lower-priority opportunities after the expensive duplicate work.

### Native compiler hotspots

A separate bounded stack sample of the passing 85-module dispatcher check took
17.64 seconds under instrumentation. Of 7,444 main-thread samples, 3,001 were
at `__wait4` under foreign-adapter process calls (about 40%); 3,393 were under
`lowerModules` (about 46%), predominantly `importedTypesForModule`, type-name
lowering, set lookups, string construction, and copying. These are sampled
stack proportions including blocked time, **not CPU percentages or precise
phase durations**. The native parent sample does not resolve where its adapter
children spend their own time.

The evidence reinforces two compiler targets: avoid redundant foreign-adapter
invocations using validated canonical input/dependency evidence, and share/index
imported-type information instead of repeatedly constructing broad per-module
copies. Preserve aliases, `.zd` contracts, header dependencies, target settings,
and compiler identity in reuse decisions. A parser rewrite is not the first
performance lever indicated by this profile.

### Successful follow-up: guard repair and unchanged-build reuse

The upstream guard repair uses the lowering planner's live flag consistently
in tail-await frames and declares it in synchronous post-await match arms.
The reduced fixture covers moved success/error payloads, custom cleanup,
cancellation around child ownership, and destruction of unclaimed aggregate
results. Stage 0/native execution and bounded UBSan probes pass. The native
compiler was rebuilt to a fixed point before these application measurements.

Zapp now publishes deterministic native archives from freshly compiled objects.
Identical bytes leave the previous archive untouched. Object compilation still
runs, so header, compiler, and flag changes are not hidden by a new dependency
cache. Regression tests cover timestamp-only changes, changed header contents,
archive corruption, and archiver failure without replacing a valid artifact.

The separate generated-dispatcher `z check` is removed. The final
`z build --generated ...` remains authoritative: standalone-driver tests build,
hit the cache, then reject malformed generated code and stale overlay hashes.
This removes the observed 16–17-second duplicate pass without removing semantic
validation or changing release optimization.

| Successful workload | Observed wall time | Measurement boundary |
| --- | ---: | --- |
| Release pipeline requiring native recompilation | 31.08–32.21 s | Metadata reuse, Vite production build, native compile/link, bundle and ad-hoc signing |
| Unchanged release pipeline | 2.02–2.90 s | Same complete build-only pipeline, including Vite |
| Dev pipeline requiring native recompilation | 25.03 s | Service metadata, native compile/link, development bundle and signing |
| Unchanged dev build-and-bundle | 0.58–0.69 s | Excludes Vite server startup, worker bundling, and app launch |
| Native `z build` inside unchanged runs | 0.19–0.30 s | Validated compiler input-cache hit |
| Native debug build after generated Z source changed | 24.60 s | Direct `z build`; unchanged repeat 0.20 s |

These are local observations, not statistical medians. Existing metadata and
SDK caches were warm; the recompilation rows are **not clean-machine builds**.
Dev and release still share an artifact slot, so the first mode switch rebuilt
the native application. The generated-source invalidation probe added only a
comment to a generated dispatcher; it proves conservative invalidation, not
fine-grained semantic incremental compilation. Normal generation subsequently
restored that artifact. No interactive launch or startup time is included.

Repeat the build-only pipeline using
`bun benchmarks/profile-zapp-build.ts ../zapp release <label>` (or `dev`).
The probe records phase/command timings in
`.z-cache/benchmarks/zapp-build.jsonl`, bounds subprocess groups, and does not
launch the application. See `benchmarks/README.md` for prerequisites and the dev
measurement exclusions. Compare successful runs with successful runs; do not
divide the original failed-build times by these cache-hit results.

### Agreed work remains queued; remaining performance sequence

The paused functional checkpoint remains **main-host wakeup placement and
cancellation/join integration for the lifecycle-owned launch listener**, followed
by startup/readiness. The endpoint/inbox probe remains compile-only; automatic
secondary-instance forwarding is still disabled. See the matching continuation
in Zapp's `docs/application-activation.md` and Z's ownership-pressure log.

The correctness/cache checkpoint above is complete. The remaining performance
sequence, without losing the functional continuation, is:

1. Separate profile caches; measure frontend-only, one-Z-file, contract/header,
   and compiler-change invalidation separately.
2. Profile/cache foreign-adapter work and reduce imported-type lowering copies.
3. Only then design module/object-level incremental code generation and native
   compilation to reduce genuine source-change rebuilds. Do not trade runtime
   optimization or ownership checks for an apparently faster release build.

An unchanged build should validate inputs and reuse artifacts, not lower 85
modules again; this now holds for same-profile Z Notes repeats. Genuine source
changes still pay the broad lowering/Clang path, so changed-source latency is the
next material compiler target. This is a tooling/compiler implementation goal,
not a proposed change to Z syntax or application semantics. Clean-cache builds,
interactive dev launch, memory, and the wider invalidation matrix remain to be
measured separately.

## Compiler and runtime benchmark refresh — 2026-09-08

The reproducible suite now includes `benchmarks/build-latency.ts`, independent
of Zapp. It builds identical 24-module projects (16 helper functions per module)
through Stage 0 and the fixed-point native driver. Three trials alternate
driver order. Each source/header mutation changes the executed checksum, so a
fast stale executable cannot pass. Every native unchanged run must report an
input-cache hit; source/header/profile changes must miss. Process groups have
180-second watchdogs and only probe-owned temporary directories are removed.

Measured on the Apple M4 Pro development host, using compiler source revision
`e9a9608` with benchmark-harness edits. Debug builds use `-O0`, release builds
`-O2 -DNDEBUG`; bootstrap and executable validation are outside the timing.
Normal desktop/background services were active, but compiler test processes
were stopped before the measured runs. Fresh project caches still share warm
host filesystem/toolchain caches and are not clean-machine builds.

| Build scenario | Stage-0 median | Native median |
| --- | ---: | ---: |
| Fresh project cache | 316 ms | 317 ms |
| Unchanged debug build | 309 ms | 50 ms |
| One module changed | 302 ms | 182 ms |
| Transitive C header changed | 303 ms | 245 ms |
| Switch debug → release | 296 ms | 181 ms |
| Unchanged release build | 292 ms | 53 ms |
| Return release → debug | 302 ms | 169 ms |

The [complete matrix](../benchmarks/results/build-latency-2026-09-08.md)
and [raw trials](../benchmarks/results/build-latency-2026-09-08.json) include
min/max, toolchains, checksums, cache outcomes, and binary sizes. This synthetic
workload shows roughly sixfold faster native no-op builds, but **does not**
predict 50-ms Z Notes rebuilds or prove universally faster native cold builds.
Source changes still rebuild the whole graph. Switching back to debug misses
despite a previous successful debug build, confirming the remaining
profile-specific artifact-cache opportunity. The real Z Notes boundary and
its 24–32-second recompilation cost remain documented above.

The full runtime suite was rerun separately: nine samples after two warmups,
all nine workloads and applicable C/C++/Rust/Zig/Nim/Go references, at the
existing runtime `-O3 -DNDEBUG` profile. All checksums passed. The harness now
also preserves raw samples and allocation records in adjacent JSON rather than
only Markdown medians, and bounds compiler/native subprocess execution.

| Runtime probe | Z / native control duration | Observation |
| --- | ---: | --- |
| Arithmetic | 1.008× C | Same inspected hot-loop instructions; no allocation |
| Imported C call | 1.007× C | One direct call per iteration in optimized assembly |
| Dynamic array | 1.028× C | Matching growth allocation counts; checked indexing |
| Struct ownership | 0.995× C++ | One drop call per iteration after optimization |
| Structured task pair | 1.013× direct Z await | Same frame allocation count in both paths |
| Native thread create/join | 0.931× C | OS scheduling noise; larger Z task storage remains |
| Same-thread channel | 1.078× C | Two fixed Z allocations; no per-message ring allocation |
| Async producer channel | 1.188× blocking C | Different scheduling semantics; one task frame per send |
| Synchronous channel | 1.007× C | Four fixed allocations; semantics-matched native control |

See [the runtime report](../benchmarks/results/checkpoint-2026-09-08-macos-arm64.md)
and [raw samples](../benchmarks/results/checkpoint-2026-09-08-macos-arm64.json).
Most absolute kernel times are higher than July's report, including C controls;
that is not evidence of a Z compiler regression by itself. Arithmetic, direct
C calls, and deterministic cleanup retain their expected low-overhead shapes.
The other assembly-classification rows in the generated report remain prior
inspection notes, not automatically re-proven claims.

One concrete memory change deserves tracking: the async-pair probe still makes
100,001 balanced allocations but now requests 10,400,192 bytes, versus about
8.8 MB in July: **104 versus 88 bytes per ready-task frame**, plus one root
frame. Inspection against the earlier emitter finds two additional,
unconditional executor pointers in the shared task header (`completion_executor`
and `native_executor`), accounting for that 16-byte increase on this host.
The thread probe also
shows increased frame storage. These are requested allocation bytes, not peak
resident memory, and the change is not attributed to this turn's native
TaskScope fix (these runtime probes emit through Stage 0). Audit shared task
header growth and consider feature-specific/cold fields before adding further
per-task state. Async channel frame reuse/pooling remains the highest-volume
known allocation target; the channel's synchronous ring path is already near C.

Next benchmark expansion should cover header/.zd/overlay/compiler invalidation,
SDK-heavy graphs, peak memory, native-emitter runtime parity, ARC identity,
Map/Set, and generators. Keep compile latency, runtime, and allocation costs
separate. No claim about beating all contemporary languages follows from these
small workloads.
