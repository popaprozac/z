# Bootstrap implementation status

Last reviewed: 2026-07-19.

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
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous cleanup-bearing error values |
| Closures | Implemented | Borrowed and owned ARC environments; weak captures |
| Strings and console | Implemented | Owned UTF-8 strings, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`; grapheme-aware `length` remains planned |
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
| Z source modules | Implemented | Explicit exports, namespace/selective imports, aliases, cycle diagnostics |
| CLI | Implemented | `z check`, `z emit`, and `z run` through Bun; native run I/O streams live and arguments after `--` are forwarded |
| System standard APIs | Implemented foundation | Default `std/fs` and `std/process` modules; owned reads/arguments, borrowed writes/process argv, direct no-shell child launch, typed OS failures |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate; richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial groundwork | Stage 0 remains TypeScript/Bun; file/process/argv contracts now run through a generated native substrate, while portable stdlib and compiler phases have not yet moved to Z |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records and enums | Implemented | Complete supported layouts, nested records, constants |
| C pointers | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts; nullable declared handles lift into niche-backed `Option`; internal toolchain notes remain |
| C callbacks | Partial | Call-only and caller-thread escaping callbacks use `.zd` with named context and exact release contracts; cross-thread callbacks remain unsupported |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks and persistent observer tokens |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded spawned mutable async borrows, whole Z async value aggregates, and fallible async results through `try`/`attempt`/match; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, spawned output async borrows, ARC/closure storage, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link |
| Swift value via C++ | Implemented probe | Native static construction, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, noncopyable values, protocols, errors, async, packages |

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
native Swift move support. Generated static and instance scalar methods are now
called directly; this does not yet imply Swift property, string-input, generic,
protocol, error, async, or package support. `swift::String` returns have one
explicit conversion: an annotated Z `String` destination receives a fresh owned
UTF-8 copy, including embedded NUL bytes. Swift `String` inputs remain rejected
until the boundary is length-aware in both directions.

## Async and concurrency

| Area | Status | Current boundary |
| --- | --- | --- |
| Async syntax and typing | Implemented | Functions/methods, `await`, `spawn`, task scopes, typed errors |
| Stackless task frames | Partial | Scalars, owned String/TextBuffer, cleanup-bearing fixed arrays, growable arrays, copied Slice descriptors, owned structs/enums/classes, direct move-only C++ locals and parameters, collection elements containing them, cleanup-free direct-awaited output, and fallible native result transfer through `try`/`attempt`/match across suspension |
| Executor | Implemented bootstrap | Deterministic single-thread FIFO ready queue |
| Explicit native threads | Implemented narrow tier | `thread.spawn` starts one OS thread for a synchronous one-shot closure; `move` is required when capturing; plain values copy, unique Array/String/TextBuffer owners move, and deeply readonly classes share through atomic ARC; await and implicit scope exit join |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation, shared immutable and exclusive mutable child borrows (including fixed- and growable-collection-backed Slice), plus path-sensitive early release across straight-line code and `if` branches; loops remain conservative to scope exit |
| Caller cancellation | Implemented slice | Consuming `await task.cancel()` requests cancellation, joins descendants and cleanup, and discards an unclaimed completed outcome |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Sync work in async frames | Partial | Z and direct C++ calls/methods, console, checked arithmetic, concise matches |
| Embedded awaits | Partial | Left-to-right cleanup-free values and awaited conditions |
| Lazy/suspending expressions | Planned | `&&`, `||`, ternaries, value `if`, suspending match arms, owned hidden results |
| Channels, actors, executors | Planned direction | API and sendability remain intentionally unsettled |
| CPU parallelism | Partial evidence | One explicit native thread can execute Copy-value or uniquely owned Array/String/TextBuffer work in parallel; pools, general sendability, atomic ARC, nonblocking joins, and multithreaded executors remain planned |

See [`async-model.md`](async-model.md) for the intended model and phase details.

## Validation probes

- [`examples/applications/document-workspace`](../examples/applications/document-workspace): cross-platform,
  multi-module document registration and saving with move-only native leases,
  cleanup-bearing errors, optional views, array growth, and zero live resources.
- [`examples/applications/source-stager`](../examples/applications/source-stager): reads a requested Z
  source file, writes a staged copy, observes native argv, and launches Clang
  directly through the first self-hosting standard APIs.
- [`examples/applications/source-inspector`](../examples/applications/source-inspector): tokenizes real Z
  source with owned tokens, checked UTF-8 byte operations, typed lexer errors,
  and `std/text` `TextBuffer` escape decoding.
- [`examples/interop/objc/nswindow.z`](../examples/interop/objc/nswindow.z): direct AppKit window.
- [`examples/interop/objc/objc-nullability.z`](../examples/interop/objc/objc-nullability.z): explicit
  `T | null` AppKit guard narrowing alongside `Option.fromNullable` and
  `some`/`none` matching.
- [`examples/interop/objc/desktop-ownership`](../examples/interop/objc/desktop-ownership): ARC application
  model plus move-only owned documents and AppKit shell.
- [`examples/interop/objc/desktop-ownership/ownership-views.z`](../examples/interop/objc/desktop-ownership/ownership-views.z): zero-copy scoped
  lookup compared with an independently owned document snapshot.
- [`examples/interop/objc/appkit-events.z`](../examples/interop/objc/appkit-events.z): persistent native
  notification callbacks, weak Z capture, imported notification constants, and
  explicit observer-token removal.
- [`examples/interop/swift/swift-interop`](../examples/interop/swift/swift-interop): Swift class through its
  generated Objective-C compatibility header.
- [`examples/interop/swift/swift-value-interop`](../examples/interop/swift/swift-value-interop): Swift-native
  owned value constructed and called directly, then stored in a Z aggregate,
  through its generated C++ compatibility header.
- [`examples/interop/cpp/foreign-values.z`](../examples/interop/cpp/foreign-values.z): `.zd`-contracted
  copyable C++ RAII value copied through an owning Z aggregate with zero live
  native values after scope exit.
- [`examples/interop/cpp/cpp-move-only.z`](../examples/interop/cpp/cpp-move-only.z): `.zd`-contracted
  non-copyable C++ RAII value borrowed, moved through an owned function and a Z
  value struct, then deterministically released with zero live native values.
- [`examples/interop/cpp/cpp-move-only-array.z`](../examples/interop/cpp/cpp-move-only-array.z): move-only
  native values stored in a growable array, relocated through native move
  construction, and destroyed in reverse order, including a mixed `String`
  aggregate.
- [`examples/interop/cpp/cpp-move-only-enum.z`](../examples/interop/cpp/cpp-move-only-enum.z): named
  enum payloads borrowed or consumed through `match`, replaced safely, and
  deterministically destroyed.
- [`examples/interop/cpp/cpp-arena.z`](../examples/interop/cpp/cpp-arena.z): move-only C++
  values transferred into stable arena storage and destructed by reset.
- [`examples/interop/cpp/cpp-references.z`](../examples/interop/cpp/cpp-references.z): C++ named-value
  references and receiver qualifiers mapped onto existing Z `in`, `inout`, and
  owned-transfer semantics with direct lvalue/`std::move` lowering.
- [`examples/async/async-native-ownership.z`](../examples/async/async-native-ownership.z): a move-only
  C++ value constructed directly in aligned task-frame storage, returned and
  relayed through task results, consumed by its caller, and cleaned exactly once.
- [`examples/async/async-collection-slices.z`](../examples/async/async-collection-slices.z): growable
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
4. **Self-hosting prerequisites — first substrate plus source-tokenizing slice implemented.**
   Target-neutral `std/fs`, `std/process`, and owned program-argument APIs run on
   macOS and have Windows/POSIX native branches. Checked String byte operations
   and `std/text` `TextBuffer` now support a multi-module Z source inspector with
   UTF-8 boundary-preserving token copies, escape decoding, source locations,
   and typed lexer errors. A production lexer still needs complete token grammar,
   Unicode identifiers, template interpolation, and compiler data structures.
5. **Threaded concurrency evidence — Copy, unique-owner, and readonly ARC slices implemented.**
   `thread.spawn` now proves one real cross-thread task frame with explicit
   move capture, hot start, structured join, private Copy snapshots, and moved
   Array/String/TextBuffer owners/results plus atomic-ARC deeply readonly class
   identity. Next probe broader cleanup-bearing sendability, weak-reference and
   destruction-affinity protocols, mutable shared-state isolation,
   nonblocking executor integration, and a cross-thread callback before
   committing actors, channels, pools, or a multithreaded executor as settled
   language design.
