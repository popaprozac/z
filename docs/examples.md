# Examples

The examples are executable specifications for Z's implemented surface. Stage
0 accepts the complete currently implemented language; the fixed-point native
compiler accepts the documented self-hosting subset. Run examples from the
repository root with `bun run z run <path>`; use `check` for compile-only probes
and `emit` to inspect generated native code.

Applications and interop probes with `z.json` are also runnable as projects.
The repository wrapper accepts the directory, while a native `z` on `PATH`
supports `z check .`, `z run .`, and `z build .` from inside it. The manifest's
required `target.name` and `target.entry` select the artifact and entry module.
An explicit `.zs` path remains the entry override for a project's alternate
smoke programs.

## Start here

| Area | Example | What it demonstrates |
| --- | --- | --- |
| First native program | [`first.zs`](../examples/language/basics/first.zs) | Functions, inference, direct C import |
| Console and strings | [`console.zs`](../examples/language/basics/console.zs) | Explicit standard import, interpolation, typed formatting |
| Numeric conversion | [`numeric-conversions.zs`](../examples/language/basics/numeric-conversions.zs) | Explicit target-type construction, check-free widening, and checked narrowing/native-width adaptation |
| Modules | [`modules/main.zs`](../examples/language/modules/main.zs) | Functions, types, and immutable configuration values through namespace imports and selective aliases |
| Construction | [`construction.zs`](../examples/language/basics/construction.zs) | Struct object construction and class-only `new` |
| Struct defaults | [`struct-defaults.zs`](../examples/language/basics/struct-defaults.zs) | Independent field defaults, `Type()`, explicit empty construction, and partial overrides |
| Struct spread | [`struct-spread.zs`](../examples/language/basics/struct-spread.zs) | Same-type derivation, explicit copy/move capability, later overrides, default suppression, and whole-source transfer |
| Optional struct fields | [`optional-fields.zs`](../examples/language/basics/optional-fields.zs) | Optional presence with `field?: T`, contextual `some` lifting, explicit `Option<T>`, and cleanup-bearing payloads |
| Optional chaining | [`optional-chaining.zs`](../examples/language/basics/optional-chaining.zs) | Conditional field/method access, flat `Option` results, borrowed stored fields, owned results, void no-op, and preserved typed errors |
| Object destructuring | [`destructuring.zs`](../examples/language/basics/destructuring.zs) | Local field/alias patterns, explicit copy/move ownership, and borrowed Map-entry patterns |
| Array destructuring | [`array-destructuring.zs`](../examples/language/basics/array-destructuring.zs) | Checked positional reads, explicit `_` discards, cleanup-bearing element views, and zero-allocation `Slice<T>` rest |
| Transparent type aliases | [`type-aliases/main.zs`](../examples/language/types/type-aliases/main.zs) | Exported callback alias, selective import, unchanged native function-value representation, and editor navigation |
| Results | [`result.zs`](../examples/language/control-flow/result.zs) | `return`, `throw`, `attempt`, and exhaustive matching |
| Value-producing loops | [`loop-expressions.zs`](../examples/language/control-flow/loop-expressions.zs) | `select` from `for...of` and `while`, required exhaustion `else`, and expression typing |
| Custom iteration | [`custom-iterator.zs`](../examples/language/control-flow/custom-iterator.zs) | Generic `Iterator<T>`, explicit stored-iterator mutation, owned yielded values, and temporary iterators |
| Generators | [`generators.zs`](../examples/language/control-flow/generators.zs) | Cold `Generator<T>` frames, `yield`, hidden cursor mutation, and ordinary `for...of` consumption |
| Generator completion | [`generator-return.zs`](../examples/language/control-flow/generator-return.zs) | Explicit terminal `return`, `GeneratorStep<Yield, Return>`, and lossless manual advancement |
| Throwing generators | [`generator-throws.zs`](../examples/language/control-flow/generator-throws.zs) | Cold non-throwing construction with explicit fallible advancement and cleanup |
| Async generators | [`async-generators.zs`](../examples/language/control-flow/async-generators.zs) | Cold `AsyncGenerator<Yield, Return>` construction, awaited `.next()`, suspension between yields, and terminal return |
| Async iteration | [`async-for-await.zs`](../examples/language/control-flow/async-for-await.zs) | Sequential `for await...of`, temporary-stream ownership, early break, and stored-handle resumption |
| Throwing async iteration | [`async-for-await-errors.zs`](../examples/language/control-flow/async-for-await-errors.zs) | Explicit `try for await`, typed advancement-error propagation, and stream cleanup |
| Async iteration patterns | [`async-for-await-destructuring.zs`](../examples/language/control-flow/async-for-await-destructuring.zs) | Owned field transfer, aliases, suspension, explicit moves, and cleanup of unselected fields |
| Async event stream | [`async-event-stream.zs`](../examples/language/control-flow/async-event-stream.zs) | Owned input records, persistent connection/collection loops, borrowed enum matching, typed errors, yielded events, and terminal summary |
| Options | [`option.zs`](../examples/language/types/option.zs) | `Option.some`, `Option.none`, and payload matching |
| Native desktop application | [`z-notes`](../examples/applications/z-notes) | AppKit controls, `std/objc` target/action, ARC application state, nullable selection, direct SQLite import, async dedicated-worker loading with owned result transfer, main-executor delivery, and native library linkage |
| Shimless libcurl pressure test | [`z-curl`](../examples/applications/z-curl) | Qualified system-header import, flat adjacent `.zd`, anonymous native enums, expression macros, enum-backed typed errors, fixed global flags, deterministic `CURL *` cleanup, checked option-dependent variadics, owner-tied callback/context installation, byte-slice projection, and thrown callback-error narrowing |
| Raylib application | [`z-raylib`](../examples/applications/z-raylib) | Shimless checked C slice, nominal enum conversion, interactive drawing, canonical alias-aware `Image`/`Texture2D` value resources, reverse deterministic cleanup, and a non-escaping runtime-owned texture borrow |
| SDL3 application | [`z-sdl3`](../examples/applications/z-sdl3) | Large-header import, owned native handles, scalar `out` projection, interactive rendering, reverse-order cleanup, and a conventional `SDL_PollEvent(out event)` loop with checked allocation-free discriminated-union matching |
| SDL3 interop comparison | [`comparisons/sdl3`](../examples/comparisons/sdl3) | The same interactive application in Z, C, Zig, Nim, and raw-binding Rust, comparing declaration acquisition, ownership proof, union/output handling, unsafe surface, and build configuration |
| Application lifetime root | [`application-root`](../examples/applications/application-root) | A user-defined mixed-affinity ARC application published through `Once<Application>`, retrieved synchronously on a native worker, read through `Mutex`-protected state while its UI member stays main-only, and removed by deterministic guard cleanup |
| Framework composition | [`zapp-skeleton`](../examples/applications/zapp-skeleton) | A user-owned Application API with synchronized global lookup, mutex-backed worker state, async dedicated-thread work, and explicit delivery back to `thread.main` |
| AppKit framework composition | [`zapp-appkit`](../examples/applications/zapp-appkit) | Real AppKit identity plus one mutable-build/deeply-readonly handler router shared by a target/action callback and native worker, stored in a mixed-affinity root and updated through explicit main-executor placement |
| Scoped shared state | [`mutex-state.zs`](../examples/language/ownership/mutex-state.zs) | A deployment coordinator whose counters are protected by `Mutex<T>` through non-escaping `in` and `inout` critical-section closures |
| Concurrent handler router | [`thread-any-callables.zs`](../examples/language/concurrency/thread-any-callables.zs) | `on thread.any` named and capturing handlers, a frozen function-valued Map, atomic closure ownership, deeply readonly ARC publication, and native-worker invocation |
| Application walkthrough | [`document-workspace`](../examples/applications/document-workspace) | A native document model combining modules, errors, arrays, named enums, optional views, mutation, and deterministic cleanup |
| Collection pressure test | [`project-index`](../examples/applications/project-index) | Borrowed Map lookups, owned snapshots, dirty-path Sets, typed IO errors, and an unchanged dense-to-hashed benchmark |
| Self-hosting groundwork | [`source-stager`](../examples/applications/source-stager) | File IO, owned argv, typed OS failures, and direct no-shell child launch |
| Stage-1 Z frontend | [`compiler/frontend`](../compiler/frontend) | Checked UTF-8 tokens, owned flat AST shapes, native module graphs, self-parsing, and exact stage-0 parity |
| Frontend client | [`source-inspector`](../examples/applications/source-inspector) | Readable scanner, natural yielding `for...of`, fallible generator token stream with terminal summary, smoke tests, and standalone protocol clients |

```sh
bun run z run examples/language/basics/first.zs
bun run z run examples/language/basics/construction.zs
bun run z run examples/language/control-flow/result.zs
```

## Ownership and values

| Area | Examples |
| --- | --- |
| Borrow capabilities | [`borrowed-parameters.zs`](../examples/language/ownership/borrowed-parameters.zs), [`native-out.zs`](../examples/interop/c/native-out.zs) |
| Explicit duplication and transfer | [`copy-move.zs`](../examples/language/ownership/copy-move.zs) |
| Local/receiver/parameter-tied views and regions | [`local-views.zs`](../examples/language/ownership/local-views.zs), [`parameter-views.zs`](../examples/language/ownership/parameter-views.zs), [`optional-views.zs`](../examples/language/ownership/optional-views.zs), [`arena.zs`](../examples/language/ownership/arena.zs), [`ownership-views.zs`](../examples/interop/objc/desktop-ownership/ownership-views.zs), [`ownership-boundaries.zs`](../examples/interop/objc/desktop-ownership/ownership-boundaries.zs) |
| Deterministic cleanup | [`deinit.zs`](../examples/language/ownership/deinit.zs), [`replacement.zs`](../examples/language/ownership/replacement.zs), [`consuming-methods.zs`](../examples/language/ownership/consuming-methods.zs) |
| Scoped shared mutation | [`mutex-state.zs`](../examples/language/ownership/mutex-state.zs) |
| ARC and weak references | [`classes.zs`](../examples/language/basics/classes.zs), [`weak-references.zs`](../examples/language/ownership/weak-references.zs) |
| Closures | [`closures.zs`](../examples/language/basics/closures.zs), [`owned-closures.zs`](../examples/language/ownership/owned-closures.zs), [`function-values.zs`](../examples/language/basics/function-values.zs), [`throwing-function-values.zs`](../examples/language/basics/throwing-function-values.zs), [`thread-any-callables.zs`](../examples/language/concurrency/thread-any-callables.zs) |
| Collections | [`arrays.zs`](../examples/language/collections/arrays.zs), [`slices.zs`](../examples/language/collections/slices.zs), [`dynamic-arrays.zs`](../examples/language/collections/dynamic-arrays.zs), [`map.zs`](../examples/language/collections/map.zs), [`set.zs`](../examples/language/collections/set.zs), [`custom-hash.zs`](../examples/language/collections/custom-hash.zs), [`destructuring.zs`](../examples/language/basics/destructuring.zs) |
| Generics, traits, and aliases | [`generics.zs`](../examples/language/types/generics.zs), [`generic-constraints.zs`](../examples/language/types/generic-constraints.zs), [`type-aliases/main.zs`](../examples/language/types/type-aliases/main.zs), [`custom-iterator.zs`](../examples/language/control-flow/custom-iterator.zs) |
| Enums and matching | [`enum-patterns.zs`](../examples/language/control-flow/enum-patterns.zs), [`match-expression.zs`](../examples/language/control-flow/match-expression.zs), [`owned-enums.zs`](../examples/language/ownership/owned-enums.zs) |

## Native interop

| Boundary | Example | Notes |
| --- | --- | --- |
| Z library called from C | [`z-export`](../examples/interop/c/z-export) | Scalar, `c struct`, and fixed-representation `c enum` exports; generated guarded header/static archive; ordinary Z-to-Z calls; and a handwritten strict-C consumer |
| Z runtime embedded by C | [`z-runtime-export`](../examples/interop/c/z-runtime-export) | A main-bound `Once` root owned by generated initialize/shutdown, pthread retrieval and `Mutex` mutation through exported calls, rejected main-only access, deterministic `busy` teardown, and exactly-once `deinit` |
| Shared Z library called from C | [`z-shared-export`](../examples/interop/c/z-shared-export) | The same checked C export boundary published as a host-native dynamic library plus generated header |
| Selective C import | [`selective-import.zs`](../examples/interop/c/selective-import.zs) | Header declarations with local aliases |
| C records and enums | [`foreign-types.zs`](../examples/interop/c/foreign-types.zs) | Native layouts and constants |
| C enum conversion | [`foreign-enum-conversion.zs`](../examples/interop/c/foreign-enum-conversion.zs) | Explicit nominal-enum extraction through checked integer construction |
| C union output | [`native-union.zs`](../examples/interop/c/native-union.zs) | ABI-preserving `out` initialization plus checked borrowed matching over contracted tag and payload members |
| C scalar pointers | [`scalar-pointers.zs`](../examples/interop/c/scalar-pointers.zs) | `.zd`-checked `in`, `inout`, and definitely initialized `out` scalar storage |
| Raw native boundary | [`native-boundary.zs`](../examples/interop/raw/native-boundary.zs) | Isolated anonymous C helper with `in` / `inout` / `out`, definite output initialization, and a whole-function `= raw c` body |
| C pointers | [`foreign-pointers.zs`](../examples/interop/c/foreign-pointers.zs), [`foreign-handle.zs`](../examples/interop/c/foreign-handle.zs) | Borrowed and owned `.zd` contracts |
| Z declaration contract | [`declared-handle.zs`](../examples/interop/c/declared-handle.zs), [`declared-handle.h.zd`](../examples/interop/c/declared-handle.h.zd) | Adjacent `.zd` capabilities, niche-backed `Option.fromNullable`, borrowed/consuming match, and `deinit` release |
| C callbacks | [`callbacks.zs`](../examples/interop/c/callbacks.zs), [`callbacks.h.zd`](../examples/interop/c/callbacks.h.zd) | `.zd` call-only borrowing plus escaping ownership, named context/release pairing, and caller-thread guarantees |
| Cross-thread C callback | [`cross-thread-callback`](../examples/interop/c/cross-thread-callback) | `thread any` contract, pthread invocation, atomic closure ownership, and deeply readonly ARC capture |
| Deployment target | [`deployment-target`](../examples/interop/c/deployment-target) | Explicit macOS minimum version, Clang/Swift target propagation, and Z-native deprecation warnings |
| C++ | [`cpp-interop.zs`](../examples/interop/cpp/cpp-interop.zs), [`cpp-selective-interop.zs`](../examples/interop/cpp/cpp-selective-interop.zs) | Qualified and selective namespace imports, aliases, overloads, and records |
| C++ lifecycle value | [`foreign-values.zs`](../examples/interop/cpp/foreign-values.zs), [`cpp-callables.zs`](../examples/interop/cpp/cpp-callables.zs), [`foreign-values.hpp.zd`](../tests/fixtures/foreign-values.hpp.zd) | `.zd` copy/deinit contract, native aggregate copies, constructors, static/const/mutable methods, overloads, and deterministic RAII destruction |
| C++ move-only value | [`cpp-move-only.zs`](../examples/interop/cpp/cpp-move-only.zs), [`move-only.hpp.zd`](../tests/fixtures/move-only.hpp.zd) | `.zd` move/deinit contract, `in` borrow, owned calls/returns, whole-struct moves, use-after-move diagnostics, and deterministic native destruction |
| C++ move-only storage | [`cpp-move-only-array.zs`](../examples/interop/cpp/cpp-move-only-array.zs), [`cpp-move-only-enum.zs`](../examples/interop/cpp/cpp-move-only-enum.zs) | Native move construction during dynamic-array growth, reverse destruction, named enum payload borrowing/consumption/replacement, and mixed Z/native cleanup |
| C++ arena storage | [`cpp-arena.zs`](../examples/interop/cpp/cpp-arena.zs) | Stable region views over move-only C++ values and destructor-driven reset to zero live resources |
| C++ references | [`cpp-references.zs`](../examples/interop/cpp/cpp-references.zs) | `const T&`, `T&`, move-only `T&&`, and receiver-qualified methods mapped onto existing Z capabilities with no wrapper overhead |
| AppKit window | [`nswindow.zs`](../examples/interop/objc/nswindow.zs) | Direct Objective-C ARC calls |
| Objective-C nullability | [`objc-nullability.zs`](../examples/interop/objc/objc-nullability.zs) | `T | null`, narrowing, and `Option.fromNullable` |
| Objective-C protocols | [`protocol-conformance.zs`](../examples/interop/objc/protocol-conformance.zs) | Z class conformance, checked selectors, generated adapter, and `objc.bind` lifetime |
| Persistent AppKit events | [`appkit-events.zs`](../examples/interop/objc/appkit-events.zs) | Native blocks, weak capture, observer tokens |
| AppKit target/action | [`target-action.zs`](../examples/interop/objc/target-action.zs) | `std/objc` connection owns the control and Z closure for an explicit safe lifetime |
| Swift class | [`swift-interop`](../examples/interop/swift/swift-interop) | Generated Objective-C compatibility header |
| Swift callback-to-async | [`swift-task-scope`](../examples/interop/swift/swift-task-scope) | Generated Objective-C block, qualified `.zd` `thread any`, infallible and value/error `async completion` contracts, synthesized `Task<T, E>`, safe cancellation wait, a native worker awaiting a real Swift `@MainActor` operation, and a raw global-queue callback retrieving `Once<Application>` before structured publication through `thread.main` |
| Swift value | [`swift-value-interop`](../examples/interop/swift/swift-value-interop) | Generated C++ methods, owned aggregate storage, and exact explicit `String` return copies |
| Swift enum | [`swift-enum-interop`](../examples/interop/swift/swift-enum-interop) | Direct generated associated-value case factories, owned copies, methods, and cleanup |

Apple examples require macOS and Xcode Command Line Tools. `appkit-events.zs`
opens a native window and exits when that window closes.

## Async and structured concurrency

Read [`async-model.md`](async-model.md) alongside these examples:

| Shape | Example |
| --- | --- |
| Model overview | [`async-overview.zs`](../examples/async/async-overview.zs) — typed outcomes, sequential await, a hot child task, lexical scope join, and awaited conditions |
| Sequential await | [`async-sequential.zs`](../examples/async/async-sequential.zs) |
| Typed errors | [`async-errors.zs`](../examples/async/async-errors.zs) |
| Cleanup-bearing async errors | [`async-owned-errors.zs`](../examples/async/async-owned-errors.zs) — owned String error fields across observation, propagation, completed discard, and cancellation |
| Hot task and explicit join | [`async-tasks.zs`](../examples/async/async-tasks.zs) |
| Lexical task scopes | [`async-scopes.zs`](../examples/async/async-scopes.zs) |
| Scope-local ownership and child borrows | [`async-scope-locals.zs`](../examples/async/async-scope-locals.zs) |
| Lazy branch suspension | [`async-branch-expressions.zs`](../examples/async/async-branch-expressions.zs) — selected-only `&&`, `||`, ternary, value-`if`, and loop-condition awaits |
| Native callback task scopes | [`task-scope-native-callback.zs`](../examples/async/task-scope-native-callback.zs) — `thread any` C callback submission through named `TaskScope` ownership onto the main executor, including an async submitted root that owns and awaits a dedicated worker |
| Foreign-thread application root | [`foreign-thread-application-root.zs`](../examples/async/foreign-thread-application-root.zs) — automatic bounded runtime entry for a pthread callback, synchronized retrieval of a mixed-affinity `Once<Application>`, and structured main-executor publication |
| Cancellation | [`async-cancellation.zs`](../examples/async/async-cancellation.zs) |
| Caller-driven cancellation | [`async-caller-cancellation.zs`](../examples/async/async-caller-cancellation.zs) — consuming request-and-join, descendant cleanup, and deterministic native resource release |
| Scheduler-aware timers | [`async-delay.zs`](../examples/async/async-delay.zs) |
| Cooperative executor scheduling | [`scheduler-yield.zs`](../examples/async/scheduler-yield.zs) — timer-free interleaving and an explicit cancellation-observation point on the current executor |
| Main-thread placement | [`executor-placement.zs`](../examples/async/executor-placement.zs) — flattened direct calls plus hop-and-wait and structured main children; [`thread-main-placement.zs`](../examples/async/thread-main-placement.zs) — deadlock-free native-worker handoff with a copied value; [`thread-main-loop.zs`](../examples/async/thread-main-loop.zs) — a main-isolated suspending `while` whose synchronous publication segments run on main while the worker owns cancellable waits and repetition; [`appkit-main-result.zs`](../examples/async/appkit-main-result.zs) — an owned worker String published through ARC-retained AppKit identity; [`darwin-main-run-loop.zs`](../examples/async/darwin-main-run-loop.zs) — CFRunLoop wakeup and execution on the actual Darwin main loop |
| Explicit native-thread work | [`thread-spawn.zs`](../examples/async/thread-spawn.zs) — one hot OS thread, Copy-value capture, nonblocking await, concurrent FIFO timer progress, and explicit join; [`thread-affine-worker.zs`](../examples/async/thread-affine-worker.zs) — an async closure on a private worker executor, inherited child tasks, typed failure, delay, main-executor hop, and exact-worker resumption; [`thread-errors.zs`](../examples/async/thread-errors.zs) — owned `Task<T, E>` errors, bound/direct worker `try`, local `attempt`, propagation, and matching; [`thread-transfer.zs`](../examples/async/thread-transfer.zs) — thread-local mutation of a Copy snapshot versus unique Array-owner transfer; [`thread-text.zs`](../examples/async/thread-text.zs) — owned String measurement, mutable TextBuffer consumption, and owned text results; [`thread-native.zs`](../examples/async/thread-native.zs) — `.zd`-contracted move-only C++ ownership transferred and destroyed on the worker; [`thread-native-errors.zs`](../examples/async/thread-native-errors.zs) — worker failure destroys a moved C++ owner before the task joins |
| Owned values across suspension | [`async-ownership.zs`](../examples/async/async-ownership.zs), [`async-owned-enums.zs`](../examples/async/async-owned-enums.zs) |
| Move-only native values across suspension | [`async-native-ownership.zs`](../examples/async/async-native-ownership.zs) — local ownership plus fallible return/await relay, `try`, `attempt`, direct match, and deterministic Result cleanup |
| Native-owning Z aggregates across suspension | [`async-native-aggregate.zs`](../examples/async/async-native-aggregate.zs) — whole-owner relay, success/failure, consuming match, cancellation cleanup, and zero leaked native values |
| Owned native async parameters | [`async-native-parameters.zs`](../examples/async/async-native-parameters.zs) — immediate argument transfer into hot child tasks for direct C++ owners and native-owning Z structs |
| Scoped immutable async borrowing | [`async-borrowing.zs`](../examples/async/async-borrowing.zs) — direct-await C++ borrow, two scope-bounded child borrows of one Z aggregate, post-join consumption, and zero leaked native values |
| Direct-awaited mutable borrowing | [`async-inout.zs`](../examples/async/async-inout.zs) — a Z struct and move-only C++ owner mutated after suspension without ownership transfer or leaked cleanup |
| Scoped child-task mutable borrowing | [`async-scoped-inout.zs`](../examples/async/async-scoped-inout.zs) — exclusive child mutation, independent parent work, and early owner reuse after explicit join |
| Async Slice borrowing | [`async-slices.zs`](../examples/async/async-slices.zs) — copied pointer/length descriptors, direct read borrowing, scoped child-task mutation, and post-join owner reuse |
| Async collection-backed Slices | [`async-collection-slices.zs`](../examples/async/async-collection-slices.zs) — growable and cleanup-bearing owners, cancellation-released loans, post-cancel growth, and reverse cleanup |
| Direct-awaited output initialization | [`async-out.zs`](../examples/async/async-out.zs) — a suspended callee initializes cleanup-free caller storage before the caller resumes |
| Async methods | [`async-methods.zs`](../examples/async/async-methods.zs) |

```sh
bun run z run examples/async/async-sequential.zs
bun run z run examples/async/async-tasks.zs
bun run z run examples/async/async-scopes.zs
bun run z run examples/async/async-cancellation.zs
bun run z run examples/async/async-delay.zs
```

## Application-shaped probes

[`application-root`](../examples/applications/application-root) isolates the
generic module-owned identity mechanism behind the desktop-framework discussion.
Its `Application` class is user code. A statically empty `Once<Application>`
publishes one strong main-lifecycle ARC root, another source module reads it
through an ordinary exported function, and a native worker retrieves the same
identity directly. The worker can call its unrestricted mutex-backed method but
cannot touch the main-only UI member. The move-only lifetime guard removes the
root deterministically when `main` exits.

[`z-notes`](../examples/applications/z-notes) is the native desktop composition
probe. It opens an AppKit window, owns notes in an ARC-managed Z model,
represents selection with `Option<usize>`, and wires an interactive Add Note
button through the explicit `std/objc` target/action adapter. The rest of the
control and window surface comes directly from AppKit headers. It imports
`sqlite3.h` directly, selects the SQLite system library in `z.json`, and uses
an adjacent `.zd` contract to classify owned database and prepared-statement
outputs without a handwritten wrapper. One ARC-managed `NoteDatabase` stores
the source-nameable `sqlite.sqlite3` owner, reuses the connection for loading
and insertion, and closes it at final release. SQLite column text is a nullable
`view cstring` tied to its statement, narrowed, and copied into owned Z
`String` storage. Editable AppKit title/body fields become owned Z strings and
are persisted through placeholder binding; a declaration-only
`fixed SQLITE_TRANSIENT` parameter safely supplies SQLite's hidden destructor
sentinel at the C ABI boundary. SQLite zero-success status calls project into
`void throws i32`, while `sqlite3_step` remains raw for its ROW/DONE outcomes.
Those outcomes use typed `SQLITE_ROW` and `SQLITE_DONE` macros imported directly
from the system header rather than application-owned numeric copies.
Loaded and newly inserted notes render through
directly imported `NSScrollView`/`NSTextView` controls, with `TextBuffer` joining
borrowed `Array<Note>` contents into owned display text. A persistence smoke
reloads quoted text from the same database without opening a window.

[`document-workspace`](../examples/applications/document-workspace) is the
recommended non-GUI application walkthrough. It uses domain-oriented names to
combine three Z modules, a move-only C++ document lease, dynamic storage, a
move-only named enum, cleanup-bearing errors, `try`/`attempt`, mutable methods,
and `Option<view DocumentSession>`. It also returns a zero-allocation
`DocumentSelection` containing two `view DocumentSession` fields tied to one
workspace, then proves the loan ends before the workspace grows. Its
deterministic run ends with three saved documents and zero live native leases. Read its adjacent
[`README.md`](../examples/applications/document-workspace/README.md) for the
scenario and an ownership-by-ownership explanation.

[`project-index`](../examples/applications/project-index) pressure-tests Map and
Set in an application-shaped module. File records are borrowed for ordinary
lookups, explicitly copied for durable reports, and moved into their final
consumer. Its deterministic smoke test and fixed benchmark verified the move
from dense storage to hashed buckets without changing application source.

[`message-router`](../examples/applications/message-router) uses an ARC `Router`
class to own a direct function and an owned capturing closure behind one
throwing `Handler` alias in `Map<String, Handler>`. Its synchronous throwing
dispatch method uses the same typed `Result` path as an ordinary function.
Lookup returns an independently retained
`Option<Handler>`; borrowed matching invokes it without consuming the Option;
typed routing failure remains available through `attempt`; and final Map
cleanup destroys the captured ARC state exactly once. The same source executes
in Stage 0 and the fixed-point native compiler's strict-C differential corpus.
Its `native-callback.zs` entry then moves the router into a callback governed by
an adjacent `.zd` contract. C retains the generated closure environment, the
closure retains the Z router, and clearing the native registration releases the
entire handler graph. This is the first application-shaped proof that a
foreign callback can enter a reusable Z module and reach long-lived,
class-owned behavior without a handwritten shim or a hidden stack lifetime.

[`source-stager`](../examples/applications/source-stager) is the first
self-hosting-groundwork tool. It reads a source path from `process.args()`,
copies that source through `std/fs`, invokes Clang directly through
`process.run`, and handles the typed failure path without exceptions or a shell.
The native self-hosting emitter now compiles this same application into a
standalone binary; Bun is needed to build the current bootstrap artifact, not
to execute the emitted stager.

[`compiler/frontend`](../compiler/frontend) now owns the reusable stage-1 Z
lexer and parser; [`source-inspector`](../examples/applications/source-inspector)
is its readable client and smoke-test application. The current AST covers the
complete declaration layer plus variable declarations, returns, expression
statements, and nested standalone blocks. Identifiers, scalar literals, arrays,
objects, calls, members, and indexes use a flat owned expression arena;
unary, binary-precedence, and ternary nodes share that arena. Z-specific
`new`, `weak`, `try`, `attempt`, `await`, and `task` nodes do too. Templates
retain ordered text/value children, including nested embedded expressions.
Expression-bodied closures retain capture mode, typed/capability-bearing
parameters, result/error types, and their body root. Block-bodied closures carry
cross-arena edges into the same flat statement storage used by function,
constructor, and cleanup bodies. Assignment targets/values, `throw`, `select`,
`break`, and `continue` are distinct statement nodes. Structured `if`, `else if`,
and `else` retain condition roots and branch edges; braced and single-statement
branches share one block representation. `while` retains its condition and body;
`for...of` retains its immutable binding, iterable, and body, with nested
`break`/`continue` nodes. Statement and value-producing `match` forms share one
flat subject/arm tree; payload bindings, object destructuring, aliases, and arm
bodies retain their locations and statement edges. `async scope` retains its
required block as the lexical structured-join edge. Value-producing `if`
expressions retain condition, value-block, and nested else-if edges, with branch
statements pointing into the shared arena. `on`, `await on`, and `task on`
retain placement mode, exact `on` location, executor root, optional result/error
types, and body statements. Enum payload construction and explicit `out`/`inout`
arguments are structural expression nodes too. Generic callees and generic
member calls retain canonical nested type arguments. Imports retain namespace or
selective bindings, aliases, binding locations, and headers. `z self-host-parse` caches its
native parser library by compiler/frontend content, loads it in-process, and
passes every requested source file directly from the Bun host through a narrow
FFI boundary. Add `--timings` to see library preparation, native frontend work,
protocol decoding, and stage-0 parity parsing separately.
The native resolver takes a host-loaded batch of canonical paths and source
strings, parses each module, and consumes the resulting ASTs directly to check
local edges, dependency order, exports, aliases, collisions, missing modules,
and cycles. Its first pressure fixture includes transitive `../` resolution and
each failure shape. `z check --native-frontend` now reuses the ordinary
analyzer's canonical batch, invokes that resolver through the reusable
in-process boundary, and retains the validated graph as compiler-analysis
evidence. Compiler-owned parity then checks the graph and exercises indexed
local, selective-alias, and namespace-member signature queries; the CLI only
reports the result and timings. Ordinary semantic analysis also observes each
successful direct Z call and verifies its native definition/signature, while
buffering native failures behind authoritative stage-zero diagnostics. Generic
function calls export their settled substitutions and concrete callable contract
at the call site. The same evidence now covers instance/static calls on generic
owners and inferred or explicit generic-class construction without decoding
stage-zero monomorph names; `check --native-frontend` reports both exported and consumed
native evidence. Generic aggregate literals, fields, and explicit type uses also
consume their native template metadata through a source-keyed structural rebase.
Cross-module aliases with the same visible declaration name remain distinct
inside nested user-defined monomorphs such as `Envelope<Slot<Node>>`; the native
bridge proves each source-template identity and generic path before accepting
the inferred binding or expression type.
Direct async calls preserve their success and error effects until `await`.
[`async-generators.zs`](../examples/language/control-flow/async-generators.zs)
proves cold generator construction and intrinsic awaited `.next()` results;
[`async-errors.zs`](../examples/async/async-errors.zs) proves `attempt await`
and `try await` without falling back for inferred bindings.
[`async-tasks.zs`](../examples/async/async-tasks.zs) carries those same effects
through owned `Task<T, E>` handles and consuming joins; all twelve inferred
locals are native-authoritative.
[`executor-placement.zs`](../examples/async/executor-placement.zs) proves
direct synchronous and async placement, placed tasks, consuming joins, and an
`inout`/`move` block result across all six inferred locals.
The frontend remains stage-zero-compiled, while the example directory is now a
small educational consumer rather than the implementation home.

[`desktop-ownership`](../examples/interop/objc/desktop-ownership) combines an ARC-managed Z
application model, move-only documents and strings, borrowed enumeration, and
an AppKit shell. Its findings are recorded in
[`ownership-pressure.md`](ownership-pressure.md); it exists to pressure-test the
ownership model rather than present a finished framework API.

[`ownership-views.zs`](../examples/interop/objc/desktop-ownership/ownership-views.zs) compares four lookup
contracts without a GUI: a zero-copy scoped callback, an indexed receiver-tied
`view Document`, a niche-backed `Option<view Document>` lookup, and an owned
snapshot that remains valid after collection mutation.

[`ownership-boundaries.zs`](../examples/interop/objc/desktop-ownership/ownership-boundaries.zs)
then carries the same decision into async code: value-owned projections and
class-owned callbacks remain synchronous lexical regions, while an explicit
owned snapshot crosses task creation, workspace mutation, and suspension.

[`unsafe/native-boundary.zs`](../examples/interop/unsafe/native-boundary.zs)
shows the middle native trust tier without introducing raw-pointer syntax. A
mutable native character pointer is asserted locally as `cstring`; an otherwise
unsupported handle remains an opaque compiler type, is checked against null,
and may pass only back to functions expecting the identical native pointer.
The example uses value-producing unsafe expressions to copy borrowed text into
an owned `String` and select a scalar while keeping native identities confined.
