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
  `for...of`, closures, match-arm payloads, constructors, methods, and `deinit`,
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
  parameters, field types/visibility/read-only state, and enum variants/payloads
  across the graph. Local and imported enums plus compiler-provided `Option<T>`
  and `Result<T, E>` now drive native match subject, payload, generic aggregate
  destructuring, exhaustiveness, and arm-result checks. The tier also covers
  Z-defined field reads and assignments across local/selective/namespace type
  identities, including generic substitution, private access, read-only writes,
  and enum equality. Z-defined instance and static method calls use graph-carried
  visibility, receiver mode, async/error state, method and owner generics,
  parameter capabilities/types, and result types. It covers closure result
  contracts, indexing, unary/binary operators, and ternaries, and validates known
  initializers, assignments, conditions, call arguments, and returns with native
  source-located diagnostics. Nominal type identity is resolved by defining
  module and symbol rather than source spelling, while signatures, fields,
  methods, and enum payloads are rebased to the caller's visible namespace or
  selective alias for readable diagnostics. Generic unification uses the same
  identity recursively through nullable, `view`, fixed-array, and nested-generic
  shapes, so aliases do not create false inference conflicts. Native value
  bindings also retain declaration mutability: direct reassignment accepts
  `let`, `inout`, and `out` storage while rejecting `const`, value, and `in`
  bindings at the assignment target.
- `module-resolver-protocol.zs` frames that host-loaded batch and returns the
  resolved graph through the same in-process native-library boundary.
- `parser-protocol.zs` encodes the temporary parity protocol shared by native
  clients.
- `parser-library.zs` is the compiler-facing root compiled into a
  content-addressed dynamic library and loaded in-process by the Bun driver.

The readable clients and smoke tests remain under
[`examples/applications/source-inspector`](../../examples/applications/source-inspector).
Run exact stage-zero parity with:

```sh
bun run z self-host-lex compiler/frontend/lexer.zs
bun run z self-host-parse compiler/frontend/lexer.zs compiler/frontend/parser.zs
bun run z self-host-resolve examples/language/modules/main.zs --timings
```

The text protocol is a bootstrap boundary, not the intended final frontend API.
The resolver intentionally receives host-canonicalized paths and source text in
its first tier, keeping filesystem loading separate from graph semantics. A
shared stage-zero loader discovers that canonical source batch once for both the
current linker and native parity boundary. The in-process command compares its
module indexes, lexical edges, entry, dependency-first order, symbol kinds,
export state, aliases, local targets, and source coordinates with stage 0. Its
timing report separates library preparation, host discovery, framing, native
lex/parse/resolve/symbol/name/type work, protocol decode, and stage-zero parity
work. Identifier and expression-level type lookup currently cover materialized
expression trees. Unknown foreign/intrinsic-member/async shapes deliberately defer
instead of guessing. Opaque expression spans, receiver-capability enforcement,
contextual
collection and return-driven generic inference, generic constraints and methods,
type-constructor arity, trait conformance, control-flow merging, and ownership
remain stage-zero work.
The reported native interval therefore does more semantic work than the
graph-and-symbol-only stage-zero comparison.
Repeated corpus measurements and incrementally
feeding the native graph into ordinary compiler commands are the next layers.
