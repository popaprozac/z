# Examples

The examples are small executable specifications for the stage-0 compiler. Run
them from the repository root with `bun run z run <path>`; use `check` for
compile-only probes and `emit` to inspect generated native code.

## Start here

| Area | Example | What it demonstrates |
| --- | --- | --- |
| First native program | [`first.z`](../examples/first.z) | Functions, inference, direct C import |
| Console and strings | [`console.z`](../examples/console.z) | Explicit standard import, interpolation, typed formatting |
| Modules | [`modules/main.z`](../examples/modules/main.z) | Exports, namespace imports, selective aliases |
| Construction | [`construction.z`](../examples/construction.z) | Struct object construction and class-only `new` |
| Results | [`result.z`](../examples/result.z) | `return`, `throw`, `attempt`, and exhaustive matching |
| Options | [`option.z`](../examples/option.z) | `Option.some`, `Option.none`, and payload matching |

```sh
bun run z run examples/first.z
bun run z run examples/construction.z
bun run z run examples/result.z
```

## Ownership and values

| Area | Examples |
| --- | --- |
| Borrow capabilities | [`borrowed-parameters.z`](../examples/borrowed-parameters.z), [`native-out.z`](../examples/native-out.z) |
| Deterministic cleanup | [`deinit.z`](../examples/deinit.z), [`replacement.z`](../examples/replacement.z), [`consuming-methods.z`](../examples/consuming-methods.z) |
| ARC and weak references | [`classes.z`](../examples/classes.z), [`weak-references.z`](../examples/weak-references.z) |
| Closures | [`closures.z`](../examples/closures.z), [`owned-closures.z`](../examples/owned-closures.z), [`function-values.z`](../examples/function-values.z) |
| Collections | [`arrays.z`](../examples/arrays.z), [`slices.z`](../examples/slices.z), [`dynamic-arrays.z`](../examples/dynamic-arrays.z) |
| Generics and traits | [`generics.z`](../examples/generics.z), [`generic-constraints.z`](../examples/generic-constraints.z) |
| Enums and matching | [`enum-patterns.z`](../examples/enum-patterns.z), [`match-expression.z`](../examples/match-expression.z), [`owned-enums.z`](../examples/owned-enums.z) |

## Native interop

| Boundary | Example | Notes |
| --- | --- | --- |
| Selective C import | [`selective-import.z`](../examples/selective-import.z) | Header declarations with local aliases |
| C records and enums | [`foreign-types.z`](../examples/foreign-types.z) | Native layouts and constants |
| C pointers | [`foreign-pointers.z`](../examples/foreign-pointers.z), [`foreign-handle.z`](../examples/foreign-handle.z) | Borrowed and owned API-note contracts |
| C callbacks | [`callbacks.z`](../examples/callbacks.z) | Call-only and escaping callback contracts |
| C++ | [`cpp-interop.z`](../examples/cpp-interop.z) | Namespace functions and plain records |
| AppKit window | [`nswindow.z`](../examples/nswindow.z) | Direct Objective-C ARC calls |
| Objective-C nullability | [`objc-nullability.z`](../examples/objc-nullability.z) | `T | null`, narrowing, and `Option.fromNullable` |
| Persistent AppKit events | [`appkit-events.z`](../examples/appkit-events.z) | Native blocks, weak capture, observer tokens |
| Swift class | [`swift-interop`](../examples/swift-interop) | Generated Objective-C compatibility header |
| Swift value | [`swift-value-interop`](../examples/swift-value-interop) | Generated C++ interface and owned value |

Apple examples require macOS and Xcode Command Line Tools. `appkit-events.z`
opens a native window and exits when that window closes.

## Async and structured concurrency

Read [`async-model.md`](async-model.md) alongside these examples:

| Shape | Example |
| --- | --- |
| Sequential await | [`async-sequential.z`](../examples/async-sequential.z) |
| Typed errors | [`async-errors.z`](../examples/async-errors.z) |
| Hot spawn and explicit join | [`async-spawn.z`](../examples/async-spawn.z) |
| Lexical task scopes | [`async-scopes.z`](../examples/async-scopes.z) |
| Cancellation | [`async-cancellation.z`](../examples/async-cancellation.z) |
| Scheduler-aware timers | [`async-delay.z`](../examples/async-delay.z) |
| Owned values across suspension | [`async-ownership.z`](../examples/async-ownership.z), [`async-owned-enums.z`](../examples/async-owned-enums.z) |
| Async methods | [`async-methods.z`](../examples/async-methods.z) |

```sh
bun run z run examples/async-sequential.z
bun run z run examples/async-spawn.z
bun run z run examples/async-scopes.z
bun run z run examples/async-cancellation.z
bun run z run examples/async-delay.z
```

## Application-shaped probes

[`desktop-ownership`](../examples/desktop-ownership) combines an ARC-managed Z
application model, move-only documents and strings, borrowed enumeration, and
an AppKit shell. Its findings are recorded in
[`ownership-pressure.md`](ownership-pressure.md); it exists to pressure-test the
ownership model rather than present a finished framework API.

[`ownership-views.z`](../examples/ownership-views.z) isolates the most important
borrow-return question without a GUI: it compares a zero-copy scoped document
callback with an owned snapshot that remains valid after workspace mutation.
