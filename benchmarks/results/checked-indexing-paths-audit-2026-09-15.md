# Checked indexing: descriptor-path follow-up

Compiler `db73fb6c`, following the [baseline audit](checked-indexing-audit-2026-09-15.md).
No public API, language rule, unchecked-access capability, or release-mode
safety policy changed.

## Equivalent-code experiment

The baseline opaque native kernels were rebuilt with one change at a time.
Changing `void *` storage to typed pointers, forcing accessor inlining, loading
the pointer before the accessor's guard, passing the descriptor by value, and
calling an index helper from inside the accessor all retained the extra
sequential check. Emitting the checked subscript at the use site removed it.

The landed form keeps the descriptor's field path visible to Clang:

```c
((Element *)state->registers.data)[checked_index(index, state->registers.length)]
```

Here `checked_index` still aborts when `index >= length`. The actual emitter
uses generated pointer typedefs to preserve element constness and Objective-C
strong-storage qualifiers. It repeats only side-effect-free local/field
operands; calls, nested indexing, and other expressions keep the original
accessor. This is not a `restrict` annotation or an unchecked operation.

The resulting optimized IR distinguishes the containing descriptor paths and
loads the register backing pointer before the inner loop. This experiment
establishes the benefit of the complete emission form; it does not claim a
particular LLVM pass is solely responsible.

Opaque-kernel bounds-failure sites, identical at `-O2` and `-O3` on Apple
Clang 17.0.0 (`clang-1700.4.4.1`):

| Kernel | Previous native | Updated native | Checked C / Stage 0 |
| --- | ---: | ---: | ---: |
| Sequential scan | 0 | 0 | 0 |
| Indirect table lookup | 2 | 1 | 1 |
| Register loop, direct fields | 3 | 2 | 2 |
| Register loop, code-field view | 3 | 2 | 2 |

The remaining checks protect unproven indirect and register indexes. In the
normal-inlining register kernels, constructor sizes and operand masks already
let Clang remove all bounds guards before this change.

## Correctness finding

Regression testing found that Stage 0 evaluated the receiver in
`rows[next()].values[0]` twice. Its separate data and length expressions both
included `next()`. Native accessors already evaluated it once. Stage 0 now
captures complex descriptor receivers once; this does not copy array elements
or add ownership operations. The benchmark source does not use this shape, so
the correction is not a change to its algorithm.

Both emitters passed checked read/write/view/empty-array cases, nested
side-effect counters, fixed-array and Slice composition, and String storage at
`-O0`, `-O2`, and `-O3` with UBSan. Out-of-range probes intercept `abort` with a
distinct process exit code to avoid OS crash reports. Objective-C array
self-assignment, indexed property access, pop, and cleanup pass separately.
The native compiler reaches a byte-identical bootstrap fixed point.

## Measurement boundaries

The original kernel, reference C, input, and support sources are unchanged.
The benchmark harness now recognizes the native direct-index guard as well as
the four existing array accessor guards when constructing its bounds-removed
control. It still leaves overflow, allocation, Slice, and unrelated guards
intact and fails closed on an unexpected helper count.

The opaque register-view kernel's medians (milliseconds, 134,217,728
operations, two warmups and nine samples) are:

| Profile | Previous native | Updated native | Same-run checked C | Same-run Stage 0 |
| --- | ---: | ---: | ---: | ---: |
| `-O2` | 68.85 | 49.19 | 49.25 | 48.86 |
| `-O3` | 69.29 | 50.45 | 50.76 | 50.17 |

Native's `-O2` range is 48.29–53.33 ms, overlapping checked C's 47.93–53.89
ms and Stage 0's 47.73–53.26 ms. The previously observed native-only gap is
closed; small differences among the updated emitters are not interpreted as
speedups. The bounds-removed native control is 46.07 ms at `-O2`, reflecting
checks that remain necessary when register sizes are unknown, plus any
optimizer scheduling changes caused by removing them.

Normal inlining remains at the existing checked-C level: the `-O2`
register-view medians are 46.08 ms native, 46.19 ms checked C, and 46.18 ms
Stage 0. There is no corresponding large improvement to claim in that case.

Reports: [opaque functions](checked-indexing-paths-isolated-2026-09-15-darwin-arm64.md)
and [normal inlining](checked-indexing-paths-2026-09-15-darwin-arm64.md).
Adjacent JSON files contain every sample, toolchain, compiler and input hash,
and the generated C/IR/assembly artifact locations. Input and support hashes
match the original reports. This benchmark records individual compile times,
not a statistically controlled compiler-build-speed comparison.

These are synthetic kernel results, not an end-to-end JavaScript engine
speedup. The consumer currently measures Stage 0 emission, which already had
the favorable checked form for these kernels. No consumer rewrite or repin is
required to validate the native optimizer result.
