# Native Z frontend

This directory contains the reusable lexer and parser being implemented in Z
for incremental self-hosting. Stage 0 still compiles these sources and owns
semantic analysis and code generation; the frontend itself is native Z code.

- `lexer.zs` performs checked UTF-8 tokenization while publishing UTF-16 source
  coordinates compatible with the language server and stage-zero compiler.
- `parser.zs` builds owned, flat declaration, statement, and expression arenas.
- `module-resolver.zs` consumes those native ASTs directly and validates a
  host-loaded batch of canonical module paths: local edges, dependency order,
  selective exports, aliases, duplicate bindings, missing modules, and cycles.
  Its first semantic tier builds source-located symbol tables for declarations,
  namespace imports, and selective bindings. It also performs source-ordered
  lexical identifier lookup through parameters, locals, nested blocks,
  `for...of`, local/iteration object patterns, closures, match-arm payloads,
  constructors, methods, and `deinit`,
  producing native unknown-name diagnostics with exact source locations. Type
  references retain their nested nominal components structurally, and the
  resolver checks declaration signatures, fields, constraints, enum payloads,
  local annotations, closure/executor signatures, `new`, and explicit generic
  arguments against intrinsics, generic parameters, and module type symbols. A
  first expression-typing tier infers scalar/template/array literals,
  parameters, annotated and inferred locals, local aliases, and direct calls
  across local, selective-import, and namespace-import boundaries. Module
  function symbols retain async state, generic parameters, parameter
  capabilities and types, return type, and error type. Generic calls accept
  explicit type arguments or infer them from direct, nested-generic,
  fixed-array, `Slice`, nullable, and `view` parameter shapes, then substitute
  their parameter and return contracts. Type symbols retain aggregate type
  parameters, field types/visibility/read-only state, custom-deinitializer and
  custom-constructor presence and constructor callable signatures,
  and enum variants/payloads across the graph. Local and imported enums plus compiler-provided `Option<T>`
  and `Result<T, E>` now drive native match subject, payload, generic aggregate
  destructuring, exhaustiveness, and arm-result checks. Local value-struct
  patterns and iteration patterns retain field/alias locations, introduce
  source-ordered bindings, and export inferred field contracts when known. The
  tier also covers Z-defined field reads and assignments across
  local/selective/namespace type identities, including generic substitution,
  private access, read-only writes, and enum equality. Z-defined instance and
  static method calls use graph-carried
  visibility, receiver mode, async/error state, method and owner generics,
  parameter capabilities/types, and result types. Local closures preserve
  explicit parameter capabilities/types and inferred or explicit result types,
  validate expression and block bodies in nested scopes, and route local calls
  through the ordinary capability/type checker. Settled local, imported, and
  method parameter contracts contextually supply omitted closure parameter and
  block-result types; capabilities remain explicit and must match. Capture discovery distinguishes
  parameters and closure locals from outer bindings: borrowed cleanup-bearing
  captures become conservative loans, while `move` consumes uniquely owned
  captures and copies ARC-managed identities. It also covers indexing,
  unary/binary operators, and ternaries, and validates known
  initializers, assignments, conditions, call arguments, and returns with native
  source-located diagnostics. Nominal type identity is resolved by defining
  module and symbol rather than source spelling, while signatures, fields,
  methods, and enum payloads are rebased to the caller's visible namespace or
  selective alias for readable diagnostics. Generic unification uses the same
  identity recursively through nullable, `view`, fixed-array, and nested-generic
  shapes, so aliases do not create false inference conflicts. Native value
  bindings also retain declaration mutability: direct reassignment accepts
  `let`, `inout`, and `out` storage while rejecting `const`, value, and `in`
  bindings at the assignment target. The same record carries initialized,
  uninitialized, or maybe-uninitialized flow state. Direct assignment and
  nested blocks update that state, `if` merges only branches that can continue,
  loops conservatively include their zero-iteration path, and successful exits
  require every `out` parameter to be initialized. Direct and imported Z calls enforce declared
  parameter capabilities before evaluating storage: `out` and `inout` require
  their matching explicit call-site marker and mutable bindings, `inout`
  requires initialized storage, and a successful `out` call initializes it.
  Expression traversal carries these transitions left-to-right while ternary
  and short-circuit branches merge them conservatively. Per-call access roots
  reject every overlap except shared `in`/`in` and copyable `value`/`value`
  uses, including conflicts between a receiver and its arguments. Value-struct
  `inout this` requires mutable addressable storage; a class reference keeps
  identity mutation through an owned `const` binding while an immutable `in`
  borrow cannot invoke the mutating method. The binding record also carries
  available, moved, or maybe-moved ownership state. Owned value arguments move
  deterministic-cleanup structs, enums, arrays, and standard storage while ARC
  classes, weak references, and closures copy their managed handle. Continuing
  branches and loops merge move state conservatively while exiting branches do
  not poison later flow; borrowed bindings cannot be consumed,
  assignment and successful `out` restore ownership, and `move this` invalidates
  a named receiver. Exhaustive `match (value)` consumes cleanup-bearing enum
  storage while `match (in value)` borrows named storage. Payload bindings inherit
  owned or borrowed access, cleanup-bearing object-pattern fields remain borrowed,
  and continuing arms merge their outer ownership effects. Reads after definite
  or conditional transfer originate in Z. Ordinary value destinations now use
  the same transfer rule: local initialization, replacement assignment, return,
  throw, selected match results, conditional branches, fixed-array elements,
  synthesized aggregate fields, and enum payload construction. Synthesized
  object construction validates exact fields and recursively consumes nested
  ownership. Declared class constructors instead use their graph-carried
  parameter capabilities and types, including owner-generic substitution, so
  owned, `in`, `inout`, and `out` arguments behave exactly like ordinary calls.
  Synchronous Z functions, methods, and constructors preserve a pending error
  effect until `attempt` materializes `Result<T, E>` or `try` validates and
  propagates `E` from an enclosing `throws E` body. Unhandled throwing calls,
  non-throwing operands, incompatible propagation, and mismatched or undeclared
  `throw` values now originate in Z. Generic error types and imported aliases use
  the same substitution and nominal-identity rules as ordinary call results.
  Function return contracts also remain visible through nested match-arm
  statements, and payload-free constructors such as `Option<T>.none` are
  classified as fresh enum values rather than ownership-bearing field moves.
- `module-resolver-protocol.zs` frames that host-loaded batch and returns the
  resolved graph through the same in-process native-library boundary.
- `parser-protocol.zs` encodes the temporary parity protocol shared by native
  clients.
- `c-emitter.zs` is the first native lowering/code-generation slice. It emits
  ordinary `i32`/`boolean`/`void` functions, value parameters, explicitly typed
  locals, direct calls, arithmetic, assignment, `if`, `while`, loop control,
  returns, and non-generic data-only value structs from the owned Stage 1 AST.
  Struct layout, construction, value passing, and field access are executable.
  Signed `i32` addition, subtraction, multiplication, and negation retain Z's
  checked-overflow behavior.
- `lowering-ir.zs` owns the typed flat-arena boundary between parser semantics
  and target text. Checked arithmetic, direct calls, field reads, and struct
  construction are settled operations in this IR; the C printer does not
  rediscover them from source-shaped nodes.
- `parser-library.zs` is the compiler-facing root compiled into a
  content-addressed dynamic library and loaded in-process by the Bun driver.

The readable clients and smoke tests remain under
[`examples/applications/source-inspector`](../../examples/applications/source-inspector).
Run exact stage-zero parity with:

```sh
bun run z self-host-lex compiler/frontend/lexer.zs
bun run z self-host-parse compiler/frontend/lexer.zs compiler/frontend/parser.zs
bun run z self-host-resolve examples/language/modules/main.zs --timings
bun run z self-host-emit tests/fixtures/self-host-emit-input.zs
bun run z check examples/language/modules/main.zs --native-frontend --timings
```

`self-host-emit` is an end-to-end bootstrap proof rather than an alternate
production backend. Its output compiles and runs without rebuilding a
TypeScript AST. The command passes its canonical source batch through native
module resolution and semantic analysis before emission, so invalid names and
types fail before Clang. Scalar and control-flow fixtures prove that native
lexing, parsing, semantic validation, and C emission compose.
Stage 0 still owns full-language semantic analysis, lowering, module linking,
runtime support, foreign interop, and production `emit`/`run`.

Scalar calls, mutable control flow, value structs, owned enums, `Option<T>`,
and `Result<T, E>` now run directly through the typed lowering IR. Checked
operations, aggregate construction, ownership transfer, and error propagation
are settled lowering operations rather than formatting decisions rediscovered
by the C printer.

Payload enums use a nominal tag plus C union. Dependency-ordered definitions
allow aggregate payloads, and synthesized active-variant deinitializers destroy
only the selected cleanup-bearing payload. Exhaustive consuming match transfers
that payload into exactly one arm owner. Direct return matches, typed local
match results, call/constructor subjects, and selecting block arms share the
ordinary cleanup planner.

Compiler `Option<T>` reuses that representation without allocation.
Compiler `Result<T, E>` likewise keeps Z's surface model: `return` constructs
success, `throw` constructs failure, `attempt` preserves the result, and `try`
either extracts success or propagates failure after surrounding cleanup. Both
payload-free `Result<void, E>` success and cleanup-bearing success/error
payloads are executable. Inferred local bindings consume the native resolver's
source-positioned semantic evidence, so struct, Option, Result, `try`, and match
storage share one authoritative type decision with cleanup planning rather than
being re-inferred by the emitter.

`self-host-emit` now consumes the canonical graph's dependency order and lowers
all discovered modules rather than rejecting an entry import. The first
executable tier covers selectively imported scalar functions in one generated C
translation unit. Native scalar emission includes `i32`, `u8`, and `usize`;
checked arithmetic selects a width-correct helper from native semantic evidence
instead of treating every integer expression as `i32`. A local selective alias
is resolved back to the exported
source symbol before emission, so alias ergonomics do not invent an ABI-level
wrapper. Duplicate type or function spellings across modules now fail before C
emission rather than generating an ambiguous translation unit. Value structs
now retain canonical graph identity and cleanup metadata across a selective type
alias, factory return, inferred local, parameter, and field projection. An
implicit owned-argument transfer suppresses caller cleanup and the imported
callee destroys the parameter exactly once. Recursive cleanup also survives a
local Z struct wrapping that imported owner, including implicit transfer into
the field and then into a consuming function. Imported enum identity now
includes aliased payload/payload-free construction, factory returns, exhaustive
match, owned payload transfer, and scope cleanup. Selective struct aliases now
construct the canonical exported value directly from object initializers.
Colliding module-private functions, structs, and enums receive internal
module-qualified C names. Local calls, type references, construction, enum
payloads, match, and recursive cleanup all retain that identity. Same-named
exports still fail closed pending an exported-symbol/ABI naming policy;
separate-object emission remains an explicit follow-up.

Cleanup plans cover owned parameters and locals, nested lexical scopes,
branches, loop fallthrough and `break`/`continue`, replacement assignment,
recursive aggregate fields, non-empty custom deinitializers, conditional
transfer live flags, consuming match, and the implemented error exits. A
lowered return evaluates its result into a temporary, runs reverse exit cleanup,
and then returns the saved value. A local enters the cleanup plan only after its
initializer; `move local` removes that cleanup and transfers destruction to the
final owner. Loop-carried conditional transfer and broader nested-expression
`try` remain fail-closed.

Linear owned-parameter transfer is executable too. `move resource` becomes an
explicit lowered ownership operation that emits no C copy wrapper, removes
cleanup from the transferring function, and leaves destruction with the final
callee. Owners that remain live through `if` and `while` now receive cleanup on
nested returns and ordinary fallthrough. A move combined with control flow is
handled through `if` as described below; loop-carried transfer remains
fail-closed. Owners local to `if` branches now clean on branch fallthrough and
before early return.
Loop-local owners now clean at ordinary iteration fallthrough and on the exact
`break`/`continue` edge. The plan resets at each nested loop boundary so inner
loop control never destroys an outer-iteration owner.

Conditional owner transfer through `if` now joins through an explicit generated
live flag. The move clears it before handoff and every later cleanup is guarded;
the untouched path leaves it set. Straight-line moves remain flag-free.
Loop-carried conditional transfer remains fail-closed until the back-edge joins
the live state.

Whole-binding owned replacement is executable as well. The emitter evaluates
the replacement into a temporary before destroying the previous value, then
transfers the temporary into the still-live binding. This preserves RHS access
to the old value without leaking or destroying the replacement twice.

Cleanup classification is recursive across value-struct fields. A struct with
no custom `deinit` still receives generated reverse field cleanup when it
contains a cleanup-bearing struct, and locals of that outer type participate in
the same scope plans.

Non-empty custom `deinit` bodies now lower through the typed statement and
expression IR. They may execute ordinary synchronous Z control flow and calls
and access receiver fields through `this`; the user body runs before generated
reverse field cleanup. Cleanup planning now consumes a statement arena rather
than a function-only shape, so cleanup-bearing deinitializer locals reuse the
same lexical, loop-edge, replacement, and fallthrough machinery as ordinary
functions.

Z `const` remains binding immutability, not immutable physical storage. The C
emitter therefore keeps value-struct local storage writable so deterministic
cleanup may receive its address; source-level reassignment remains a semantic
error.

`check --native-frontend` is the first ordinary-command integration. Stage 0
still owns diagnostics and unsupported semantic shapes; the native frontend
analyzes the same canonical module batch, gates command success on exact
graph/symbol parity, and supplies validated authoritative results for the
supported semantic subset. The opt-in bridge keeps diagnostics stable while
measuring equivalent work and finding semantic composition gaps.
`--timings` is available only with this bridge.

The parser text protocol remains a bootstrap boundary. Resolver phase API
version 1 now returns one owned native result handle. Entry identity, module
paths, dependency lists, dependency order,
graph/evidence counts, and symbol identity are queried directly through that
handle and consumed by the host. One bulk fixed-width record fill carries every
symbol's kind, export state, imported name, local target, and source location.
Top-level function signatures use a base-record batch plus one flattened item
batch for type parameters, trait constraints, parameter capabilities/types,
return types, errors, and executor affinity. Aggregate/type bases and items form
a second pair, while constructor and method callable bases/items form a third.
Together they preserve fields, variants, visibility, read-only state, trait
conformance, receiver capabilities, async/error effects, and executor affinity.
Call-resolution bases/items, inferred-binding records, root-expression records,
and their flattened nominal-identity paths complete the same structural
handoff. Success has no text payload: topology, symbols, signatures, and semantic
evidence all come from bulk fixed-width queries over the retained graph.
Resolver failures alone use the temporary framed diagnostic payload. The
retained handle owns the resolved Z graph and all borrowed strings until the
host releases it, so the host never needs a second native resolution or an
escaping borrowed lifetime. The host rejects unknown API versions before
creating a result.
The resolver intentionally receives host-canonicalized paths and source text in
its first tier, keeping filesystem loading separate from graph semantics. A
shared stage-zero loader discovers that canonical source batch once for both the
current linker and native parity boundary. The in-process command compares its
module indexes, lexical edges, entry, dependency-first order, symbol kinds,
export state, aliases, local targets, and source coordinates with stage 0. Its
timing report separates library preparation, host discovery, framing, native
lex/parse/resolve plus structural handoff, and stage-zero parity work.
Identifier and expression-level type lookup currently cover materialized
expression trees. Unknown foreign and unsupported intrinsic-member shapes
deliberately defer instead of guessing. Native signatures retain nominal trait constraints and
aggregate conformance. Inferred and explicit generic calls, generic methods,
generic construction, and trait-authorized calls inside constrained bodies enforce
those contracts natively. Standalone Z and intrinsic generic type uses recursively
validate arity and constraints through arrays, nullable/view wrappers, nested
generics, and function signatures; bare generic names remain available only at
constructor-inference sites. Direct generic function and method calls may infer
otherwise-missing result parameters from a local annotation, assignment target,
or enclosing function return contract. Generic functions, static and instance
methods, declared constructors, and synthesized aggregate fields propagate
settled parameter types through nested calls and ternary, value-producing `if`,
and expression-`match` branches. Direct Z async calls retain their pending
success/error effect until `await`; cold `AsyncGenerator` construction and
intrinsic awaited advancement use the same model. Structured `task` creation
materializes source-level `Task<T, E>` evidence, and awaiting the handle consumes
it while restoring the pending success/error effect. Opaque expression spans,
generic trait declarations, foreign calls and placements whose upstream capture
types are absent from the native source graph,
escaping closure-environment validation, borrow last-use release, and complete
recursive ownership lowering remain stage-zero work.
The wider executable corpus additionally checks semantic compatibility that
aggregate evidence counts alone cannot prove: trait receiver modes, contextual
payload-free generic variants, structurally compatible function types with
different parameter names, and invocation through function-valued aggregate
fields all retain native authority.
Transparent callable aliases now expand before contextual closure and call
analysis. Function-type shapes retain a separate `throws E` effect, so
contextual or explicitly throwing closure bodies receive the error contract and
their resulting callable evidence preserves it. Existing synchronous and
native-thread throwing-closure programs therefore remain native-authoritative
without requiring foreign thread metadata in the native source graph.
Compiler-provided weak references are native as well: `WeakExpired` is an
intrinsic type, `weak value` validates a class target without consuming its
owner, and `Weak<T>.upgrade()` yields `T throws WeakExpired`. The existing
weak-reference and weak-capture application therefore remains fully
native-authoritative.
Recursive cleanup and explicit-copy analysis also stay in each aggregate's
defining module. Concrete generic arguments are rebased there before
substitution, preserving ownership through exported aggregates whose nested
field types are intentionally not imported by the caller. The project-index
application exercises that path through `IndexReport -> FileRecord -> String`
and remains fully native-authoritative.
Dependent relational comparisons between an active type parameter and a
contextual numeric literal are provisionally accepted to match current
template-style specialization. Stage 0 still validates every concrete
instantiation; this narrow deferral must be replaced by native specialization
before the native frontend becomes the sole authority for unconstrained generic
operators.
Unresolved external types are identified structurally from imports whose
target is not a local Z module. Operations that require unavailable Clang,
Objective-C, C++, or Swift type facts—numeric typedef classification,
contextual foreign literals and closures, or foreign getter ownership—defer to
Stage 0 rather than producing a speculative native diagnostic. A sweep of all
155 executable example roots leaves no partial binding/expression-authority
gap. The native lexer now recognizes contextual raw-native headers and preserves
each embedded body as one opaque token across nested braces, quotes, and
comments. The parser structurally accepts
`function ... = raw c|cpp|objc { ... }`; raw expressions remain opaque to
native semantics and continue through Stage 0's dedicated boundary checks.
Ordinary identifiers named `raw` are unaffected. Foreign and raw deferral are
bootstrap boundaries, not claims that Stage 1 understands the foreign ABI;
native FIIR ingestion and raw-boundary validation must eventually replace them
before the host can disappear.
Concrete generic call evidence retains source-level nested types such as
`Option<i32>` and is rebased onto Stage 0's temporary materialized lowering
types only after source-template substitution proves the contracts equivalent.
The same native pass now exports settled types for unannotated initialized local
bindings, keyed by the binding name's stable source location. The semantic
bridge validates name, mutability, and type before using that native binding
contract; materialized generic types use their source display names for the
comparison. Direct aggregate bindings additionally carry their resolved module
and symbol, so local, selective-import, and namespace-qualified spellings share
one identity. Identity paths now recurse through compiler-known wrappers such as
`Option`, arrays and slices, views, `Weak`, tasks, function signatures, and
materialized `Result` payloads. User-defined generic aggregate materialization
now retains the source template plus ordered source arguments. Binding and
expression evidence therefore carries nominal identities through nested shapes
such as `Envelope<Slot<SyntaxNode>>`, while the bridge validates the matching
identity path shape instead of accepting equal-looking type text.
Settled root expressions now form a third source-located evidence stream. Each
record carries its source type and the same recursive declaration identities as
binding evidence. The compiler indexes these records by canonical module and
expression offset; Stage 0 consumes a record only when location, concrete type,
and every nominal identity agree. Expressions absent from the native tree, or
whose linked representation cannot yet be proven equivalent, stay on the
Stage-0 path. The check report separately shows exported, observed, and
native-authoritative root-expression counts.
Native resolver failures cross the bootstrap boundary as structured diagnostic
records rather than display text. Unknown names/types/members, type mismatches,
invalid operators, and invalid matches are now authoritative native diagnostics
when their file and location belong to the canonical source batch. Stage 0 still
owns parser, loader, and unsupported-shape diagnostics; malformed, out-of-batch,
or non-semantic native failures remain buffered until Stage 0 succeeds.
Semantic evidence queries now translate linked Stage-0 locations back to their
canonical module-local offsets before consulting the native index. This keeps
imported function bodies authoritative even though Stage 0 rebases their offsets
to make one linked program. Qualified names rooted in non-Z selective imports
remain opaque foreign types, allowing the native pass to validate surrounding Z
code without claiming C/C++ header semantics.
The reported native interval therefore does more semantic work than the
graph-and-symbol-only stage-zero comparison.
A representative ordinary-check corpus now covers the native frontend itself,
two application-shaped multi-module programs, `Result`, arenas, owned closures,
generic constraints, async ownership, and C++-backed resource fields. Every
Stage-0 semantic resolution observed on that corpus has a validated native
authority contract. Migrating the remaining unsupported ownership/effect
contexts is the next self-hosting layer.
The ordered continuation plan and current criteria live in
[`docs/bootstrap-status.md`](../../docs/bootstrap-status.md#self-hosting-continuation-point).
