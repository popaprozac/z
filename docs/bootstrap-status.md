# Bootstrap implementation status

Last reviewed: 2026-07-21.

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
| Bindings, functions, inference | Implemented | Local inference; public/API contracts remain explicit |
| Structs and methods | Implemented | Value layout, mutation, static methods, deterministic cleanup |
| ARC classes | Implemented | Identity, sharing, constructors, private fields, weak references |
| Traits | Partial | Nominal static conformance and generic constraints; no trait values/dynamic dispatch |
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches, and tag equality for payload-free Z enums |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous cleanup-bearing error values |
| Closures | Implemented | Borrowed and owned ARC environments; weak captures |
| Strings and console | Implemented | Owned UTF-8 strings, exact byte equality, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`; grapheme-aware `length` remains planned |
| Integer safety | Implemented | Checked arithmetic plus explicit wrapping/saturating operations |
| Generators | Planned | `yield` is reserved; no generator lowering |
| `comptime` | Planned experiment | No compile-time execution model committed |

## Ownership and collections

| Area | Status | Current boundary |
| --- | --- | --- |
| Moves and deterministic `deinit` | Implemented | Flow-sensitive cleanup across return, throw, loops, and matches |
| `in` / `inout` / `out` | Implemented | Explicit declaration and mutable call-site capabilities |
| Unified loan checker | Implemented foundation | Call-, task-, receiver-view-, and Arena-region lifetimes share one root/capability/lifetime representation and conflict matrix; cross-thread loans remain to integrate |
| Fixed arrays | Implemented | Checked indexing and reverse element cleanup |
| `Array<T>` | Implemented | Growable owned storage and move-aware elements |
| `Slice<T>` | Partial | Non-escaping parameters plus direct-awaited and scope-bounded spawned borrowing from fixed and growable owners, including cleanup-bearing Z and move-only C++ elements; returned/stored and cross-thread Slices remain |
| Receiver-tied `view T` | Implemented narrow tier | Direct field/index projections and niche-backed `Option<view T>` lookups from synchronous value-struct methods; inferred const local, read-only, non-storable, synchronous `in T` forwarding and proven nonescaping inline capture, no class owners |
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
| Z source modules | Partial | Explicit exports, namespace/selective imports, aliases, cycle diagnostics; exported signatures containing selectively imported standard named types still need cross-module normalization |
| CLI | Implemented | `z check`, `z emit`, and `z run` through Bun; native run I/O streams live and arguments after `--` are forwarded |
| System standard APIs | Implemented foundation | Default `std/fs` and `std/process` modules; owned reads/arguments, borrowed writes/process argv, direct no-shell child launch, typed OS failures |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate; richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial frontend | Stage 0 remains TypeScript/Bun; native Z owns the lexer, current full parser arenas, module graph, function/type/method signatures, lexical/type lookup, and initial primitive/generic/cross-module-match/field/method expression typing with parity commands; ownership, complete semantics, lowering, code generation, and the CLI driver remain in stage 0 |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records and enums | Implemented | Complete supported layouts, nested records, constants |
| C pointers | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts; owned nullable `T *` results and `T **` outputs receive deterministic cleanup; nullable declared handles lift into niche-backed `Option`; owned handles with explicit transfer/destruction facts cross `thread.spawn`; internal toolchain notes remain |
| C callbacks | Partial | Call-only and caller-thread escaping callbacks use `.zd` with named context and exact release contracts; cross-thread callbacks remain unsupported |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Native library linkage | Implemented host slice | Validated, deduplicated `target.link.libraries` names become host-native library arguments; raw linker flags and cross-platform library resolution remain outside the project contract |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks and persistent observer tokens |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded spawned mutable async borrows, whole Z async value aggregates, fallible async results, and explicit native-thread transfer when `.zd` separately guarantees transfer and receiving-thread destruction; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, spawned output async borrows, ARC/closure storage, native sharing, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link |
| Swift value via C++ | Implemented probes | Native static construction, associated-value enum case factories, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, protocols, errors, async, packages; Swift 6.2 currently withholds noncopyable values and async functions from its generated C++ interface |

Current interop gaps that block a richer desktop application include
broader Objective-C block shapes, target/action adapters, protocol conformance,
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

- [`examples/applications/z-notes`](../examples/applications/z-notes): AppKit application
  shell, ARC-owned note model, optional selection, direct SQLite declaration
  import, and explicit `sqlite3` project linkage.
- [`examples/applications/document-workspace`](../examples/applications/document-workspace): cross-platform,
  multi-module document registration and saving with move-only native leases,
  cleanup-bearing errors, optional views, array growth, and zero live resources.
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
   return type, and error type through the native graph protocol. Ownership
   analysis remains stage-zero work. A first native lexical resolver
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
   nested types report the exact inner token location. Opaque expression spans,
   foreign namespace member verification, type-constructor generic arity, value
   member lookup, duplicate local diagnostics, type compatibility/conformance,
   and ownership remain stage-zero work.
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
   and extracted method values still defer. Z-defined instance and static calls now follow
   local/imported type metadata, enforce visibility and argument/result contracts,
   and substitute aggregate and method generics. Receiver capability state is
   retained but awaits the native ownership pass. Complete contextual literal and
   return-driven inference, foreign/intrinsic method lookup,
   generic constraints/methods, normalized cross-module type identities, match
   ownership/control-flow merging, capability enforcement, and flow/ownership
   state remain stage-zero work.
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
