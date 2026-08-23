---
title: Project status
description: What Z proves today and what remains experimental.
---

Z is pre-alpha. It has moved beyond a toy compiler, but it is not ready for
production or compatibility-sensitive use.

## Implemented and exercised

- TypeScript-shaped parsing, nominal static types, generics, enums, exhaustive
  matching, `Option<T>`, `Result<T, E>`, and typed errors
- Value structs, ARC-managed classes, weak references, explicit ownership
  capabilities, deterministic cleanup, and conservative non-escaping views
- Native C-family code generation through Clang
- Header-first C and Objective-C interop, substantial `.zd` contracts, and
  selected C++ values, methods, namespaces, RAII, and move-only resources
- A visible Zapp WebKit round trip whose executable `main`, consuming
  application builder, UI ownership, protocol handler,
  dynamic `id` class narrowing, typed JSON routing, frozen Z service dispatch,
  generated TypeScript binding, and registration lifetime are implemented in Z
- Arrays, strings, maps, sets, filesystem/process primitives, synchronization,
  arenas, JSON foundations, and inline Z tests
- Structured tasks, cancellation, executor placement, dedicated native threads,
  `Mutex<T>`, and `Once<T>` across proven slices
- Language-server highlighting, hover, completion, diagnostics, and `z.json`
  schema support
- A standalone native compiler capable of rebuilding its own constrained source
  graph to a fixed point

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
