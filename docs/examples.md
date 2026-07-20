# Examples

The examples are small executable specifications for the stage-0 compiler. Run
them from the repository root with `bun run z run <path>`; use `check` for
compile-only probes and `emit` to inspect generated native code.

## Start here

| Area | Example | What it demonstrates |
| --- | --- | --- |
| First native program | [`first.z`](../examples/language/basics/first.z) | Functions, inference, direct C import |
| Console and strings | [`console.z`](../examples/language/basics/console.z) | Explicit standard import, interpolation, typed formatting |
| Modules | [`modules/main.z`](../examples/language/modules/main.z) | Exports, namespace imports, selective aliases |
| Construction | [`construction.z`](../examples/language/basics/construction.z) | Struct object construction and class-only `new` |
| Results | [`result.z`](../examples/language/control-flow/result.z) | `return`, `throw`, `attempt`, and exhaustive matching |
| Options | [`option.z`](../examples/language/types/option.z) | `Option.some`, `Option.none`, and payload matching |
| Application walkthrough | [`document-workspace`](../examples/applications/document-workspace) | A native document model combining modules, errors, arrays, named enums, optional views, mutation, and deterministic cleanup |
| Self-hosting groundwork | [`source-stager`](../examples/applications/source-stager) | File IO, owned argv, typed OS failures, and direct no-shell child launch |
| Source tokenizing | [`source-inspector`](../examples/applications/source-inspector) | Checked UTF-8 byte offsets, typed lexer errors, owned tokens, and `TextBuffer` escape decoding |

```sh
bun run z run examples/language/basics/first.z
bun run z run examples/language/basics/construction.z
bun run z run examples/language/control-flow/result.z
```

## Ownership and values

| Area | Examples |
| --- | --- |
| Borrow capabilities | [`borrowed-parameters.z`](../examples/language/ownership/borrowed-parameters.z), [`native-out.z`](../examples/interop/c/native-out.z) |
| Receiver-tied views and regions | [`optional-views.z`](../examples/language/ownership/optional-views.z), [`arena.z`](../examples/language/ownership/arena.z), [`ownership-views.z`](../examples/interop/objc/desktop-ownership/ownership-views.z) |
| Deterministic cleanup | [`deinit.z`](../examples/language/ownership/deinit.z), [`replacement.z`](../examples/language/ownership/replacement.z), [`consuming-methods.z`](../examples/language/ownership/consuming-methods.z) |
| ARC and weak references | [`classes.z`](../examples/language/basics/classes.z), [`weak-references.z`](../examples/language/ownership/weak-references.z) |
| Closures | [`closures.z`](../examples/language/basics/closures.z), [`owned-closures.z`](../examples/language/ownership/owned-closures.z), [`function-values.z`](../examples/language/basics/function-values.z) |
| Collections | [`arrays.z`](../examples/language/collections/arrays.z), [`slices.z`](../examples/language/collections/slices.z), [`dynamic-arrays.z`](../examples/language/collections/dynamic-arrays.z) |
| Generics and traits | [`generics.z`](../examples/language/types/generics.z), [`generic-constraints.z`](../examples/language/types/generic-constraints.z) |
| Enums and matching | [`enum-patterns.z`](../examples/language/control-flow/enum-patterns.z), [`match-expression.z`](../examples/language/control-flow/match-expression.z), [`owned-enums.z`](../examples/language/ownership/owned-enums.z) |

## Native interop

| Boundary | Example | Notes |
| --- | --- | --- |
| Selective C import | [`selective-import.z`](../examples/interop/c/selective-import.z) | Header declarations with local aliases |
| C records and enums | [`foreign-types.z`](../examples/interop/c/foreign-types.z) | Native layouts and constants |
| C pointers | [`foreign-pointers.z`](../examples/interop/c/foreign-pointers.z), [`foreign-handle.z`](../examples/interop/c/foreign-handle.z) | Borrowed and owned `.zd` contracts |
| Z declaration contract | [`declared-handle.z`](../examples/interop/c/declared-handle.z), [`declared-handle.h.zd`](../examples/interop/c/declared-handle.h.zd) | Adjacent `.zd` capabilities, niche-backed `Option.fromNullable`, borrowed/consuming match, and `deinit` release |
| C callbacks | [`callbacks.z`](../examples/interop/c/callbacks.z), [`callbacks.h.zd`](../examples/interop/c/callbacks.h.zd) | `.zd` call-only borrowing plus escaping ownership, named context/release pairing, and caller-thread guarantees |
| Deployment target | [`deployment-target`](../examples/interop/c/deployment-target) | Explicit macOS minimum version, Clang/Swift target propagation, and Z-native deprecation warnings |
| C++ | [`cpp-interop.z`](../examples/interop/cpp/cpp-interop.z), [`cpp-selective-interop.z`](../examples/interop/cpp/cpp-selective-interop.z) | Qualified and selective namespace imports, aliases, overloads, and records |
| C++ lifecycle value | [`foreign-values.z`](../examples/interop/cpp/foreign-values.z), [`cpp-callables.z`](../examples/interop/cpp/cpp-callables.z), [`foreign-values.hpp.zd`](../tests/fixtures/foreign-values.hpp.zd) | `.zd` copy/deinit contract, native aggregate copies, constructors, static/const/mutable methods, overloads, and deterministic RAII destruction |
| C++ move-only value | [`cpp-move-only.z`](../examples/interop/cpp/cpp-move-only.z), [`move-only.hpp.zd`](../tests/fixtures/move-only.hpp.zd) | `.zd` move/deinit contract, `in` borrow, owned calls/returns, whole-struct moves, use-after-move diagnostics, and deterministic native destruction |
| C++ move-only storage | [`cpp-move-only-array.z`](../examples/interop/cpp/cpp-move-only-array.z), [`cpp-move-only-enum.z`](../examples/interop/cpp/cpp-move-only-enum.z) | Native move construction during dynamic-array growth, reverse destruction, named enum payload borrowing/consumption/replacement, and mixed Z/native cleanup |
| C++ arena storage | [`cpp-arena.z`](../examples/interop/cpp/cpp-arena.z) | Stable region views over move-only C++ values and destructor-driven reset to zero live resources |
| C++ references | [`cpp-references.z`](../examples/interop/cpp/cpp-references.z) | `const T&`, `T&`, move-only `T&&`, and receiver-qualified methods mapped onto existing Z capabilities with no wrapper overhead |
| AppKit window | [`nswindow.z`](../examples/interop/objc/nswindow.z) | Direct Objective-C ARC calls |
| Objective-C nullability | [`objc-nullability.z`](../examples/interop/objc/objc-nullability.z) | `T | null`, narrowing, and `Option.fromNullable` |
| Persistent AppKit events | [`appkit-events.z`](../examples/interop/objc/appkit-events.z) | Native blocks, weak capture, observer tokens |
| Swift class | [`swift-interop`](../examples/interop/swift/swift-interop) | Generated Objective-C compatibility header |
| Swift value | [`swift-value-interop`](../examples/interop/swift/swift-value-interop) | Generated C++ methods, owned aggregate storage, and exact explicit `String` return copies |
| Swift enum | [`swift-enum-interop`](../examples/interop/swift/swift-enum-interop) | Direct generated associated-value case factories, owned copies, methods, and cleanup |

Apple examples require macOS and Xcode Command Line Tools. `appkit-events.z`
opens a native window and exits when that window closes.

## Async and structured concurrency

Read [`async-model.md`](async-model.md) alongside these examples:

| Shape | Example |
| --- | --- |
| Sequential await | [`async-sequential.z`](../examples/async/async-sequential.z) |
| Typed errors | [`async-errors.z`](../examples/async/async-errors.z) |
| Hot spawn and explicit join | [`async-spawn.z`](../examples/async/async-spawn.z) |
| Lexical task scopes | [`async-scopes.z`](../examples/async/async-scopes.z) |
| Cancellation | [`async-cancellation.z`](../examples/async/async-cancellation.z) |
| Caller-driven cancellation | [`async-caller-cancellation.z`](../examples/async/async-caller-cancellation.z) — consuming request-and-join, descendant cleanup, and deterministic native resource release |
| Scheduler-aware timers | [`async-delay.z`](../examples/async/async-delay.z) |
| Explicit native-thread work | [`thread-spawn.z`](../examples/async/thread-spawn.z) — one hot OS thread, Copy-value capture, parent progress, and explicit join; [`thread-errors.z`](../examples/async/thread-errors.z) — `Task<T, E>`, worker `throw`, `try await`, and `attempt await`; [`thread-transfer.z`](../examples/async/thread-transfer.z) — thread-local mutation of a Copy snapshot versus unique Array-owner transfer; [`thread-text.z`](../examples/async/thread-text.z) — owned String measurement, mutable TextBuffer consumption, and owned text results; [`thread-native.z`](../examples/async/thread-native.z) — `.zd`-contracted move-only C++ ownership transferred and destroyed on the worker; [`thread-native-errors.z`](../examples/async/thread-native-errors.z) — worker failure destroys a moved C++ owner before the task joins |
| Owned values across suspension | [`async-ownership.z`](../examples/async/async-ownership.z), [`async-owned-enums.z`](../examples/async/async-owned-enums.z) |
| Move-only native values across suspension | [`async-native-ownership.z`](../examples/async/async-native-ownership.z) — local ownership plus fallible return/await relay, `try`, `attempt`, direct match, and deterministic Result cleanup |
| Native-owning Z aggregates across suspension | [`async-native-aggregate.z`](../examples/async/async-native-aggregate.z) — whole-owner relay, success/failure, consuming match, cancellation cleanup, and zero leaked native values |
| Owned native async parameters | [`async-native-parameters.z`](../examples/async/async-native-parameters.z) — immediate argument transfer into hot spawned tasks for direct C++ owners and native-owning Z structs |
| Scoped immutable async borrowing | [`async-borrowing.z`](../examples/async/async-borrowing.z) — direct-await C++ borrow, two scope-bounded child borrows of one Z aggregate, post-join consumption, and zero leaked native values |
| Direct-awaited mutable borrowing | [`async-inout.z`](../examples/async/async-inout.z) — a Z struct and move-only C++ owner mutated after suspension without ownership transfer or leaked cleanup |
| Scoped spawned mutable borrowing | [`async-scoped-inout.z`](../examples/async/async-scoped-inout.z) — exclusive child mutation, independent parent work, and early owner reuse after explicit join |
| Async Slice borrowing | [`async-slices.z`](../examples/async/async-slices.z) — copied pointer/length descriptors, direct read borrowing, scoped spawned mutation, and post-join owner reuse |
| Async collection-backed Slices | [`async-collection-slices.z`](../examples/async/async-collection-slices.z) — growable and cleanup-bearing owners, cancellation-released loans, post-cancel growth, and reverse cleanup |
| Direct-awaited output initialization | [`async-out.z`](../examples/async/async-out.z) — a suspended callee initializes cleanup-free caller storage before the caller resumes |
| Async methods | [`async-methods.z`](../examples/async/async-methods.z) |

```sh
bun run z run examples/async/async-sequential.z
bun run z run examples/async/async-spawn.z
bun run z run examples/async/async-scopes.z
bun run z run examples/async/async-cancellation.z
bun run z run examples/async/async-delay.z
```

## Application-shaped probes

[`document-workspace`](../examples/applications/document-workspace) is the
recommended non-GUI application walkthrough. It uses domain-oriented names to
combine three Z modules, a move-only C++ document lease, dynamic storage, a
move-only named enum, cleanup-bearing errors, `try`/`attempt`, mutable methods,
and `Option<view DocumentSession>`. Its deterministic run ends with three saved
documents and zero live native leases. Read its adjacent
[`README.md`](../examples/applications/document-workspace/README.md) for the
scenario and an ownership-by-ownership explanation.

[`source-stager`](../examples/applications/source-stager) is the first
self-hosting-groundwork tool. It reads a source path from `process.args()`,
copies that source through `std/fs`, invokes Clang directly through
`process.run`, and handles the typed failure path without exceptions or a shell.

[`desktop-ownership`](../examples/interop/objc/desktop-ownership) combines an ARC-managed Z
application model, move-only documents and strings, borrowed enumeration, and
an AppKit shell. Its findings are recorded in
[`ownership-pressure.md`](ownership-pressure.md); it exists to pressure-test the
ownership model rather than present a finished framework API.

[`ownership-views.z`](../examples/interop/objc/desktop-ownership/ownership-views.z) compares four lookup
contracts without a GUI: a zero-copy scoped callback, an indexed receiver-tied
`view Document`, a niche-backed `Option<view Document>` lookup, and an owned
snapshot that remains valid after collection mutation.
