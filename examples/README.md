# Z examples

Examples are grouped by the concept or native boundary they exercise. Run an
executable example from the repository root:

```sh
bun run z run examples/language/basics/first.zs
```

Use `bun run z check <path>` for type checking and `bun run z emit <path>` to
inspect the generated C-family source. The broader guided index lives in
[`docs/examples.md`](../docs/examples.md).

## Language

### Basics

- [`first.zs`](language/basics/first.zs): first native program and direct C call
- [`console.zs`](language/basics/console.zs): typed logging and interpolation
- [`construction.zs`](language/basics/construction.zs): struct construction and class-only `new`
- [`structs.zs`](language/basics/structs.zs), [`classes.zs`](language/basics/classes.zs), and [`constructors.zs`](language/basics/constructors.zs)
- [`mutation.zs`](language/basics/mutation.zs), [`mutable-methods.zs`](language/basics/mutable-methods.zs), and [`static-methods.zs`](language/basics/static-methods.zs)
- [`function-values.zs`](language/basics/function-values.zs) and [`closures.zs`](language/basics/closures.zs)
- [`strings.zs`](language/basics/strings.zs), [`integer-safety.zs`](language/basics/integer-safety.zs), and [`sleep.zs`](language/basics/sleep.zs)

### Control flow and errors

- [`control-flow.zs`](language/control-flow/control-flow.zs), [`conditional-expressions.zs`](language/control-flow/conditional-expressions.zs), [`loops.zs`](language/control-flow/loops.zs), and [`iteration.zs`](language/control-flow/iteration.zs)
- [`match.zs`](language/control-flow/match.zs), [`match-expression.zs`](language/control-flow/match-expression.zs), and [`enum-patterns.zs`](language/control-flow/enum-patterns.zs)
- [`result.zs`](language/control-flow/result.zs) and [`try.zs`](language/control-flow/try.zs)

### Types and collections

- [`aggregate-enums.zs`](language/types/aggregate-enums.zs), [`option.zs`](language/types/option.zs), [`generics.zs`](language/types/generics.zs), and [`generic-constraints.zs`](language/types/generic-constraints.zs)
- [`arrays.zs`](language/collections/arrays.zs), [`slices.zs`](language/collections/slices.zs), [`dynamic-arrays.zs`](language/collections/dynamic-arrays.zs), and [`dynamic-array-cleanup.zs`](language/collections/dynamic-array-cleanup.zs)
- [`modules/main.zs`](language/modules/main.zs): multi-file exports and imports

### Ownership

- [`borrowed-parameters.zs`](language/ownership/borrowed-parameters.zs) and [`consuming-methods.zs`](language/ownership/consuming-methods.zs)
- [`deinit.zs`](language/ownership/deinit.zs) and [`replacement.zs`](language/ownership/replacement.zs)
- [`optional-views.zs`](language/ownership/optional-views.zs): zero-copy fallible lookup with `Option<view T>` and proven nonescaping inline capture
- [`arena.zs`](language/ownership/arena.zs): stable region allocation, synchronous `in` views, reset, and reverse cleanup
- [`owned-closures.zs`](language/ownership/owned-closures.zs), [`owned-enums.zs`](language/ownership/owned-enums.zs), and [`weak-references.zs`](language/ownership/weak-references.zs)

[`language/design/future.md`](language/design/future.md) contains a non-runnable
syntax sketch. It records intended language shape without claiming bootstrap
support or producing language-server diagnostics from hypothetical imports.

## Applications

- [`document-workspace`](applications/document-workspace): a readable,
  multi-module native application model combining document registration,
  domain errors, move-only C++ leases, dynamic arrays, optional views, saving,
  and zero-live-resource verification. Start with its
  [`README.md`](applications/document-workspace/README.md).
- [`source-stager`](applications/source-stager): a small compiler-tool-shaped
  program using `std/fs`, owned program arguments, typed OS failures, and direct
  child-process execution. Its [`README.md`](applications/source-stager/README.md)
  explains the self-hosting boundary.
- [`source-inspector`](applications/source-inspector): a multi-module source tool
  that tokenizes real Z code with checked UTF-8 byte offsets, owned token copies,
  exact parser-facing kinds, template interpolation, decimal/exponent numbers,
  typed lexer errors, and `TextBuffer` escape decoding. Its native token-stream
  bridge is compared directly with the stage-0 TypeScript lexer.

## Async

- [`async-phase-0.zs`](async/async-phase-0.zs): overview of the implemented model
- [`async-sequential.zs`](async/async-sequential.zs), [`async-spawn.zs`](async/async-spawn.zs), and [`async-scopes.zs`](async/async-scopes.zs)
- [`async-errors.zs`](async/async-errors.zs), [`async-cancellation.zs`](async/async-cancellation.zs), [`async-caller-cancellation.zs`](async/async-caller-cancellation.zs), and [`async-delay.zs`](async/async-delay.zs)
- [`async-aggregates.zs`](async/async-aggregates.zs), [`async-ownership.zs`](async/async-ownership.zs), and [`async-owned-enums.zs`](async/async-owned-enums.zs)
- [`async-native-ownership.zs`](async/async-native-ownership.zs): move-only C++ ownership across suspension, fallible task-result relays, `try await`, `attempt await`, and match
- [`async-native-aggregate.zs`](async/async-native-aggregate.zs): a native-owning Z value struct across suspension, fallible relay, consuming match, and deterministic aggregate/native cleanup
- [`async-native-parameters.zs`](async/async-native-parameters.zs): direct C++ and native-owning Z values transferred into hot spawned task frames
- [`async-borrowing.zs`](async/async-borrowing.zs): direct-await and explicit-scope spawned immutable borrows without moving the owner
- [`async-inout.zs`](async/async-inout.zs): direct-awaited mutation of a Z struct and move-only C++ owner across suspension
- [`async-scoped-inout.zs`](async/async-scoped-inout.zs): scope-bounded spawned mutation with early release after explicit join
- [`async-slices.zs`](async/async-slices.zs): direct and scope-bounded Slice borrowing over fixed-array storage
- [`async-collection-slices.zs`](async/async-collection-slices.zs): growable and cleanup-bearing Slice backing, post-cancel growth, and reverse owner cleanup
- [`async-out.zs`](async/async-out.zs): direct-awaited initialization of caller storage across suspension
- [`async-methods.zs`](async/async-methods.zs)
- [`thread-native.zs`](async/thread-native.zs): trusted `.zd` thread transfer and receiving-thread destruction for a move-only C++ owner

## Native interop

### C

- [`selective-import.zs`](interop/c/selective-import.zs), [`selective-declarations.zs`](interop/c/selective-declarations.zs), and [`foreign-types.zs`](interop/c/foreign-types.zs)
- [`foreign-pointers.zs`](interop/c/foreign-pointers.zs), [`foreign-handle.zs`](interop/c/foreign-handle.zs), and [`native-out.zs`](interop/c/native-out.zs)
- [`declared-handle.zs`](interop/c/declared-handle.zs) with its adjacent [`.zd` contract](interop/c/declared-handle.h.zd)
- [`callbacks.zs`](interop/c/callbacks.zs) with its adjacent [`.zd` contract](interop/c/callbacks.h.zd)
- [`deployment-target`](interop/c/deployment-target) and [`apple-groundwork.zs`](interop/c/apple-groundwork.zs)

### C++

- [`cpp-interop.zs`](interop/cpp/cpp-interop.zs) and [`cpp-selective-interop.zs`](interop/cpp/cpp-selective-interop.zs)
- [`foreign-values.zs`](interop/cpp/foreign-values.zs) and [`cpp-callables.zs`](interop/cpp/cpp-callables.zs)
- [`cpp-move-only.zs`](interop/cpp/cpp-move-only.zs), [`cpp-move-only-array.zs`](interop/cpp/cpp-move-only-array.zs), [`cpp-move-only-enum.zs`](interop/cpp/cpp-move-only-enum.zs), [`cpp-arena.zs`](interop/cpp/cpp-arena.zs), and [`cpp-references.zs`](interop/cpp/cpp-references.zs)

### Objective-C and Swift

- [`nswindow.zs`](interop/objc/nswindow.zs), [`objc-nullability.zs`](interop/objc/objc-nullability.zs), and [`appkit-events.zs`](interop/objc/appkit-events.zs)
- [`desktop-ownership`](interop/objc/desktop-ownership): application-shaped ownership and view probes
- [`swift-interop`](interop/swift/swift-interop): Swift class through a generated Objective-C header
- [`swift-value-interop`](interop/swift/swift-value-interop): Swift value and owned string return through a generated C++ header

Apple examples require macOS and Xcode Command Line Tools. Some native examples
reuse deterministic headers from [`tests/fixtures`](../tests/fixtures); those
fixtures are compiler test inputs rather than public Z declarations.
