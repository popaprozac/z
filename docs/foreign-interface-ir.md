# Foreign Interface IR

The Foreign Interface IR (FIIR) is the normalized contract between native API
metadata producers and the Z semantic checker. It prevents Clang AST details,
Swift interface details, API-note storage, or a stage-0 JSON shape from leaking
through the compiler.

```text
Clang AST ────────────────> raw declarations ─┐
Swift/package adapters ───> raw declarations ─┼─> contract normalization ─> FIIR ─> Z sema/backend
API-note sources ─────────> semantic facts ───┘
```

The boundary is implemented across three focused modules:

- [`foreign-ir.ts`](../compiler/src/foreign-ir.ts) owns raw producer declarations
  and normalized FIIR contracts;
- [`foreign-api-notes.ts`](../compiler/src/foreign-api-notes.ts) parses, validates,
  merges, and tracks the freshness of stage-0 API-note sources;
- [`foreign-contracts.ts`](../compiler/src/foreign-contracts.ts) combines raw
  declarations with semantic facts and rejects incoherent boundaries.

The Clang walk now emits native namespace paths and complete overload candidates,
including each candidate's native spelling, canonical type spellings, parameter
order, declaration location, and availability facts before ownership metadata is
read. Contract normalization maps every overload independently; FIIR never
models an overload set as one signature plus a list of names.
Only the normalized result is attached to `ForeignModule` and exposed to generic
inference, semantic analysis, code generation, and the language server.

## What FIIR owns

FIIR describes facts the rest of the compiler needs:

- modules, functions, parameters, constants, records, enums, scalar aliases,
  opaque native values, Objective-C objects/interfaces, and callbacks;
- both Z-facing type identity and native declaration spelling;
- hierarchical native namespace identity for functions and named types,
  unambiguous short aliases, and full callable overload sets;
- native source locations and platform availability on functions, types,
  constants, Objective-C interfaces, methods, and properties;
- constant provenance distinguishing enum members, native variables, and
  object-like integer macros while retaining the original native token;
- nullability and owned, borrowed, or consuming pointer contracts;
- non-escaping record access (`in`, `out`, `inout`);
- callback and Objective-C block lifetime, context, release, and threading
  contracts;
- native language/backend requirements such as Objective-C ARC or C++.

Unsupported native types remain explicit IR nodes. The importer does not invent
a safe Z type because a declaration happens to parse.

## What FIIR does not own

- Clang or Swift compiler AST nodes;
- Z parser nodes, source import declarations, or diagnostics presentation;
- a frozen `.json` wire format;
- native layout re-declarations—the original toolchain interface remains the ABI
  authority;
- backend lowering decisions such as retain insertion or C expression syntax;
- guessed ownership, nullability, callback escape, or async contracts.

The current `ForeignModule` wrapper still pairs `ForeignModuleIR` with the Z
source import declaration for diagnostics. That source attachment belongs to
the frontend adapter, not to FIIR itself.

## Producers

### Clang declarations

The current producer reads C, Objective-C, C++, and generated Swift compatibility
headers through Clang. It produces `ForeignModuleDeclarations` while preserving
the native spelling, source location, and availability used by generated source.
Clang's elided repeated filenames are hydrated inside this producer; that
serialization detail never reaches FIIR consumers. The producer does not decide
pointer ownership, callback escape, record access, or release behavior.

### API notes

Headers often omit semantic facts required for memory safety. API notes enrich
the declaration result with ownership, nullability, record access, callback
escape, release, threading, and integer-status error projection. Multiple
sources may contribute disjoint facts,
but contradictory safety facts are rejected rather than resolved by source
order. Unknown fields, functions, and parameter indices are also rejected before
FIIR reaches sema. Project contracts use adjacent `<header>.zd` Z declaration
files with `declare module`. Internal toolchain metadata may feed the same
normalizer without becoming a second project-authored contract format.

### Swift and package metadata

Declared Objective-C-compatible Swift targets now provide the first independent
Swift metadata producer. `swift-symbolgraph-extract` preserves `@MainActor`
facts that the generated Objective-C header omits and identifies the matching
Objective-C runtime class and selector. Z merges those facts with Clang's ABI
declarations before FIIR reaches semantic analysis. The symbol graph never
redeclares the ABI, callback ownership, or completion guarantees.

Future external Swift module interfaces, generated C++ ownership facts, package
products, and broader actor/sendability metadata should produce the same IR. Z
semantic analysis should not care which tool supplied a function or type once
its verified contract is equivalent.

## Required invariants

An FIIR producer/merge step must reject a boundary unless all safety-critical
facts are coherent:

1. an owned pointer return names a compatible consuming release operation;
2. a borrowed/consuming parameter has stable native type identity;
3. nullable and non-null variants cannot be silently interchanged;
4. `in` record access targets const storage; `out`/`inout` target writable
   storage and cannot escape;
5. an escaping callback has complete context, threading, invocation-cardinality,
   and exactly-once release contracts;
6. overload resolution selects exactly one viable native signature; no-match and
   ties remain visible diagnostics rather than first-declaration fallback;
7. opaque RAII values carry explicit copy/move/deinit capabilities, `.zd`
   cannot exceed what Clang proves, and values are never treated as plain byte
   records;
8. C++ named-value references retain immutable, mutable, or consuming access;
   public constructors and static/instance methods retain overload signatures
   and native source metadata. Instance methods additionally retain borrowed,
   mutable, or consuming receiver access;
9. native thread transfer, shared identity, and receiving-thread destruction
   remain explicit facts independent of ordinary move/copy/deinit lifecycle;
   the current executable tier requires transfer plus destruction for a unique
   C/C++ owner, while native sharing remains reserved;
10. explicit native unavailability is rejected at the Z use site and points back
   to the native declaration. An explicit project deployment target also makes
   introduced/obsoleted versions errors and applicable deprecations warnings;
   without one, FIIR retains the versions without guessing a target.
11. a status projection targets an integer native return, declares at least one
    success value, preserves every other status as that exact integer error, and
    activates owned outputs before failure cleanup.

## Self-hosting shape

The IR is intentionally representable in intended Z: tagged enums for foreign
type variants, structs for declarations/contracts, `Array<T>` for ordered
parameters and fields, maps supplied by the compiler library for symbol lookup,
and owned `String` values for source/native names. No part requires executing
TypeScript objects or embedding a Clang node in semantic analysis.

The eventual self-hosted compiler may invoke a small toolchain adapter process
or stable C API to obtain `ForeignModuleDeclarations`. The Z compiler then owns
contract normalization and receives the same normalized FIIR regardless of
whether declarations came from Clang, a Swift interface reader, package
metadata, or a versioned cache. No Clang node, TypeScript object identity, or
API-note JSON shape crosses into the type checker.

That gives self-hosting a concrete seam:

```text
toolchain adapter process/C API
    -> raw declaration stream
Z-owned metadata readers
    -> ownership/nullability/callback facts
Z-owned normalizer
    -> validated FIIR
Z sema and native backends
```

The first adapter seam is now executable. The real Clang header producer can
frame a function-only module as a versioned `ZFDCL` raw-declaration stream,
carrying function names, namespaces, overloads, native type spellings,
parameters, source locations, executor affinity, and availability into an
owned Z decoder. Text is length-prefixed UTF-8 and records are flat, so the
native compiler can validate and consume a bounded stream without adopting
TypeScript object layouts or JSON as compiler architecture. An end-to-end
fixture runs a scalar C header through Clang, the stream encoder, native Z
decoding, strict C compilation, and execution.

The same producer/decoder seam is now exposed across standalone processes:
Stage 0's internal `self-host-foreign` command writes a header-addressed
artifact, and the self-emitted native driver validates it without relying on a
TypeScript representation. Ordinary native `check` still rejects the import;
decoding untrusted declarations is not equivalent to applying `.zd` facts or
constructing validated FIIR.

This first protocol tier deliberately fails closed for native types, constants,
Objective-C declarations, interfaces, and protocols. It is producer-facing
data, not serialized FIIR: `.zd` facts still need to be read and normalized in
Z before semantic analysis may trust the result. The normalized in-memory FIIR
remains a separate, version-independent compiler model.

## Next slices

1. extend the host deployment-target slice with cross-compilation and explicit
   runtime availability guards when their semantics are designed;
2. extend implemented named-value reference and receiver-qualifier facts to
   returned references, explicit lifetime contracts, inheritance, user-defined
   conversions, and richer properties without flattening names;
3. extend implemented move/deinit value capabilities from synchronous locals,
   calls, returns, and Z structs into non-trivial container, closure, and async
   frame storage;
4. expand block/callback adapters with threading and callback-to-async
   synthesis;
5. automate standalone-driver invocation of the implemented
   Clang-to-`ZFDCL` adapter, then add records for native types, constants,
   callbacks, Objective-C declarations, interfaces, and protocols without
   weakening its fail-closed boundary;
6. implement the `.zd` reader and contract normalizer in Z, producing validated
   in-memory FIIR rather than teaching native sema about wire records.
