# Bootstrap implementation status

Last reviewed: 2026-07-18.

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
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt` |
| Closures | Implemented | Borrowed and owned ARC environments; weak captures |
| Strings and console | Implemented | Owned UTF-8 strings, templates, typed formatting |
| Integer safety | Implemented | Checked arithmetic plus explicit wrapping/saturating operations |
| Generators | Planned | `yield` is reserved; no generator lowering |
| `comptime` | Planned experiment | No compile-time execution model committed |

## Ownership and collections

| Area | Status | Current boundary |
| --- | --- | --- |
| Moves and deterministic `deinit` | Implemented | Flow-sensitive cleanup across return, throw, loops, and matches |
| `in` / `inout` / `out` | Implemented | Explicit declaration and mutable call-site capabilities |
| Fixed arrays | Implemented | Checked indexing and reverse element cleanup |
| `Array<T>` | Implemented | Growable owned storage and move-aware elements |
| `Slice<T>` | Partial | Parameter-only, non-escaping lexical views |
| Receiver-tied `view T` | Implemented narrow tier | Direct field/index projections from synchronous value-struct methods; inferred const local, read-only, non-storable, non-forwardable, no class owners |
| General returned/stored borrows | Planned | Parameter provenance, optional views, class alias safety, and retained views remain open |
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
| CLI | Implemented | `z check`, `z emit`, and `z run` through Bun; native run I/O streams live |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Foreign Interface IR | Implemented foundation | Raw producer declarations are separate from API-note parsing/merge and normalized contracts; source locations and richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, local/import completion, hover, Z definitions |
| Native definitions | Planned | Header source-location metadata is not yet exposed to go-to-definition |
| Self-hosting | Planned | Stage 0 remains TypeScript/Bun; file/process APIs and sufficient Z surface come first |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records and enums | Implemented | Complete supported layouts, nested records, constants |
| C pointers | Partial | Safe opaque handles and record borrows require API notes |
| C callbacks | Partial | Call-only and caller-thread escaping callbacks with exact release contracts |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks and persistent observer tokens |
| C++ | Partial | Namespace free functions, plain records, first opaque copyable RAII values |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link |
| Swift value via C++ | Implemented probe | Native struct return/copy/round-trip/destruction without handwritten shim |
| Swift methods/strings/generics | Planned vertical slices | Generated C++ methods, `swift::String`, protocols, errors, async, packages |

Current interop gaps that block a richer desktop application include
broader Objective-C block shapes, target/action adapters, protocol conformance,
cross-thread callbacks, availability, and API notes at SDK scale. General
`T | null`/`Option<T>` representation unification remains language
foundation work; Objective-C reference options now have the first one-pointer
niche-backed specialization and explicit conversion bridge.

The Swift owned-value probe is intentionally honest about the toolchain: current
generated wrappers copy and deterministically destroy Swift values, but delete
C++ move construction. Z therefore treats this as copyable foreign RAII, not as
native Swift move support.

## Async and concurrency

| Area | Status | Current boundary |
| --- | --- | --- |
| Async syntax and typing | Implemented | Functions/methods, `await`, `spawn`, task scopes, typed errors |
| Stackless task frames | Partial | Scalars, aggregates, owned structs/enums/classes across suspension |
| Executor | Implemented bootstrap | Deterministic single-thread FIFO ready queue |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation on propagation |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Sync work in async frames | Partial | Z calls/methods, console, checked arithmetic, concise matches |
| Embedded awaits | Partial | Left-to-right cleanup-free values and awaited conditions |
| Lazy/suspending expressions | Planned | `&&`, `||`, ternaries, value `if`, suspending match arms, owned hidden results |
| Channels, actors, executors | Planned direction | API and sendability remain intentionally unsettled |
| CPU parallelism | Planned | Requires sendability, atomic ARC, and multithreaded executors |

See [`async-model.md`](async-model.md) for the intended model and phase details.

## Validation probes

- [`examples/nswindow.z`](../examples/nswindow.z): direct AppKit window.
- [`examples/objc-nullability.z`](../examples/objc-nullability.z): explicit
  `T | null` AppKit guard narrowing alongside `Option.fromNullable` and
  `some`/`none` matching.
- [`examples/desktop-ownership`](../examples/desktop-ownership): ARC application
  model plus move-only owned documents and AppKit shell.
- [`examples/ownership-views.z`](../examples/ownership-views.z): zero-copy scoped
  lookup compared with an independently owned document snapshot.
- [`examples/appkit-events.z`](../examples/appkit-events.z): persistent native
  notification callbacks, weak Z capture, imported notification constants, and
  explicit observer-token removal.
- [`examples/swift-interop`](../examples/swift-interop): Swift class through its
  generated Objective-C compatibility header.
- [`examples/swift-value-interop`](../examples/swift-value-interop): Swift-native
  owned value through its generated C++ compatibility header.
- `bun test`: compiler, runtime, diagnostics, interop, async, and editor
  regression suite.

## Near-term validation order

1. Split and maintain tutorial, semantics, rationale, and bootstrap status
   documents (this structure is now in place).
2. Extend the backend-neutral Foreign Interface IR now that raw Clang
   declarations, API-note sources, and validated contracts are separate; native
   source locations and availability metadata are the next tooling layer.
3. Extend the desktop probe through one real native event callback into owned Z
   state (one-shot and persistent notification paths are now validated).
4. Expand receiver-tied views only from real pressure: the value-struct tier is
   implemented; optional results, parameter provenance, stable/class-owned
   storage, and regions remain evidence-driven experiments.
5. Keep actors, channels, multithreaded executors, and atomic ARC provisional
   until sendability and cross-thread frame probes provide evidence.
