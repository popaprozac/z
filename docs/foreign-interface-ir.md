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
frame functions, scalar typedefs, nominal enum types, typed native constants,
record layouts/fields, and the first Objective-C declaration graph as a
versioned `ZFDCL` raw-declaration stream. Version 9 carries scalar
alias/underlying identity, enum identity/underlying type,
constant identity/type, record identity/layout, canonical C record identity
across typedef aliases, field order/types, function names, namespaces,
overloads, native type
spellings, parameters, source locations, executor affinity, availability,
Objective-C interfaces, protocols, inherited protocol names, methods,
method-parameter `id<Protocol>` qualifiers, and async projection indices
plus the producer's semantic Objective-C type identity and nullability beside
the exact ABI spelling into an owned Z decoder. Text is
length-prefixed UTF-8 and records are flat, so the
native compiler can validate and consume a bounded stream without adopting
TypeScript object layouts or JSON as compiler architecture. An end-to-end
fixture runs a scalar C header through Clang, the stream encoder, native Z
decoding, strict C compilation, and execution.

The same producer/decoder seam is now exposed across standalone processes.
Stage 0's internal command and the `z-foreign-adapter` executable share one
header-addressed producer. The self-emitted native driver finds the adjacent
`.zd`, prefers an adapter packaged beside its own executable and otherwise
invokes one from `PATH`, decodes its project-local
`.z-cache/foreign` artifact, and performs contract normalization itself without
relying on a TypeScript representation. Driver identities include module,
header, contract, include directories, and target settings. Adapter metadata
hashes Clang's complete preprocessed header view plus the contract; a hit skips
AST production, while a direct or transitive header change regenerates the
stream. Decoding untrusted declarations is still not equivalent to validated
FIIR. The versioned stream projects only declaration categories this native
tier can represent, so unrelated declarations do not poison a supported import.
Function records retain their exact native type spellings; a missing
adapter/contract, a `.zd` declaration that depends on an omitted type category,
or any unsupported contract fact still rejects the import during normalization.

The contract layer has crossed as well. A Z-owned `.zd` parser reads the
implemented scalar/status, scalar-pointer, record-resource, opaque-handle,
owner-tied pointer, borrowed-text, named foreign-lifetime, type-field
projection, and invalidation grammar. It checks module and function identity,
parameter names/counts, capabilities, nullability, supported ABI mappings, and
lifecycle/provenance facts against the raw declarations. `view cstring` accepts
only a header-proven character-pointer result, retains nullable spelling, and
requires either one unambiguous immutable pointer input or an explicit
`borrowed from owner;` fact. That owner feeds the same loan used by child
pointers and `invalidates owner;`.
Pointer-bearing cleanup-free records may remain in FIIR as view-only native
types. Their header-proven scalar/enum fields stay visible, while uncontracted
pointer fields are hidden. A type fact
`project field: view cstring [| null] { borrowed from lifetime; }` verifies that
the named record field is a compatible `const char *` and attaches a declared,
module-scoped foreign lifetime identity to the resulting view. No pointer type
or lifetime parameter is added to ordinary Z.
Null-only parameters are admitted only at pointer positions and remain a
visible `null` argument in Z. Fixed parameters name a producer-proven constant
whose exact or canonical scalar type matches the Clang parameter; they are
removed from the source signature but retained in an ordered FIIR argument
plan. Direct calls and generated status adapters consume that same plan, so a
hidden constant is reinserted at its original ABI position rather than inferred
from source arity.
Single-indirection pointers to supported scalar types reuse Z's existing
capability model. `in` requires a const pointee, while `inout` and `out` require
mutable native storage. FIIR publishes the pointee scalar as the Z parameter
type; semantic analysis then applies ordinary mutability and definite-output
rules, and C lowering takes the address without a wrapper.
Normalized callables carry source-level Z types plus exact native status and
ownership evidence. Any fact outside the native tier is an error; it is never
discarded for forward compatibility.

Plain recursively copyable C structs containing representable scalar or record
fields form the first record tier. They cross by value in parameters/results, while existing
`.zd` `in`, `inout`, and `out` parameter capabilities are checked against const
or mutable native pointers. Both forms become ordinary imported struct types
and lower to direct C construction, field access, native calls, and—where
required—address taking. The ownership-bearing record tier admits
pointer-bearing records only after an adjacent contract classifies the
canonical C record with `move` and a verified `deinit` function. Every producer
must say `owned` or `borrowed`; borrowed records are local non-escaping views
until runtime lifetime provenance is modeled. Parameters retain Z's semantic
`in`/`move` capability independently from the C ABI's by-value/pointer mode,
preventing a borrow from changing the native signature. Contracted writable
union pointers may initialize opaque ABI-preserving storage. A checked
discriminant contract exposes tag-only cases or cleanup-free active-member
views; pointer-bearing payload records remain view-only and expose only safe
fields plus reviewed lifetime-bound text projections. Without that contract,
only producer-proven scalar or enum fields support a local unsafe active-member
read. By-value unions, Objective-C properties, full native Objective-C
semantic normalization/lowering, and unclassified resource records still fail
closed.

Opaque pointer ownership is represented separately from record layout. A
nullable inferred result may declare `deinit release;`, and a nullable `out`
parameter may carry the same block fact. The normalizer proves the producer is
exactly `T *` (or `T **` for the output), proves `release(T *) -> void`, and
publishes one source-nameable handle type reused by later `in` and `move`
parameters. Native lowering keeps the ABI direct, initializes empty output
storage to null, cleans any produced owner before a failed status propagates,
and can move the nullable owner into `Option.fromNullable` with a single
producer evaluation. An exact header-derived pointer result may instead
declare `borrowed;`; native sema exposes it as a nullable, non-escaping view,
emits the direct pointer return without cleanup, and rejects storage,
capture, return, consumption, and owned `Option` lifting. `borrowed from owner;`
additionally records the native parameter index that supplies provenance. The
ordinary semantic model carries that index as a view source, allowing `view T`
and `Option<view T>` forwarding while retaining the owner's lexical loan.
Normalized functions may carry native parameter indices from
`invalidates owner;` or module-scoped identities from
`invalidates lifetime;`. Semantic analysis checks both against the same
owner/view loan graph before the direct call; code generation emits no wrapper
or runtime invalidation check. Clang proves field existence and pointer shape,
but `borrowed from lifetime` and named invalidation are trusted behavioral
facts supplied by the declaration author.

Scalar typedef evidence verifies
parameters/results and then lowers
to the underlying Z scalar because C typedefs are not nominal. The stream is
producer-facing data, not serialized FIIR: `.zd` facts still
need to be read and normalized in Z before semantic analysis may trust the
result. The normalized scalar, integer-status, and simple-record callables
attach to ordinary native module symbols:
selective aliases and namespace members share Z's arity, type, and throwing
effect checker, while an imported function missing from the checked contract
fails closed. The normalized in-memory FIIR remains a separate,
version-independent compiler model.

That same tier now reaches native lowering. Imported headers are emitted once,
infallible scalar/record calls retain their native target directly, and
integer-status calls route through a generated C11 adapter that calls the
native function once and constructs `Result<void, E>` from the normalized
success literals. The executable fixture strict-compiles and runs both
selective and namespace calls without exposing producer records to lowering.

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
5. add cross-process locking and eviction to the implemented target-aware
   foreign artifact cache, then add richer records, callbacks, Objective-C
   declarations, interfaces, and protocols without
   weakening its fail-closed boundary;
6. expand the implemented `.zd` reader and contract normalizer from decimal,
   symbolic scalar, nominally preserved enum-backed integer statuses, ordinary
   enum parameters/constants, and the first ownership-bearing record facts
   through general pointer, buffer, callback, executor, and native-value facts,
   then extend the validated
   in-memory FIIR already consumed by native sema and scalar/status lowering
   into richer emission rather than teaching any layer about wire records.
