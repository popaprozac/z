# Design checkpoint — 2026-07-19

This is a dated record of Z's thesis, evidence, open risks, and next validation
sequence. It is design history rather than a live implementation-status page.
For current compiler coverage, use [`bootstrap-status.md`](bootstrap-status.md).

## Working thesis

Z is an interop-first, memory-safe native language for application and platform
developers. Its source should feel familiar to TypeScript users without
inheriting JavaScript's runtime or semantic model. Its distinctive combination
is:

- direct, toolchain-derived C, Objective-C, C++, and eventually Swift interop;
- value ownership and inferred lexical borrowing with explicit boundary
  capabilities (`in`, `inout`, `out`, and `move`);
- deterministic native-resource cleanup plus opt-in ARC identity and `Weak<T>`;
- typed errors, exhaustive matching, owned closures, and structured async;
- readable C-family output now, with self-hosting as the long-term goal.

No single contemporary is the comparison. Rust and Zig set the native
performance and control bar; Swift is the closest application/platform-language
benchmark; Nim is the interop-ergonomics benchmark; Hylo is especially relevant
to the ownership and projection model; Odin, C3, Mojo, Carbon, and Vale each
exercise adjacent parts of the design space.

## Performance target

The target is a **ceiling near C, Rust, and Zig** for programs using comparable
storage and ownership shapes. This is not a promise that every safe abstraction
is free.

- Value structs, unique ownership, lexical borrows, borrowed slices, direct ABI
  calls, arenas, and explicit manual/unsafe escape hatches should admit
  allocation-free or zero-wrapper lowering where their semantics permit it.
- ARC/ORC classes deliberately pay for shared identity. That trade is comparable
  to a Rust program choosing `Rc`/`Arc`; it must not impose reference counting on
  ordinary Z values.
- Bounds checks, checked arithmetic, copying, retain/release traffic, closure
  environments, dynamic dispatch, and task-frame allocation all have real costs.
  Optimizers may remove some of them, but the language and documentation should
  identify rather than conceal them.
- Native-source generation and Clang make the target plausible, but do not prove
  it. The current debuggable `z run` profile is a correctness tool, not a
  benchmark configuration.

Performance claims should compare equivalent semantics: Z value ownership to
Rust/Zig/C value ownership, and Z ARC identity to an explicitly shared Rust or
Swift design. Release benchmarks must separately measure allocation,
retain/release traffic, bounds checks, native-call wrappers, task creation, and
cancellation cleanup. Generated C-family source remains inspectable evidence.

## What is already credible

- Header-derived C and Objective-C use is unusually direct for a project at this
  age, including ARC, blocks, AppKit, nullability, and editor information.
- C++ RAII values, move-only ownership, references, overloads, and generated
  Swift C++ compatibility values cross the boundary without inventing a second
  object model.
- The ownership model handles non-trivial application-shaped probes without
  source lifetime parameters, and the unified loan checker now covers call,
  task, receiver-view, and Arena-region lifetimes.
- Stackless async tasks, structured scopes, hot spawn, cancellation, scheduler
  delay, native ownership, and fixed-array-backed slices have executable
  lowering on the deterministic FIFO executor.
- Diagnostics, examples, editor support, and readable generated code are treated
  as part of the language rather than deferred polish.

## What remains unproven

- Soundness has strong executable evidence, not a formal proof or mature corpus.
- Non-escaping views may become an ergonomic wall in larger programs. Arena and
  region work must test that honestly before Z grows a broad lifetime language.
- The hardest Swift surfaces remain: noncopyable values, protocols, typed errors,
  async APIs, packages, and SDK-scale metadata. The installed Swift 6.2
  generated C++ interface explicitly withholds noncopyable values and async
  functions; that is now a tested toolchain gate rather than an unexamined item.
- The implemented `thread.spawn` slice proves a real cross-thread frame,
  structured join, private Copy snapshots, unique Array/String/TextBuffer owner
  transfer, and compiler-proven deeply readonly identity through atomic ARC.
  Mutable shared identity, concurrent weak upgrade, native sendability, and
  cross-thread callbacks may still force changes to isolation, cancellation,
  destruction-affinity, and executor assumptions.
- Interop breadth is not interop maturity. Swift and Nim remain far ahead in
  production coverage even where Z's intended source experience is compelling.
- The self-hosting boundary around Clang/Swift metadata and async lowering still
  needs a convincing Z-shaped interface.

## Reading the external reviews

The reviews correctly identified Z's strongest potential niche as an
interop-first safe native language, and correctly warned that familiar syntax
can postpone rather than remove systems-language surprises. They also correctly
prioritized real-program ownership pressure, hard Swift experiments,
cross-thread concurrency evidence, documentation separation, and an early
self-hosting boundary sketch.

Two qualifications matter. Z already has a real copyable Swift value slice
through the toolchain-generated C++ interface, so the next Swift test should be
a harder ownership or concurrency surface rather than repeating that result.
And Z is ahead for its age in some interop ergonomics, not ahead of mature
languages in total coverage. `comptime` also remains a deliberately small
planned experiment rather than a rejected direction.

## Upcoming validation sequence

1. Finish async `Slice<T>` backing for growable arrays and cleanup-bearing
   collections, including join, cancellation, and owner-loan safety.
2. Run an arena/region spike and study projection models such as Hylo's before
   widening `view` or introducing user-visible lifetime identities.
3. **Begun:** `thread.spawn` now proves explicit move capture, private Copy
   snapshots, moved Array/String/TextBuffer owners/results, explicitly
   contracted C/C++ owner transfer, deeply readonly atomic-ARC class sharing,
   live-state-aware owned `Task<T, E>` errors, and race-free nonblocking joins on
   one native thread. Extend that evidence through application-driven
   cross-thread callbacks, UI-thread delivery, weak-reference and
   destruction-affinity protocols, and mutable shared-state isolation before
   fixing pools or a multithreaded executor design. The intended placed-block
   capture spelling is contextual `using (in value, inout state, move owner)`:
   Copy snapshots may remain inferred, loans end only when the child actually
   joins, and spawned `out` remains deferred pending failure/cancellation rules.
4. **Probed:** Swift 6.2 does not expose noncopyable values or Swift async APIs
   through its generated C++ interface. Z records that gate and now imports a
   nearby Swift-only surface—associated-value enum case factories—directly.
   Re-probe the hard surfaces as Swift evolves; meanwhile advance protocols,
   errors, packages, and metadata through public interfaces and generated Swift
   bridge targets. Keep direct Swift ABI lowering as an explicit high-cost
   escalation path if real application pressure makes full compatibility urgent.
5. Scale the platform surface with API notes, Objective-C protocols,
   target/action adapters, runtime availability, and richer block shapes.
6. Continue the portable standard-library and self-hosting path, including a
   concrete Z-facing interface to Clang and Swift metadata.
7. Design and test a deliberately small `comptime` experiment only after the
   ownership, interop, and execution foundations above provide real use cases.
8. Add a first-class `z test` workflow once function-body parsing and module
   discovery are stable. The intended surface includes Z-native test
   declarations, file/module discovery, name filtering, clear source-located
   failures, deterministic execution by default, and explicit support for
   native/interop fixtures. This should be a language-aware runner rather than
   only an alias for the compiler's existing Bun regression suite.

## Immediate application sequence

Before the next application probe, audit the public type vocabulary and editor
presentation as one hygiene pass: primitive casing and widths, platform-sized
integers, owned versus borrowed text, nullable native references, collection
names, task/result/option shapes, and suppression of generated implementation
names. This is a consistency gate, not an invitation to redesign stable names
without evidence.

The first native **Z Notes** AppKit skeleton now contains an `NSApplication`,
`NSWindow`, a Z-owned notes model, optional selection, direct `sqlite3.h`
import, and explicit native-library linkage. Its adjacent `.zd` contract now
classifies the owned nullable SQLite handle produced through `sqlite3 **` and
closes it deterministically without a handwritten wrapper. Grow the app only along
pressure seams: Objective-C protocol conformance, delegates/data sources,
target/action, escaping block lifetime, background search through
`thread.spawn`, `Task<T, E>` loading and saving, cancellation, UI-thread
delivery, and optionally a Swift-only helper. The application is an executable
composition test, not a parallel framework project.

Once that skeleton exposes its first concrete language boundaries, begin the
incremental self-hosting frontend track: Z lexer under the TypeScript driver,
then parser, module resolver/diagnostics, semantic analysis, C emission, and
finally the CLI driver. Clang and Swift metadata ingestion remain external
toolchain services behind a Z-shaped interface rather than self-hosting goals.

The sequence is evidence-driven. If a non-trivial Z program, arena spike,
cross-thread boundary, hard Swift value, or like-for-like benchmark contradicts
the thesis, the design should change before surface area makes it expensive to
do so.
