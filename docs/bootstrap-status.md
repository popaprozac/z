# Bootstrap implementation status

Last reviewed: 2026-07-23.

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
| Traits | Partial | Nominal static conformance and generic constraints; no trait values/dynamic dispatch |
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches, and tag equality for payload-free Z enums |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous cleanup-bearing error values |
| Closures | Partial | Borrowed and owned ARC environments plus weak captures; mutation of ordinary captured bindings works, while preserving addressable move-only resource capabilities such as `TextBuffer` through a borrowed closure remains |
| Strings and console | Implemented | Owned UTF-8 strings, exact byte equality, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`; grapheme-aware `length` remains planned |
| Integer safety | Implemented | Checked arithmetic, explicit wrapping/saturating operations, and `TargetInteger(value)` construction that lowers range-contained pairs directly and checks narrowing/signedness-risk pairs; lossy and floating-point conversions remain |
| Generators | Planned | `yield` is reserved; no generator lowering |
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
| `Slice<T>` | Partial | Non-escaping parameters plus direct-awaited and scope-bounded spawned borrowing from fixed and growable owners, including cleanup-bearing Z and move-only C++ elements; returned/stored and cross-thread Slices remain |
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
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions; `copy`/`move` incompatibilities diagnose live and keyword hover explains inferred type, capability source, copy cost, and source invalidation; broader incomplete-pattern recovery remains |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial frontend | Stage 0 remains TypeScript/Bun; native Z owns the lexer, current full parser arenas, module graph, function/type/method signatures, lexical/type lookup, initial primitive/generic/cross-module-match/field/method expression typing, and the first definite-initialization/ownership flow tier with parity commands; complete semantics, lowering, code generation, and the CLI driver remain in stage 0 |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records and enums | Implemented | Complete supported layouts, nested records, constants |
| C macros | Implemented literal slice | Active object-like integer-literal macros defined by the imported header receive target-correct scalar types, namespace/selective imports, direct native emission, completion, hover, and definitions; function-like, string, alias, and expression macros remain |
| C pointers and statuses | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts; owned nullable `T *` results and `T **` outputs receive deterministic cleanup and expose source-nameable namespace types such as `sqlite.sqlite3`; those owners may persist in ARC class fields and close at final release; `void throws _ { success N; }` projects integer statuses into allocation-free typed errors and activates owned outputs before propagation; null-only parameters safely hide unsupported pointer values; nullable `view cstring` results borrow their single pointer input and copy into owned `String`; fixed native sentinel parameters preserve the verified ABI while disappearing from safe Z calls; nullable declared handles lift into niche-backed `Option`; owned handles with explicit transfer/destruction facts cross `thread.spawn`; general pointer/view contracts and internal toolchain notes remain |
| C callbacks | Partial | Call-only and caller-thread escaping callbacks use `.zd` with named context and exact release contracts; cross-thread callbacks remain unsupported |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Native library linkage | Implemented host slice | Validated, deduplicated `target.link.libraries` names become host-native library arguments; raw linker flags and cross-platform library resolution remain outside the project contract |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, imported property ownership (`weak`/`strong`/`copy`/`assign`), labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks, persistent observer tokens, lifetime-safe `std/objc` target/action connections, and checked Z-class protocol adapters with owned weak-property bindings |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded spawned mutable async borrows, whole Z async value aggregates, fallible async results, and explicit native-thread transfer when `.zd` separately guarantees transfer and receiving-thread destruction; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, spawned output async borrows, ARC/closure storage, native sharing, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link |
| Swift value via C++ | Implemented probes | Native static construction, associated-value enum case factories, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, protocols, errors, async, packages; Swift 6.2 currently withholds noncopyable values and async functions from its generated C++ interface |

Current interop gaps that block a richer desktop application include
broader Objective-C block shapes, inherited/generic protocol edge cases,
cross-thread callbacks, runtime availability guards, cross-compilation, and API
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
| Async syntax and typing | Implemented | Functions/methods, `await`, `spawn`, task scopes, typed errors, and `on thread.main` / `await on thread.main` / `spawn on thread.main` placement blocks |
| Stackless task frames | Partial | Scalars, owned String/TextBuffer, cleanup-bearing fixed arrays, growable arrays, copied Slice descriptors, owned structs/enums/classes, direct move-only C++ locals and parameters, collection elements containing them, cleanup-free direct-awaited output, and fallible native result transfer through `try`/`attempt`/match across suspension |
| Executor | Implemented bootstrap | Deterministic single-thread FIFO ready queue |
| Explicit native threads | Implemented narrow tier | `thread.spawn` starts one OS thread for a synchronous one-shot closure; `move` is required when capturing; plain values copy, unique Array/String/TextBuffer owners and explicitly contracted C/C++ native owners move, and deeply readonly classes share through atomic ARC; `(): T throws E` produces `Task<T, E>` with live-state-aware owned errors plus bound/direct `try` and local `attempt`; await, cancellation, and implicit scope exit suspend through a race-free executor completion queue before joining; native `share` remains deferred |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation, shared immutable and exclusive mutable child borrows (including fixed- and growable-collection-backed Slice), plus path-sensitive early release across straight-line code and `if` branches; loops remain conservative to scope exit |
| Caller cancellation | Implemented slice | Consuming `await task.cancel()` requests cancellation, joins descendants and cleanup, and discards an unclaimed completed outcome |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Sync work in async frames | Partial | Z and supported direct native calls/methods, console, checked arithmetic, concise matches |
| Embedded awaits | Partial | Left-to-right cleanup-free values and awaited conditions |
| Lazy/suspending expressions | Planned | `&&`, `||`, ternaries, value `if`, suspending match arms, owned hidden results |
| Executor placement | Implemented ownership-aware runtime tier | `thread.main` is typed; synchronous proof, hop-and-wait, and structured children execute with plain copied values, owned String copies, retained Z ARC classes, and ARC-retained Objective-C identity from the owning async task. Native workers publish without blocking main; Darwin installs and wakes a CFRunLoop source. Mutable/borrowed/native-affine captures, foreign affinity declarations, Windows message-loop integration, and Linux toolkit adapters remain |
| Channels and actors | Planned direction | API, isolation, and sendability remain intentionally unsettled |
| CPU parallelism | Partial evidence | One explicit native thread can execute Copy-value or uniquely owned Array/String/TextBuffer work in parallel without blocking unrelated FIFO tasks or timers; pools, general sendability, mutable shared-state isolation, and multithreaded executors remain planned |

See [`async-model.md`](async-model.md) for the intended model and phase details.

## Validation probes

- [`examples/applications/z-notes`](../examples/applications/z-notes): persistent
  AppKit application, ARC-owned note model, optional selection, direct SQLite
  declaration import, owned database/statement cleanup, borrowed native text
  views, explicit `sqlite3` linkage, and `std/objc` target/action.
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
- [`examples/applications/source-inspector`](../examples/applications/source-inspector): readable clients and smoke tests for the native frontend, including the
  standalone lexer/parser protocol executables.
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
  scoped spawn, and cancellation, followed by safe growth and reverse cleanup.
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
   parameters work through direct await and explicit-scope spawn. Mutable
   `inout` parameters work through direct await and exclusive explicit-scope
   spawn. Fixed and growable async collection owners, including move-only native
   elements, now provide Slice backing with reverse cleanup on completion and
   cancellation; a live spawned loan prevents reallocation until join. Cleanup-free
   `out` works through direct await. Spawned output,
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
   classes, traits, and enums. `z self-host-parse` checks exact declaration kind,
   name, export/async state, order, and location parity against stage 0 across an
   adversarial fixture plus the lexer and parser sources themselves. Complete
   import nodes retain default namespace bindings or selective imported/local
   names, alias source locations, and module headers with exact parity, providing
   the first structural input for a native module resolver. Complete top-level
   function signatures retain generics and constraints, receiver and
   parameter capabilities, nested canonical types, return types, and `throws`.
   Structs/classes now retain generic constraints, implemented traits, visible
   and readonly fields, throwing constructors, static/async/receiver methods,
   and `deinit`; trait methods and enum payload variants are structural too.
   Canonical type-shape parity covers the complete declaration layer. Top-level
   function bodies now retain owned `const`/`let`, `return`, expression-statement,
   and recursively nested block nodes. Primary and postfix expressions are now
   real flat arenas covering identifiers, scalar literals, parentheses, arrays,
   objects, calls, member access, and indexes. Prefix unary operators, the full
   current binary-precedence table, and right-nested ternaries use the same
   representation. `new`, `weak`, `try`, `attempt`, direct `await`, and direct
   `spawn` retain their distinct grammar and node kinds too. Nodes retain values,
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
   tasks, function signatures, and materialized `Result` payloads. Arguments of
   user-defined generic monomorphs retain the stage-zero fallback because their
   source substitutions are not preserved directly after materialization.
   Settled root expressions now export their own source-located evidence stream.
   Each record carries the inferred source type plus recursive nominal identity
   paths, and `NativeSemanticIndex` keys it by canonical module and expression
   offset. The semantic bridge accepts a native expression result only when its
   location, concrete type, and every declaration identity match the linked
   Stage-0 expression. Generated, opaque, foreign, async, and otherwise absent
   roots continue through the Stage-0 fallback. Ordinary native checks report
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
   bodies may call only methods supplied by their declared traits. Foreign/intrinsic
   method lookup, generic trait declarations, async/foreign call effects,
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
   Statement and expression `match` forms share a flat match-expression tree.
   Subject and arm edges, `in` mode, payload bindings, object-field destructuring,
   aliases, source locations, and each arm's statement body are structural.
   `async scope` statements retain their required block edge, preserving the
   lexical child-lifetime and implicit-join boundary for later native analysis.
   Value-producing `if` expressions retain condition, then-value-block, and
   else-value-block/if-expression edges. Their branch statements use the shared
   statement arena, preserving local declarations and explicit `select` nodes.
   Executor-placement expressions retain sync/await/spawn mode, a distinct
   source-located `on` marker, the executor expression root, optional success and
   error types, and the placed body. This leaves a structural insertion point for
   the planned contextual `using` capture clause.
   Contextual keywords are accepted as member names after `.` just as they are
   by stage 0. Unicode identifiers remain future lexer work.
   Exact lexer and parser parity now covers UTF-16 locations after BMP and
   supplementary Unicode text without giving up byte-oriented native slicing.
5. **Threaded concurrency evidence — Copy, unique-owner, native-owner, readonly ARC, and owned-error slices implemented.**
   `thread.spawn` now proves one real cross-thread task frame with explicit
   move capture, hot start, structured join, private Copy snapshots, and moved
   Array/String/TextBuffer owners/results, explicitly contracted C/C++ owners,
   plus atomic-ARC deeply readonly class identity, live-state-aware owned error
   transfer through `Task<T, E>`, and nonblocking executor completion. The next
   concurrency probes should be driven by the desktop application: cross-thread
   callbacks, UI-thread delivery, weak-reference and destruction-affinity
   protocols, and mutable shared-state isolation. Do not commit actors,
   channels, pools, or a multithreaded executor as settled language design yet.

## Self-hosting resume point

Self-hosting is intentionally paused at a stable semantic-authority checkpoint,
not declared complete. Native Z owns lexing, structural parsing, module-graph
resolution, a substantial semantic subset, structured diagnostics for that
subset, and the evidence consumed by ordinary `check --native-frontend` runs.
The representative corpus gate must remain green as language work continues.

When focused self-hosting work resumes, use this order:

1. Extend native semantics from demonstrated corpus gaps, prioritizing
   user-defined generic-monomorph identities, foreign/intrinsic and async effect
   boundaries, escaping closure environments, precise borrow last-use release,
   receiver-path capabilities, and recursive ownership contexts. Do not port a
   feature merely for nominal completeness; add a realistic corpus case first.
2. Replace the temporary text protocol with a structural in-process phase
   handoff. Preserve canonical module-local source locations and the guarded
   Stage-0 fallback while doing so. Measure cold library preparation, warm native
   work, protocol/handoff cost, and Stage-0 parity separately.
3. Finish the native semantic subset required to compile the compiler itself.
   Broader language features may continue to fall back to Stage 0 until their
   native representation is justified by real programs.
4. Port lowering and the C-family emitter for that compiler subset. Continue to
   invoke Clang as an external tool; self-hosting does not require replacing it.
5. Move module loading, project driving, files/paths/processes, diagnostics, and
   command-line orchestration into the Z driver, then remove the corresponding
   TypeScript/Bun paths only after parity.
6. Build the compiler with Stage 0, use that native compiler to compile itself,
   and compare consecutive generations plus the complete test/corpus results.

The next self-hosting sprint should begin when duplicated Stage-0 semantics are
slowing language work, a new feature exposes a native corpus gap worth closing,
or the compiler subset has the collections and APIs needed for lowering. Direct
Swift ABI support, actors/channels, complete async executors, and unrelated
language breadth are not prerequisites. Until then, self-hosting proceeds
incrementally alongside language design rather than ahead of it.
