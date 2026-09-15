# Checked indexing: generated-code audit

Compiler `684ce980`, Apple M4 Pro, macOS/Darwin 25.4.0 arm64, Apple Clang
17.0.0 (`clang-1700.4.4.1`). Both `-O2 -DNDEBUG` and `-O3 -DNDEBUG` were
inspected. Compiler source was committed and unchanged; benchmark additions
were uncommitted and their exact hashes are recorded with the measurements.

Reports: [normal inlining](checked-indexing-2026-09-15-darwin-arm64.md),
[opaque functions](checked-indexing-isolated-2026-09-15-darwin-arm64.md).
Their adjacent JSON files retain every measured sample and generated-source
hash. Run instructions and validity boundaries are in the
[benchmark guide](../README.md#checked-indexing-code-generation-audit).

## What survived optimization

The table counts distinct bounds-failure sites in each **opaque kernel's**
optimized LLVM IR, not `abort` calls in the whole binary. Assembly may merge
several failure sites into one shared `abort` block. Allocation, setup,
clock-subtraction, and cleanup are outside these kernel functions.

| Kernel | Checked C | Stage 0 | Native emitter |
| --- | ---: | ---: | ---: |
| Sequential scan | 0 | 0 | 0 |
| Indirect table lookup | 1 | 1 | 2 |
| Register loop, direct fields | 2 | 2 | 3 |
| Register loop, code-field view | 2 | 2 | 3 |

These counts match at `-O2` and `-O3`. Sequential scanning proves its own
range. An indirect table address needs a runtime check; when register sizes
are opaque, source and destination indexes need checks too. The native emitter
also retains the sequential index check before the indirect lookup and the
instruction-fetch check in the register loops. Stage 0 and checked C eliminate
those checks while retaining the genuinely unproven accesses.

The native register loop additionally reloads the register data pointer inside
the loop; Stage 0 hoists it. For example, the native `registersView` `-O3`
assembly contains both:

```asm
cbz x14, LBB0_11       ; instruction-count check inside the loop
...
ldr x2, [x0, #72]     ; reload register data pointer
ldr x16, [x2, x16, lsl #3]
```

Its loop latch already decrements `x14` and exits at zero. Stage 0 has no
corresponding inner `cbz`, and loads the register descriptor before the loop.
The native descriptor/accessor form and Stage 0's typed storage/index-helper
form therefore expose different optimization opportunities to Clang. The
precise cause needs a controlled equivalent-code experiment; it is **not yet
attributed to `void *`, a single branch, or one optimizer pass**.

Under normal inlining, Clang also sees the constructor's 256-register extent
and the masked operand indexes. All register and instruction bounds checks
disappear in both emitters. The direct-field and field-view kernels have the
same relevant optimized operations: the view itself adds no runtime machinery.
The indirect lookup retains its data-dependent check, while its sequential
index check disappears in both emitters.

## Runtime evidence

Each kernel runs 4,096 elements × 32,768 rounds (134,217,728 operations), two
warmups and nine samples per variant, rotating/reversing variant order. These
are native kernel times; they exclude setup, allocation, cleanup and startup.

Selected `-O2` medians, milliseconds:

| Register-view kernel | Checked C | Checked Stage 0 | Checked native |
| --- | ---: | ---: | ---: |
| Normal inlining | 46.91 | 46.24 | 46.43 |
| Opaque function | 48.73 | 49.84 | 68.85 |

Removing **all array bounds guards** in the opaque control gives 45.82 ms,
45.77 ms, and 45.74 ms respectively. That is an upper-bound experiment on this
valid-input workload, not a proposed optimization: it removes the legitimate
register checks as well as the redundant instruction check and changes
optimizer scheduling. It does not establish how much a safe emitter-only fix
will recover. `-O3` shows the same structural issue (opaque checked native
69.29 ms versus Stage 0 49.61 ms).

Most normal-inlining differences are small relative to sample variation.
The normal `-O3` indirect rows were particularly noisy; no gain or regression
is inferred from them. The opaque register gap is larger than the recorded
sample ranges. None of these numbers predicts an end-to-end JavaScript engine
gain: this kernel has no dispatch, object model, calls, collection, exceptions,
or real bytecode validation. It neither confirms nor refutes the consumer's
2–9% bounds-only engine measurements.

## Next optimization boundary

First investigate equivalent checked native accessor/emission shapes that let
Clang eliminate the dominated sequential checks and hoist descriptor loads.
Retain the register/index checks when their range is unproven; do not introduce
`restrict`, unchecked public APIs, or profile-dependent safety changes as a
shortcut. Re-run these identical kernels and negative bounds tests after any
emitter change, then measure the actual consumer.

General method-effect inference and views through indexed owners are separate
language/checker work. The consumer's existing interpreter layout does not
need to be redesigned to use a field view merely to validate this checkpoint.
