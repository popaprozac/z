# Z examples

Examples are grouped by the concept or native boundary they exercise. Run an
executable example from the repository root:

```sh
bun run z run examples/language/basics/first.zs
```

Use `bun run z check <path>` for type checking and `bun run z emit <path>` to
inspect the generated C-family source. The broader guided index lives in
[`docs/examples.md`](../docs/examples.md).

Directories containing `z.json` are complete projects. The repository wrapper
accepts that directory, as in the Z Notes README; a native `z` on `PATH`
supports `z check .`, `z run .`, and `z build .` from inside it. Both forms
select the named `target.entry`. Passing a `.zs` path explicitly overrides the
entry for focused smoke programs while retaining the project configuration.
[`interop/c/z-export`](interop/c/z-export) and
[`interop/c/z-shared-export`](interop/c/z-shared-export) demonstrate the same
checked Z-to-C exports as static and shared native artifacts.
[`interop/c/z-runtime-export`](interop/c/z-runtime-export) isolates generated
runtime initialization, host-thread entry, busy versus draining teardown,
join, and shutdown.

## Language

### Basics

- [`first.zs`](language/basics/first.zs): first native program and direct C call
- [`console.zs`](language/basics/console.zs): typed logging and interpolation
- [`construction.zs`](language/basics/construction.zs): struct construction and class-only `new`
- [`struct-defaults.zs`](language/basics/struct-defaults.zs) and [`optional-fields.zs`](language/basics/optional-fields.zs): independently evaluated defaults and optional-presence fields backed by `Option<T>`
- [`structs.zs`](language/basics/structs.zs), [`classes.zs`](language/basics/classes.zs), and [`constructors.zs`](language/basics/constructors.zs)
- [`mutation.zs`](language/basics/mutation.zs), [`mutable-methods.zs`](language/basics/mutable-methods.zs), and [`static-methods.zs`](language/basics/static-methods.zs)
- [`function-values.zs`](language/basics/function-values.zs) and [`closures.zs`](language/basics/closures.zs)
- [`strings.zs`](language/basics/strings.zs), [`integer-safety.zs`](language/basics/integer-safety.zs), and [`sleep.zs`](language/basics/sleep.zs)

### Control flow and errors

- [`control-flow.zs`](language/control-flow/control-flow.zs), [`conditional-expressions.zs`](language/control-flow/conditional-expressions.zs), [`loops.zs`](language/control-flow/loops.zs), [`loop-expressions.zs`](language/control-flow/loop-expressions.zs), [`iteration.zs`](language/control-flow/iteration.zs), [`custom-iterator.zs`](language/control-flow/custom-iterator.zs), [`generators.zs`](language/control-flow/generators.zs), [`generator-return.zs`](language/control-flow/generator-return.zs), and [`generator-throws.zs`](language/control-flow/generator-throws.zs)
- [`match.zs`](language/control-flow/match.zs), [`match-expression.zs`](language/control-flow/match-expression.zs), and [`enum-patterns.zs`](language/control-flow/enum-patterns.zs)
- [`result.zs`](language/control-flow/result.zs) and [`try.zs`](language/control-flow/try.zs)

### Types and collections

- [`aggregate-enums.zs`](language/types/aggregate-enums.zs), [`option.zs`](language/types/option.zs), [`generics.zs`](language/types/generics.zs), [`generic-constraints.zs`](language/types/generic-constraints.zs), and [`type-aliases/main.zs`](language/types/type-aliases/main.zs)
- [`arrays.zs`](language/collections/arrays.zs), [`slices.zs`](language/collections/slices.zs), [`dynamic-arrays.zs`](language/collections/dynamic-arrays.zs), [`dynamic-array-cleanup.zs`](language/collections/dynamic-array-cleanup.zs), [`map.zs`](language/collections/map.zs), [`map-identities.zs`](language/collections/map-identities.zs), [`map-native-values.zs`](language/collections/map-native-values.zs), and [`set.zs`](language/collections/set.zs)
- [`modules/main.zs`](language/modules/main.zs): multi-file exports and imports

### Ownership

- [`borrowed-parameters.zs`](language/ownership/borrowed-parameters.zs) and [`consuming-methods.zs`](language/ownership/consuming-methods.zs)
- [`deinit.zs`](language/ownership/deinit.zs) and [`replacement.zs`](language/ownership/replacement.zs)
- [`mutex-state.zs`](language/ownership/mutex-state.zs): blocking exclusive access through synchronous non-escaping `in` and `inout` closures
- [`local-views.zs`](language/ownership/local-views.zs): name a zero-copy field/index projection until its last use
- [`optional-views.zs`](language/ownership/optional-views.zs): zero-copy fallible lookup with `Option<view T>` and proven nonescaping inline capture
- [`arena.zs`](language/ownership/arena.zs): stable region allocation, synchronous `in` views, reset, and reverse cleanup
- [`owned-closures.zs`](language/ownership/owned-closures.zs), [`owned-enums.zs`](language/ownership/owned-enums.zs), and [`weak-references.zs`](language/ownership/weak-references.zs)

[`language/design/future.md`](language/design/future.md) contains a non-runnable
syntax sketch. It records intended language shape without claiming bootstrap
support or producing language-server diagnostics from hypothetical imports.

## Applications

- [`application-root`](applications/application-root): a concise user-defined
  mixed-affinity `Application` published through synchronized `std/sync`
  `Once<T>`, read across a module boundary, and retrieved safely from a native
  worker whose unrestricted method reads `Mutex`-protected state while its UI
  member remains main-only.
- [`zapp-skeleton`](applications/zapp-skeleton): a user-authored framework
  composition probe with global application lookup, mutex-protected state,
  dedicated worker work, and explicit result delivery to `thread.main`.
- [`zapp-appkit`](applications/zapp-appkit): the same user-owned architecture
  holding real `NSWindow` and `NSTextField` identities, with worker-safe model
  access and a native UI update explicitly placed onto `thread.main`.
- [`z-notes`](applications/z-notes): a native AppKit and SQLite application
  combining ARC state, Objective-C protocols and target/action, owned native
  handles, async loading on a dedicated worker, typed owned result transfer,
  and main-executor delivery. Its
  [`README.md`](applications/z-notes/README.md) documents the ownership domains
  and current composition boundaries.
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
  typed lexer errors, and `TextBuffer` escape decoding. Its generator scanner
  yields owned tokens, returns a typed scan summary, and fails during explicit
  advancement. The native token-stream bridge is compared directly with the
  stage-0 TypeScript lexer.
- [`project-index`](applications/project-index): an application-shaped Map/Set
  pressure test with borrowed lookup views, explicit owned snapshots, custom
  hashing, typed IO errors, and an unchanged dense-to-hashed benchmark.
- [`z-curl`](applications/z-curl): a shimless libcurl GET using an adjacent
  `.zd` for owned handles, typed native status errors, variadic options,
  callback/context lifetime, byte-slice projection, and callback-error
  narrowing.
- [`z-raylib`](applications/z-raylib): a native Raylib application exercising
  canonical C aliases, move-only by-value resources, runtime-owned borrows,
  nominal enum conversion, and reverse cleanup.
- [`z-sdl3`](applications/z-sdl3): a native SDL3 application exercising
  large-header import, owned handles, scalar output projection, nominal enum
  conversion, and deterministic shutdown.

## Async

- [`async-phase-0.zs`](async/async-phase-0.zs): overview of the implemented model
- [`async-sequential.zs`](async/async-sequential.zs), [`async-tasks.zs`](async/async-tasks.zs), [`async-scopes.zs`](async/async-scopes.zs), and [`async-scope-locals.zs`](async/async-scope-locals.zs)
- [`async-branch-expressions.zs`](async/async-branch-expressions.zs): selected-only suspension in logical, ternary, value-`if`, and loop-condition branches
- [`async-errors.zs`](async/async-errors.zs), [`async-owned-errors.zs`](async/async-owned-errors.zs), [`async-cancellation.zs`](async/async-cancellation.zs), [`async-caller-cancellation.zs`](async/async-caller-cancellation.zs), [`async-delay.zs`](async/async-delay.zs), and [`scheduler-yield.zs`](async/scheduler-yield.zs)
- [`async-aggregates.zs`](async/async-aggregates.zs), [`async-ownership.zs`](async/async-ownership.zs), and [`async-owned-enums.zs`](async/async-owned-enums.zs)
- [`async-native-ownership.zs`](async/async-native-ownership.zs): move-only C++ ownership across suspension, fallible task-result relays, `try await`, `attempt await`, and match
- [`async-native-aggregate.zs`](async/async-native-aggregate.zs): a native-owning Z value struct across suspension, fallible relay, consuming match, and deterministic aggregate/native cleanup
- [`async-match-arms.zs`](async/async-match-arms.zs): consuming owned matches whose selected arm can await, return an owned ARC result, `select`, or throw with exact payload cleanup
- [`async-native-parameters.zs`](async/async-native-parameters.zs): direct C++ and native-owning Z values transferred into hot child task frames
- [`async-borrowing.zs`](async/async-borrowing.zs): direct-await and explicit-scope child-task immutable borrows without moving the owner
- [`async-inout.zs`](async/async-inout.zs): direct-awaited mutation of a Z struct and move-only C++ owner across suspension
- [`async-scoped-inout.zs`](async/async-scoped-inout.zs): scope-bounded child-task mutation with early release after explicit join
- [`async-slices.zs`](async/async-slices.zs): direct and scope-bounded Slice borrowing over fixed-array storage
- [`async-collection-slices.zs`](async/async-collection-slices.zs): growable and cleanup-bearing Slice backing, post-cancel growth, and reverse owner cleanup
- [`async-out.zs`](async/async-out.zs): direct-awaited initialization of caller storage across suspension
- [`async-methods.zs`](async/async-methods.zs)
- [`thread-native.zs`](async/thread-native.zs): trusted `.zd` thread transfer and receiving-thread destruction for a move-only C++ owner
- [`thread-affine-worker.zs`](async/thread-affine-worker.zs): an `async` closure bound to one dedicated worker, inherited child tasks, typed failure, scheduler delay, `await on thread.main`, and resumption back on the worker
- [`foreign-thread-application-root.zs`](async/foreign-thread-application-root.zs): automatic scoped runtime entry for a `.zd` `thread any` pthread callback, synchronized `Once<Application>` access, and structured publication through `TaskScope` onto `thread.main`
- [`executor-affinity.zs`](async/executor-affinity.zs): declaration-header `on thread.main` contracts, main-isolated methods, and transitive affinity inherited through stored fields
- [`member-affinity.zs`](async/member-affinity.zs): field-level `on thread.main`, main-bound ARC lifecycle, retained `Mutex<T>` state, and unrestricted worker-safe methods on the same application identity

## Native interop

### C

- [`selective-import.zs`](interop/c/selective-import.zs), [`selective-declarations.zs`](interop/c/selective-declarations.zs), and [`foreign-types.zs`](interop/c/foreign-types.zs)
- [`foreign-pointers.zs`](interop/c/foreign-pointers.zs), [`foreign-handle.zs`](interop/c/foreign-handle.zs), and [`native-out.zs`](interop/c/native-out.zs)
- [`declared-handle.zs`](interop/c/declared-handle.zs) with its adjacent [`.zd` contract](interop/c/declared-handle.h.zd)
- [`callbacks.zs`](interop/c/callbacks.zs) with its adjacent [`.zd` contract](interop/c/callbacks.h.zd)
- [`deployment-target`](interop/c/deployment-target) and [`apple-groundwork.zs`](interop/c/apple-groundwork.zs)
- [`z-export`](interop/c/z-export), [`z-runtime-export`](interop/c/z-runtime-export), and [`z-shared-export`](interop/c/z-shared-export): checked exports and native embedding lifecycle

### C++

- [`cpp-interop.zs`](interop/cpp/cpp-interop.zs) and [`cpp-selective-interop.zs`](interop/cpp/cpp-selective-interop.zs)
- [`foreign-values.zs`](interop/cpp/foreign-values.zs) and [`cpp-callables.zs`](interop/cpp/cpp-callables.zs)
- [`cpp-move-only.zs`](interop/cpp/cpp-move-only.zs), [`cpp-move-only-array.zs`](interop/cpp/cpp-move-only-array.zs), [`cpp-move-only-enum.zs`](interop/cpp/cpp-move-only-enum.zs), [`cpp-arena.zs`](interop/cpp/cpp-arena.zs), and [`cpp-references.zs`](interop/cpp/cpp-references.zs)

### Objective-C and Swift

- [`nswindow.zs`](interop/objc/nswindow.zs), [`objc-nullability.zs`](interop/objc/objc-nullability.zs), and [`appkit-events.zs`](interop/objc/appkit-events.zs)
- [`desktop-ownership`](interop/objc/desktop-ownership): application-shaped ownership and view probes
- [`swift-interop`](interop/swift/swift-interop): Swift class through a generated Objective-C header
- [`swift-task-scope`](interop/swift/swift-task-scope): Swift global-queue callbacks through generated Objective-C blocks, `.zd` async projection, bounded Z runtime entry, synchronized application-root access, and structured publication on `thread.main`
- [`swift-value-interop`](interop/swift/swift-value-interop): Swift value and owned string return through a generated C++ header

Apple examples require macOS and Xcode Command Line Tools. Some native examples
reuse deterministic headers from [`tests/fixtures`](../tests/fixtures); those
fixtures are compiler test inputs rather than public Z declarations.
