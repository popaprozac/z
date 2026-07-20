# Z examples

Examples are grouped by the concept or native boundary they exercise. Run an
executable example from the repository root:

```sh
bun run z run examples/language/basics/first.z
```

Use `bun run z check <path>` for type checking and `bun run z emit <path>` to
inspect the generated C-family source. The broader guided index lives in
[`docs/examples.md`](../docs/examples.md).

## Language

### Basics

- [`first.z`](language/basics/first.z): first native program and direct C call
- [`console.z`](language/basics/console.z): typed logging and interpolation
- [`construction.z`](language/basics/construction.z): struct construction and class-only `new`
- [`structs.z`](language/basics/structs.z), [`classes.z`](language/basics/classes.z), and [`constructors.z`](language/basics/constructors.z)
- [`mutation.z`](language/basics/mutation.z), [`mutable-methods.z`](language/basics/mutable-methods.z), and [`static-methods.z`](language/basics/static-methods.z)
- [`function-values.z`](language/basics/function-values.z) and [`closures.z`](language/basics/closures.z)
- [`strings.z`](language/basics/strings.z), [`integer-safety.z`](language/basics/integer-safety.z), and [`sleep.z`](language/basics/sleep.z)

### Control flow and errors

- [`control-flow.z`](language/control-flow/control-flow.z), [`conditional-expressions.z`](language/control-flow/conditional-expressions.z), [`loops.z`](language/control-flow/loops.z), and [`iteration.z`](language/control-flow/iteration.z)
- [`match.z`](language/control-flow/match.z), [`match-expression.z`](language/control-flow/match-expression.z), and [`enum-patterns.z`](language/control-flow/enum-patterns.z)
- [`result.z`](language/control-flow/result.z) and [`try.z`](language/control-flow/try.z)

### Types and collections

- [`aggregate-enums.z`](language/types/aggregate-enums.z), [`option.z`](language/types/option.z), [`generics.z`](language/types/generics.z), and [`generic-constraints.z`](language/types/generic-constraints.z)
- [`arrays.z`](language/collections/arrays.z), [`slices.z`](language/collections/slices.z), [`dynamic-arrays.z`](language/collections/dynamic-arrays.z), and [`dynamic-array-cleanup.z`](language/collections/dynamic-array-cleanup.z)
- [`modules/main.z`](language/modules/main.z): multi-file exports and imports

### Ownership

- [`borrowed-parameters.z`](language/ownership/borrowed-parameters.z) and [`consuming-methods.z`](language/ownership/consuming-methods.z)
- [`deinit.z`](language/ownership/deinit.z) and [`replacement.z`](language/ownership/replacement.z)
- [`optional-views.z`](language/ownership/optional-views.z): zero-copy fallible lookup with `Option<view T>`
- [`owned-closures.z`](language/ownership/owned-closures.z), [`owned-enums.z`](language/ownership/owned-enums.z), and [`weak-references.z`](language/ownership/weak-references.z)

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
  typed lexer errors, and `TextBuffer` escape decoding.

## Async

- [`async-phase-0.z`](async/async-phase-0.z): overview of the implemented model
- [`async-sequential.z`](async/async-sequential.z), [`async-spawn.z`](async/async-spawn.z), and [`async-scopes.z`](async/async-scopes.z)
- [`async-errors.z`](async/async-errors.z), [`async-cancellation.z`](async/async-cancellation.z), [`async-caller-cancellation.z`](async/async-caller-cancellation.z), and [`async-delay.z`](async/async-delay.z)
- [`async-aggregates.z`](async/async-aggregates.z), [`async-ownership.z`](async/async-ownership.z), and [`async-owned-enums.z`](async/async-owned-enums.z)
- [`async-native-ownership.z`](async/async-native-ownership.z): move-only C++ ownership across suspension, fallible task-result relays, `try await`, `attempt await`, and match
- [`async-native-aggregate.z`](async/async-native-aggregate.z): a native-owning Z value struct across suspension, fallible relay, consuming match, and deterministic aggregate/native cleanup
- [`async-native-parameters.z`](async/async-native-parameters.z): direct C++ and native-owning Z values transferred into hot spawned task frames
- [`async-borrowing.z`](async/async-borrowing.z): direct-await and explicit-scope spawned immutable borrows without moving the owner
- [`async-inout.z`](async/async-inout.z): direct-awaited mutation of a Z struct and move-only C++ owner across suspension
- [`async-scoped-inout.z`](async/async-scoped-inout.z): scope-bounded spawned mutation with early release after explicit join
- [`async-out.z`](async/async-out.z): direct-awaited initialization of caller storage across suspension
- [`async-methods.z`](async/async-methods.z)

## Native interop

### C

- [`selective-import.z`](interop/c/selective-import.z), [`selective-declarations.z`](interop/c/selective-declarations.z), and [`foreign-types.z`](interop/c/foreign-types.z)
- [`foreign-pointers.z`](interop/c/foreign-pointers.z), [`foreign-handle.z`](interop/c/foreign-handle.z), and [`native-out.z`](interop/c/native-out.z)
- [`declared-handle.z`](interop/c/declared-handle.z) with its adjacent [`.zd` contract](interop/c/declared-handle.h.zd)
- [`callbacks.z`](interop/c/callbacks.z) with its adjacent [`.zd` contract](interop/c/callbacks.h.zd)
- [`deployment-target`](interop/c/deployment-target) and [`apple-groundwork.z`](interop/c/apple-groundwork.z)

### C++

- [`cpp-interop.z`](interop/cpp/cpp-interop.z) and [`cpp-selective-interop.z`](interop/cpp/cpp-selective-interop.z)
- [`foreign-values.z`](interop/cpp/foreign-values.z) and [`cpp-callables.z`](interop/cpp/cpp-callables.z)
- [`cpp-move-only.z`](interop/cpp/cpp-move-only.z), [`cpp-move-only-array.z`](interop/cpp/cpp-move-only-array.z), [`cpp-move-only-enum.z`](interop/cpp/cpp-move-only-enum.z), and [`cpp-references.z`](interop/cpp/cpp-references.z)

### Objective-C and Swift

- [`nswindow.z`](interop/objc/nswindow.z), [`objc-nullability.z`](interop/objc/objc-nullability.z), and [`appkit-events.z`](interop/objc/appkit-events.z)
- [`desktop-ownership`](interop/objc/desktop-ownership): application-shaped ownership and view probes
- [`swift-interop`](interop/swift/swift-interop): Swift class through a generated Objective-C header
- [`swift-value-interop`](interop/swift/swift-value-interop): Swift value and owned string return through a generated C++ header

Apple examples require macOS and Xcode Command Line Tools. Some native examples
reuse deterministic headers from [`tests/fixtures`](../tests/fixtures); those
fixtures are compiler test inputs rather than public Z declarations.
