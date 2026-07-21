# Native Z frontend

This directory contains the reusable lexer and parser being implemented in Z
for incremental self-hosting. Stage 0 still compiles these sources and owns
semantic analysis and code generation; the frontend itself is native Z code.

- `lexer.z` performs checked UTF-8 tokenization while publishing UTF-16 source
  coordinates compatible with the language server and stage-zero compiler.
- `parser.z` builds owned, flat declaration, statement, and expression arenas.
- `parser-protocol.z` encodes the temporary parity protocol shared by native
  clients.
- `parser-library.z` is the compiler-facing root compiled into a
  content-addressed dynamic library and loaded in-process by the Bun driver.

The readable clients and smoke tests remain under
[`examples/applications/source-inspector`](../../examples/applications/source-inspector).
Run exact stage-zero parity with:

```sh
bun run z self-host-lex compiler/frontend/lexer.z
bun run z self-host-parse compiler/frontend/lexer.z compiler/frontend/parser.z
```

The text protocol is a bootstrap boundary, not the intended final frontend API.
The next integration layers are direct native AST consumption, a Z module
resolver, and incremental replacement of stage-zero frontend phases.
