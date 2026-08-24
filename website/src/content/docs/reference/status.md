---
title: Project status
description: What Z proves today and what remains experimental.
---

Z is pre-alpha. It has moved beyond a toy compiler, but it is not ready for
production or compatibility-sensitive use.

## Implemented and exercised

- TypeScript-shaped parsing, nominal static types, generics, enums, exhaustive
  matching, `Option<T>`, `Result<T, E>`, typed errors, and statically dispatched
  trait constraints that specialize across module-private boundaries
- Value structs, ARC-managed classes, weak references, explicit ownership
  capabilities, deterministic cleanup, and conservative non-escaping views
- Native C-family code generation through Clang
- Header-first C and Objective-C interop, substantial `.zd` contracts, and
  selected C++ values, methods, namespaces, RAII, and move-only resources
- A visible Zapp WebKit round trip whose executable `main`, consuming
  portable application builder, selected platform-module seam, UI ownership,
  protocol handler,
  dynamic `id` class narrowing, typed JSON routing, frozen Z service dispatch,
  generated TypeScript binding, and registration lifetime are implemented in Z
- Arrays, strings, maps, sets, filesystem/process primitives, synchronization,
  arenas, JSON foundations, and inline Z tests
- Structured tasks, cancellation, executor placement, dedicated native threads,
  `Mutex<T>`, and `Once<T>` across proven slices
- Stored synchronous callables and a first stored-async direct-await tier that
  preserve either `thread.main` isolation or arbitrary-thread `thread.any`
  sharing without scheduling implicitly. Native lowering now preserves the
  distinct asynchronous start-frame ABI through aggregate storage and executes
  captured, nonthrowing expression closures. Primitive and ownership-bearing
  results transfer exactly once; an unclaimed owned result is destroyed with
  its frame. A void closure containing one direct `await scheduler.yield()` now
  polls and requeues on a local FIFO executor. The first linear async `main`
  shape now owns its callable local, one ordinary local, and child invocation in
  a persistent heap frame. A cleanup-free local crosses as the child's single
  value argument; a cleanup-bearing owner crosses as an address-stable `in`
  borrow and remains guarded by frame live state. Both normal completion and
  unfinished-frame destruction clean that owner exactly once. Broader function
  bodies, multiple locals and arguments, and cancellation propagation remain in
  progress.
- Language-server highlighting, hover, completion, diagnostics, and `z.json`
  schema support
- A standalone native compiler capable of rebuilding its own constrained source
  graph to a fixed point
- Compiler API 2 and `z metadata`, exposing versioned checked public symbols and
  public call sites to tools without source scanning. Zapp derives typed service
  bindings from this artifact.

## Partial and still expanding

- Feature composition across every ownership, closure, async, and storage shape
- General suspension and thread-affine continuation behavior
- Library-scale C++ coverage and generated Swift/Objective-C compatibility
- The self-hosted compiler's authority over the complete language surface
- Standard-library breadth, diagnostics polish, compilation latency, and editor
  refactoring support
- Linux and Windows validation comparable to the project's macOS pressure tests
- Target-selected platform compilation with inactive-code-aware editor
  behavior; the manifest target is authoritative today, while source-level
  compile-time selection syntax remains deliberately unsettled

## Planned, not promised as current behavior

- A package manager, registry, lockfile, and compatibility policy
- Production release artifacts and a stable bootstrap chain
- Native Swift ABI interoperability, Swift value types, protocols, and concurrency
- ORC cycle collection, richer regions, and carefully bounded shape-stability or
  local-uniqueness analysis
- Fuzzing, sanitizer coverage, deterministic release engineering, debugger
  integration, and ecosystem-scale hardening

The repository's [bootstrap status](https://github.com/popaprozac/z/blob/main/docs/bootstrap-status.md)
is the source of truth for temporary implementation limits. The
[language reference](https://github.com/popaprozac/z/blob/main/docs/language-reference.md)
records accepted semantics independently of which bootstrap tiers execute every
shape today.
