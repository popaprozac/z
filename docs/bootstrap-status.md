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
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate; richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, completion, hover, and Z/native definitions |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Planned | Stage 0 remains TypeScript/Bun; file/process APIs and sufficient Z surface come first |

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records and enums | Implemented | Complete supported layouts, nested records, constants |
| C pointers | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts; nullable declared handles lift into niche-backed `Option`; internal toolchain notes remain |
| C callbacks | Partial | Call-only and caller-thread escaping callbacks use `.zd` with named context and exact release contracts; cross-thread callbacks remain unsupported |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, labels, nullability, niche-backed `Option.fromNullable`, owned `String`/`NSString` copies, escaping blocks and persistent observer tokens |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; named `const T&`/`T&`/move-only `T&&` parameters and `const &`/`&`/move-only `&&` methods map to `in`/`inout`/owned capabilities and direct native lowering; reference returns, copyable rvalue references, capability-changing argument/receiver overload sets, richer storage, and templates remain |
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
- [`examples/interop/cpp/cpp-references.z`](../examples/interop/cpp/cpp-references.z): C++ named-value
  references and receiver qualifiers mapped onto existing Z `in`, `inout`, and
  owned-transfer semantics with direct lvalue/`std::move` lowering.
- `bun test`: compiler, runtime, diagnostics, interop, async, and editor
  regression suite.

## Near-term validation order

1. Split and maintain tutorial, semantics, rationale, and bootstrap status
   documents (this structure is now in place).
2. Extend the backend-neutral Foreign Interface IR now that raw declarations,
   API-note sources, normalized contracts, native definitions, availability,
   deployment-target checks, value-lifecycle facts, and C++ constructors/static/
   instance methods, named-value references, receiver qualifiers, and move-only
   native value facts are separate; next pressure should come from richer native
   declaration shapes and storage contexts.
3. Extend the desktop probe through one real native event callback into owned Z
   state (one-shot and persistent notification paths are now validated).
4. Expand receiver-tied views only from real pressure: the value-struct tier is
   implemented; optional results, parameter provenance, stable/class-owned
   storage, and regions remain evidence-driven experiments.
5. Keep actors, channels, multithreaded executors, and atomic ARC provisional
   until sendability and cross-thread frame probes provide evidence.
