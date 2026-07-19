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

This is not yet the production Z lexer. It intentionally recognizes only the
subset needed to pressure-test identifiers, numbers, comments, quoted strings,
escapes, symbols, locations, ownership, and error propagation. Template
interpolation, complete numeric grammar, Unicode identifiers, and parser-facing
token detail remain future frontend work.
