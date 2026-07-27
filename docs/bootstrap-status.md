# Bootstrap implementation status

Last reviewed: 2026-07-27.

This document answers “what does the Bun/TypeScript stage-0 compiler implement
today?” It is not the language specification. Accepted source semantics live in
[`language-reference.md`](language-reference.md); design rationale and open
questions live in [`DESIGN.md`](../DESIGN.md).

Status meanings:

- **Implemented**: parsed, type-checked, lowered, and regression-tested for the
  stated surface.
- **Partial**: a useful vertical slice runs, with named boundaries below.
- **Planned**: accepted direction or required experiment, not implemented.

## Core language

| Area | Status | Current boundary |
| --- | --- | --- |
| Bindings, functions, inference | Implemented | Local inference plus first-tier value-struct object destructuring and aliases; public/API contracts remain explicit |
| Structs and methods | Implemented | Value layout, mutation, static methods, deterministic cleanup |
| ARC classes | Implemented | Identity, sharing, constructors, private fields, weak references |
| Traits | Partial | Nominal static conformance, generic declarations/specializations, and generic constraints; no trait values/dynamic dispatch |
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches, and tag equality for payload-free Z enums |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous and async cleanup-bearing Z, String, ARC, and move-only native error values with live-state-aware propagation and discard |
| Control flow expressions | Implemented synchronous tier | Ternary, `if`, `match`, `while`, and `for...of` produce values through explicit `select`; loop expressions require an exhaustion `else`, retain cleanup and ownership analysis, allow `continue`, and reject valueless `break`; async loop expressions remain |
| Closures | Partial | Borrowed and owned ARC environments, weak captures, and stored throwing function values whose `throws E` effect is preserved through aliases, calls, `try`, and `attempt`; nested closures automatically forward read and mutation captures through intervening environments while preserving shadowing and per-boundary ownership/thread checks. Preserving addressable move-only resource capabilities such as `TextBuffer` through a borrowed closure remains |
| Strings and console | Implemented | Owned UTF-8 strings, exact byte equality, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`; grapheme-aware `length` remains planned |
| Integer safety | Implemented | Checked arithmetic, explicit wrapping/saturating operations, and `TargetInteger(value)` construction that lowers range-contained pairs directly and checks narrowing/signedness-risk pairs; lossy and floating-point conversions remain |
| Transparent type aliases | Implemented foundation | `type Transform = (value: i32) => i32` names existing function, aggregate, collection, nullable, view, and nested types without changing representation or nominal identity; local/exported/selective/namespace use, construction/static lookup, recursive-chain diagnostics, editor support, and native parser/module parity work; generic alias parameters and opaque/newtype identity remain |
| Generators | Implemented synchronous tier plus composable async tier | Explicit `Generator<T>` and `AsyncGenerator<T>` sequences, terminal `Return`, and `throws E` advancement from `std/iteration`; both forms are cold move-only heap frames with typed `yield`/`return`, explicit `try`/`attempt` on fallible advancement, deterministic return/error/early-drop cleanup, editor support, and native-parser parity. Async `.next()` returns a one-shot `Task` that resumes the persistent stream frame through `if`, `while`, `break`/`continue`, built-in collection `for...of`, borrowed statement `match`, and ordinary awaits; caller cancellation joins the active advancement before cleanup and overlapping advancement is rejected. Async iteration sugar, consuming/value-producing suspending matches, generator methods, borrowed inputs/yields, and sent values remain |
| `comptime` | Planned experiment | No compile-time execution model committed |
| Inline assembly | Planned design | Explicit `unsafe` boundary with `in` / `inout` / `out` operands; statement-first lowering, machine constraints, clobbers, target pruning, and backend portability remain to be designed and tested |

## Ownership and collections

| Area | Status | Current boundary |
| --- | --- | --- |
| Moves and deterministic `deinit` | Implemented | Flow-sensitive cleanup across return, throw, loops, and matches |
| Explicit `copy` / `move` expressions | Implemented foundation | Readable contextual prefix keywords; `copy` supports cleanup-free values, owned String, recursively copyable Z structs/enums/arrays, and `.zd`-proven native copies, while `move` transfers unique whole-binding owners and diagnoses later source use; custom copy hooks and direct container-element extraction remain separate design work |
| `in` / `inout` / `out` | Implemented | Explicit declaration and mutable call-site capabilities |
| Unified loan checker | Implemented foundation | Call-, task-, receiver-view-, and Arena-region lifetimes share one root/capability/lifetime representation and conflict matrix; cross-thread loans remain to integrate |
| Fixed arrays | Implemented | Checked indexing and reverse element cleanup |
| `Array<T>` | Implemented | Growable owned storage and move-aware elements |
| `Map<K, V>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed lookup, owned value-storage transfer, deterministic replacement/removal/delete/clear, `Option<view V>` lookup for values tied into the unified loan checker, retained `Option<V>` lookup for Z-class and Objective-C identity, native construction/destruction for move-only C++ values, borrowed `Map.Entry<K, V>` iteration with whole-entry or `{ key, value }` patterns, mutation exclusion and editor support, built-in scalar/String/enum keys, and readonly nominal `Hashable` keys through `std/hash`; function/weak values, native keys, and copy-only native values remain |
| `Set<T>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed membership, owned unique-value transfer, insertion status, deterministic duplicate/removal/delete/clear cleanup, owned `Option<T>` removal, borrowed element iteration with mutation exclusion and editor support, and the same built-in or nominal `Hashable` contract as `Map` |
| `Iterator<T>` | Implemented synchronous tier | Explicit `std/iteration` import; generic nominal conformance, `next(inout this): Option<T>`, explicit mutable loans for stored value iterators, unique temporary iterator storage, owned element transfer and cleanup, native-parser parity, and editor support; consuming, mutable-element, move-only foreign-element, and async iterators remain |
| `Slice<T>` | Partial | Non-escaping parameters plus direct-awaited and scope-bounded child-task borrowing from fixed and growable owners, including cleanup-bearing Z and move-only C++ elements; returned/stored and cross-thread Slices remain |
| Receiver-tied `view T` | Implemented narrow tier | Direct field/index projections and niche-backed `Option<view T>` lookups from synchronous value-struct methods; inferred const local, read-only, non-storable, implicit ordinary by-value load when `T` is already cleanup-free and copyable—including contextual `match`/`if` expression arms—plus synchronous `in T` forwarding and proven nonescaping inline capture; no class owners |
| `std/memory` `Arena` | Implemented narrow tier | Stable region allocation, inferred owner-tied views, reverse `deinit`/ARC/native RAII cleanup, shared-loan reset exclusion and proven nonescaping inline capture; synchronous and single-threaded |
| General returned/stored borrows | Planned | Parameter provenance, class alias safety, retained views, and regions remain open |
| ORC cycle collection | Planned | `Weak<T>` works now; arbitrary strong cycles are not collected |

The ongoing empirical record is
[`ownership-pressure.md`](ownership-pressure.md). The first desktop probe shows
the core model handling ARC application state plus move-only documents cleanly,
while the value-struct lookup probe now crosses the first non-escaping wall with
an inferred receiver-tied view.

## Modules and tooling

| Area | Status | Current boundary |
| --- | --- | --- |
| Z source modules | Partial | Explicit exports, namespace/selective imports, aliases, cycle diagnostics, and canonical native type identity across intermediate modules; ordinary lowering still uses stage 0 |
| CLI | Implemented | `z check`, `z emit`, and `z run` through Bun; `check --native-frontend` reuses stage 0's canonical source batch/ASTs, attaches an indexed native semantic graph, and reports compiler-owned graph/query plus live call-resolution parity; native run I/O streams live and arguments after `--` are forwarded |
| System standard APIs | Implemented foundation | Default `std/fs` and `std/process` modules; owned reads/arguments, borrowed writes/process argv, direct no-shell child launch, typed OS failures |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate; richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions; `copy`/`move` incompatibilities diagnose live and keyword hover explains inferred type, capability source, copy cost, and source invalidation. Native hover separates the source-level Z signature from ABI and availability details, uses source-nameable handle types, and resolves the selected Objective-C receiver instead of merging unrelated selectors. Broader incomplete-pattern recovery remains |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial frontend | Stage 0 remains TypeScript/Bun; native Z owns the lexer—including opaque raw-native body boundaries—current parser arenas, module graph, structural phase API, function/type/method signatures, lexical/type lookup, primitive/generic/async/cross-module expression typing, definite-initialization and ownership flow, and structured diagnostics for that subset. All 155 executable examples pass the hybrid native gate without partial binding/expression authority; foreign ABI-only and raw-expression semantics deliberately defer. Complete semantics, lowering, code generation, and the CLI driver remain in stage 0 |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records, unions, and enums | Partial | Complete supported struct layouts, nested records, nominal enums, constants, and `.zd`-classified move-only by-value resources. `export type T { move; deinit release; }` keeps the native record ABI while `owned;` and non-escaping `borrowed;` producer facts govern cleanup; canonical Clang identity carries facts across typedef aliases such as raylib `Texture` → `Texture2D`. Imported C unions receive ABI-preserving storage and may be initialized through contracted `out Union*` parameters; supported scalar and enum members can then be copied inside `unsafe` after the program validates the native discriminator. Nominal imported enums convert explicitly outward through checked integer construction such as `u32(value)` while implicit and integer-to-enum conversion remain rejected. Pointer/nested-record union members, safe discriminated projections, borrowed runtime lifetime names, and by-value union construction remain |
| Clang header ingestion | Implemented spill-backed slice | Header ASTs and macro preprocessor output are imported directly from Clang. Ordinary imports keep the fast bounded pipe path; process-buffer or decoded-string overflow retries through a unique spill file, removing the former 64 MiB plain-C ceiling and importing SDL3's 70.8 MB `SDL_render.h` AST unchanged. Z currently materializes the completed JSON document for semantic filtering; incremental parsing remains a future memory optimization for substantially larger headers |
| C macros | Implemented literal slice | Active object-like integer-literal macros defined by the imported header receive target-correct scalar types, namespace/selective imports, direct native emission, completion, hover, and definitions; function-like, string, alias, and expression macros remain |
| C pointers and statuses | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts, including flat basename discovery for qualified includes; standalone `.zd` checking validates the active source against the real header. Owned nullable `T *` results and `T **` outputs receive deterministic cleanup and expose source-nameable namespace types such as `sqlite.sqlite3`; those owners may persist in ARC class fields and close at final release. By-value C resources use the separate record-resource tier above. Anonymous typedef enums import with their cases, expression-valued integer macros compose from other header macros, and `void throws _ { success CONSTANT; }` projects integer or integer-backed enum statuses into allocation-free typed errors while activating owned outputs before propagation. Named `project ...: Slice<u8>` contracts combine native byte-pointer plus `size_t` pairs into one borrowed argument and lower directly back to `.data`/`.length`; `project inout` additionally requires mutable native storage and explicit Z call-site mutation. Enum-member literal parameters plus explicit `cstring`, declaration-only `clong`, and an owner-tied byte-callback connection provide closed, type-checked C variadic overloads, proven against libcurl. `connection throws _` installs a separate context/callback option pair as one operation and returns a move-only `native.Connection` whose lexical loan guarantees callback removal before owner destruction. Null-only parameters safely hide unsupported pointer values; nullable `view cstring` results borrow their single pointer input and copy into owned `String`; fixed native sentinel parameters preserve the verified ABI while disappearing from safe Z calls; nullable declared handles lift into niche-backed `Option`; owned handles with explicit transfer/destruction facts cross `thread.spawn`. Broader C ABI vocabulary, resource lifetime provenance, general element-typed/retained buffer projections, general callback projections, general pointer/view contracts, and internal toolchain notes remain |
| Native callbacks | Partial | C call-only and escaping callbacks use `.zd` with named context, explicit `invoked once`/`invoked repeatedly` cardinality, and exact release contracts; generated Swift/Objective-C static methods may refine ARC-owned block parameters without inventing context/release ABI. `thread caller` preserves thread-local ownership, while `thread any` emits atomic closure ownership and checks conservative concurrent-shareability. Nested `failure N;` or `failure CONSTANT;` contracts allow compatible throwing Z function values: ordinary returns pass through, while thrown payloads are destroyed and narrowed to the declared callback ABI result. `async completion;` requires exact-once delivery, preserves the raw overload, synthesizes an infallible task, and traps duplicate native completion before re-entering completed storage; a never-invoked callback leaves the task pending. `async completion(value, error) { return value; throw error; }` projects a nullable Objective-C error into an owned `Task<T, E>`. Cancellation without a native hook waits for completion before frame destruction. A named/imported `TaskScope` owns repeated callback-created main-executor work and joins it without detachment; returned `TaskControl` identities expose admission and per-operation cancellation without duplicating join ownership. The current C callback tier permits one named byte projection per callback, although its length may multiply several native factors; failure constants are checked for integer/enum category, while exact scalar width and range validation remains. Instance projections, weak cross-thread capture, ownership-bearing completion values, native cancellation hooks, callback-payload preservation, and broader callback projections remain |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Native header/library search and linkage | Implemented host slice | Validated, deduplicated `target.includeDirectories` and `target.link.directories` resolve from `z.json`; library names become host-native arguments; package discovery, raw linker flags, and cross-platform library resolution remain outside the project contract |
| Raw native source | Implemented narrow tier | `raw c` / `raw cpp` / `raw objc` standalone expressions lower through isolated helpers with explicit `using (in ... / inout ... / out ...) : T` contracts; named functions use `= raw <language> { ... }` and their ordinary parameters/result as the boundary. Native `return` cannot escape the helper, `out` participates in definite initialization, dialect selection is automatic, `on thread.main` composes, and Clang diagnostics map to `.zs`. Raw shape restrictions are validated before generic materialization, ordinary fields named `c`/`cpp`/`objc` remain ordinary Z, and embedded source cannot reference compiler-owned `Z_` or `_z_` identifiers. Tier 1 accepts ABI-stable scalars, `cstring`, and imported native types; async/throwing/generic/method bodies, `move`, Z-owned representations, and embedded-language completion remain |
| Inline `unsafe` Z | Implemented narrow tier | Synchronous `unsafe { ... }` keeps Z syntax and types while allowing a compatible native `char *` result to be asserted locally as `cstring`, retaining another unsupported pointer as a scope-confined opaque identity, or asserting the active scalar/enum member of imported C union storage initialized through a checked boundary. The expression form uses `select` and can produce representable scalars or independently owned Z copies. Opaque and locally asserted borrowed values may compare with null or pass through exact matching native pointer spellings, but cannot be inspected, selected, stored outside the block, returned, captured by a closure, laundered through an ordinary Z call, or used in async functions; `String.from` is the explicit owned-copy boundary for asserted `cstring`. Pointer-bearing by-value records remain unavailable even inside `unsafe` and require `raw` in this tier. Inferred capabilities, pointer arithmetic, and a general raw-pointer type remain deliberately absent |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, imported property ownership (`weak`/`strong`/`copy`/`assign`), labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks, persistent observer tokens, lifetime-safe `std/objc` target/action connections, and checked Z-class protocol adapters with owned weak-property bindings |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded child-task mutable async borrows, whole Z async value aggregates, fallible async results, and explicit native-thread transfer when `.zd` separately guarantees transfer and receiving-thread destruction; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, child-task output async borrows, ARC/closure storage, native sharing, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link, declared-target symbol-graph import of Swift `@MainActor` type/method isolation, qualified `.zd` threading contracts for escaping blocks, and exactly-once callback-to-task synthesis with owned nullable `NSError` failures that resumes safely from arbitrary threads before AppKit work returns to `thread.main` |
| Swift value via C++ | Implemented probes | Native static construction, associated-value enum case factories, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, protocols, errors, async, packages; Swift 6.2 currently withholds noncopyable values and async functions from its generated C++ interface |

Current interop gaps that block a richer desktop application include
broader Objective-C block shapes, inherited/generic protocol edge cases,
cross-thread callback delivery into structured tasks, runtime availability
guards, cross-compilation, and API
notes at SDK scale. General
`T | null`/`Option<T>` representation unification remains language
foundation work; Objective-C reference options now have the first one-pointer
niche-backed specialization and explicit conversion bridge.

The Swift owned-value probe is intentionally honest about the toolchain: current
generated wrappers copy and deterministically destroy Swift values, but delete
C++ move assignment. Z therefore treats this as copyable foreign RAII, not as
native Swift move support. Generated static and instance scalar methods and
generated associated-value enum case factories are now called directly; this
does not yet imply Swift property, string-input, generic, protocol, error,
async, or package support. `swift::String` returns have one
explicit conversion: an annotated Z `String` destination receives a fresh owned
UTF-8 copy, including embedded NUL bytes. Swift `String` inputs remain rejected
until the boundary is length-aware in both directions. A toolchain-boundary
fixture verifies that Swift 6.2 marks `~Copyable` values and Swift `async`
functions unavailable to C++; Z does not bypass that limit through private ABI.

## Async and concurrency

| Area | Status | Current boundary |
| --- | --- | --- |
| Async syntax and typing | Implemented | Functions/methods, `await`, `task`, task scopes, typed errors, direct-call and block `await on thread.main` / `task on thread.main` placement, and executor-local `await scheduler.yield()` |
| Stackless task frames | Partial | Scalars, owned String/TextBuffer, cleanup-bearing fixed arrays, growable arrays, copied Slice descriptors, owned structs/enums/classes, direct move-only C++ locals and parameters, collection elements containing them, consuming owned enum matches, cleanup-free direct-awaited output, and fallible native result transfer through `try`/`attempt`/match across suspension. Values declared directly in `async scope` have live-state cleanup after child join across normal exit, `break`/`continue`, return, throw, and cancellation; cleanup-bearing ordinary conditional/loop/match locals remain |
| Executor | Implemented serial/thread-affine tier | Deterministic FIFO per executor: root/main work uses its serial executor and an explicitly async `thread.spawn` closure owns a private executor bound to that OS thread; shared pools and work stealing remain planned |
| Explicit native threads | Implemented thread-affine tier | `thread.spawn` starts one OS thread for a synchronous or explicitly `async` one-shot closure; an async worker owns a private executor, can await scheduler operations and structured children, can `await on thread.main`, and resumes on the same live worker; `move` is required when capturing; plain values copy, unique Array/String/TextBuffer owners and explicitly contracted C/C++ native owners move, deeply readonly classes share through atomic ARC, and main-isolated Z classes cross opaquely with access and release confined to main; `(): T throws E` produces `Task<T, E>` with live-state-aware owned errors plus bound/direct `try` and local `attempt`; await, cooperative cancellation, and implicit scope exit suspend through race-free cross-executor queues before joining; native `share` remains deferred |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation, shared immutable and exclusive mutable child borrows, plus named `async scope updates {}` handles. A child site may not cross a loop back-edge while frames use one fixed slot per syntactic site; direct await or an async scope created inside each iteration provides a proven join. Imported `TaskScope` accepts thread-safe callback submissions onto `thread.main`, rejects during close, and joins accepted synchronous `(): void` or explicitly async `async (): void` roots and their descendants. `schedule` returns a cleanup-bearing, non-joining `TaskControl` with `accepted`, `requestCancel()`, and `isCancellationRequested`; scheduled async roots handle errors locally |
| Caller cancellation | Implemented slice | Consuming `await task.cancel()` requests cancellation, joins descendants and cleanup, and discards an unclaimed completed outcome |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Cooperative scheduling | Implemented | `await scheduler.yield()` requeues the current task on its existing executor without a timer or executor hop and exposes a structural cancellation-observation point |
| Sync work in async frames | Partial | Z and supported direct native calls/methods, console, checked arithmetic, `cstring` locals/calls, concise and block-arm matches, synchronous nonescaping inline closures with case-local environments, and receiver-tied views whose last use ends before suspension |
| Embedded awaits | Partial | Left-to-right cleanup-free values, awaited conditions, selected match/if/ternary/logical branches, and nested lazy boolean conditions; arbitrary lazy-expression embedding inside larger calls/aggregates remains |
| Lazy/suspending expressions | Implemented direct-value tier | `&&`, `||`, ternaries, value `if`, and value `match` preserve selected-branch evaluation in async binding, return, and control-condition positions. Selected results transfer scalar, ARC, String, Z-owned, or move-only native values; typed propagation and cancellation retain exact cleanup |
| Executor placement and isolation | Implemented ownership-aware native-aware tier | `thread.main` is typed; hop-and-wait, nested suspension, direct placed calls, and structured children execute through main placement. Block captures use contextual `using (in value, inout state, move owner)`; cleanup-free Copy values and String snapshots may remain inferred, loans last through join, borrowed children require an async scope, and `out` remains deferred. Async direct callees flatten to their original task frame; synchronous nonthrowing calls use a one-shot placed frame. Existing proof comes from declaration contracts or enclosing placement, so the redundant bare synchronous proof block was removed. Z `class`, `struct`, and `function` declarations accept a header `on thread.main` contract; explicit Clang actor attributes, declared Swift-target symbol graphs, and `.zd` native type/function/method fallbacks enter the same FIIR affinity fact. Stored fields inherit isolation, native and Z calls enforce it, and hover exposes it. Native workers can await main-isolated async operations and carry a main-isolated Z class only as an opaque retained capability; access occurs in a placed child and worker cleanup queues release back to main. Values/errors return to the original executor and cancellation routes to the child-owning executor; Darwin installs and wakes a CFRunLoop source. Throwing synchronous direct calls, raw foreign-identity transport, async isolated auto-hop, external prebuilt Swift module metadata, Windows message-loop integration, and Linux toolkit adapters remain |
| Channels and actors | Planned direction | API, isolation, and sendability remain intentionally unsettled |
| CPU parallelism | Partial evidence | One explicit native thread can execute Copy-value or uniquely owned Array/String/TextBuffer work in parallel without blocking unrelated FIFO tasks or timers; its async continuation remains thread-affine across suspension and main-executor hops; pools, general sendability, mutable shared-state isolation, and multithreaded executors remain planned |

See [`async-model.md`](async-model.md) for the intended model and phase details.

## Validation probes

- [`examples/applications/z-notes`](../examples/applications/z-notes): persistent
  AppKit application, ARC-owned note model, optional selection, direct SQLite
  declaration import, owned database/statement cleanup, borrowed native text
  views, explicit `sqlite3` linkage, `std/objc` target/action, and async startup
  loading on a dedicated worker. The worker creates and destroys its SQLite
  owner locally, transfers an owned `Array<Note>` through `Task<T, E>`, and the
  main task enters the synchronous AppKit lifetime through
  `await on thread.main`.
- [`examples/applications/document-workspace`](../examples/applications/document-workspace): cross-platform,
  multi-module document registration and saving with move-only native leases,
  cleanup-bearing errors, optional views, array growth, and zero live resources.
- [`examples/applications/project-index`](../examples/applications/project-index): multi-module Map/Set
  pressure test with borrowed String-key lookups, owned record snapshots, typed
  filesystem errors, and a fixed dense-to-hashed benchmark.
- [`examples/applications/source-stager`](../examples/applications/source-stager): reads a requested Z
  source file, writes a staged copy, observes native argv, and launches Clang
  directly through the first self-hosting standard APIs.
- [`compiler/frontend`](../compiler/frontend): reusable native Z lexer/parser,
  owned flat AST arenas, and the in-process parser-library bridge to stage 0.
- [`examples/applications/source-inspector`](../examples/applications/source-inspector): readable clients and smoke tests for the native frontend, including a
  fallible owned-token generator with a terminal scan summary and the standalone
  lexer/parser protocol executables.
- [`examples/interop/objc/nswindow.zs`](../examples/interop/objc/nswindow.zs): direct AppKit window.
- [`examples/interop/objc/objc-nullability.zs`](../examples/interop/objc/objc-nullability.zs): explicit
  `T | null` AppKit guard narrowing alongside `Option.fromNullable` and
  `some`/`none` matching.
- [`examples/interop/objc/desktop-ownership`](../examples/interop/objc/desktop-ownership): ARC application
  model plus move-only owned documents and AppKit shell.
- [`examples/interop/objc/desktop-ownership/ownership-views.zs`](../examples/interop/objc/desktop-ownership/ownership-views.zs): zero-copy scoped
  lookup compared with an independently owned document snapshot.
- [`examples/interop/objc/appkit-events.zs`](../examples/interop/objc/appkit-events.zs): persistent native
  notification callbacks, weak Z capture, imported notification constants, and
  explicit observer-token removal.
- [`examples/interop/objc/target-action.zs`](../examples/interop/objc/target-action.zs): explicit
  `std/objc` connection ownership for AppKit's weak target plus selector convention.
- [`examples/interop/swift/swift-interop`](../examples/interop/swift/swift-interop): Swift class through its
  generated Objective-C compatibility header.
- [`examples/interop/swift/swift-task-scope`](../examples/interop/swift/swift-task-scope): Swift global-queue
  callback through an ARC-owned block, atomic Z closure environment, named
  `TaskScope`, generated symbol-graph `@MainActor` isolation, synchronous
  callback completion, and a joined AppKit operation on `thread.main`.
- [`examples/interop/swift/swift-value-interop`](../examples/interop/swift/swift-value-interop): Swift-native
  owned value constructed and called directly, then stored in a Z aggregate,
  through its generated C++ compatibility header.
- [`examples/interop/swift/swift-enum-interop`](../examples/interop/swift/swift-enum-interop): Swift-native
  associated-value enum cases constructed directly through generated callable
  case factories, then copied and called as owned values.
- [`examples/interop/cpp/foreign-values.zs`](../examples/interop/cpp/foreign-values.zs): `.zd`-contracted
  copyable C++ RAII value copied through an owning Z aggregate with zero live
  native values after scope exit.
- [`examples/interop/cpp/cpp-move-only.zs`](../examples/interop/cpp/cpp-move-only.zs): `.zd`-contracted
  non-copyable C++ RAII value borrowed, moved through an owned function and a Z
  value struct, then deterministically released with zero live native values.
- [`examples/interop/cpp/cpp-move-only-array.zs`](../examples/interop/cpp/cpp-move-only-array.zs): move-only
  native values stored in a growable array, relocated through native move
  construction, and destroyed in reverse order, including a mixed `String`
  aggregate.
- [`examples/interop/cpp/cpp-move-only-enum.zs`](../examples/interop/cpp/cpp-move-only-enum.zs): named
  enum payloads borrowed or consumed through `match`, replaced safely, and
  deterministically destroyed.
- [`examples/interop/cpp/cpp-arena.zs`](../examples/interop/cpp/cpp-arena.zs): move-only C++
  values transferred into stable arena storage and destructed by reset.
- [`examples/interop/cpp/cpp-references.zs`](../examples/interop/cpp/cpp-references.zs): C++ named-value
  references and receiver qualifiers mapped onto existing Z `in`, `inout`, and
  owned-transfer semantics with direct lvalue/`std::move` lowering.
- [`examples/async/async-native-ownership.zs`](../examples/async/async-native-ownership.zs): a move-only
  C++ value constructed directly in aligned task-frame storage, returned and
  relayed through task results, consumed by its caller, and cleaned exactly once.
- [`examples/async/async-collection-slices.zs`](../examples/async/async-collection-slices.zs): growable
  and cleanup-bearing collection owners borrowed as Slices across direct await,
  scoped task, and cancellation, followed by safe growth and reverse cleanup.
- `bun test`: compiler, runtime, diagnostics, interop, async, and editor
  regression suite.

## Agreed foundation sequence

1. **Optional receiver-tied views — implemented.** Validate
   `Option<view T>` lookup results, match-arm provenance, last-use diagnostics,
   editor information, and one-pointer native lowering in application-shaped
   code.
2. **Move-only storage contexts — synchronous slice implemented.** Dynamic
   arrays use raw native storage, move construction during growth, and reverse
   destruction. Named enums manage the active tagged-union payload across moves
   and replacement. Compiler `Option` and `Result` use the same non-trivial
   tagged-union lifetime machinery, and all compose with Z-managed cleanup. Direct
   move-only C++ async locals, whole Z value structs/enums containing them, and
   fallible returns work across suspension, `return await`, `try await`,
   `attempt await`, hidden result slots, match, and cancellation. Owned async
   parameters transfer into child frames at task creation. Immutable `in`
   parameters work through direct await and explicit-scope task. Mutable
   `inout` parameters work through direct await and exclusive explicit-scope
   task. Fixed and growable async collection owners, including move-only native
   elements, now provide Slice backing with reverse cleanup on completion and
   cancellation; a live child-task loan prevents reallocation until join. Cleanup-free
   `out` works through direct await. Child-task output,
   ownership-bearing output, ARC fields, and closure environments remain.
3. **Larger application probe — implemented.** The multi-module
   `document-workspace` combines a move-only native lease, dynamic arrays,
   named enum transfer, cleanup-bearing errors, `try`/`attempt`, mutable methods,
   and `Option<view T>`, then verifies zero live native resources. It exposed and
   closed module-linked enum classification, view-method dispatch, and
   statement-valued `throw` lowering gaps.
4. **Self-hosting prerequisites — lexer and declaration-parser foundations implemented.**
   Target-neutral `std/fs`, `std/process`, and owned program-argument APIs run on
   macOS and have Windows/POSIX native branches. Checked String byte operations
   and `std/text` `TextBuffer` now support a multi-module Z source inspector with
   UTF-8 boundary-preserving token copies, escape decoding, source locations,
   typed lexer errors, exact current keyword/operator kinds, decimal/exponent
   numbers, template interpolation modes, line and non-nesting block-comment
   trivia, and unknown-byte rejection. Native scanning and slicing retain UTF-8
   byte indexes while public offsets and columns use the shared UTF-16 code-unit
   contract required by stage 0 and LSP clients. Stage 0 compiles a native
   token-stream bridge and compares its kinds, decoded text, offsets, lines, and
   columns with the TypeScript lexer through `z self-host-lex`; the Z lexer also
   tokenizes its own complete source. The bridge buffers its full protocol into
   one native write.
   A linear Z parser now consumes the native token array and retains an owned,
   source-located top-level declaration skeleton for imports, functions, structs,
   classes, traits, transparent type aliases, and enums. `z self-host-parse` checks exact declaration kind,
   name, export/async state, order, and location parity against stage 0 across an
   adversarial fixture plus the lexer and parser sources themselves. Complete
   import nodes retain default namespace bindings or selective imported/local
   names, alias source locations, and module headers with exact parity, providing
   the first structural input for a native module resolver. Complete top-level
   function signatures retain generics and constraints, receiver and
   parameter capabilities, nested canonical types, return types, and `throws`.
   Structs/classes now retain generic constraints, implemented traits, visible
   and readonly fields, throwing constructors, static/async/receiver methods,
   and `deinit`; trait methods, alias targets, and enum payload variants are structural too.
   Canonical type-shape parity covers the complete declaration layer. Top-level
   function bodies now retain owned `const`/`let`, `return`, expression-statement,
   and recursively nested block nodes. Primary and postfix expressions are now
   real flat arenas covering identifiers, scalar literals, parentheses, arrays,
   objects, calls, member access, and indexes. Prefix unary operators, the full
   current binary-precedence table, and right-nested ternaries use the same
   representation. `new`, `weak`, `try`, `attempt`, direct `await`, and direct
   `task` retain their distinct grammar and node kinds too. Nodes retain values,
   integer child edges, argument/field labels, and locations without recursive
   heap boxes. Enum payload construction retains separate enum/case/payload
   identities, and explicit `out`/`inout` call arguments retain their capability
   and source-located binding as first-class nodes. Generic identifier and member
   callees retain canonical nested type arguments, making the parser's pervasive
   `Array<T>()` arena construction structural rather than opaque.
   Unsupported expressions remain source-located canonical token spans marked
   opaque; unsupported statement forms remain traversable but unmaterialized.
   Exact body parity now covers the fixture plus the lexer and parser sources
   themselves. Traversal borrows tokens and copies only AST-retained text. Parser
   framing is shared by executable and library clients. The compiler-facing
   parser bridge is content-addressed by its compiler/frontend inputs, loaded
   once as a native dynamic library, and receives each file's path and source
   bytes synchronously through Bun FFI. It therefore avoids both helper-process
   startup and native-side file I/O. `z self-host-parse ... --timings` exposes
   library preparation, in-process native frontend work, protocol decoding, and
   the stage-0 parity parse independently. This pressure also closed canonical
   `TextBuffer`/`Arena` type identity through intermediate source modules.
   The reusable lexer, parser, protocol, and in-process library now live under
   `compiler/frontend`; Source Inspector remains their readable application
   client and standalone bridge pressure test. The first native module resolver
   directly consumes parsed Z `Program` values from a host-loaded canonical
   source batch. It validates lexical `./`/`../` edges, dependency-first order,
   selective exports and aliases, duplicate bindings, missing modules, and
   cycles without serializing the AST between parsing and resolution. That batch
   now crosses the compiler's existing in-process native-library boundary in one
   FFI call. `z self-host-resolve` compares module indexes, lexical edges, entry,
   and dependency order with a stage-zero graph and reports boundary, framing,
   native execution, decoding, and stage-zero parity timings separately. The
   stage-zero linker and native boundary now consume one canonical source batch;
   the command discovers its full local graph from only the entry path. The first
   native semantic tier builds and parity-checks source-located symbols for Z
   functions, structs, classes, traits, enums, namespace imports, selective
   bindings, aliases, exports, and local target modules. Function symbols also
   retain async state, generic parameters, parameter capabilities and types,
   return type, and error type through the native graph protocol; aggregate type
   signatures also carry custom-deinitializer/custom-constructor state and the
   constructor's parameter/result/error contract. A first native lexical resolver
   now walks every materialized function, constructor, method, and `deinit`
   expression tree in source order. It introduces parameter and local bindings,
   isolates nested blocks and loop bindings, adds closure parameters and
   match-arm payload/destructuring bindings, recognizes `this` only in instance
   bodies, and reports unknown names at their native source coordinates.
   Native type-name lookup now retains every nested nominal component directly
   in `TypeReference` rather than reparsing its canonical display string. It
   resolves primitives and standard type constructors, generic parameters,
   local/imported declarations, local namespace exports, fields, constraints,
   parameters/results/errors, enum payloads, local annotations,
   closure/executor signatures, `new`, and explicit generic arguments. Unknown
   nested types report the exact inner token location. Z and intrinsic generic
   type uses now validate arity and nominal constraints recursively, including
   nested generics and function signatures, while preserving bare generic names
   at constructor-inference sites. Opaque expression spans, foreign namespace
   member verification, value member lookup, duplicate local diagnostics, full
   type compatibility/conformance, and complete ownership coverage remain
   stage-zero work.
   The first native expression-typing tier now carries declared parameter types
   into source-ordered scopes; infers scalar, template, fixed-array, identifier,
   and explicitly typed closure values; and propagates direct Z call results. It
   validates known local initializers, assignments, boolean
   conditions, call arguments, return values, unary/binary operators, indexing,
   and ternaries. Direct calls now follow local declarations, selective imports
   (including aliases), and namespace imports to their target signatures.
   Generic calls infer type parameters through direct, nested generic,
   fixed-array, `Slice`, nullable, and `view` parameter shapes, or accept
   explicit type arguments, before substituting parameter and result types.
   Argument-driven inference now also specializes local or imported generic
   struct literals, synthesized class initialization, and declared class
   constructors; selective aliases preserve caller-visible result spellings
   while evidence remains keyed to the defining type. Context-only aggregate
   inference for parameters absent from every field/constructor argument remains
   unresolved in the native tier.
   Conflicting inference, value/type arity, and known cross-module argument
   mismatches originate in Z.
   Local and imported enums plus compiler-provided `Option<T>` and `Result<T, E>`
   now drive native match subject and payload types. Type symbols carry aggregate
   type parameters, field contracts, visibility/read-only state, and enum
   variants/payloads across the native graph protocol. The pass validates unknown
   and duplicate variants, payload/payloadless patterns, local or imported generic
   aggregate destructuring fields, exhaustiveness, and known expression-arm result
   types. Unknown foreign and async shapes remain explicitly unresolved,
   so this tier increases guarantees without emitting speculative errors.
   Z-defined field reads and assignments now resolve across local, selective,
   and namespace type names, substitute generic field types, enforce private and
   read-only contracts, and make enum comparisons concrete. Foreign, intrinsic,
   and extracted method values still defer. Z-defined instance and static calls
   now follow
   local/imported type metadata, enforce visibility and argument/result contracts,
   and substitute aggregate and method generics. Receiver capability state
   participates in the first native ownership pass. Nominal identity now uses
   defining module/symbol coordinates independently of whether source spells a
   type locally, through a namespace, or through a selective alias. Imported
   function/method signatures, fields, and enum payloads rebase into the caller's
   visible spelling, including transit through an intermediate module. Generic
   inference compares those identities recursively through nullable,
   `view`, fixed-array, and nested-generic shapes while retaining readable source
   spellings in genuine conflict diagnostics. Native bindings now retain the
   first capability-state bit: direct reassignment accepts `let`, `inout`, and
   `out` storage while rejecting `const`, value, and `in` bindings. Bindings also
   carry initialized, uninitialized, or maybe-uninitialized state. Direct
   assignments and nested blocks update it, `if` merges only continuing branches,
   loops retain the conservative zero-iteration path, and successful returns/fallthrough
   require every `out` parameter to be initialized. Direct/imported function and
   Z-method calls now enforce `out`/`inout` markers, mutable storage, initialized
   `inout` input, invalid explicit capabilities on value/`in` parameters, and
   parameter types before a successful `out` transition initializes storage.
   Expression traversal carries effects left-to-right; ternary and short-circuit
   alternatives merge them conservatively. Per-call access roots now reject all
   overlaps except `in`/`in` and `value`/`value`, including receiver/argument
   conflicts. Value-struct `inout this` requires mutable addressable storage;
   owned `const` class references retain identity mutation while immutable `in`
   class borrows reject it, and borrowed `this` cannot invoke `move this`.
   Bindings now additionally carry available, moved, or maybe-moved state.
   Cleanup-bearing values passed to owned parameters transfer ownership while
   ARC classes, weak references, and function values copy; continuing branches
   and loops merge state conservatively while exiting branches are excluded,
   borrowed bindings cannot be consumed, assignment
   and successful `out` restore storage, and `move this` invalidates a named
   receiver. Exhaustive `match (value)` consumes cleanup-bearing subjects while
   `match (in value)` borrows named storage; payload bindings inherit the matching
   access, cleanup-bearing destructured fields remain borrowed, and continuing
   arms merge outer move state. Readonly-field receiver paths, richer reachability,
   and nested value mutation remain part of the broader native ownership/flow pass.
   Local initialization, whole-value replacement, return, throw, selected match
   results, conditional branches, fixed-array elements, synthesized aggregate
   fields, and enum payloads now share the same ownership-transfer primitive.
   Synthesized object construction validates complete field shape and recursively
   consumes ownership only when graph metadata rules out a custom constructor.
   Declared class construction uses its graph-carried parameter capabilities and
   types, substitutes aggregate generics, and shares the ordinary call transition
   rules for owned, `in`, `inout`, and `out` arguments. Synchronous Z functions,
   methods, and constructors retain a pending error effect until `attempt`
   produces `Result<T, E>` or `try` validates compatible propagation from an
   enclosing throwing body. Unhandled calls, non-throwing wrapper operands,
   incompatible errors, and invalid `throw` statements diagnose natively, with
   generic substitution and imported aliases preserved.
   Local closure expressions now retain callable parameter modes/types and
   inferred or explicit result contracts, analyze expression and block bodies in
   nested value environments, and invoke through the same argument capability,
   exclusivity, transfer, and type rules as named functions. Native capture
   discovery excludes parameters and closure-local bindings. Borrow closures
   conservatively loan cleanup-bearing outer values; `move` closures consume
   unique owners while ARC identities remain copyable. Immutable capture writes,
   use-after-capture moves, uninitialized captures, and moved captures diagnose
   in Z.
   Enclosing return contracts now flow through statement match arms, and
   payload-free enum/`Option` constructors no longer resemble partial field
   moves to ownership analysis. The resolver now uses its own owned `Set<String>`
   for binding membership and `Map<String, usize>` indexes for symbol lookup;
   copyable `Option<view usize>` payloads load into independent indexes while
   cleanup-bearing views remain borrowed. With explicit copies on alternate
   owned-String result paths, the native resolver analyzes the complete
   three-module frontend graph—lexer, parser, and resolver—with 375 symbols and
   exact stage-zero graph/symbol parity.
   Ordinary `z check` can now opt into that same result through
   `--native-frontend`; stage zero remains authoritative for diagnostics, then
   native analysis gates success on exact parity. This is now a narrow hybrid
   integration, not yet a frontend-selection promise. It exposes equivalent-work timings and
   lets application checks grow the native corpus without changing default
   diagnostics. The ordinary analyzer now supplies its already-discovered
   canonical `SourceModuleBatch` to a resolver callback after successful stage-0
   semantics, validates module identity on return, and retains the resulting
   native graph on `AnalyzedSource`. `NativeSemanticIndex` is the first
   compiler-owned consumer: it resolves local symbols, selective aliases, and
   namespace members to their defining native declaration and callable/type
   signature. A compiler parity service now constructs the canonical stage-zero
   graph and proves each indexed binding lookup plus resolved selective/namespace
   signature against it; both `check --native-frontend` and
   `self-host-resolve` use that one service. Native evidence is prepared before
   the main stage-zero semantic pass, allowing successful direct Z function,
   static-method, instance-method, and explicit class-constructor calls to
   shadow-resolve their defining native symbol and signature as they occur.
   Method observations additionally prove static/instance identity, visibility,
   receiver capability, async/error state, parameter capabilities and types, and
   result type. Constructor observations prove the corresponding parameter,
   result, and error contract. The check report keeps function, method, and
   constructor resolution counts separate so this live migration surface remains
   measurable instead of disappearing inside whole-graph parity.
   Struct and synthesized-class aggregate construction, every Z field selected by
   construction or member access, and payload-bearing or payload-free source enum
   variants are now native-authoritative. Aggregate
   contracts supply struct/class identity and field layout while preserving the
   validated stage-zero constructor/deinitializer bodies needed by lowering;
   field contracts supply source type, visibility, and readonly state; enum
   contracts supply exact payload type. The resolved field selected during a
   member expression is retained for later assignment and mutable-method checks,
   so native readonly metadata feeds the existing ownership path rather than a
   parallel checker. Match statements and expressions use native variants, and
   object patterns use the same native field contract for binding types and
   ownership. Separate aggregate, field, and enum-variant authority counts keep
   this migration tier measurable. Generic aggregate construction and field
   resolution use the native template's structural metadata while retaining the
   linked concrete declaration as lowering identity; the bridge keys that rebase
   by source definition and field name and never decodes a monomorph name.
   Explicit local,
   closure, and executor-placement type uses now recursively rebuild Z types from
   native declarations nested in function values, `Weak`, `Task`, `Option`,
   arrays, slices, and views. The rebuilt names feed local storage, closure
   signatures, and executor result/error contracts. Explicit uses of linked
   generic aggregate types now follow that same validated template-to-concrete
   rebase. Native checks report these type-use authority resolutions
   independently, while primitive, foreign, compiler-synthesized, and bare
   generic-parameter types remain on the stage-zero path.
   The graph protocol now also exports source-located concrete generic-call
   contracts after native inference settles. Each record identifies its defining
   module and symbol and carries type substitutions, parameter capabilities and
   types, async/error state, and result type. `NativeSemanticIndex` validates and
   indexes these records by canonical module plus call-expression offset. Direct
   generic Z functions are native-authoritative when the complete contract maps
   cleanly onto the linked concrete declaration. Source-template substitution
   proves nested concrete contracts such as `Option<i32>` before rebasing them
   onto Stage 0's temporary materialized lowering names. Direct calls now infer missing
   generic result parameters from local annotations, assignment targets, and
   enclosing function returns before exporting the same concrete evidence.
   Generic functions, static and instance methods, declared constructors, and
   synthesized aggregate fields propagate settled contracts through nested calls
   and ternary, value-producing `if`, and expression-`match` branches. Concrete
   names needing richer cross-module rebasing retain the stage-zero fallback. The same source-keyed evidence now makes instance/static methods on
   generic owners and inferred or explicit generic-class constructors
   authoritative after validating the owner symbol, ordered substitutions,
   receiver contract, and fully concrete callable signature. Native checks report exported contracts
   separately from contracts actually consumed by the semantic bridge.
   Unannotated initialized `const` and `let` declarations now export a second
   source-located evidence stream containing the native frontend's settled local
   type. The compiler indexes those records by binding-name offset and validates
   name, mutability, and source-level type before using them as authoritative
   local binding contracts. This includes materialized generic values such as
   `Option<i32>` through the compiler's source display-name map. Direct aggregate
   bindings also carry their resolved module and symbol, allowing local,
   selective-import, and namespace-qualified spellings to prove the same type
   identity without string heuristics. Path-keyed identities now recurse through
   compiler-known wrappers including `Option`, arrays and slices, views, `Weak`,
   tasks, function signatures, and materialized `Result` payloads. User-defined
   generic aggregate materialization retains its source template and ordered
   source arguments, so nominal identities survive nested monomorphs such as
   `Envelope<Slot<SyntaxNode>>`. The bridge validates those identities at their
   exact generic paths and no longer lets equal-looking type text bypass nominal
   proof.
   Settled root expressions now export their own source-located evidence stream.
   Each record carries the inferred source type plus recursive nominal identity
   paths, and `NativeSemanticIndex` keys it by canonical module and expression
   offset. The semantic bridge accepts a native expression result only when its
   location, concrete type, and every declaration identity match the linked
   Stage-0 expression. Generated, opaque, foreign, unsupported executor,
   and otherwise absent roots continue through the Stage-0 fallback. Ordinary native checks report
   expression contracts exported, observed, and used authoritatively as separate
   counts.
   Native evidence lookups translate linked Stage-0 source locations back to
   canonical module-local offsets before querying the semantic index. Imported
   function bodies therefore no longer miss evidence—or collide with unrelated
   local offsets—after Stage 0 rebases them into one linked program. Qualified
   type names rooted in non-Z selective imports are treated as opaque foreign
   types, so application-shaped C++ resources compose with native Z analysis
   without the resolver pretending to understand the header.
   A representative ordinary-check corpus now covers the six-module native
   frontend itself, Source Inspector, Document Workspace, `Result`, arenas,
   owned closures, generic constraints, and async ownership. On that corpus,
   every function/method/constructor, aggregate/field/variant, explicit type,
   inferred binding, and root-expression resolution observed by Stage 0 is
   backed by a consumed native-authority contract.
   Successful non-generic Z function, method, and explicit class-constructor calls
   are now native-authoritative semantic results. Their parameter modes and types,
   async/error state, and result type come from the native signature; methods also
   take static/instance identity, visibility, and receiver capability from native
   metadata. A checked rebasing step maps native source-level type names onto the
   already-linked stage-zero declarations used by ownership analysis and code
   generation, so native `inout this` and `move this` feed the existing
   exclusivity and consumption checks rather than creating a parallel ownership
   path. Stage zero independently proves each contract equivalent before using
   it. Direct generic functions, methods on generic owners, separately generic
   instance methods, separately generic static methods on non-generic owners,
   and inferred or explicit generic-class constructors with complete native
   substitutions now use the same authority path. Static calls combining an
   independently generic owner and method remain deferred pending syntax. Ordinary
   checks without `--native-frontend` retain the stage-zero path.
   Native-authority counts are reported separately for functions, methods, and
   constructors.
   Direct Z async calls now retain an internal pending success/error effect
   instead of discarding their result type. `await` consumes that effect only
   inside an async function, preserves typed failures for the surrounding
   `attempt` or `try`, and rejects unsettled async calls. Cold
   `AsyncGenerator<T, R, E>` construction remains synchronous, while intrinsic
   awaited `.next()` advancement follows the same pending-effect path. The
   existing async-generator and scalar async-error examples now export and
   consume every inferred binding contract through native authority.
   Structured `task operation()` now converts the same pending call effect into
   source-level `Task<T>` or `Task<T, E>` evidence. Awaiting a named handle
   consumes its ownership and restores the success/error effect for direct,
   `try`, or `attempt` handling. The existing async-tasks application moves from
   four to all twelve inferred bindings under native authority.
   Native-source-resolved `await on` and `task on` placements now preserve
   direct call effects and block result/error contracts. Explicit `in`, `inout`,
   and `move` captures are validated in a dedicated semantic module; block
   `select` types and post-join ownership flow feed ordinary native evidence.
   The executor-placement example moves from two to all six inferred bindings.
   A placement whose capture originates in unavailable foreign or
   `thread.spawn` metadata deliberately defers instead of inventing an
   unknown-capture diagnostic.
   A wider executable-corpus sweep now also guards semantic compatibility at
   the native boundary. Trait method signatures preserve `inout this` and
   `move this`; contextual payload-free generic variants such as
   `Option.none` are constructors rather than ownership-bearing field moves;
   and function values compare by capabilities and parameter/result types
   rather than local parameter names. Function-valued aggregate fields are
   callable through the same native signature path. The existing classes,
   Option, owned async-enum, and function-value programs all pass with every
   Stage-0-observed binding and expression backed by native authority.
   Transparent callable aliases now expand to their underlying signature during
   native closure contextualization and calls. Function-type parsing retains
   `throws E`; contextual and explicitly throwing closures carry that error
   into body checking, returned function evidence, and pending call effects.
   The ordinary throwing-function application plus both native-thread error
   examples now consume every observed binding and expression through native
   authority.
   Compiler-provided weak references now cross the same boundary:
   `WeakExpired` is an intrinsic type, `weak value` requires a Z class without
   consuming its strong owner, and `Weak<T>.upgrade()` produces a native
   throwing effect returning `T`. The existing weak-reference and weak-capture
   application now consumes all ten observed bindings and all twenty-seven
   observed expressions through native authority.
   Recursive cleanup and explicit-copy analysis now remain in an aggregate's
   defining module. Only concrete generic arguments are rebased into that
   module before substitution, so an exported struct cannot lose ownership
   merely because one of its nested field types is not separately imported by
   the caller. The unchanged project-index application now consumes all seven
   observed bindings and all twenty-four observed expressions through native
   authority, including its explicit move of an `IndexReport` whose nested
   `FileRecord` owns Strings.
   Dependent relational comparisons in generic bodies now accept a contextual
   numeric literal provisionally when the other operand is an active type
   parameter. This mirrors Z's existing template-style behavior for the
   concrete `Pair<i32>` specialization and restores native authority for all
   five calls, four inferred bindings, and six observed expressions in the
   existing generics example. Stage 0 still proves each concrete
   specialization; native specialization must replace this narrow deferral
   before Stage 1 can become the sole authority for unconstrained generic
   operators.
   A 155-root executable-example sweep found five false native diagnostics where
   the source-only graph lacked Clang/Objective-C metadata: numeric C typedef
   operations, contextual foreign literals, copied foreign property results,
   and contextual block closures. Imports with no local Z module target are now
   explicitly classified as unresolved external types. Only judgments that need
   the missing ABI facts defer to Stage 0; surrounding Z calls, aggregates,
   bindings, expressions, and ownership remain native-authoritative. The five
   unchanged interop examples now check. The adjacent raw-native root exposed a
   parser rather than type-system gap. Stage 1 now lexes a raw body as one opaque
   token, preserving nested native braces/quotes/comments, and structurally
   accepts `function ... = raw c|cpp|objc { ... }` without interpreting the
   embedded source. Ordinary identifiers named `raw` remain ordinary. All 155
   executable examples now pass the hybrid gate with zero partial
   binding/expression-authority gaps; Stage 0 continues to own raw escape-hatch
   semantic validation.
   The first native C-emission proof now consumes the owned Stage 1 `Program`
   directly. `z self-host-emit` lowers a deliberately closed subset—ordinary
   `i32`/`boolean`/`void` functions, value parameters, explicitly typed locals,
   direct calls, unary/binary expressions, assignment, `if`, `while`,
   `break`/`continue`, returns, and non-generic data-only value structs—to
   portable C. Struct layout, compound construction, value passing, and field
   access are executable. Before emission, the canonical
   batch passes through the same native module resolver and semantic analyzer
   used by the parity bridge; an invalid name is rejected natively rather than
   left for Clang. Regressions compile and execute both a scalar call program
   returning 42 and a mutable factorial/control-flow program. Raw signed C
   arithmetic is not substituted for Z semantics: emitted `i32`
   addition, subtraction, multiplication, and negation use checked helpers, and
   an overflow regression terminates instead of invoking C signed-overflow
   behavior. This removes TypeScript AST reconstruction from one complete
   source-to-native path. It is not yet the production emitter: Stage 0 remains
   authoritative for the full language, module linking, ownership cleanup,
   runtime types, foreign interop, and production diagnostics.
   These three shapes established and now pass through the native lowering-IR
   boundary. The flat typed arenas normalize checked arithmetic, direct calls,
   field reads, and struct construction before target emission; the C printer
   no longer imports parser nodes or interprets operator strings. Deterministic
   cleanup adds scope/branch/return exit plans, so ownership-bearing structs
   extend this IR rather than teaching the C printer source semantics.
   The first such extension is implemented for a deliberately linear tier:
   a data-only struct may declare an empty custom `deinit`, an owned value
   parameter receives an explicit lowered cleanup plan, and return emission
   saves the result before destroying the parameter. The executable regression
   places `Resource_deinit(&resource)` between result evaluation and the C
   return.
   A linear parameter-transfer follow-up lowers `move resource` explicitly.
   The relay function emits the value handoff without deinitializing it, while
   the final owner retains the return-exit cleanup.
   Top-level linear owned locals now enter that same cleanup plan after
   initialization. Live locals clean in reverse order after return-result
   evaluation, while `move local` transfers cleanup to the callee. Destructible
   value structs deliberately use writable C storage even when their Z binding
   is `const`: Z prevents rebinding semantically, while physical mutability lets
   `deinit` receive the value's address. A control-flow follow-up carries
   still-live outer parameters and locals through `if`/`while`; nested returns
   receive the current cleanup snapshot and fallthrough retains the owners.
   Conditional transfer remains fail-closed because its divergent live states
   need an explicit join representation. Cleanup-bearing locals within `if`
   branches now clean at branch fallthrough and before early return; a
   fallthrough analysis omits unreachable duplicate cleanup after a terminating
   block. Loop-local owners remain rejected until `break`/`continue` record the
   exact scopes they exit. Replacement assignment, non-empty deinitializers,
   conditional transfer, and error cleanup merging remain future slices.
   Native resolver failures now cross the bootstrap boundary as structured kind,
   file, line, column, and message records. Unknown-name, unknown-type,
   unknown-member, type-mismatch, invalid-operator, and invalid-match failures
   become authoritative native diagnostics when their location belongs to the
   canonical source batch. Stage zero still owns parser, module-loading, and
   unsupported-shape diagnostics; malformed, out-of-batch, and non-semantic
   native failures remain buffered, so a Stage-0 error wins in those cases.
   Prepared-library invocation lives in a
   reusable native-frontend service rather than the CLI. Native checks therefore
   no longer repeat host import discovery or parity lexing/parsing—the comparison
   graph is built from the canonical batch's existing ASTs and dependency maps.
   The CLI now owns only native preparation/invocation and reporting, not graph or
   signature semantics. Later compiler consumers have an explicit migration seam
   instead of reading a CLI-only side effect.
   Native signatures now retain generic trait constraints and nominal aggregate
   conformance. Native inference enforces those constraints for inferred and
   explicit function/method calls and aggregate construction; constrained generic
   bodies may call only methods supplied by their declared traits.
   Foreign method lookup, generic trait declarations, foreign call
   effects and executor placements with unavailable foreign/thread metadata,
   escaping closure-environment validation,
   precise closure borrow last-use release, remaining receiver-path capability
   enforcement, and full recursive ownership contexts remain stage-zero work.
   Template literals now
   retain ordered decoded-text leaves and ordinary embedded-expression roots,
   including nested templates, in the same flat arena. Expression-bodied
   closures retain borrow/move capture mode, source-located parameters,
   capabilities, optional parameter and result/error types, and an ordinary
   expression body root. Function, constructor, `deinit`, and closure bodies now
   use flat statement arenas with integer child edges. Block-bodied closures
   carry statement-root edges into the enclosing arena, so their currently
   supported variable, assignment, return, throw, select, expression, loop-control,
   and nested-block statements are structural without recursive per-block
   allocation. Assignments retain separate target and value expression roots,
   preserving Z's rule that assignment itself is not an expression.
   Structured `if`, `else if`, and `else` statements retain ordinary condition
   expression roots and integer branch edges. Explicit blocks and single-statement
   branches normalize to the same block node, while else-if chains point directly
   to the next conditional node.
   `while` statements retain an ordinary condition root and required block edge.
   `for...of` statements retain the immutable binding and its location, iterable
   expression root, and required block edge. Existing `break` and `continue`
   nodes therefore compose inside a complete structural loop tree.
   Value-producing `while` and `for...of` expressions retain the same condition,
   binding, iterable, and body edges plus a required exhaustion-value block.
   Their explicit `select` statements share the ordinary statement arena.
   Statement and expression `match` forms share a flat match-expression tree.
   Subject and arm edges, `in` mode, payload bindings, object-field destructuring,
   aliases, source locations, and each arm's statement body are structural.
   `async scope` statements retain their required block edge, preserving the
   lexical child-lifetime and implicit-join boundary for later native analysis.
   Value-producing `if` expressions retain condition, then-value-block, and
   else-value-block/if-expression edges. Their branch statements use the shared
   statement arena, preserving local declarations and explicit `select` nodes.
   Executor-placement expressions retain await/task mode, a distinct
   source-located `on` marker, the executor expression root, optional success and
   error types, and the placed body. This leaves a structural insertion point for
   the planned contextual `using` capture clause.
   Contextual keywords are accepted as member names after `.` just as they are
   by stage 0. Unicode identifiers remain future lexer work.
   Exact lexer and parser parity now covers UTF-16 locations after BMP and
   supplementary Unicode text without giving up byte-oriented native slicing.
5. **Threaded concurrency evidence — thread-affine async worker slice implemented.**
   `thread.spawn` now proves one real cross-thread task frame with explicit
   move capture, hot start, structured join, private Copy snapshots, and moved
   Array/String/TextBuffer owners/results, explicitly contracted C/C++ owners,
   plus atomic-ARC deeply readonly class identity, live-state-aware owned error
   transfer through `Task<T, E>`, and nonblocking executor completion.
   An `async` worker closure owns a private executor, awaits child work and
   delays, hops to `thread.main`, then resumes on the same dedicated worker;
   cooperative cancellation wakes and unwinds a suspended worker. The next
   concurrency probes should be driven by the desktop application: cross-thread
   callbacks, UI-thread delivery, weak-reference and destruction-affinity
   protocols, and mutable shared-state isolation. Do not commit actors,
   channels, pools, or a multithreaded executor as settled language design yet.

## Self-hosting continuation point

Self-hosting has advanced beyond its stable semantic-authority checkpoint into
the first executable native-emission slice, but is not declared complete.
Native Z owns lexing, structural parsing, module-graph resolution, a substantial
semantic subset, structured diagnostics for that subset, the evidence consumed
by ordinary `check --native-frontend` runs, and a deliberately narrow direct
AST-to-C proof. The representative corpus gate must remain green as this grows.

Continue focused self-hosting work in this order:

1. Continue decomposing the former 8,980-line `module-resolver.zs` without
   changing semantics: separate evidence/model types, graph construction, name/type
   utilities, and expression/ownership flow behind one resolver operation and
   one explicit model module. Keep parity and timing gates green. Use the
   extraction to determine whether ordinary Z modules are sufficient or whether
   a narrowly scoped borrowed semantic context is justified; do not infer a
   need for trait values merely from the current file size. Evidence/model,
   lexical module paths, signature projection, and symbol construction are now
   separate. Parsing, dependency edges, graph skeleton construction, and
   dependency ordering now live in `module-graph.zs`; lexical scope and name
   validation now live in `semantic-names.zs`. Shared intrinsic, numeric,
   nullable, fixed-array, generic, and callable type-shape recognition now lives
   in `semantic-type-shapes.zs`. Canonical cross-module type identity, spelling
   rebasing, and trait lookup now live in
   `semantic-type-identities.zs`; declaration type-name, arity, callable-shape,
   and generic-constraint validation now live in
   `semantic-type-validation.zs`. Semantic orchestration, expression inference,
   and ownership diagnostics remain in the resolver. The initialization and
   ownership state values plus binding copy, mutation, borrow, and branch-merge
   operations now live in `semantic-flow-state.zs`. Generic substitution,
   cleanup detection, move-on-owned-use, explicit-copy eligibility, and custom
   constructor lookup now live in `semantic-type-ownership.zs`. Enum-match
   shapes, aggregate-field lookup, method signatures, generic constraint
   bindings, and owner visibility identities now live in
   `semantic-member-lookups.zs`. Match payload bindings, object-pattern shape
   validation, private-field enforcement, and pattern diagnostics now live in
   `semantic-pattern-validation.zs`; arm expression inference and ownership-flow
   merging remain in the resolver. Recursive generic unification, contextual
   substitution, constraint checking, and parameterized type-name construction
   now live in `semantic-generic-inference.zs`; aggregate construction consumes
   one normalized lookup shape while recursive field-expression inference
   remains in the resolver. Per-call capability conflicts and pending
   throwing-call effects now live in `semantic-call-contracts.zs`.
   Initialization/use-after-move diagnostics, storage-root discovery, and
   whole-value consumption now live in `semantic-expression-ownership.zs`.
   Expected/actual compatibility for callable values, contextual literals,
   nullability, Slices, and receiver-tied views now lives in
   `semantic-expression-types.zs`. Closure parameter contextualization,
   callable-shape construction, and lexical capture discovery now live in
   `semantic-closures.zs`; move/borrow effects and recursive closure-body
   inference remain in the resolver. Function parameter and receiver bindings,
   generic context, and generator yield/return discovery now live in
   `semantic-function-contexts.zs`; statement traversal and final output
   initialization proofs remain in the resolver. Compiler-provided numeric
   literal, collection method, iterable projection, and throwing-generator
   behavior now lives in `semantic-intrinsics.zs`. Callable target identity and
   construction/deduplication of generic-call, inferred-binding, and
   root-expression evidence now live in `semantic-evidence.zs`; recursive
   inference still decides what evidence is authoritative in the resolver.
   Copy/move eligibility plus unary, arithmetic, bitwise, comparison, and
   equality result typing now live in `semantic-operators.zs`; short-circuit
   flow and actual ownership consumption remain in the resolver.
2. Extend native semantics from demonstrated corpus gaps, prioritizing
   foreign/intrinsic boundaries, escaping closure environments, precise borrow
   last-use release, receiver-path capabilities, and recursive ownership
   contexts. Do not port a feature merely for nominal completeness; add a
   realistic corpus case first.
3. Keep the completed version-1 structural phase API green. One owned native
   result handle supplies entry, module paths, dependency lists/order,
   symbols, every signature shape, and all call/binding/expression evidence.
   Bulk fixed-width base/item batches preserve generic constraints, fields,
   variants, trait conformance, capabilities, effects, source locations, and
   flattened nominal-identity paths. Success has no text payload; only resolver
   failures retain the temporary framed diagnostic payload. The host validates
   the API version, structural cardinalities, references, and owned-handle
   lifecycle before adopting the canonical graph directly. Preserve canonical
   module-local locations and the guarded Stage-0 fallback. Measure cold library
   preparation, warm native work/handoff, and Stage-0 parity separately.
4. Finish the native semantic subset required to compile the compiler itself.
   Broader language features may continue to fall back to Stage 0 until their
   native representation is justified by real programs.
5. Grow the now-started native lowering and C-family emitter from its first
   executable scalar, control-flow, and cleanup-free value-struct slices to the
   compiler subset. The explicit typed lowering IR is now implemented; extend
   it with deterministic scope-exit cleanup plans. Add constructs only with an
   end-to-end fixture. Continue to
   invoke Clang as an external tool; self-hosting does not require replacing it.
6. Move module loading, project driving, files/paths/processes, diagnostics, and
   command-line orchestration into the Z driver, then remove the corresponding
   TypeScript/Bun paths only after parity.
7. Build the compiler with Stage 0, use that native compiler to compile itself,
   and compare consecutive generations plus the complete test/corpus results.

The next self-hosting sprint should begin when duplicated Stage-0 semantics are
slowing language work, a new feature exposes a native corpus gap worth closing,
or the compiler subset has the collections and APIs needed for lowering. Direct
Swift ABI support, actors/channels, complete async executors, and unrelated
language breadth are not prerequisites. Until then, self-hosting proceeds
incrementally alongside language design rather than ahead of it.
