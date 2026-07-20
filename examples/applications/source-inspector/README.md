# Source inspector

This application is a small, readable pressure test for the APIs a future
self-hosted Z frontend will need. It reads an actual Z source file and runs a
real tokenizer over its UTF-8 storage, producing owned tokens with byte offsets,
line and column locations, decoded string literals, and typed lexer errors.

Run it against its own lexer:

```sh
bun run z run examples/applications/source-inspector/main.z -- \
  examples/applications/source-inspector/lexer.z
```

The lexer deliberately uses `byteLength` and `byteAt` because compiler source
locations are byte offsets. `copyBytes(start, end)` creates an owned token-sized
`String` and checks that both ends fall on UTF-8 boundaries. Escape decoding
uses the move-only `TextBuffer` from `std/text`: unchanged source chunks append
without allocating substrings, while `finish()` transfers the completed bytes
into an owned `String` token.

The lexer now emits exact parser-facing kinds for Z's current reserved keywords,
punctuation, operators, and template interpolation boundaries. `move` and `view`
deliberately remain identifiers because the stage-0 parser treats them as
contextual keywords. Comments are trivia, matching the stage-0 lexer. Decimal
and exponent forms are single number tokens, malformed exponents are typed lexer
errors, and unknown bytes are rejected rather than accepted as generic symbols.

Run its focused grammar checks with:

```sh
bun run z run examples/applications/source-inspector/lexer-smoke.z
```

[`token-stream.z`](token-stream.z) is the first stage-1 bridge. It emits a stable
tab-separated token stream with fixed-width hexadecimal locations and
hexadecimal token text. It buffers the complete stream and performs one native
write rather than flushing once per token. The TypeScript driver exposes the
parity path directly:

```sh
bun run z self-host-lex examples/applications/source-inspector/lexer.z
```

That command compiles the bridge with stage 0, runs it natively, and compares
its complete token sequence and source locations with the bootstrap lexer.

[`parser.z`](parser.z) is the first parser foundation. It consumes those owned
tokens with a linear cursor and builds a declaration skeleton containing source
locations, declaration kinds, names, and export/async state. Top-level function
nodes additionally retain generic parameters and multi-trait constraints,
receiver and parameter capabilities, nested type references, return types, and
typed `throws`. Balanced declaration bodies are traversed through borrowed token
access; only text retained in the tree becomes an owned snapshot. Run exact
stage-0 parity across one or more source files with:

```sh
bun run z self-host-parse examples/applications/source-inspector/lexer.z \
  examples/applications/source-inspector/parser.z
```

The parity command checks canonical function signatures as well as declaration
metadata. Its adversarial corpus covers nested generics, function types, fixed
arrays, `view`, nullability, `async`, `throws`, and every parameter/receiver
capability. Aggregate members, enum variants, statements, and expressions are
not constructed yet. Unicode identifiers, block comments, direct in-process
compiler integration, and the complete syntax tree remain future slices. Build
time and subprocess startup still dominate these bootstrap commands, so
native-vs-stage-0 parser performance should be compared only after the frontend
has an in-process driver boundary.
