# Foreign Interface IR

The Foreign Interface IR (FIIR) is the normalized contract between native API
metadata producers and the Z semantic checker. It prevents Clang AST details,
Swift interface details, API-note storage, or a stage-0 JSON shape from leaking
through the compiler.

```text
Clang AST ───────────────┐
API notes ───────────────┤
Swift interfaces ────────┼─> FIIR validation/merge ─> Z sema ─> native backend
package metadata ────────┘
```

The first code extraction lives in
[`compiler/src/foreign-ir.ts`](../compiler/src/foreign-ir.ts). It is deliberately
behavior-preserving: the Clang importer still produces the same data and all
existing semantic/code-generation consumers keep their public types.

## What FIIR owns

FIIR describes facts the rest of the compiler needs:

- modules, functions, parameters, constants, records, enums, scalar aliases,
  opaque native values, Objective-C objects/interfaces, and callbacks;
- both Z-facing type identity and native declaration spelling;
- nullability and owned, borrowed, or consuming pointer contracts;
- non-escaping record access (`in`, `out`, `inout`);
- callback lifetime, context, release, and threading contracts;
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
headers through Clang. It maps supported declarations into FIIR while preserving
the native spelling used by generated source.

### API notes

Headers often omit semantic facts required for memory safety. API notes enrich
the declaration result with ownership, nullability, record access, callback
escape, release, and threading. The adjacent JSON used today is stage-0 input;
it is not FIIR and is not a promised user-authored format.

### Swift and package metadata

Future Swift module interfaces, generated C++ surfaces, API notes, and package
products should produce the same IR. Z semantic analysis should not care which
tool supplied a function or type once its verified contract is equivalent.

## Required invariants

An FIIR producer/merge step must reject a boundary unless all safety-critical
facts are coherent:

1. an owned pointer return names a compatible consuming release operation;
2. a borrowed/consuming parameter has stable native type identity;
3. nullable and non-null variants cannot be silently interchanged;
4. `in` record access targets const storage; `out`/`inout` target writable
   storage and cannot escape;
5. an escaping callback has a complete context, threading, and exactly-once
   release contract;
6. overload ambiguity remains visible until an explicit resolver selects one;
7. opaque RAII values preserve their native construction/copy/destruction
   semantics rather than being treated as plain byte records.

## Self-hosting shape

The IR is intentionally representable in intended Z: tagged enums for foreign
type variants, structs for declarations/contracts, `Array<T>` for ordered
parameters and fields, maps supplied by the compiler library for symbol lookup,
and owned `String` values for source/native names. No part requires executing
TypeScript objects or embedding a Clang node in semantic analysis.

The eventual self-hosted compiler may invoke a small toolchain adapter process
or stable C API to obtain declaration metadata. That adapter is replaceable as
long as it validates and serializes the same FIIR contract. This keeps “how to
talk to Clang” outside the Z type checker without pretending the native
toolchain is disposable.

## Next slices

1. add source-location and availability metadata so editor definitions and
   diagnostics point into native interfaces;
2. separate raw declaration extraction from API-note merge/validation;
3. represent namespace hierarchy, overload sets, constructors, methods, and
   properties without flattening names;
4. add explicit copy/move/destructor capabilities for general C++ and Swift
   values;
5. describe block/callback adapters and callback-to-async synthesis;
6. add serialization only when caching or a self-hosted toolchain adapter needs
   it, then version that format separately from the in-memory IR.
