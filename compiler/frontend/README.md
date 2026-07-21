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
```

The text protocol is a bootstrap boundary, not the intended final frontend API.
The resolver intentionally receives host-canonicalized paths and source text in
its first tier, keeping filesystem loading separate from graph semantics. The
next integration layer is feeding that batch through the in-process library and
incrementally replacing stage-zero module resolution.
